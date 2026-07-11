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
 * Stage 1 (this task): scratch setting tools (camera, ends-on, negative
 * prompt, duration, model, entity-refs toggle), generate_candidate_clip
 * (the only paid tool here), and the two loop-interpreted no-ops
 * record_critique / finish. Stage 2 tools (Kontext image edits, entity
 * tag/create) land in later tasks by pushing more entries into
 * DIRECTOR_TOOLS — this file's shape does not change.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Project, Shot } from "@/lib/db/schema";
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
  /** True for tools that mutate real, shared state outside the run's scratch (entity tag/create — Stage 2). */
  sharedStateEdit?: boolean;
  execute(ctx: DirectorRunCtx, input: Record<string, unknown>): Promise<DirectorToolResult>;
}

/**
 * Shared success-path helper: every tool except record_critique appends
 * the same `action` event shape on success, so this is the one place that
 * knows the payload layout instead of 12 duplicated appendEvent calls.
 */
async function recordAction(
  ctx: DirectorRunCtx,
  tool: string,
  input: Record<string, unknown>,
  message: string,
): Promise<DirectorToolResult> {
  await ctx.appendEvent("action", { tool, input, message });
  return { ok: true, message };
}

const CAMERA_MOVE_IDS = CAMERA_MOVES.map((m) => m.id);
const CLIP_MODEL_IDS = CLIP_MODELS.map((m) => m.id);

/** Resolves the scratch's clip model spec, falling back to the app default — mirrors renderDirectedClip's own fallback. */
function scratchModelSpec(scratch: Pick<DirectingSettings, "clipModel">) {
  return getClipModel(scratch.clipModel) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
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
    execute: async (ctx, input) => {
      await ctx.appendEvent("critique", input);
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
