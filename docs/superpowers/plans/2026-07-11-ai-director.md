# AI Assistant Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-shot budgeted agentic director per the approved spec `docs/superpowers/specs/2026-07-11-ai-director-design.md` — sees stills and sampled clip frames, wields every directing control through a declarative tool registry, iterates within a user budget in an Inngest loop, and lands a candidate clip the user approves.

**Architecture:** A `src/lib/director/` module family: `frame-sampler` (ffmpeg-static), `director-tools` (the extensibility registry — Claude tools array, prompt inventory, feed events, and budget metering all derive from it), `director-context` (briefing text + images), `director-run` (run/event persistence helpers), and a `direct-shot` Inngest function running assess→act→generate iterations. Candidates render through the EXISTING clip pathway refactored to accept scratch settings + an output key. Approval promotes candidate + settings + scratch still atomically.

**Tech Stack:** Next.js 15, Drizzle/Postgres (`npm run db:push`), Inngest, `@anthropic-ai/sdk` (vision + tool use, model `claude-sonnet-5`), `ffmpeg-static` (new dep), Vitest.

## Global Constraints

- Security stack order on every new mutation route: `applyRateLimit` → `verifyCsrf` → `getSession` → UUID validation → ownership join (template: `src/app/api/projects/[id]/shots/[shotId]/sfx/route.ts`).
- Every file starts with a header block comment (tests included).
- Budget allow-list 0.25–5.00 USD; guidance/rejection notes ≤500 chars, forwarded only into prompts, never into R2 keys or full-text logs.
- The director's tool inputs are validated by the SAME guards as human PATCH routes (`isCameraMove`, `isCameraStrength`, ends-on enum, `isClipModelId`, duration bounds, 500-char caps). The model gets no capability a user PATCH lacks, except writing its own run's candidate assets.
- The shot's real `clip.mp4`, `image.png`, and directing settings are NEVER mutated during a run — only `resolve(action: "approve")` commits. Exception (spec §Decisions 3): `tag_entity`/`untag_entity` and entity CREATION are real, additive actions.
- Budget enforcement lives in the tool executor: refuse when `spentUsd + estCostUsd(input) > budgetUsd` with a structured over-budget tool result. Anthropic usage is metered into `spentUsd` (Sonnet: $3/M input tokens, $15/M output tokens — estimates, constants in one place).
- Candidate R2 prefix (server-composed only): `projects/{projectId}/shots/{shotId}/director/{runId}/` — `candidate.mp4`, `frame-{i}.png`, `scratch-image.png`, `end-frame.png`.
- One active run per shot: 409 on start while a run has status `running` or `awaiting_approval`.
- Iteration cap 5; stuck-guard (an iteration that changes nothing actionable ends the run); stop flag honored between steps.
- Copy (verbatim): group label `AI Director`; button `Direct this shot`; budgets `$0.75 / $1.50 / $3.00` default `$1.50`; guidance placeholder `e.g. "the dog should react to the lantern"`; candidate label `Candidate — your current clip is untouched`; buttons `Approve` / `Reject & retry` / `Dismiss`.
- Registry invariant (CI-enforced): every `DirectorTool` has a non-trivial description (≥20 chars), an `inputSchema`, and an `estCostUsd` function.

---

# STAGE 1 — Foundations (Tasks 1–9): watch → adjust → regenerate → verdict

### Task 1: Schema — director_runs + director_events

**Files:**
- Modify: `src/lib/db/schema.ts`

**Interfaces:**
- Produces (Drizzle tables + inferred types `DirectorRun`, `NewDirectorRun`, `DirectorEvent`):

```ts
export const directorRunStatusEnum = pgEnum("director_run_status", [
  "running", "awaiting_approval", "approved", "rejected", "stopped", "failed",
]);

export const directorRuns = pgTable("director_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  shotId: uuid("shot_id").notNull().references(() => shots.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  status: directorRunStatusEnum("status").default("running").notNull(),
  budgetUsd: doublePrecision("budget_usd").notNull(),
  spentUsd: doublePrecision("spent_usd").default(0).notNull(),
  guidance: text("guidance"),
  verdict: text("verdict"),
  stopRequested: boolean("stop_requested").default(false).notNull(),
  clipCandidatePath: text("clip_candidate_path"),
  candidateDurationSeconds: integer("candidate_duration_seconds"),
  candidateModel: text("candidate_model"),
  settingsSnapshot: jsonb("settings_snapshot").$type<Record<string, unknown>>(),
  proposals: jsonb("proposals").$type<Array<Record<string, unknown>>>().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index("director_runs_shot_id_idx").on(t.shotId)]);

export const directorEvents = pgTable("director_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => directorRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  type: text("type").notNull(), // 'note' | 'critique' | 'action' | 'cost' | 'error'
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("director_events_run_id_seq_idx").on(t.runId, t.seq)]);
```

(Header comments per repo convention; check `pgEnum`/`doublePrecision`/`jsonb`/`index` imports already exist in the file — they do.)

- [ ] **Step 1:** Add the tables + type exports. **Step 2:** `npm run db:push` — purely additive (abort on any destructive prompt). **Step 3:** Verify both tables + the enum via information_schema; `npm run test` stays green (42/42). **Step 4:** Commit `feat(director): director_runs and director_events tables`.

---

### Task 2: Frame sampler (ffmpeg-static)

**Files:**
- Create: `src/lib/director/frame-sampler.ts`
- Test: `tests/unit/frame-sampler.test.ts`
- Modify: `package.json` (add `ffmpeg-static`)

**Interfaces:**
- Produces: `async function sampleVideoFrames(video: Buffer, count: number): Promise<Buffer[]>` — writes the buffer to a temp file (`os.tmpdir()`, random name, cleaned in `finally`), probes duration via ffmpeg (`-i` stderr parse or `-show_entries` via the same binary with `-f null`), extracts `count` JPEG frames at evenly spaced timestamps `(i/(count-1)) * duration` clamped inside [0, duration-0.05], returns them as Buffers in order. Throws a descriptive Error when ffmpeg exits non-zero.

- [ ] **Step 1:** `npm install ffmpeg-static` (binary path via `import ffmpegPath from "ffmpeg-static"`).
- [ ] **Step 2: Failing test** (hermetic — generates its own 2s test video with the same bundled ffmpeg, no network):

```ts
/**
 * Frame-sampler tests. Hermetic: synthesizes a 2s test video with the
 * bundled ffmpeg (lavfi testsrc), then samples frames from it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ffmpegPath from "ffmpeg-static";
import { sampleVideoFrames } from "@/lib/director/frame-sampler";

let video: Buffer;
beforeAll(() => {
  const out = join(tmpdir(), `fs-test-${process.pid}.mp4`);
  execFileSync(ffmpegPath as string, ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", out]);
  video = readFileSync(out);
});

describe("sampleVideoFrames", () => {
  it("returns the requested number of JPEG frames in order", async () => {
    const frames = await sampleVideoFrames(video, 4);
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect(f.length).toBeGreaterThan(500);
      expect(f[0]).toBe(0xff); // JPEG SOI
      expect(f[1]).toBe(0xd8);
    }
  });
  it("throws a descriptive error on a non-video buffer", async () => {
    await expect(sampleVideoFrames(Buffer.from("not a video"), 2)).rejects.toThrow(/ffmpeg/i);
  });
});
```

- [ ] **Step 3:** RED → implement (use `execFile` promisified; duration probe: run ffmpeg with `["-i", tmp, "-f", "null", "-"]` and regex `Duration: (\d+):(\d+):(\d+\.\d+)` from stderr; per-frame: `["-y", "-ss", String(ts), "-i", tmp, "-frames:v", "1", "-q:v", "3", framePath]`) → GREEN.
- [ ] **Step 4:** `npx tsc --noEmit`, `npm run lint`, full `npm run test`. Commit `feat(director): hermetic ffmpeg frame sampler`.

---

### Task 3: DirectingSettings + clip-render refactor (candidates share the real pathway)

**Files:**
- Modify: `src/lib/shot-clip-generation.ts`
- Test: `tests/unit/directing-settings.test.ts`

**Interfaces:**
- Consumes: everything already in the file (spec/camera/duration/end-frame/refs resolution).
- Produces:

```ts
/** Everything clip resolution needs, decoupled from the shots row. */
export interface DirectingSettings {
  imagePath: string;                 // start still (real or scratch)
  motionPrompt: string;
  clipModel: string | null;
  cameraMove: string | null;
  cameraStrength: string | null;
  endsOn: "free" | "next" | "custom";
  endFramePath: string | null;
  endFrameStatus: string | null;
  clipDurationChoice: number | null;
  negativePrompt: string | null;     // shot-level override
  useEntityRefs: boolean;
  referencedEntityIds: string[];
  slotSeconds: number | null;
}
export function settingsFromShot(shot: Shot): DirectingSettings; // pure mapper (slotSeconds from endInBeat-startInBeat)
export async function renderDirectedClip(
  project: Project,
  shotId: string,                    // for next-shot lookup + entity tag scoping
  settings: DirectingSettings,
  outputR2Key: string,
): Promise<GenerateShotClipResult>;  // same result shape; NO shot-row mutation inside
```

`generateShotClip(project, shot, opts)` becomes: flip `clipStatus: "generating"` → `settingsFromShot(shot)` (with `opts.model` override applied to `clipModel`) → `renderDirectedClip(project, shot.id, settings, standard clip.mp4 key)` → write the shot-row success update (clipPath/status/duration/model + SFX reset) / catch-mark-failed-rethrow. Behavior byte-identical for existing callers (route + orchestrator untouched).

- [ ] **Step 1: Failing tests** for the pure mapper:

```ts
  it("settingsFromShot maps the row and computes slotSeconds", () => {
    const s = settingsFromShot({ ...baseShot, startInBeat: 1, endInBeat: 4.3, endsOn: "next" } as Shot);
    expect(s.slotSeconds).toBeCloseTo(3.3);
    expect(s.endsOn).toBe("next");
  });
  it("settingsFromShot yields null slotSeconds when bounds missing", () => {
    expect(settingsFromShot({ ...baseShot, startInBeat: null } as Shot).slotSeconds).toBeNull();
  });
```

(Build `baseShot` as a minimal `Shot`-shaped literal in the test file.)

- [ ] **Step 2:** RED → refactor exactly as the Interfaces block describes (move the existing resolution/upload/fal/R2 body into `renderDirectedClip`; it reads next-shot via the existing timeline-order lookup using `shotId`; the R2 `PutObjectCommand` targets `outputR2Key`) → GREEN; all existing suites stay green.
- [ ] **Step 3:** `npx tsc --noEmit` (route + orchestrator call sites compile unchanged), lint. Commit `refactor(director): DirectingSettings + renderDirectedClip — one pathway for shots and candidates`.

---

### Task 4: Tool registry core + budget gate (TDD)

**Files:**
- Create: `src/lib/director/director-tools.ts`
- Create: `src/lib/director/director-budget.ts`
- Test: `tests/unit/director-tools.test.ts`, `tests/unit/director-budget.test.ts`

**Interfaces:**
- Produces:

```ts
// director-budget.ts
export const ANTHROPIC_USD_PER_MTOK_INPUT = 3;
export const ANTHROPIC_USD_PER_MTOK_OUTPUT = 15;
export function usageCostUsd(u: { input_tokens: number; output_tokens: number }): number; // round4
export function assertWithinBudget(spentUsd: number, budgetUsd: number, estUsd: number):
  { ok: true } | { ok: false; refusal: string }; // refusal text names the numbers

// director-tools.ts
export interface DirectorRunCtx {
  project: Project; shot: Shot; runId: string;
  scratch: DirectingSettings;                       // mutated by setting tools
  scratchImageEdited: boolean;
  appendEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  addSpend(usd: number): Promise<void>;
  addProposal(p: Record<string, unknown>): Promise<void>;
  candidateKey(file: string): string;               // run-prefixed R2 key builder
}
export interface DirectorToolResult { ok: boolean; message: string; data?: Record<string, unknown> }
export interface DirectorTool { name; description; inputSchema; estCostUsd(input): number; sharedStateEdit?: boolean; execute(ctx, input): Promise<DirectorToolResult> }
export const DIRECTOR_TOOLS: DirectorTool[];
export function getDirectorTool(name: string): DirectorTool | null;
export function toAnthropicTools(): Anthropic.Tool[];              // derived
export function capabilityInventory(): string;                     // derived prompt text: "- name: description" lines
```

Stage-1 tool set (free unless noted): `set_camera_move` (schema enum from `CAMERA_MOVES.map(m=>m.id)`, `strength` enum subtle/medium/strong; validates via `isCameraMove`/`isCameraStrength`; null allowed via `"none"` sentinel mapped to null), `set_ends_on` (enum free|next — `custom` REJECTED with a helpful message until an end frame exists on the scratch, i.e. `scratch.endFramePath` set), `set_negative_prompt` (≤500 or null), `set_clip_duration` (int 1–15 or null; validated against the scratch model's `durations` via `getClipModel`), `set_clip_model` (enum from `CLIP_MODELS.map(m=>m.id)`; description embeds each `whenToUse`), `set_use_entity_refs` (boolean), `generate_candidate_clip` (est = `estClipUsd(scratch model spec, resolveClipDuration(spec, scratch.slotSeconds, scratch.clipDurationChoice))`; execute → `renderDirectedClip(project, shot.id, scratch, ctx.candidateKey("candidate.mp4"))`, then persists candidate fields on the run via ctx callback — expose `setCandidate(result)` on ctx), `record_critique` (free; payload echoed to the feed as a `critique` event; inputSchema: `{ dimensions: [{name, pass, note}], summary }`), `finish` (free; `{ verdict, quality: "pass" | "best_effort" }`).

- [ ] **Step 1: Failing tests:**

```ts
// director-budget.test.ts
  it("prices anthropic usage", () => {
    expect(usageCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBe(3);
    expect(usageCostUsd({ input_tokens: 0, output_tokens: 100_000 })).toBe(1.5);
  });
  it("refuses over-budget spends with named numbers", () => {
    const r = assertWithinBudget(1.2, 1.5, 0.45);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain("1.2");
  });
  it("allows exact-fit spends", () => {
    expect(assertWithinBudget(1.0, 1.5, 0.5).ok).toBe(true);
  });

// director-tools.test.ts
  it("every tool satisfies the registry invariant", () => {
    for (const t of DIRECTOR_TOOLS) {
      expect(t.description.length).toBeGreaterThanOrEqual(20);
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.estCostUsd).toBe("function");
    }
  });
  it("enums derive from app sources", () => {
    const cam = getDirectorTool("set_camera_move")!;
    expect(JSON.stringify(cam.inputSchema)).toContain('"push-in"');
    const model = getDirectorTool("set_clip_model")!;
    expect(JSON.stringify(model.inputSchema)).toContain('"kling-v3-pro"');
  });
  it("setting tools mutate scratch and are free", async () => {
    const ctx = makeCtx(); // test helper: minimal ctx with in-memory scratch + spies
    const t = getDirectorTool("set_camera_move")!;
    expect(t.estCostUsd({ move: "push-in", strength: "subtle" })).toBe(0);
    const r = await t.execute(ctx, { move: "push-in", strength: "subtle" });
    expect(r.ok).toBe(true);
    expect(ctx.scratch.cameraMove).toBe("push-in");
  });
  it("set_ends_on rejects custom without a scratch end frame", async () => {
    const ctx = makeCtx();
    const r = await getDirectorTool("set_ends_on")!.execute(ctx, { endsOn: "custom" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/end frame/i);
  });
  it("toAnthropicTools and capabilityInventory cover every tool", () => {
    expect(toAnthropicTools()).toHaveLength(DIRECTOR_TOOLS.length);
    for (const t of DIRECTOR_TOOLS) expect(capabilityInventory()).toContain(t.name);
  });
```

(`makeCtx()` lives in the test file: real `DirectingSettings` literal, `appendEvent`/`addSpend`/`addProposal` as recording spies, `candidateKey: (f) => "test/" + f`.)

- [ ] **Step 2:** RED → implement both modules (invalid inputs return `{ok:false, message}` — never throw; every successful execute also `appendEvent("action", { tool, input, message })`) → GREEN.
- [ ] **Step 3:** tsc, lint, full suite. Commit `feat(director): tool registry core + all-inclusive budget gate`.

---

### Task 5: Director context (briefing text + images)

**Files:**
- Create: `src/lib/director/director-context.ts`
- Test: `tests/unit/director-context.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DirectorBriefingData {  // plain data in, pure text out — testable
  projectBrief: string | null; styleString: string | null; script: string | null;
  beatText: string; shot: { imagePrompt: string; motionPrompt: string };
  scratch: DirectingSettings;
  neighbors: { prev?: { imagePrompt: string; endsOn: string }; next?: { imagePrompt: string; endsOn: string } };
  entities: Array<{ id: string; name: string; type: string; sheetReady: boolean; taggedHere: boolean }>;
  budgetUsd: number; spentUsd: number; guidance: string | null;
}
export function buildBriefingText(d: DirectorBriefingData): string;  // pure; sections in fixed order
export async function gatherBriefingImages(project, shot, run, scratch): Promise<Anthropic.ImageBlockParam[]>;
// downloads from R2: scratch still, scratch end frame (if any), prev/next stills (if done), latest candidate frames (if any, from run prefix) — each labeled via a preceding text block by the CALLER; this returns [{label, block}] pairs:
// actual signature: Promise<Array<{ label: string; block: Anthropic.ImageBlockParam }>>
```

- [ ] **Step 1: Failing tests** for `buildBriefingText`: includes every section header (`## Script`, `## This beat`, `## This shot`, `## Neighbors`, `## Cast & locations`, `## Budget`, `## Guidance`); renders entity sheet-readiness (`(sheet ready)` / `(no sheet)`); shows `spent $X of $Y`; omits the Guidance section when null; includes the scratch settings line (camera/ends-on/model/duration).
- [ ] **Step 2:** RED → implement (image gathering downloads via `GetObjectCommand` like `fal-upload.ts` does, converts to base64 `image/png`/`image/jpeg` blocks; skip missing assets silently) → GREEN.
- [ ] **Step 3:** tsc/lint/suite; commit `feat(director): briefing text + image gathering`.

---

### Task 6: Run persistence helpers + start/poll/stop routes

**Files:**
- Create: `src/lib/director/director-run.ts`
- Create: `src/app/api/projects/[id]/shots/[shotId]/director/route.ts` (POST start, GET poll)
- Create: `src/app/api/projects/[id]/shots/[shotId]/director/stop/route.ts` (POST)

**Interfaces:**
- Produces (`director-run.ts`): `createRun(projectId, shotId, budgetUsd, guidance): Promise<DirectorRun>` (409-guard check is the ROUTE's job); `appendRunEvent(runId, type, payload)` (seq = max+1 in one insert-select); `addRunSpend(runId, usd)` (SQL increment); `getRunWithEvents(shotId, sinceSeq?)`; `requestStop(runId)`; `activeRunForShot(shotId)` (status running|awaiting_approval).
- Routes: `POST …/director` `{ budgetUsd (0.25–5.00), guidance? ≤500 }` → 409 if `activeRunForShot`, precondition shot has a done image (400), create run, `inngest.send({ name: "shot/director.run", data: { runId, projectId, shotId } })`, 202 `{ runId }`. `GET …/director?since=N` → `{ run, events }` (latest run for the shot; events with seq > N). `POST …/director/stop` → `requestStop`, 200. Full security stack on all three; GET requires session+ownership (no CSRF needed, read-only — mirror the preview route's auth pattern).

- [ ] **Step 1:** Implement helpers + routes (structural template: sfx route). **Step 2:** tsc/lint/suite green. **Step 3:** Commit `feat(director): run persistence + start/poll/stop routes`.

---

### Task 7: The direct-shot Inngest loop

**Files:**
- Create: `src/inngest/functions/direct-shot.ts`
- Modify: `src/inngest/index.ts` (register `directShotFn` in `functions`)

**Interfaces:**
- Consumes: everything from Tasks 2–6; Anthropic SDK idiom from `src/lib/chain-suggestion.ts` (client instantiation, tool_choice).
- Produces: `directShotFn` — event `shot/director.run`, per-project-shot concurrency 1, retries 1.

Loop skeleton (each numbered block is a `step.run` with a deterministic id):

```ts
// 1. "load" — run + project + shot rows; guard: run.status === "running" else exit.
// 2. scratch = settingsFromShot(shot) (+ scratchImagePath tracking, initially shot.imagePath)
// 3. for (let i = 1; i <= 5; i++):
//    a. step.run(`assess-${i}`): stop check → gatherBriefingImages + buildBriefingText →
//       Claude messages.create({ model: "claude-sonnet-5", max_tokens: 2000,
//         system: SYSTEM_PROMPT (includes capabilityInventory()),
//         tools: [recordCritiqueTool], tool_choice: {type:"tool", name:"record_critique"},
//         messages: [user: [text briefing, ...labeled image blocks]] })
//       → meter usageCostUsd into spend (cost event) → append critique event (with persisted 0%/100% candidate frames when present) → return critique.
//       If every dimension passes AND a candidate exists → break to finish("pass").
//    b. step.run(`act-${i}`): a bounded tool-use conversation (≤8 assistant turns):
//       tools = toAnthropicTools(); for each tool_use block: budget-check estCostUsd →
//       refused ⇒ structured tool_result {ok:false, refusal}; else execute(ctx, input)
//       (paid tools call addRunSpend + cost event). Conversation ends when the model
//       stops calling tools or calls finish. Track `actedThisIteration` =
//       any successful non-critique/non-finish tool.
//    c. If finish was called → break. If !actedThisIteration → append note "no further
//       actionable changes — stopping" and break (stuck-guard).
//    d. If generate_candidate_clip succeeded this iteration: step.run(`frames-${i}`):
//       download candidate → sampleVideoFrames(buf, 4) → persist frames 0/3 to run prefix
//       (frame-0.png/frame-3.png) → stash all 4 for the next assess.
// 4. "finalize": persist the scratch onto the run — settingsSnapshot =
//    { ...scratch, scratchImageEdited } (Task 13's promotionPlan reads exactly this);
//    status → awaiting_approval (verdict from finish, or "Budget exhausted — best
//    effort within $X" / stuck-guard note); if stopRequested → "stopped".
// 5. catch (unrecoverable): status → failed + error event; spend already persisted incrementally.
```

SYSTEM_PROMPT (constant in the file): the director persona; the quality dimensions (subject action matches VO; continuity with neighbors; cast on-model; camera & pacing; visual artifacts); budget discipline ("prefer free setting changes; spend only when the critique demands it; if over budget, finish best_effort"); the derived `capabilityInventory()`; "the user's guidance overrides your taste".

- [ ] **Step 1:** Implement per the skeleton. **Step 2:** tsc/lint/suite; `PUT /api/inngest` registers the fn (dev-server check in Task 9). **Step 3:** Commit `feat(director): direct-shot Inngest loop — assess/act/generate within budget`.

---

### Task 8: Minimal feed UI (inspector fifth group)

**Files:**
- Modify: `src/components/editor/inspector.tsx`
- Modify: `src/components/editor/editor-store.tsx`

**Interfaces:**
- Store gains: `startDirector(shotId, budgetUsd, guidance?): Promise<boolean>`, `stopDirector(shotId)`, `directorState[shotId]` fed by a poll (3s while a run is `running`, idiom: the batch poll) exposing `{ run, events }`; poll starts when a run starts or a mounted shot has an active run.
- Inspector: new bottom group `AI Director` — at rest: budget `<select>` ($0.75/$1.50/$3.00 default $1.50), guidance input (≤500, placeholder per Global Constraints), `Direct this shot` button (disabled: no done image, or active run); running: feed list (🎬 critique summaries + dimension pass/fails, 🔧 action lines from `payload.message`, 💸 `+$0.45 → $0.62 / $1.50`, ❌ errors), candidate first/last frame `<img>`s when a critique payload carries them, `Stop` button; terminal non-approved states render a one-line history row (`Last run: {status} · ${spent} spent`). (The verdict card is Task 13 — until then `awaiting_approval` renders the history row plus a muted "verdict UI lands in Stage 3".)

- [ ] **Step 1:** Implement store + UI per above (all copy verbatim). **Step 2:** tsc/lint/suite. **Step 3:** Commit `feat(director): AI Director inspector group — start, live feed, stop`.

---

### Task 9: Stage-1 gate (controller)

- [ ] Full gates: `npm run test`, `npx tsc --noEmit`, `npm run lint`, `INNGEST_DEV="" npm run build`.
- [ ] Live free-path check (controller, dev + inngest dev servers): start a run with a $0.25 budget on a shot with an image but deliberately let it act only on free tools if it chooses; verify feed renders critiques/actions, spend metering ticks from Anthropic usage alone, stop works, 409 double-start, run reaches a terminal state. (Anthropic tokens cost real cents — acceptable without a user gate; NO fal spends in this check unless the model generates a candidate within $0.25, which is fine.)
- [ ] Ledger + fix anything found. Stage 1 shippable.

---

# STAGE 2 — Full powers (Tasks 10–12)

### Task 10: Kontext tools (scratch end frame + scratch image edit)

**Files:**
- Modify: `src/lib/shot-frame-edit.ts` (export the internal Kontext helper for arbitrary source/output keys: `export async function runKontextEditToKey(sourceR2Key: string, instruction: string, outputR2Key: string): Promise<void>` — extract from the existing private implementation, both existing services delegate to it; no behavior change)
- Modify: `src/lib/director/director-tools.ts`
- Test: extend `tests/unit/director-tools.test.ts`

**Interfaces:**
- New tools: `create_custom_end_frame` `{ instruction ≤500 }` (est $0.04; execute: `runKontextEditToKey(ctx.scratch.imagePath, instruction, ctx.candidateKey("end-frame.png"))` → scratch.endFramePath = that key, endFrameStatus = "done") and `edit_start_image` `{ instruction ≤500 }` (est $0.04; `runKontextEditToKey(scratch.imagePath, instruction, ctx.candidateKey("scratch-image.png"))` → scratch.imagePath = that key, `ctx.scratchImageEdited = true`).
- Tests: registry invariant still passes; est costs are 0.04; instruction >500 → `{ok:false}` (validated in execute, no fal call — assert the fal helper spy wasn't called by injecting a mock via a test-only ctx hook? Keep it simple: validate length BEFORE calling the helper and unit-test only the validation branch).

- [ ] Steps: failing tests → extract helper (all suites green — the two existing services still pass their usage) → implement tools → GREEN → tsc/lint → commit `feat(director): Kontext tools — scratch end frame + start-image edit`.

---

### Task 11: Entity tools

**Files:**
- Modify: `src/lib/director/director-tools.ts`
- Test: extend `tests/unit/director-tools.test.ts`

**Interfaces:**
- `create_entity` `{ name ≤80, type: character|location|object, description ≤500 }` — free; inserts the entities row (same shape as the entities POST route: projectId/name/type/description) after checking name-uniqueness within the project (mirror the route's duplicate check); returns the new id.
- `generate_entity_sheet` `{ entityId }` — est $0.04; validates the entity belongs to `ctx.project`; calls the existing `generateEntitySheet(project, entity)`.
- `tag_entity` / `untag_entity` `{ entityId }` — free; REAL update of `shots.referencedEntityIds` for `ctx.shot.id` (≤8 tags cap, mirroring the PATCH route) AND updates `ctx.scratch.referencedEntityIds` to match.
- `propose_entity_update` `{ entityId, field: "description", newValue ≤500, rationale ≤300 }` — free; `sharedStateEdit: true`; execute ONLY calls `ctx.addProposal({entityId, entityName, field, from, to: newValue, rationale})` — asserts in tests that no entities-row update occurs.

- [ ] Steps: failing tests (registry invariant; propose routes to addProposal spy and touches no DB — ctx spies make this assertable; tag cap enforcement message) → implement → GREEN → tsc/lint → commit `feat(director): entity tools — create/sheet/tag + shared-edit proposals`.

---

### Task 12: Stage-2 gate (controller)

- [ ] Full gates (test/tsc/lint/build). Grep: `sharedStateEdit` true only on `propose_entity_update`. Registry count matches the spec's launch set. Ledger. Stage 2 shippable.

---

# STAGE 3 — Approval (Tasks 13–15)

### Task 13: Resolve route — approve promotes atomically

**Files:**
- Create: `src/app/api/projects/[id]/shots/[shotId]/director/resolve/route.ts`
- Create: `src/lib/director/director-resolve.ts`
- Test: `tests/unit/director-resolve.test.ts`

**Interfaces:**
- `director-resolve.ts`: `export function promotionPlan(run: DirectorRun): { shotPatch: Record<string, unknown>; copyOps: Array<{ from: string; to: string }> }` — PURE: from `settingsSnapshot` + candidate fields builds the shot update (directing settings incl. `clipModel: candidateModel`, `clipPath` → standard key, `clipDurationSeconds`, `clipStatus: "done"`, SFX reset `sfxPath: null, sfxStatus: "pending"`, and `endFramePath`/`endsOn` from the snapshot with the run-prefixed end frame copied to the shot's standard `end-frame.png` key when present) and the R2 copy operations (`candidate.mp4` → `clip.mp4`; `scratch-image.png` → `image.png` when `settingsSnapshot.scratchImageEdited`; `end-frame.png` likewise).
- Route `POST …/director/resolve` `{ action: "approve" | "reject" | "dismiss", note? ≤500, approvedProposalIds?: number[] }`: run must be `awaiting_approval` (or `stopped` with a candidate, approve-only) else 400. approve → execute `promotionPlan` (R2 `CopyObjectCommand`s then the shot update, then apply checked proposals as entities-row description updates), run → `approved`. reject → note appends to `guidance` (`\n\nUser feedback: …`), run → `rejected` (the UI immediately offers retry = a fresh POST start that copies guidance forward — the START route gains an optional `retryOfRunId` that seeds guidance from that run). dismiss → `rejected`, nothing applied, no note required.
- Full security stack; house error shapes.

- [ ] **Step 1: Failing tests** for `promotionPlan`: maps every directing field from a full snapshot; includes clip copy op always; includes image copy op only when `scratchImageEdited`; SFX reset present; endsOn custom keeps custom + copies the end frame to the shot key.
- [ ] **Step 2:** RED → implement pure fn → GREEN → route + start-route `retryOfRunId` addition.
- [ ] **Step 3:** tsc/lint/suite → commit `feat(director): resolve route — atomic approve/reject/dismiss`.

---

### Task 14: Verdict card + polish UI

**Files:**
- Modify: `src/components/editor/inspector.tsx`, `src/components/editor/editor-store.tsx`
- Modify: `src/components/editor/storyboard-view.tsx` (badges), `src/components/editor/unified-editor.tsx` (only if the timeline badge lives there — check where shot badges render; the v3 directed-ending badge is in storyboard-view.tsx)

**Interfaces:**
- Store: `resolveDirector(shotId, action, note?, approvedProposalIds?)` (+ retry via `startDirector(..., retryOfRunId)`); poll continues through `awaiting_approval`.
- Inspector verdict card on `awaiting_approval`: candidate `<video>` (presigned via a `candidateUrl` the GET poll includes; muted loop; label verbatim `Candidate — your current clip is untouched`), verdict text, settings diff computed client-side (shot current vs `settingsSnapshot`, rendered `Camera: none → push-in · Ends on: free → custom · …`), proposals as checkboxes (default unchecked, showing `from → to` + rationale), buttons `Approve` / `Reject & retry` (reveals note field + budget picker prefilled with the same amount) / `Dismiss`. GET poll route gains `candidateUrl` presign + `endFrameUrl`/frame presigns for feed images (extend Task 6's GET).
- Badges: storyboard tile 🎬 pulse (`animate-pulse`) while `running`, static 🎬 when `awaiting_approval` (title "Director verdict waiting").

- [ ] Steps: implement store → card → badges; tsc/lint/suite; live click-through against a stubbed `awaiting_approval` row seeded via psql (free); commit `feat(director): verdict card, retry flow, storyboard badges`.

---

### Task 15: Docs + verification + final review

**Files:**
- Create: `docs/feature20/feature.md`, `docs/feature20/test-case.md`

- [ ] **Step 1:** feature.md per feature-playbook (mirror feature19): architecture (module family + registry derivation rule verbatim from the spec), data model, lifecycle, budget semantics, security, limitations (spec §Known limitations), extensibility how-to ("adding a directing control to the director = 1 registry entry" with a worked example).
- [ ] **Step 2:** test-case.md: unit suites (counts, PASS); route TCs (409 double-start, budget allow-list 400s, resolve preconditions); UI TCs (copy verbatim, feed event rendering, stop, verdict card, proposal checkboxes); paid TC pending: **hero run** — throwaway shot with a deliberate VO/still mismatch (VO says "raises the lantern", still shows it lowered), budget $1.50 — assert the director's first critique flags the mismatch, it stages a fix (end frame or image edit), lands an approvable candidate within budget, and approve promotes correctly.
- [ ] **Step 3:** Pre-commit checklist (CLAUDE.md) with grep evidence; full gates incl. `INNGEST_DEV="" npm run build`; commit `docs(director): feature20 documentation + test cases`.
- [ ] **Step 4: STOP — user gates:** paid hero run (~$1.50–2 incl. Anthropic tokens; explicit go-ahead with estimate), live verification, final whole-branch review (most capable model), merge decision per the established workflow.
