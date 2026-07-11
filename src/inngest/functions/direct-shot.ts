/**
 * Inngest function: the AI Assistant Director's agent loop (spec §Loop,
 * task 7 — the feature's heart). Consumes `shot/director.run` (sent by the
 * start route once a director_runs row exists) and iterates on a single
 * shot's clip within its budget: up to 5 rounds of self-critique (a forced
 * `record_critique` tool call against the current candidate/settings) then
 * action (a bounded, model-driven tool-use conversation over the full
 * DIRECTOR_TOOLS registry — free setting changes, a paid re-render, or
 * `finish`). A round that critiques a passing candidate ends the run
 * immediately; otherwise action always runs, because a passing critique
 * with no candidate yet still needs one generated (the system prompt tells
 * the model this explicitly — see SYSTEM_PROMPT below).
 *
 * Inngest step discipline: every Claude call and every DB/R2 side effect
 * that must survive a replay lives inside a `step.run` with a deterministic
 * id (`assess-N`, `act-N`, `frames-N`, `finalize`/`fail`). Mutable
 * loop state (the working `scratch` DirectingSettings and
 * `scratchImageEdited`) is threaded through as plain variables reassigned
 * from each step's *return value* — never mutated by a closure a memoized
 * step won't re-run. Reads that must be fresh on every iteration (the stop
 * flag, spentUsd for a budget gate) are deliberately plain `await`s
 * OUTSIDE any step, so a replay always sees current DB state, per the spec.
 *
 * Budget: every paid execute is gated by `assertWithinBudget` against a
 * freshly re-read run row immediately before the call — tool registry
 * execute()s never call addRunSpend/addProposal themselves for
 * generate_candidate_clip (see director-tools.ts), so the loop is the one
 * place that meters both Claude token usage AND estimated tool cost.
 *
 * Errors: a validation failure or budget refusal becomes both a
 * `director_events` "error" row and the tool_result Claude sees, and the
 * loop keeps going. Anything that escapes a step (Anthropic API failure
 * surviving Inngest's own step retry, an unexpected DB error, etc.) is
 * caught once at the top level — status -> "failed", one "error" event,
 * spend already persisted incrementally is left as-is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { inngest } from "../client";
import { db } from "@/lib/db";
import { directorRuns, projects, shots, beats, entities, type Project, type Shot, type DirectorRun } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import {
  getDirectorTool,
  toAnthropicTools,
  capabilityInventory,
  type DirectorRunCtx,
} from "@/lib/director/director-tools";
import { usageCostUsd, assertWithinBudget } from "@/lib/director/director-budget";
import { buildBriefingText, gatherBriefingImages, type BriefingImage, type DirectorBriefingData } from "@/lib/director/director-context";
import { sampleVideoFrames } from "@/lib/director/frame-sampler";
import { settingsFromShot, loadOrderedProjectShots, type DirectingSettings } from "@/lib/shot-clip-generation";
import { appendRunEvent, addRunSpend, addRunProposal, setRunCandidate, getRunById } from "@/lib/director/director-run";

const MAX_ITERATIONS = 5;
const MAX_ACT_TURNS = 8;
const CLAUDE_MODEL = "claude-sonnet-5";

/** Only the record_critique tool's Anthropic-shaped definition, reused from the registry so the schema never drifts. */
const RECORD_CRITIQUE_TOOLS = toAnthropicTools().filter((t) => t.name === "record_critique");

const SYSTEM_PROMPT = `You are the AI Assistant Director: an autonomous agent that iterates on ONE shot's clip until it's good, then hands it to a human for final approval.

## Quality dimensions
Judge every candidate (or, before one exists, the current settings) against:
1. Subject action matches the voiceover for this beat.
2. Continuity with the neighboring shots (framing, subject, motion direction).
3. Cast stays on-model (consistent with any tagged reference sheets).
4. Camera move and pacing suit the beat.
5. No visual artifacts — deformities, morphing, flicker, warped hands/faces.

## Budget discipline
Prefer free setting changes (camera, ends-on, negative prompt, duration, model, entity refs) over spending money. Only call generate_candidate_clip when your critique demands a fresh render — a change that would actually alter the result. If you are at or near the budget, stop experimenting and call finish with quality "best_effort" rather than let a render be refused.

## Finishing
You may only call finish with quality "pass" once a candidate clip actually exists AND every quality dimension passes. A passing critique with no candidate yet is not done — generate one before finishing. If you are out of iterations, out of budget, or genuinely stuck, call finish with quality "best_effort" and explain why in the verdict.

## Your capabilities
${capabilityInventory()}

## Guidance
If the user supplied guidance for this run, it ALWAYS overrides your own taste — treat it as an instruction, not a suggestion.`;

/** Builds the run-scoped tool ctx. `scratch` is mutated in place by tool execute()s — callers read it back after the step completes. */
function buildDirectorCtx(
  project: Project,
  shot: Shot,
  runId: string,
  scratch: DirectingSettings,
  scratchImageEdited: boolean,
): DirectorRunCtx {
  return {
    project,
    shot,
    runId,
    scratch,
    scratchImageEdited,
    appendEvent: (type, payload) => appendRunEvent(runId, type, payload),
    addSpend: (usd) => addRunSpend(runId, usd),
    addProposal: (p) => addRunProposal(runId, p),
    setCandidate: (result) =>
      setRunCandidate(runId, {
        clipPath: result.clipPath,
        clipDurationSeconds: result.clipDurationSeconds,
        clipModel: result.clipModel,
      }),
    candidateKey: (file) => `projects/${project.id}/shots/${shot.id}/director/${runId}/${file}`,
  };
}

/** Records one Claude usage block as spend + a "cost" event; returns the new running total (or the unchanged prior total when the usage was free). */
async function meterUsage(runId: string, usage: Anthropic.Usage, priorSpentUsd: number): Promise<number> {
  const cost = usageCostUsd(usage);
  if (cost <= 0) return priorSpentUsd;
  const runningTotal = priorSpentUsd + cost;
  await addRunSpend(runId, cost);
  await appendRunEvent(runId, "cost", { usd: cost, runningTotal });
  return runningTotal;
}

/** Wraps briefing text + image blocks into the single user message content array both assess and act send. */
function toUserContent(text: string, images: BriefingImage[]): Anthropic.MessageParam["content"] {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text }];
  for (const img of images) {
    content.push({ type: "text", text: img.label });
    content.push(img.block);
  }
  return content;
}

/**
 * Gathers this iteration's full briefing (text + images) — the one place
 * that assembles DirectorBriefingData from the DB, shared by assess and
 * act so both see identical context.
 */
async function loadBriefing(
  project: Project,
  shot: Shot,
  run: DirectorRun,
  scratch: DirectingSettings,
): Promise<{ text: string; images: BriefingImage[] }> {
  const ordered = await loadOrderedProjectShots(project.id);
  const currentIndex = ordered.findIndex((s) => s.id === shot.id);
  const prevShot = currentIndex > 0 ? ordered[currentIndex - 1] : undefined;
  const nextShot = currentIndex >= 0 ? ordered[currentIndex + 1] : undefined;

  const beatText = shot.beatId
    ? ((await db.select({ text: beats.text }).from(beats).where(eq(beats.id, shot.beatId)).limit(1))[0]?.text ??
      "(no beat text)")
    : "(no beat text)";

  const entityRows = await db
    .select({ id: entities.id, name: entities.name, type: entities.type, referenceStatus: entities.referenceStatus })
    .from(entities)
    .where(eq(entities.projectId, project.id));
  const taggedIds = new Set(shot.referencedEntityIds ?? []);

  const data: DirectorBriefingData = {
    projectBrief: project.brief,
    styleString: project.styleString,
    script: project.script,
    beatText,
    shot: { imagePrompt: shot.imagePrompt, motionPrompt: shot.motionPrompt },
    scratch,
    neighbors: {
      prev: prevShot ? { imagePrompt: prevShot.imagePrompt, endsOn: prevShot.endsOn } : undefined,
      next: nextShot ? { imagePrompt: nextShot.imagePrompt, endsOn: nextShot.endsOn } : undefined,
    },
    entities: entityRows.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      sheetReady: e.referenceStatus === "done",
      taggedHere: taggedIds.has(e.id),
    })),
    budgetUsd: run.budgetUsd,
    spentUsd: run.spentUsd,
    guidance: run.guidance,
  };

  const images = await gatherBriefingImages(project, shot, run, scratch);
  return { text: buildBriefingText(data), images };
}

interface AssessResult {
  dimensions: Array<{ name: string; pass: boolean; note?: string }>;
  summary: string;
  allPass: boolean;
  hasCandidate: boolean;
}

/**
 * One forced self-critique call: builds the briefing, forces
 * record_critique, meters usage, records the critique event (enriched with
 * presigned 0%/100% candidate-frame URLs when a candidate already exists),
 * and reports whether every dimension passed.
 */
async function runAssessStep(
  anthropic: Anthropic,
  project: Project,
  shot: Shot,
  runId: string,
  scratch: DirectingSettings,
): Promise<AssessResult> {
  const run = await getRunById(runId);
  if (!run) throw new Error(`Director run ${runId} disappeared mid-flight.`);

  const briefing = await loadBriefing(project, shot, run, scratch);
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: RECORD_CRITIQUE_TOOLS,
    tool_choice: { type: "tool", name: "record_critique" },
    messages: [{ role: "user", content: toUserContent(briefing.text, briefing.images) }],
  });
  await meterUsage(runId, response.usage, run.spentUsd);

  const hasCandidate = !!run.clipCandidatePath;
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_critique",
  );
  if (!toolUse) {
    await appendRunEvent(runId, "error", { step: "assess", message: "Claude returned no critique." });
    return { dimensions: [], summary: "No critique returned.", allPass: false, hasCandidate };
  }

  const rawInput = toolUse.input as { dimensions?: unknown; summary?: unknown };
  // Forced tool_choice makes a well-shaped response the overwhelming common
  // case, but Claude output is never guaranteed — fall back to "nothing
  // passed" rather than let a malformed dimensions/summary crash the run.
  const dimensions: AssessResult["dimensions"] = Array.isArray(rawInput.dimensions)
    ? (rawInput.dimensions as AssessResult["dimensions"])
    : [];
  const summary = typeof rawInput.summary === "string" ? rawInput.summary : "";

  const enrichedInput: Record<string, unknown> = { dimensions, summary };
  if (hasCandidate) {
    const candidateKey = (file: string) => `projects/${project.id}/shots/${shot.id}/director/${runId}/${file}`;
    enrichedInput.candidateFrames = {
      start: await getDownloadUrl(candidateKey("frame-0.png")),
      end: await getDownloadUrl(candidateKey("frame-3.png")),
    };
  }
  await getDirectorTool("record_critique")!.execute(
    buildDirectorCtx(project, shot, runId, scratch, false),
    enrichedInput,
  );

  const allPass = dimensions.length > 0 && dimensions.every((d) => d.pass === true);
  return { dimensions, summary, allPass, hasCandidate };
}

interface ToolCallOutcome {
  toolResult: Anthropic.ToolResultBlockParam;
  spentUsd: number;
  finishCalled: { verdict: string; quality: "pass" | "best_effort" } | null;
  actedThisIteration: boolean;
  candidateGenerated: boolean;
}

/** Runs a single tool_use block: budget-check (paid tools only) -> execute -> event + tool_result. Never throws. */
async function runOneToolCall(
  ctx: DirectorRunCtx,
  runId: string,
  block: Anthropic.ToolUseBlock,
  spentUsd: number,
): Promise<ToolCallOutcome> {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const empty: ToolCallOutcome = {
    toolResult: { type: "tool_result", tool_use_id: block.id, content: "" },
    spentUsd,
    finishCalled: null,
    actedThisIteration: false,
    candidateGenerated: false,
  };

  const tool = getDirectorTool(block.name);
  if (!tool) {
    return {
      ...empty,
      toolResult: { type: "tool_result", tool_use_id: block.id, content: `Unknown tool "${block.name}".`, is_error: true },
    };
  }

  const est = tool.estCostUsd(input, ctx);
  if (est > 0) {
    const freshRun = await getRunById(runId);
    const check = assertWithinBudget(freshRun?.spentUsd ?? spentUsd, freshRun?.budgetUsd ?? 0, est);
    if (!check.ok) {
      await ctx.appendEvent("error", { tool: tool.name, input, message: check.refusal });
      return {
        ...empty,
        toolResult: {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ ok: false, refusal: check.refusal }),
          is_error: true,
        },
      };
    }
  }

  const result = await tool.execute(ctx, input);
  const toolResult: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: block.id,
    content: JSON.stringify(result),
    is_error: !result.ok,
  };

  if (!result.ok) {
    await ctx.appendEvent("error", { tool: tool.name, input, message: result.message });
    return { ...empty, toolResult };
  }

  let newSpent = spentUsd;
  if (est > 0) {
    newSpent = spentUsd + est;
    await ctx.addSpend(est);
    await ctx.appendEvent("cost", { usd: est, runningTotal: newSpent });
  }

  if (tool.name === "finish") {
    const quality = input.quality === "best_effort" ? "best_effort" : "pass";
    return { ...empty, toolResult, spentUsd: newSpent, finishCalled: { verdict: String(input.verdict ?? ""), quality } };
  }

  const acted = tool.name !== "record_critique";
  return {
    ...empty,
    toolResult,
    spentUsd: newSpent,
    actedThisIteration: acted,
    candidateGenerated: acted && tool.name === "generate_candidate_clip",
  };
}

interface ActStepResult {
  scratch: DirectingSettings;
  scratchImageEdited: boolean;
  finishCalled: { verdict: string; quality: "pass" | "best_effort" } | null;
  actedThisIteration: boolean;
  candidateGenerated: boolean;
}

/**
 * The bounded (<=8 assistant turns) tool-use conversation: model sees the
 * fresh briefing + this iteration's critique, then freely calls any
 * DIRECTOR_TOOLS entry until it stops calling tools or calls finish.
 */
async function runActStep(
  anthropic: Anthropic,
  project: Project,
  shot: Shot,
  runId: string,
  scratchIn: DirectingSettings,
  scratchImageEditedIn: boolean,
  critique: AssessResult,
): Promise<ActStepResult> {
  const startRun = await getRunById(runId);
  if (!startRun) throw new Error(`Director run ${runId} disappeared mid-flight.`);

  const ctx = buildDirectorCtx(project, shot, runId, { ...scratchIn }, scratchImageEditedIn);
  const briefing = await loadBriefing(project, shot, startRun, ctx.scratch);
  const intro = `${briefing.text}\n\n## Latest self-critique\n\n${JSON.stringify(critique)}\n\nAddress the critique using your tools, then call finish with a verdict.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: toUserContent(intro, briefing.images) }];
  let spentUsd = startRun.spentUsd;
  let actedThisIteration = false;
  let candidateGenerated = false;
  let finishCalled: ActStepResult["finishCalled"] = null;

  for (let turn = 0; turn < MAX_ACT_TURNS && !finishCalled; turn++) {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: toAnthropicTools(),
      messages,
    });
    spentUsd = await meterUsage(runId, response.usage, spentUsd);
    messages.push({ role: "assistant", content: response.content as unknown as Anthropic.ContentBlockParam[] });

    if (response.stop_reason !== "tool_use") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const outcome = await runOneToolCall(ctx, runId, block, spentUsd);
      spentUsd = outcome.spentUsd;
      toolResults.push(outcome.toolResult);
      if (outcome.finishCalled) finishCalled = outcome.finishCalled;
      if (outcome.actedThisIteration) actedThisIteration = true;
      if (outcome.candidateGenerated) candidateGenerated = true;
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    scratch: ctx.scratch,
    scratchImageEdited: ctx.scratchImageEdited,
    finishCalled,
    actedThisIteration,
    candidateGenerated,
  };
}

/**
 * Downloads the just-rendered candidate, samples 4 evenly spaced JPEG
 * frames, and persists ALL FOUR to the run's R2 prefix as frame-0..3.png
 * (JPEG bytes; ContentType image/jpeg regardless of the .png key —
 * gatherBriefingImages reads ContentType, not the extension). assess-N
 * probes all four; only 0%/100% are surfaced in the critique event.
 */
async function persistCandidateFrames(project: Project, shot: Shot, runId: string): Promise<void> {
  const run = await getRunById(runId);
  if (!run?.clipCandidatePath) return;

  const object = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: run.clipCandidatePath }),
  );
  const bytes = await object.Body!.transformToByteArray();
  const frames = await sampleVideoFrames(Buffer.from(bytes), 4);

  await Promise.all(
    frames.map((frame, i) =>
      r2Client.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: `projects/${project.id}/shots/${shot.id}/director/${runId}/frame-${i}.png`,
          Body: frame,
          ContentType: "image/jpeg",
        }),
      ),
    ),
  );
}

interface LoopOutcome {
  finishResult: { verdict: string; quality: "pass" | "best_effort" } | null;
  stuckNote: string | null;
  stopped: boolean;
}

/** Terminal write: settingsSnapshot (Task 13's promotionPlan reads exactly this shape) + status + verdict. */
async function finalizeRun(
  runId: string,
  scratch: DirectingSettings,
  scratchImageEdited: boolean,
  outcome: LoopOutcome,
): Promise<void> {
  const run = await getRunById(runId);
  const settingsSnapshot: Record<string, unknown> = {
    ...scratch,
    scratchImagePath: scratch.imagePath,
    scratchImageEdited,
  };

  let status: "awaiting_approval" | "stopped" = "awaiting_approval";
  let verdict: string;
  if (outcome.stopped || run?.stopRequested) {
    status = "stopped";
    verdict = "Stopped by user request.";
  } else if (outcome.finishResult) {
    verdict =
      outcome.finishResult.quality === "best_effort"
        ? `[best effort] ${outcome.finishResult.verdict}`
        : outcome.finishResult.verdict;
  } else if (outcome.stuckNote) {
    verdict = outcome.stuckNote;
  } else {
    verdict = `Budget exhausted — best effort within $${(run?.budgetUsd ?? 0).toFixed(2)}.`;
  }

  await db.update(directorRuns).set({ status, verdict, settingsSnapshot }).where(eq(directorRuns.id, runId));
}

/** Unrecoverable-error terminal write: one "error" event + status "failed". Spend already persisted incrementally is left as-is. */
async function failRun(runId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await appendRunEvent(runId, "error", { message });
  await db
    .update(directorRuns)
    .set({ status: "failed", verdict: `Run failed: ${message}` })
    .where(eq(directorRuns.id, runId));
}

export const directShotFn = inngest.createFunction(
  {
    id: "direct-shot",
    retries: 1,
    concurrency: [{ scope: "fn", key: "event.data.shotId", limit: 1 }],
  },
  { event: "shot/director.run" },
  async ({ event, step }) => {
    const { runId, projectId, shotId } = event.data as { runId: string; projectId: string; shotId: string };

    // Memoized gate only — the run's status check is the one thing that
    // must not silently re-run on replay. The project/shot rows themselves
    // are re-fetched below as a PLAIN (non-step) read: Inngest round-trips
    // every step.run return value through JSON, which would turn their
    // Date columns into strings and break every typed helper downstream
    // (the same reason generate-batch.ts re-queries rows inside each item
    // step rather than threading them through step return values).
    const runOk = await step.run("load", async () => {
      const run = await getRunById(runId);
      return !!run && run.status === "running";
    });
    if (!runOk) return { runId, skipped: true };

    const [row] = await db
      .select({ project: projects, shot: shots })
      .from(shots)
      .innerJoin(projects, eq(shots.projectId, projects.id))
      .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
      .limit(1);
    if (!row) return { runId, skipped: true };

    const { project, shot } = row;
    const anthropic = new Anthropic();
    let scratch = settingsFromShot(shot);
    let scratchImageEdited = false;
    let finishResult: LoopOutcome["finishResult"] = null;
    let stuckNote: string | null = null;
    let stopped = false;

    try {
      for (let i = 1; i <= MAX_ITERATIONS; i++) {
        // Stop flag re-read fresh at every step boundary, outside any step.run.
        const boundary = await getRunById(runId);
        if (!boundary || boundary.stopRequested) {
          stopped = true;
          break;
        }

        const assessed = await step.run(`assess-${i}`, () => runAssessStep(anthropic, project, shot, runId, scratch));

        if (assessed.allPass && assessed.hasCandidate) {
          finishResult = { verdict: assessed.summary, quality: "pass" };
          break;
        }

        const acted = await step.run(`act-${i}`, () =>
          runActStep(anthropic, project, shot, runId, scratch, scratchImageEdited, assessed),
        );
        scratch = acted.scratch;
        scratchImageEdited = acted.scratchImageEdited;

        if (acted.finishCalled) {
          finishResult = acted.finishCalled;
          break;
        }

        if (!acted.actedThisIteration) {
          stuckNote = "No further actionable changes — stopping.";
          const note = stuckNote;
          await step.run(`stuck-${i}`, () => appendRunEvent(runId, "note", { message: note }));
          break;
        }

        if (acted.candidateGenerated) {
          await step.run(`frames-${i}`, () => persistCandidateFrames(project, shot, runId));
        }
      }

      await step.run("finalize", () => finalizeRun(runId, scratch, scratchImageEdited, { finishResult, stuckNote, stopped }));
      return { runId, status: stopped ? "stopped" : "awaiting_approval" };
    } catch (err) {
      await step.run("fail", () => failRun(runId, err));
      return { runId, status: "failed" };
    }
  },
);
