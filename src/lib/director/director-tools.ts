/**
 * AI Assistant Director tool registry — the declarative source every other
 * director module derives from (spec §Architecture): the Anthropic tool
 * list the model sees (toAnthropicTools), the human-readable capability
 * summary embedded in the system prompt (capabilityInventory), and the
 * budget-metered executor the Inngest loop (Task 7) drives per tool_use
 * block. Every tool validates its own input the same way the human PATCH
 * routes do (isCameraMove/isCameraStrength/isClipModelId/duration bounds/
 * 500-char caps) — the model gets no capability a user lacks. Invalid
 * input NEVER throws; it returns { ok: false, message }.
 *
 * Registry invariant (CI-enforced by director-tools.test.ts): every
 * DirectorTool has a description >= 20 chars, a truthy inputSchema, and an
 * estCostUsd function.
 *
 * Stage 1: scratch setting tools (camera, ends-on, negative prompt,
 * duration, model, entity-refs toggle), generate_candidate_clip, and the
 * two loop-interpreted no-ops record_critique / finish. Stage 2 (Task 10,
 * this task): the two Kontext image-edit tools (edit_start_image,
 * create_custom_end_frame — both ~$0.04, both validate their instruction
 * length before any fal call via runKontextEditToKey in
 * shot-frame-edit.ts). Remaining Stage 2 tools (entity tag/create) land in
 * later tasks by pushing more entries into DIRECTOR_TOOLS — this file's
 * shape does not change.
 *
 * Task 11 (this task): the five entity tools (create_entity,
 * generate_entity_sheet, tag_entity, untag_entity, propose_entity_update).
 * create_entity/tag_entity/untag_entity mirror the human routes' guards
 * (entities POST route's name/type/description/duplicate-name checks; the
 * shot PATCH route's referencedEntityIds cap/ownership checks) but with
 * the tighter caps this feature specifies (name <=80, description <=500).
 * tag_entity/untag_entity are the first tools in this file to write to a
 * REAL row outside the run's scratch (shots.referencedEntityIds) — by
 * design, additive and immediately visible outside the run — and they
 * also sync ctx.scratch.referencedEntityIds so later tool calls in the
 * same run see the up-to-date tag list. propose_entity_update is the
 * first sharedStateEdit: true tool: it only ever reads an entities row
 * (to capture the current description for the proposal's `from` field)
 * and calls ctx.addProposal — it must never write to the entities table.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entities, entityTypeEnum, shots, type Project, type Shot } from "@/lib/db/schema";
import { generateEntitySheet } from "@/lib/entity-sheet-generation";
import { isValidUUID } from "@/lib/api-utils";
import {
  type DirectingSettings,
  type GenerateShotClipResult,
  renderDirectedClip,
} from "@/lib/shot-clip-generation";
import {
  CAMERA_MOVES,
  isCameraMove,
  isCameraStrength,
  type CameraStrength,
} from "@/lib/clip-camera";
import {
  CLIP_MODELS,
  DEFAULT_CLIP_MODEL_ID,
  estClipUsd,
  getClipModel,
  isClipModelId,
  resolveClipDuration,
} from "@/lib/clip-models";
import {
  FRAME_EDIT_INSTRUCTION_MAX_CHARS,
  runKontextEditToKey,
} from "@/lib/shot-frame-edit";

/**
 * Everything a tool's execute() needs, supplied by the Inngest loop
 * (Task 7). `scratch` is the run's working DirectingSettings — setting
 * tools mutate it directly; generate_candidate_clip reads it to render.
 * The append/spend/proposal/setCandidate callbacks persist to the
 * director_runs/director_events rows (Task 6); candidateKey builds a
 * run-prefixed R2 key (`projects/{p}/shots/{s}/director/{runId}/{file}`).
 */
export interface DirectorRunCtx {
  project: Project;
  shot: Shot;
  runId: string;
  scratch: DirectingSettings;
  scratchImageEdited: boolean;
  appendEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  addSpend(usd: number): Promise<void>;
  addProposal(p: Record<string, unknown>): Promise<void>;
  setCandidate(result: GenerateShotClipResult): Promise<void>;
  candidateKey(file: string): string;
}

/** Result of a single tool execution — never throws; ok:false carries the refusal/validation message. */
export interface DirectorToolResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface DirectorTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  /**
   * Cost estimate in USD for a prospective call, used by the loop's
   * budget gate before execute() runs. Most tools are free and ignore
   * both params. generate_candidate_clip's estimate depends on the
   * run's current scratch (model/duration), so it accepts the ctx as an
   * optional second argument — callers that only have `input` (e.g. this
   * file's own tests) may omit it and still get a valid (default-model)
   * estimate.
   */
  estCostUsd(input: Record<string, unknown>, ctx?: DirectorRunCtx): number;
  /**
   * True if the tool only records a proposal for user approval (e.g., propose_entity_update).
   * Tools marked with this flag never write to real shared state — they only read and call
   * ctx.addProposal to stage the change for later human review.
   */
  sharedStateEdit?: boolean;
  execute(ctx: DirectorRunCtx, input: Record<string, unknown>): Promise<DirectorToolResult>;
}

/**
 * Shared success-path helper: every tool except record_critique appends
 * the same `action` event shape on success, so this is the one place that
 * knows the payload layout instead of 12 duplicated appendEvent calls.
 * `data`, when given, is echoed back on the result (e.g. create_entity's
 * new id) so the model can reference it in a later tool call this turn.
 */
async function recordAction(
  ctx: DirectorRunCtx,
  tool: string,
  input: Record<string, unknown>,
  message: string,
  data?: Record<string, unknown>,
): Promise<DirectorToolResult> {
  await ctx.appendEvent("action", { tool, input, message });
  return data ? { ok: true, message, data } : { ok: true, message };
}

const CAMERA_MOVE_IDS = CAMERA_MOVES.map((m) => m.id);
const CLIP_MODEL_IDS = CLIP_MODELS.map((m) => m.id);
const ENTITY_TYPE_IDS = entityTypeEnum.enumValues;
const ENTITY_NAME_MAX_CHARS = 80;
const ENTITY_DESCRIPTION_MAX_CHARS = 500;
const PROPOSAL_RATIONALE_MAX_CHARS = 300;
const MAX_TAGGED_ENTITIES = 8;

/** Resolves the scratch's clip model spec, falling back to the app default — mirrors renderDirectedClip's own fallback. */
function scratchModelSpec(scratch: Pick<DirectingSettings, "clipModel">) {
  return getClipModel(scratch.clipModel) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
}

/**
 * Shared instruction validator for the Kontext tools below — checked
 * BEFORE any fal call (and unit-testable without network) so a too-long
 * or empty instruction never spends the run's budget.
 */
function validateKontextInstruction(input: Record<string, unknown>): string | null {
  const instruction = input.instruction;
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    return "instruction must be a non-empty string.";
  }
  if (instruction.length > FRAME_EDIT_INSTRUCTION_MAX_CHARS) {
    return `instruction must be ${FRAME_EDIT_INSTRUCTION_MAX_CHARS} characters or fewer.`;
  }
  return null;
}

export const DIRECTOR_TOOLS: DirectorTool[] = [
  {
    name: "set_camera_move",
    description:
      'Sets the shot\'s camera move and strength (subtle/medium/strong). Pass move: "none" to clear both fields back to unset. Free — no cost.',
    inputSchema: {
      type: "object",
      properties: {
        move: { type: "string", enum: ["none", ...CAMERA_MOVE_IDS] },
        strength: { type: "string", enum: ["subtle", "medium", "strong"] },
      },
      required: ["move"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const move = input.move;
      if (move === "none") {
        ctx.scratch.cameraMove = null;
        ctx.scratch.cameraStrength = null;
        return recordAction(ctx, "set_camera_move", input, "Camera move cleared.");
      }
      if (!isCameraMove(move)) {
        return { ok: false, message: `Invalid camera move: ${JSON.stringify(move)}.` };
      }
      let strength: CameraStrength = "medium";
      if (input.strength !== undefined) {
        if (!isCameraStrength(input.strength)) {
          return { ok: false, message: `Invalid camera strength: ${JSON.stringify(input.strength)}.` };
        }
        strength = input.strength;
      }
      ctx.scratch.cameraMove = move;
      ctx.scratch.cameraStrength = strength;
      return recordAction(ctx, "set_camera_move", input, `Camera move set to ${move} (${strength}).`);
    },
  },
  {
    name: "set_ends_on",
    description:
      'Sets how the clip ends: "free" (no chaining), "next" (chains to the next shot\'s still), or "custom" (chains to this shot\'s authored end frame — only allowed once one exists). Free — no cost.',
    inputSchema: {
      type: "object",
      properties: {
        endsOn: { type: "string", enum: ["free", "next", "custom"] },
      },
      required: ["endsOn"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const endsOn = input.endsOn;
      if (endsOn !== "free" && endsOn !== "next" && endsOn !== "custom") {
        return { ok: false, message: `Invalid endsOn value: ${JSON.stringify(endsOn)}.` };
      }
      if (endsOn === "custom" && !ctx.scratch.endFramePath) {
        return {
          ok: false,
          message: "Cannot set ends-on to custom: no end frame exists yet on this shot.",
        };
      }
      ctx.scratch.endsOn = endsOn;
      return recordAction(ctx, "set_ends_on", input, `Ends-on set to ${endsOn}.`);
    },
  },
  {
    name: "set_negative_prompt",
    description:
      "Sets (or clears, with null) the negative prompt describing what the clip should avoid showing. Max 500 characters. Free — no cost.",
    inputSchema: {
      type: "object",
      properties: {
        negativePrompt: { type: ["string", "null"], maxLength: 500 },
      },
      required: ["negativePrompt"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const value = input.negativePrompt;
      if (value !== null && typeof value !== "string") {
        return { ok: false, message: "negativePrompt must be a string or null." };
      }
      if (typeof value === "string" && value.length > 500) {
        return { ok: false, message: "negativePrompt must be 500 characters or fewer." };
      }
      const trimmed = typeof value === "string" ? value.trim() : value;
      ctx.scratch.negativePrompt = trimmed === "" ? null : trimmed;
      return recordAction(
        ctx,
        "set_negative_prompt",
        input,
        ctx.scratch.negativePrompt ? "Negative prompt updated." : "Negative prompt cleared.",
      );
    },
  },
  {
    name: "set_clip_duration",
    description:
      "Sets (or clears, with null) the clip's target duration in whole seconds. Must be one of the current clip model's supported durations. Free — no cost.",
    inputSchema: {
      type: "object",
      properties: {
        durationSeconds: { type: ["integer", "null"], minimum: 1, maximum: 15 },
      },
      required: ["durationSeconds"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const value = input.durationSeconds;
      if (value === null) {
        ctx.scratch.clipDurationChoice = null;
        return recordAction(ctx, "set_clip_duration", input, "Clip duration cleared (model default).");
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 15) {
        return { ok: false, message: "durationSeconds must be an integer from 1 to 15, or null." };
      }
      const spec = scratchModelSpec(ctx.scratch);
      if (!spec.durations.includes(value)) {
        return {
          ok: false,
          message: `${spec.label} only supports these durations (seconds): ${spec.durations.join(", ")}.`,
        };
      }
      ctx.scratch.clipDurationChoice = value;
      return recordAction(ctx, "set_clip_duration", input, `Clip duration set to ${value}s.`);
    },
  },
  {
    name: "set_clip_model",
    description: `Sets the clip generation model. Options: ${CLIP_MODELS.map((m) => `${m.id} — ${m.whenToUse}`).join(" | ")}`,
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: CLIP_MODEL_IDS },
      },
      required: ["model"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const model = input.model;
      if (!isClipModelId(model)) {
        return { ok: false, message: `Invalid clip model: ${JSON.stringify(model)}.` };
      }
      ctx.scratch.clipModel = model;
      return recordAction(ctx, "set_clip_model", input, `Clip model set to ${model}.`);
    },
  },
  {
    name: "set_use_entity_refs",
    description:
      "Toggles whether tagged cast/location reference sheets are sent to the clip model (when it supports references). Free — no cost.",
    inputSchema: {
      type: "object",
      properties: {
        useEntityRefs: { type: "boolean" },
      },
      required: ["useEntityRefs"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const value = input.useEntityRefs;
      if (typeof value !== "boolean") {
        return { ok: false, message: "useEntityRefs must be a boolean." };
      }
      ctx.scratch.useEntityRefs = value;
      return recordAction(ctx, "set_use_entity_refs", input, `Entity references ${value ? "enabled" : "disabled"}.`);
    },
  },
  {
    name: "generate_candidate_clip",
    description:
      "Renders a candidate clip from the current scratch settings (image, prompt, camera, ends-on, model, duration, refs) through the real clip pathway. Paid — costs real money per the current model/duration.",
    inputSchema: { type: "object", properties: {} },
    estCostUsd: (_input, ctx) => {
      const scratch = ctx?.scratch;
      const spec = scratch ? scratchModelSpec(scratch) : getClipModel(DEFAULT_CLIP_MODEL_ID)!;
      const duration = resolveClipDuration(spec, scratch?.slotSeconds ?? null, scratch?.clipDurationChoice ?? null);
      return estClipUsd(spec, duration);
    },
    execute: async (ctx, input) => {
      try {
        const result = await renderDirectedClip(ctx.project, ctx.shot.id, ctx.scratch, ctx.candidateKey("candidate.mp4"));
        await ctx.setCandidate(result);
        return recordAction(
          ctx,
          "generate_candidate_clip",
          input,
          `Candidate clip rendered: ${result.clipDurationSeconds}s on ${result.clipModel}.`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Candidate clip generation failed: ${detail}` };
      }
    },
  },
  {
    name: "edit_start_image",
    description:
      "Edits the run's scratch start image in place via FLUX Kontext, following a natural-language instruction (max 500 characters). Paid — costs about $0.04 per call.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", maxLength: FRAME_EDIT_INSTRUCTION_MAX_CHARS },
      },
      required: ["instruction"],
    },
    estCostUsd: () => 0.04,
    execute: async (ctx, input) => {
      const validationError = validateKontextInstruction(input);
      if (validationError) return { ok: false, message: validationError };
      const instruction = input.instruction as string;
      try {
        const outputKey = ctx.candidateKey("scratch-image.png");
        await runKontextEditToKey(ctx.scratch.imagePath, instruction, outputKey);
        ctx.scratch.imagePath = outputKey;
        ctx.scratchImageEdited = true;
        return recordAction(ctx, "edit_start_image", input, "Start image edited.");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Start image edit failed: ${detail}` };
      }
    },
  },
  {
    name: "create_custom_end_frame",
    description:
      "Authors a custom end frame from the run's scratch start image via FLUX Kontext, following a natural-language instruction (max 500 characters). Paid — costs about $0.04 per call.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", maxLength: FRAME_EDIT_INSTRUCTION_MAX_CHARS },
      },
      required: ["instruction"],
    },
    estCostUsd: () => 0.04,
    execute: async (ctx, input) => {
      const validationError = validateKontextInstruction(input);
      if (validationError) return { ok: false, message: validationError };
      const instruction = input.instruction as string;
      try {
        const outputKey = ctx.candidateKey("end-frame.png");
        await runKontextEditToKey(ctx.scratch.imagePath, instruction, outputKey);
        ctx.scratch.endFramePath = outputKey;
        ctx.scratch.endFrameStatus = "done";
        return recordAction(ctx, "create_custom_end_frame", input, "Custom end frame created.");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `End frame creation failed: ${detail}` };
      }
    },
  },
  {
    name: "create_entity",
    description:
      "Creates a new cast/location/object entity in this project's Reference Bible (mirrors the entities creation route's name/type/description checks). Free — no cost. Returns the new entity's id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: ENTITY_NAME_MAX_CHARS },
        type: { type: "string", enum: [...ENTITY_TYPE_IDS] },
        description: { type: "string", maxLength: ENTITY_DESCRIPTION_MAX_CHARS },
      },
      required: ["name", "type"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const nameRaw = input.name;
      if (typeof nameRaw !== "string") {
        return { ok: false, message: "name must be a string." };
      }
      const name = nameRaw.trim();
      if (name.length === 0) {
        return { ok: false, message: "name is required." };
      }
      if (name.length > ENTITY_NAME_MAX_CHARS) {
        return { ok: false, message: `name must be ${ENTITY_NAME_MAX_CHARS} characters or fewer.` };
      }

      const type = input.type;
      if (typeof type !== "string" || !(ENTITY_TYPE_IDS as readonly string[]).includes(type)) {
        return { ok: false, message: `type must be one of ${ENTITY_TYPE_IDS.join(", ")}.` };
      }

      let description: string | null = null;
      if (input.description !== undefined) {
        if (typeof input.description !== "string") {
          return { ok: false, message: "description must be a string." };
        }
        const trimmed = input.description.trim();
        if (trimmed.length > ENTITY_DESCRIPTION_MAX_CHARS) {
          return {
            ok: false,
            message: `description must be ${ENTITY_DESCRIPTION_MAX_CHARS} characters or fewer.`,
          };
        }
        description = trimmed.length > 0 ? trimmed : null;
      }

      const existing = await db
        .select({ name: entities.name })
        .from(entities)
        .where(eq(entities.projectId, ctx.project.id));
      const nameTaken = existing.some((e) => e.name.trim().toLowerCase() === name.toLowerCase());
      if (nameTaken) {
        return { ok: false, message: "An entity with this name already exists." };
      }

      const [created] = await db
        .insert(entities)
        .values({
          projectId: ctx.project.id,
          name,
          type: type as (typeof ENTITY_TYPE_IDS)[number],
          description,
        })
        .returning();

      return recordAction(ctx, "create_entity", input, `Entity "${name}" created.`, {
        entityId: created.id,
      });
    },
  },
  {
    name: "generate_entity_sheet",
    description:
      "Generates a multi-view reference sheet image for an entity in this project via FLUX Kontext. Paid — costs about $0.04 per call.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
      },
      required: ["entityId"],
    },
    estCostUsd: () => 0.04,
    execute: async (ctx, input) => {
      const entityId = input.entityId;
      if (typeof entityId !== "string" || !isValidUUID(entityId)) {
        return { ok: false, message: "entityId must be a valid UUID." };
      }
      const [entity] = await db
        .select()
        .from(entities)
        .where(and(eq(entities.id, entityId), eq(entities.projectId, ctx.project.id)))
        .limit(1);
      if (!entity) {
        return { ok: false, message: "Entity not found in this project." };
      }
      try {
        const updated = await generateEntitySheet(ctx.project, entity);
        return recordAction(
          ctx,
          "generate_entity_sheet",
          input,
          `Reference sheet generated for "${entity.name}".`,
          { entityId: updated.id, referenceSheetPath: updated.referenceSheetPath },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Reference sheet generation failed: ${detail}` };
      }
    },
  },
  {
    name: "tag_entity",
    description:
      "Tags an entity onto this shot (adds its id to shots.referencedEntityIds, capped at 8, mirroring the shot PATCH route). Free — no cost. Writes the real shot row.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
      },
      required: ["entityId"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const entityId = input.entityId;
      if (typeof entityId !== "string" || !isValidUUID(entityId)) {
        return { ok: false, message: "entityId must be a valid UUID." };
      }
      const [entity] = await db
        .select({ id: entities.id, name: entities.name })
        .from(entities)
        .where(and(eq(entities.id, entityId), eq(entities.projectId, ctx.project.id)))
        .limit(1);
      if (!entity) {
        return { ok: false, message: "Entity not found in this project." };
      }
      const current = ctx.scratch.referencedEntityIds ?? [];
      if (current.includes(entityId)) {
        return { ok: false, message: "Entity is already tagged on this shot." };
      }
      if (current.length >= MAX_TAGGED_ENTITIES) {
        return {
          ok: false,
          message: `referencedEntityIds must be an array of at most ${MAX_TAGGED_ENTITIES} UUIDs.`,
        };
      }
      const updatedIds = [...current, entityId];
      await db.update(shots).set({ referencedEntityIds: updatedIds }).where(eq(shots.id, ctx.shot.id));
      ctx.scratch.referencedEntityIds = updatedIds;
      return recordAction(ctx, "tag_entity", input, `Tagged "${entity.name}" on this shot.`);
    },
  },
  {
    name: "untag_entity",
    description:
      "Untags an entity from this shot (removes its id from shots.referencedEntityIds, mirroring the shot PATCH route). Free — no cost. Writes the real shot row.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
      },
      required: ["entityId"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const entityId = input.entityId;
      if (typeof entityId !== "string" || !isValidUUID(entityId)) {
        return { ok: false, message: "entityId must be a valid UUID." };
      }
      const current = ctx.scratch.referencedEntityIds ?? [];
      if (!current.includes(entityId)) {
        return { ok: false, message: "Entity is not tagged on this shot." };
      }
      const updatedIds = current.filter((id) => id !== entityId);
      await db.update(shots).set({ referencedEntityIds: updatedIds }).where(eq(shots.id, ctx.shot.id));
      ctx.scratch.referencedEntityIds = updatedIds;
      return recordAction(ctx, "untag_entity", input, "Entity untagged from this shot.");
    },
  },
  {
    name: "propose_entity_update",
    description:
      "Proposes a change to an entity's description for human review — never writes to the entity directly, only records a proposal. Free — no cost.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        field: { type: "string", enum: ["description"] },
        newValue: { type: "string", maxLength: ENTITY_DESCRIPTION_MAX_CHARS },
        rationale: { type: "string", maxLength: PROPOSAL_RATIONALE_MAX_CHARS },
      },
      required: ["entityId", "field", "newValue", "rationale"],
    },
    estCostUsd: () => 0,
    sharedStateEdit: true,
    execute: async (ctx, input) => {
      const entityId = input.entityId;
      if (typeof entityId !== "string" || !isValidUUID(entityId)) {
        return { ok: false, message: "entityId must be a valid UUID." };
      }
      const field = input.field;
      if (field !== "description") {
        return { ok: false, message: `Invalid field: ${JSON.stringify(field)}.` };
      }
      const newValue = input.newValue;
      if (typeof newValue !== "string") {
        return { ok: false, message: "newValue must be a string." };
      }
      if (newValue.length > ENTITY_DESCRIPTION_MAX_CHARS) {
        return {
          ok: false,
          message: `newValue must be ${ENTITY_DESCRIPTION_MAX_CHARS} characters or fewer.`,
        };
      }
      const rationale = input.rationale;
      if (typeof rationale !== "string" || rationale.trim().length === 0) {
        return { ok: false, message: "rationale is required." };
      }
      if (rationale.length > PROPOSAL_RATIONALE_MAX_CHARS) {
        return {
          ok: false,
          message: `rationale must be ${PROPOSAL_RATIONALE_MAX_CHARS} characters or fewer.`,
        };
      }

      const [entity] = await db
        .select({ id: entities.id, name: entities.name, description: entities.description })
        .from(entities)
        .where(and(eq(entities.id, entityId), eq(entities.projectId, ctx.project.id)))
        .limit(1);
      if (!entity) {
        return { ok: false, message: "Entity not found in this project." };
      }

      await ctx.addProposal({
        entityId: entity.id,
        entityName: entity.name,
        field,
        from: entity.description,
        to: newValue,
        rationale,
      });
      return { ok: true, message: `Proposed updating "${entity.name}"'s ${field}.` };
    },
  },
  {
    name: "record_critique",
    description:
      "Records a structured self-critique (per-dimension pass/fail notes plus a summary) for the current candidate. Free — no cost; interpreted by the loop, not enforced here.",
    inputSchema: {
      type: "object",
      properties: {
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              pass: { type: "boolean" },
              note: { type: "string" },
            },
            required: ["name", "pass"],
          },
        },
        summary: { type: "string" },
      },
      required: ["dimensions", "summary"],
    },
    estCostUsd: () => 0,
    // Security (final-review C1): `frameKeys` is NEVER taken from the
    // model's input — it names R2 objects, and this tool's input is
    // model-controlled (a steered model could name another run/user's
    // keys, which the director GET route would then presign into
    // downloadable URLs). The loop's assess step (direct-shot.ts) is the
    // only place that ever attaches real frameKeys, and it does so by
    // appending the critique event directly rather than by going through
    // this execute() — so any `frameKeys` that DOES arrive here came from
    // the model and must be dropped before persisting.
    execute: async (ctx, input) => {
      const safeInput = { ...input };
      delete safeInput.frameKeys;
      await ctx.appendEvent("critique", safeInput);
      return { ok: true, message: "Critique recorded." };
    },
  },
  {
    name: "finish",
    description:
      'Ends the run with a verdict and quality label ("pass" or "best_effort"). Free — no cost; interpreted by the loop, not enforced here.',
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string" },
        quality: { type: "string", enum: ["pass", "best_effort"] },
      },
      required: ["verdict", "quality"],
    },
    estCostUsd: () => 0,
    execute: async (ctx, input) => {
      const quality = input.quality;
      if (quality !== "pass" && quality !== "best_effort") {
        return { ok: false, message: `Invalid quality: ${JSON.stringify(quality)}.` };
      }
      return recordAction(ctx, "finish", input, `Finish requested (${quality}).`);
    },
  },
];

export function getDirectorTool(name: string): DirectorTool | null {
  return DIRECTOR_TOOLS.find((t) => t.name === name) ?? null;
}

/** Maps the registry to the shape the Anthropic SDK's `tools` param expects. */
export function toAnthropicTools(): Anthropic.Tool[] {
  return DIRECTOR_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** Renders the registry as "- name: description" lines for the system prompt's capability inventory. */
export function capabilityInventory(): string {
  return DIRECTOR_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}
