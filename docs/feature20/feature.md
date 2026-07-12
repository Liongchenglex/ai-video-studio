# Feature: F-20 AI Assistant Director

> **Status: Implementation complete (Tasks 1–14, docs Task 15 Steps 1–3).
> Paid hero run, live browser verification, and final merge to master are
> Task 15 Step 4 — handled separately by the controller with explicit user
> go-ahead on spend.**
> Branch `feat/ai-director`. Design:
> [`docs/superpowers/specs/2026-07-11-ai-director-design.md`](../superpowers/specs/2026-07-11-ai-director-design.md).
> **Depends on:** F-19 Directing Controls (shipped 2026-07-11, merged to
> master as `c80194c`) — this feature is a consumer of that release's
> registry (`clip-models.ts`), camera module (`clip-camera.ts`), chaining
> module (`clip-chaining.ts`), and `shot-clip-generation.ts`'s
> `DirectingSettings`/`renderDirectedClip`/`settingsFromShot` — it adds no
> parallel abstraction for any of the three, it drives them through a
> scratch-settings copy instead of the shot's real row.

## Feature
- **Name:** AI Assistant Director
- **Purpose:** Automate the manual "watch clip → diagnose → adjust
  controls → regenerate → repeat" loop. An autonomous agent (Claude
  Sonnet, vision-enabled) that can see a shot's still/clip, holds
  whole-project context (script, beat, timeline neighbors, cast roster),
  and wields every directing control (F-19's camera/ends-on/duration/
  negative-prompt/model/references) plus entity creation/tagging/sheet
  generation — iterating within a user-set per-run budget until it lands
  one candidate clip for the user to approve, reject-and-retry, or
  dismiss. It never touches the shot's real clip/settings mid-run; it
  works on a scratch copy and a separate candidate R2 key.

## Key Files

Backend:
- `src/lib/director/director-tools.ts` (731 LOC) — the tool registry, the
  single declarative source every other director module derives from (see
  Architecture below). 16 entries; every `execute()` validates its own
  input the same way the human PATCH/POST routes do and never throws
  (`{ok:false, message}` on failure).
- `src/lib/director/director-budget.ts` — pure Anthropic-usage-to-USD
  pricing (`usageCostUsd`, Sonnet rate card $3/M in, $15/M out) and the
  budget gate (`assertWithinBudget`) shared by the loop (token metering)
  and the tool executor (paid-tool refusal).
- `src/lib/director/director-run.ts` — thin DB layer over
  `director_runs`/`director_events`: `createRun`, `appendRunEvent`
  (seq via `insert…select max(seq)+1`), `addRunSpend`/`addRunProposal`
  (SQL-expression increments, never read-then-write),
  `getRunWithEvents`/`activeRunForShot`/`resolvableRunForShot`, and the
  two atomic claim functions (`claimRunApproval`, `claimRunRejection`)
  that back the resolve route's race safety.
- `src/lib/director/director-context.ts` — `buildBriefingText` (pure,
  fixed section order: Script → This beat → This shot → Neighbors → Cast
  & locations → Budget → Guidance) and `gatherBriefingImages` (network:
  downloads scratch still, authored end frame, prev/next stills, and —
  once a candidate exists — the run's 4 persisted sample frames, from R2;
  every source probed independently, missing assets skipped silently).
- `src/lib/director/frame-sampler.ts` — `sampleVideoFrames(buffer, count)`:
  extracts `count` evenly spaced JPEG frames from a video buffer via the
  `ffmpeg-static` binary (new dependency), with a backward-rescue retry
  window (5 attempts × 0.3s) for low-fps sources where a requested
  timestamp lands past the last frame's PTS.
- `src/lib/director/director-resolve.ts` — `promotionPlan(run)` (pure):
  turns a terminal run's `settingsSnapshot` + candidate fields into a
  `shotPatch` + R2 `copyOps`, the exact plan the resolve route executes on
  approve. `buildRejectionGuidance(existing, note)` (pure): appends a
  reject note onto accumulated guidance for the retry flow.
- `src/inngest/functions/direct-shot.ts` (620 LOC) — the agent loop
  itself (Inngest function `direct-shot`, event `shot/director.run`,
  `concurrency: [{scope:"fn", key:"event.data.shotId", limit:1}]`). See
  Lifecycle below.
- `src/app/api/projects/[id]/shots/[shotId]/director/route.ts` — `POST`
  (start) + `GET` (poll).
- `src/app/api/projects/[id]/shots/[shotId]/director/stop/route.ts` —
  `POST` (cooperative stop flag).
- `src/app/api/projects/[id]/shots/[shotId]/director/resolve/route.ts`
  — `POST` (`approve` | `reject` | `dismiss`).
- `src/lib/shot-clip-generation.ts` (F-19, extended for this feature) —
  `DirectingSettings`, `settingsFromShot`, `renderDirectedClip`,
  `loadOrderedProjectShots` are the exact seams the director's scratch
  settings and candidate rendering ride on; no parallel clip-rendering
  path was added.
- `src/lib/shot-frame-edit.ts` (F-19, extended) —
  `runKontextEditToKey(sourcePath, instruction, outputKey)` is the shared
  Kontext primitive both `edit_start_image` and `create_custom_end_frame`
  call, writing to an arbitrary caller-supplied key instead of the shot's
  standard one so a director run's edits land in the run's own R2 prefix.

Frontend:
- `src/components/editor/inspector.tsx` — fifth inspector group
  `DirectorGroup` (below Sound): at-rest (budget picker `$0.75/$1.50/$3.00`
  default `$1.50`, optional guidance input, `Direct this shot` button,
  disabled without a done image or while a run is active), running (live
  polled feed via `DirectorFeedLine` — 🎬 critique w/ pass/fail dimensions
  + first/last candidate frames, 🔧 action, 💸 cost tick, ❌ error, 📝 note
  — plus **Stop**), `awaiting_approval` (history label +
  `DirectorVerdictCard`).
- `src/components/editor/director-verdict-card.tsx` (363 LOC) — candidate
  video (labeled verbatim *Candidate — your current clip is untouched*),
  verdict text, client-computed settings diff (`computeSettingsDiff`,
  mirrors exactly what `promotionPlan` would write), proposal checkboxes
  (default unchecked), **Approve** (disabled without `run.candidateUrl`)
  / **Reject & retry** (note + budget picker, resolves then immediately
  starts a fresh run via `retryOfRunId`) / **Dismiss**.
- `src/components/editor/storyboard-view.tsx` — 🎬 badge, pulsing while
  `status === "running"`, static while `status === "awaiting_approval"`
  (reads `directorState[shot.id]?.run?.status`; populated only for shots
  the session has polled at least once — see Tradeoffs).
- `src/components/editor/editor-store.tsx` — `directorState:
  Record<string, DirectorShotState>` (`{run, events}`), `startDirector`,
  `stopDirector`, `resolveDirector`, and the 3s interval poll gated on any
  shot's run being `running`/`awaiting_approval`
  (`directorPollActive`/`directorSeqRef` tracks per-shot `since`).

## Data Models

`director_runs` (`src/lib/db/schema.ts:351`):
- `id uuid pk`; `shotId`/`projectId` (fk cascade).
- `status director_run_status` — enum `running | awaiting_approval |
  approved | rejected | stopped | failed`, default `running`.
- `budgetUsd double precision not null`; `spentUsd double precision
  default 0 not null` (incremented via SQL expression, never
  read-then-write).
- `guidance text` — user's note; rejection notes append via
  `buildRejectionGuidance`.
- `verdict text`; `stopRequested boolean default false not null`.
- `clipCandidatePath text` / `candidateDurationSeconds integer` /
  `candidateModel text` — the latest rendered candidate, if any.
- `settingsSnapshot jsonb` — the scratch `DirectingSettings` the run
  finished with, plus `scratchImagePath`/`scratchImageEdited` (written
  once, at `finalizeRun`); `promotionPlan` is the only reader and assumes
  this exact shape.
- `proposals jsonb default []` — `propose_entity_update` tool-call
  results, appended via `||` concatenation.
- `createdAt`/`updatedAt`.
- **`director_runs_one_active_per_shot`** — a `uniqueIndex` on `(shotId)`
  **partial**: `WHERE status IN ('running', 'awaiting_approval')`. This is
  the DB-level backstop for the start route's 409 check — two racing
  starts cannot both insert an active run; the loser's Postgres 23505 is
  caught and mapped to the same 409 by the route
  (`isActiveRunUniqueViolation`, which walks the Drizzle error's `cause`
  chain since postgres-js wraps the raw `PostgresError`).

`director_events` (`schema.ts:393`):
- `id uuid pk`; `runId` (fk cascade); `seq integer not null` (assigned via
  `insert…select coalesce(max(seq),0)+1 from director_events where run_id
  = …` in the same statement — safe because the loop is the run's only
  writer and its steps run sequentially, not because the window is fully
  eliminated).
- `type text` — `note | critique | action | cost | error` (untyped at the
  DB level; the loop and the UI agree on the shape by convention).
- `payload jsonb not null`; `createdAt`.
- Append-only; the feed the inspector polls (`GET .../director?since=seq`).
  Critique events store candidate frame R2 **keys** (`payload.frameKeys`),
  never presigned URLs (a URL embedded in a DB row would go stale before a
  days-later poll renders it) — the GET route presigns them into
  `payload.frameUrls` fresh on every read, on a copy of the event object,
  never mutating the stored row.

## Lifecycle

`start(budget, guidance?)` → `POST .../director` validates the budget
allow-list (`$0.25`–`$5.00`) and the done-still precondition (400
otherwise), 409s a second concurrent run (pre-check + DB unique-index
backstop), inserts a `running` row, and sends `shot/director.run` to
Inngest.

The `direct-shot` loop then runs up to `MAX_ITERATIONS = 5` rounds:
1. **`assess-N`** — a forced `record_critique` tool call (vision, against
   the beat's intent: subject-action-vs-VO, neighbor continuity,
   cast-on-model, camera/pacing, artifacts). All dimensions pass AND a
   candidate already exists → immediate `finish("pass")`.
2. **`act-N`** — a bounded (`MAX_ACT_TURNS = 8`) tool-use conversation
   over the full `DIRECTOR_TOOLS` registry; free setting changes execute
   inline, paid calls are budget-gated first, `generate_candidate_clip`
   renders through `renderDirectedClip` to the run's candidate key.
3. **`frames-N`** — if a fresh candidate was rendered this iteration, 4
   evenly spaced JPEG frames are sampled and persisted to the run's R2
   prefix (`frame-0..3.png`) for next iteration's vision context.
4. A round that acts on nothing actionable (`!acted.actedThisIteration`)
   exits with a `note` event ("No further actionable changes —
   stopping.") instead of re-assessing unchanged state (stuck-guard).

Terminal states: `awaiting_approval` (verdict + candidate, or a
best-effort verdict at budget/iteration exhaustion — see `finalizeRun`'s
"finish-integrity backstop": a hallucinated `"pass"` with no actual
candidate on the fresh run row is silently downgraded to
`"best_effort"`), `stopped` (the stop flag was set between steps —
checked at up to two points per iteration, before `assess` and again
before `act`, so a stop request shrinks but does not fully close the
window before a paid `act` step could start; a stopped run's
candidate-so-far, if any, is still approvable), or `failed` (an
unrecoverable error escaping every step — e.g. an Anthropic outage
surviving Inngest's own retry — caught once at the top level; spend
already persisted incrementally is left as-is).

**Approve** (`POST .../director/resolve {action:"approve"}`) — requires a
`resolvableRunForShot` (`awaiting_approval` or `stopped`) with a
`clipCandidatePath`. The status is claimed **first**, via
`claimRunApproval`'s conditional `UPDATE … WHERE status IN
('awaiting_approval','stopped') AND clip_candidate_path IS NOT NULL`
(0 affected rows → 409 "already resolved", never retried). Only the
claim's winner may then execute `promotionPlan`'s R2 copies + shot patch;
a failure after the claim is compensated best-effort — an `error` event
is appended, the run's status is restored to whatever it was
**pre-claim** (not hardcoded back to `awaiting_approval` — a `stopped`
run that failed to promote must not resurrect as `awaiting_approval`),
and a 500 is returned; a retried approve safely re-runs the (idempotent,
overwrite-only) copies and patch. Checked proposals
(`approvedProposalIds`, integer indexes into the run's `proposals` array)
are applied last, each as an independent per-entity description update —
one bad proposal never un-promotes the already-committed clip.

**Reject & retry** — `resolve {action:"reject", note?}` appends the note
onto `guidance` (`buildRejectionGuidance`) and flips to `rejected` via the
same claim-first race guard (`claimRunRejection`); the client then
immediately issues a fresh `POST .../director` with `retryOfRunId` set to
the rejected run, which seeds the new run's `guidance` verbatim from the
old run (now carrying the accumulated feedback) when the caller doesn't
supply its own.

**Dismiss** — `resolve {action:"dismiss"}` flips to `rejected` without
touching `guidance` or applying anything; the feed collapses to a history
row (`directorHistoryLabel`: `"Last run: {status} · ${spent} spent"`).

## Budget semantics

All-inclusive metering into `spentUsd`: every Anthropic `messages.create`
call's `usage` is priced by `usageCostUsd` (Sonnet rate card — **$3/M
input tokens, $15/M output tokens**, `director-budget.ts`) and added via
`addRunSpend` + a `cost` event on every call, free or not (zero-cost
usage is a no-op). Every registry tool declares its own
`estCostUsd(input, ctx?)` — 0 for every setting-change tool,
`generate_candidate_clip`'s is dynamic (`estClipUsd(scratchModelSpec,
resolveClipDuration(...))`, mirroring F-19's own pricing), `edit_start_
image`/`create_custom_end_frame`/`generate_entity_sheet` are flat
`~$0.04` (FLUX Kontext).

**Enforcement is executor-side, not model-side**: before any paid tool's
`execute()` runs, `runOneToolCall` re-reads the run row fresh and calls
`assertWithinBudget(freshRun.spentUsd, freshRun.budgetUsd, est)`. A
refusal is a structured tool result (`{ok:false, refusal:"Over budget: …
named numbers…"}`) plus an `error` event — Claude sees it and, per the
system prompt's budget-discipline instructions, is expected to adapt or
call `finish("best_effort")`; the budget itself can never be exceeded
regardless of what the model does next. Assess/act step replay under
Inngest's own retry can double-meter Claude token spend for a
re-executed step (accepted — the budget cap still holds because every
gate check re-reads the DB fresh, it just means a replay can look more
expensive in the ledger than the API actually charged).

## Security

- **Full house stack, every route:** rate limit (`"generation"` preset on
  start's `POST`, `"mutation"` on stop and resolve) → `verifyCsrf()` →
  `getSession()` → 401 → UUID param validation → ownership join
  (`projects.userId`, 404 not 403 — IDOR-hiding convention unchanged).
- **Tool input validation mirrors the human routes exactly:**
  `isCameraMove`/`isCameraStrength` (camera), the fixed `endsOn` enum,
  `isClipModelId` + `spec.durations.includes()` (model/duration),
  `entityTypeEnum.enumValues` (entity type), 500-char caps on every
  free-text field (`negativePrompt`, Kontext `instruction`, `guidance`,
  resolve `note`, `propose_entity_update`'s `rationale`/`newValue`). The
  model has **no capability a user's own PATCH/POST routes lack**, except
  writing into its own run's R2 prefix.
- **Model-supplied text never reaches keys or logs:** every director R2
  key is server-constructed (`candidateKey(file)` =
  `projects/{p}/shots/{s}/director/{runId}/{file}`, `file` is always a
  fixed literal like `"candidate.mp4"`/`"scratch-image.png"`, never
  model input); tool call inputs land only in `director_events.payload`
  (an internal, ownership-scoped, append-only log the poll route serves
  back to the owning user) and in Anthropic API request bodies — never in
  `console.log`/error messages surfaced to another user.
- **`propose_entity_update` never writes shared state directly** — the
  registry's `sharedStateEdit: true` flag (verified by a dedicated unit
  test: exactly one tool carries it) is the only tool whose `execute()`
  calls `ctx.addProposal` instead of a DB write; approval of a proposal
  happens only inside the resolve route's `applyApprovedProposals`, gated
  by the same `WHERE project_id = …` ownership scoping as every other
  entities-table write in the app.
- **`tag_entity`/`untag_entity` are the only Stage-1/2 tools that write a
  REAL row outside the run's scratch** (`shots.referencedEntityIds`) —
  by design, additive/subtractive and immediately visible outside the
  run, mirroring the human shot-PATCH route's own cap (8 tagged
  entities) and ownership check.
- **Race safety on resolve:** `claimRunApproval`/`claimRunRejection` are
  conditional `UPDATE`s whose affected-row count IS the concurrency
  guard — two simultaneous `approve` calls (or an `approve` racing a
  `reject`/`dismiss`) can only have one winner; the loser gets a 409, not
  a silent double-apply. Promotion side effects (R2 copies, shot patch)
  only ever run after the claim is already won.
- **One active run per shot enforced at two layers:** the route's
  pre-check (`activeRunForShot`) plus the `director_runs_one_active_per_
  shot` partial unique index — a double-start would otherwise be a real
  double-spend (2× budget against the same shot).
- **No client-supplied R2 keys or fal URLs:** every key the loop reads or
  writes is server-derived from the run/shot/project ids; reference image
  URLs for clip generation are resolved the same way F-19 resolves them
  (tagged entities → ready sheets → `uploadR2ObjectToFal`), never from
  client input.
- **No new secrets:** `ANTHROPIC_API_KEY` (existing, Sonnet vision calls)
  and `FAL_KEY` (existing, Kontext/clip calls) cover every provider call
  this feature makes; no new environment variables were introduced.

## Limitations

From the spec's §Known limitations (2026-07-11-ai-director-design.md):
- **The budget cap is the hard guarantee; the quality bar is Claude's
  judgment.** A `"pass"` verdict means the model believed every dimension
  passed, not an independently verified guarantee.
- **Frame sampling (4 frames) can miss brief mid-clip artifacts** between
  samples — vision review only sees 0/33/66/100% of the candidate, not
  every frame.
- **Inngest mid-step retries may re-roll an AI decision** (accepted, same
  class of nondeterminism as F-18's chain-suggestion step) — a replayed
  `assess-N`/`act-N` step re-calls Claude and can get a different
  response than the original attempt.
- **One run per shot at a time; runs are per-shot** — no cross-shot batch
  directing in v1 (enforced by the partial unique index above).
- **Vision/token costs (~$0.02–0.05/iteration) are metered into
  `spentUsd`** — a run's total spend includes Claude usage, not just paid
  tool calls.

Inherited/implementation-level limitations noted in the progress ledger
(`.superpowers/sdd/progress.md`, AD Task entries) and accepted as-is for
this release:
- **Stop-flag window is shrunk, not eliminated.** The stop flag is
  re-read fresh (outside any `step.run`) at up to two points per
  iteration — before `assess-N` and again before `act-N` — but a stop
  requested mid-`act-N` still lets that iteration's already-in-flight
  paid tool calls complete; the loop only stops cleanly at the next
  boundary. The budget cap remains the hard backstop regardless.
- **`record_critique`/`finish` don't shape-check their inputs before
  persisting** (Task 4 final-review note) — Claude is schema-honest via
  the Anthropic tool-use contract today, so this is a latent gap, not an
  active bug; would need a guard if any other caller ever fed these
  tools directly.
- **`tag_entity`/`untag_entity` blind-overwrite `referencedEntityIds`
  from the scratch snapshot** (Task 11 final-review note) — mirrors the
  human PATCH route's own last-writer-wins semantics for this field, an
  inherited pattern rather than a director-specific gap.
- **Storyboard 🎬 badges only populate for shots the session has polled**
  (Task 14 final-review note) — `directorState` is lazily filled per
  selected shot, so a run active on a shot the user hasn't opened this
  session shows no badge until it's selected at least once.
- **The verdict card component is ~363 LOC** (>~150 LOC guideline;
  flagged, not split, in Task 14's final review) — cohesive single
  concern (candidate + diff + proposals + three resolve actions), no
  obvious seam that wouldn't just relocate the LOC.

## Extensibility how-to

**The registry is the whole extensibility surface.** Everything else in
this feature — the Anthropic `tools` array the model sees
(`toAnthropicTools()`), the system prompt's capability inventory
(`capabilityInventory()`), the budget meter (`estCostUsd` per tool), and
what shows up in the feed as an `action` event (`recordAction`'s shared
helper) — is generated from `DIRECTOR_TOOLS` at runtime. **Adding a
future directing control = adding one `DirectorTool` entry to
`src/lib/director/director-tools.ts`.** No other file needs to change.
This is CI-enforced: `director-tools.test.ts`'s registry-invariant suite
asserts every entry has a non-trivial `description`, a truthy
`inputSchema`, and a callable `estCostUsd` — a new tool that forgets one
of these fails the build.

**Worked example — adding a hypothetical `set_aspect_ratio` control**
(assume F-19-style support already exists: an `AspectRatio` type, an
`isAspectRatio` guard, and `scratch.aspectRatio` already threaded through
`DirectingSettings`/`renderDirectedClip`, the same way `cameraMove` is
today):

```ts
// in DIRECTOR_TOOLS, alongside set_camera_move / set_clip_duration / …
{
  name: "set_aspect_ratio",
  description:
    "Sets the clip's aspect ratio (16:9, 9:16, or 1:1). Free — no cost.",
  inputSchema: {
    type: "object",
    properties: {
      aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
    },
    required: ["aspectRatio"],
  },
  estCostUsd: () => 0,
  execute: async (ctx, input) => {
    const value = input.aspectRatio;
    if (!isAspectRatio(value)) {
      return { ok: false, message: `Invalid aspect ratio: ${JSON.stringify(value)}.` };
    }
    ctx.scratch.aspectRatio = value;
    return recordAction(ctx, "set_aspect_ratio", input, `Aspect ratio set to ${value}.`);
  },
},
```

That single entry is immediately: callable by Claude (added to `tools`
automatically), described to Claude in the system prompt (added to
`capabilityInventory()` automatically), free per the budget gate (`() =>
0`), and rendered in the live feed as `🔧 Aspect ratio set to 16:9.` (via
the shared `recordAction` → `action` event → `DirectorFeedLine`'s `case
"action"` in `inspector.tsx`) — with zero changes to `direct-shot.ts`,
`director-run.ts`, `director-context.ts`, or any UI file. If the field
should also promote onto the shot on approve, the one additional change
is threading it through `promotionPlan`'s `shotPatch` in
`director-resolve.ts`, mirroring how every other scratch field is copied
there today.

## Dependencies
- **External services:** Anthropic (`claude-sonnet-5`, vision + tool use,
  new to this feature — the app's Haiku usage for chain-suggestion/
  motion-enrichment is unchanged and separate), fal.ai (reused from F-19:
  `fal-ai/flux-pro/kontext` for the two Kontext director tools and
  `generate_entity_sheet`; the clip model registry for
  `generate_candidate_clip`), Cloudflare R2, Inngest (`direct-shot`
  function, `shot/director.run` event).
- **Shared utilities:** `src/lib/shot-clip-generation.ts`
  (`DirectingSettings`, `settingsFromShot`, `renderDirectedClip`,
  `loadOrderedProjectShots`), `src/lib/shot-frame-edit.ts`
  (`runKontextEditToKey`, `FRAME_EDIT_INSTRUCTION_MAX_CHARS`),
  `src/lib/clip-camera.ts`/`clip-models.ts` (enums + cost/duration
  resolution), `src/lib/entity-sheet-generation.ts`
  (`generateEntitySheet`), `src/lib/r2.ts` (`copyObject`,
  `getDownloadUrl`), `src/lib/api-utils.ts` (session/CSRF/rate-limit/UUID
  helpers, `isValidUUID`).
- **New dependency:** `ffmpeg-static` (frame extraction for candidate
  vision review — `src/lib/director/frame-sampler.ts`).
- **Feature coupling:** F-19 Directing Controls — this feature is a pure
  consumer of its registry/settings/rendering modules; it introduces no
  parallel clip-rendering, camera-suffix, or duration-resolution logic.

## Coding Patterns Used
- **Single declarative registry, single derivation rule, continued from
  F-19's "single registry, single allow-list gate" pattern** —
  `DIRECTOR_TOOLS` is the one place a tool's schema, cost, and validation
  live; the Anthropic tool list, system-prompt inventory, and feed
  rendering are all generated from it, never duplicated.
- **Pure-decision / effectful-caller split, continued** —
  `promotionPlan`, `buildRejectionGuidance`, `buildBriefingText`,
  `usageCostUsd`, `assertWithinBudget` are all pure and directly unit
  tested with no DB/network; the resolve route, the Inngest loop, and
  `gatherBriefingImages` are the effectful callers.
- **Claim-before-side-effects** — both `claimRunApproval` and
  `claimRunRejection` are conditional `UPDATE`s executed *before* any
  R2/DB side effect, so the affected-row count is the single source of
  truth for who "won" a concurrent resolve — the same shape as F-18/F-19's
  batch-idempotency guards, generalized to a two-actor race instead of a
  retry-safety check.
- **Scratch-copy-then-promote, new to this feature** — the director never
  mutates the shot's real row mid-run; it works on an in-memory
  `DirectingSettings` copy (`settingsFromShot(shot)`) and a run-prefixed
  R2 candidate key, and only `promotionPlan` (on approve) ever writes the
  scratch state onto the shot's real columns/keys. This is the structural
  reason approval is safe to retry and rejection is a true no-op.
- **Degrade-loudly, never fail, continued** — a budget refusal, a tool
  validation failure, or a missing reference image never throws or fails
  the run; each becomes a structured result Claude sees (or, for images,
  a silently skipped source) and the loop continues.
- **Keys-not-URLs in persisted state** — critique events store R2 keys,
  never presigned URLs, with presigning happening fresh at GET-time; the
  same reasoning F-19 applied to never persisting a fal-facing URL
  applies here to never persisting an expiring R2 URL.

## Tradeoffs

```md
## Tradeoffs
- Storyboard 🎬 badges only populate for shots selected at least once
  this session (directorState is lazily polled per-shot, not eagerly for
  the whole project) — a run active on an unselected shot shows no badge
  until the user clicks it.
- The verdict card (director-verdict-card.tsx) is ~363 LOC, over the
  ~150 LOC guideline — flagged at final review as a single cohesive
  concern (candidate + diff + proposals + three resolve actions) with no
  obvious split point, not fixed in this release.
- Assess/act Inngest step replay can double-meter Claude token spend for
  a re-executed step (the budget cap still holds — every gate re-reads
  spentUsd fresh from the DB — but the ledger can show more spend than
  Anthropic actually billed on a replay).
- The stop flag is checked at iteration boundaries (before assess, before
  act), not mid-step — a stop requested while an act step's paid tool
  call is in flight still lets that one call complete before the loop
  exits at the next boundary.
- record_critique/finish trust their tool_use input's shape without an
  explicit runtime schema check beyond what Anthropic's own tool-use
  contract guarantees — acceptable because Claude is currently the only
  caller of these two tools.
- tag_entity/untag_entity overwrite shots.referencedEntityIds wholesale
  from the run's scratch snapshot rather than a diff-based patch —
  mirrors the human PATCH route's existing last-writer-wins semantics for
  this field, not a director-specific gap.
```

## Known limitations
- **Budget is the hard guarantee; quality is Claude's judgment** — see
  spec §Known limitations.
- **4-frame sampling can miss brief mid-clip artifacts.**
- **Inngest step replay can re-roll an AI decision** (accepted, same
  class as F-18's chain-suggestion nondeterminism).
- **One run per shot at a time** — no cross-shot batch directing in v1.
- **Vision/token costs are metered into spentUsd** (~$0.02–0.05/iteration
  on top of any paid tool calls).
- **Stop-flag window is shrunk (two boundary checks per iteration), not
  eliminated** — see Tradeoffs.
