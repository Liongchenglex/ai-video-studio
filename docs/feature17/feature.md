# Feature: F-17 Batch "Generate all"

> **Status: SHIPPED 2026-07-07.**
> Branch `feat/v4-phase3-generate-all`. Plan:
> [`docs/superpowers/plans/2026-07-06-v4-phase3-generate-all.md`](../superpowers/plans/2026-07-06-v4-phase3-generate-all.md).
> Design: [`docs/superpowers/specs/2026-07-06-v4-phase3-generate-all-design.md`](../superpowers/specs/2026-07-06-v4-phase3-generate-all-design.md).
> Roadmap: [`docs/superpowers/plans/2026-06-13-v4-unified-editor-roadmap.md`](../superpowers/plans/2026-06-13-v4-unified-editor-roadmap.md) Phase 3.
> **Depends on:** Phase 2 (unified editor, shipped 2026-07-03) + Phase 4 /
> F-16 Reference Bible (shipped 2026-07-04) — batch generation calls the
> same shot-image route F-16 conditions on the primary tagged entity, so
> batch-generated images are entity-conditioned with no extra work here.

## Feature
- **Name:** Batch "Generate all"
- **Purpose:** Turn per-shot asset assembly into directing at project scale.
  One "Generate all" button shows an itemized cost preview (sheets, images,
  optional clips), then dispatches a durable server-side fan-out that fills
  in every missing asset: entity reference sheets first (so every tagged
  shot generates on-model in the same run), then shot images, then —
  if opted in — clips. Per-item status surfaces live in both Timeline and
  Storyboard views through the existing shared editor store, with no manual
  refresh.

## UX flow
1. **Button** — top-right "Generate all" in the unified editor's TopBar.
2. **Cost preview + confirm dialog** (`GenerateAllDialog`) — on open, fetches
   `GET /generate-all/preview` and itemizes: N reference sheets ≈ $x, N shot
   images ≈ $y, an "Also generate clips" checkbox that adds its own line
   (N clips ≈ $z) when checked, a running total that switches between
   images-only and images+clips totals, and an "estimates only — actual
   provider billing may differ slightly" note. If a batch is already running
   (`batchRunning`), the dialog shows a warning and disables Confirm. If
   there is nothing missing, Confirm reads "Nothing to generate" and is
   disabled.
3. **Confirm** — `POST /generate-all` recomputes targets server-side and
   fires one Inngest event; the dialog closes on success.
4. **Live per-item statuses** — while the batch runs, the TopBar button
   becomes a progress indicator ("Generating… N left") and the editor polls
   `GET /shots` + `GET /entities` every 5s, merging only generation fields
   (status/path/url) into the shared store. Because Timeline chips and
   Storyboard cards already render per-row status from that same store,
   every shot and entity fills in live in **both views** with no extra sync
   code.
5. **On-load detection** — a fresh page load (or reopened tab) during an
   in-flight batch starts polling immediately because `batchActive` is
   derived from row statuses already `generating` at mount — no separate
   "was a batch dispatched" flag needed for this case.
6. **Retry semantics** — failed items surface through the existing
   failed-status affordances (retry icon / redraw button) per row. There is
   no batch-level retry button; re-opening "Generate all" and confirming
   again picks up exactly the failed + still-pending rows (missing-only
   targeting), because `done` rows are never re-billed. The existing
   per-item generate buttons remain a second, narrower retry path.

## Key Files (as built)

Frontend:
- `src/components/editor/generate-all-dialog.tsx` — the cost-preview +
  confirm dialog described above.
- `src/components/editor/unified-editor.tsx` — TopBar "Generate all" /
  "Generating… N left" button, `batchRemaining` derivation, mounts
  `<GenerateAllDialog>`.
- `src/components/editor/editor-store.tsx` — `fetchGenerateAllPreview`,
  `generateAll`, `batchActive` (derived state + grace window), and the
  polling effect that merges fresh shot/entity generation fields into the
  shared store.
- `src/components/ui/dialog.tsx` — shadcn dialog primitive (added this
  phase; no prior dialog component existed in the app).

Backend:
- `src/lib/generation-costs.ts` — per-unit USD cost estimate constants
  (`SHEET_EST_USD`, `IMAGE_EST_USD`, `CLIP_EST_USD`) and
  `estimateBatchCost()`.
- `src/lib/batch-targeting.ts` — `computeBatchTargets(projectId)`: the one
  missing-only targeting computation shared by the preview endpoint, the
  dispatch endpoint, and the Inngest orchestrator.
- `src/lib/entity-sheet-generation.ts` — `generateEntitySheet()`, extracted
  from the entity reference route; owns the `referenceStatus` lifecycle.
- `src/lib/shot-image-generation.ts` — `generateShotImage()` +
  `resolvePrimaryEntity()`, extracted from the shot image route; owns the
  `imageStatus` lifecycle and primary-entity conditioning.
- `src/lib/shot-clip-generation.ts` — `generateShotClip()`, extracted from
  the shot clip route; owns the `clipStatus` lifecycle, LTX-2.3 provider.
- `src/inngest/functions/generate-batch.ts` — the three-wave orchestrator
  (`generateBatchFn`).
- `src/inngest/index.ts` — registers `generateBatchFn` in the functions
  array.
- `src/app/api/projects/[id]/generate-all/preview/route.ts` — `GET`
  itemized cost preview.
- `src/app/api/projects/[id]/generate-all/route.ts` — `POST` dispatch.
- `src/app/api/projects/[id]/shots/route.ts` — gained a `GET` handler
  (existing file, previously `POST`-only) for polling read-back.
- `src/app/api/projects/[id]/entities/[entityId]/reference/route.ts`,
  `src/app/api/projects/[id]/shots/[shotId]/image/route.ts`,
  `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts` — refactored to
  call the extracted `src/lib/` services instead of holding generation
  logic inline; external request/response shape unchanged.

## Data Models
No schema changes this phase. Batch progress is entirely **derived from
existing row statuses** — no new batch/job table, no batch entity:
- `entities.referenceStatus` (`pending`/`generating`/`done`/`failed`) —
  wave 1 target and progress source.
- `shots.imageStatus`, `shots.clipStatus` — wave 2 / wave 3 targets and
  progress source.
- `shots.referencedEntityIds` — determines which entities are "tagged in
  ≥1 shot" and therefore in scope for wave 1.

## APIs (as built)

All auth-required (`getSession()` → 401) and ownership-scoped
(`projects.userId` join, 404 on any project the caller doesn't own — the
app's existing IDOR-hiding convention, no distinct 403).

| Method | Endpoint | Status codes | Notes |
|---|---|---|---|
| `GET` | `/api/projects/:id/generate-all/preview` | 200, 401, 400 (bad UUID), 404 | Itemized `{ sheets, images, clips, totalUsd, totalWithClipsUsd, batchRunning }`. Read-only, no CSRF/rate-limit (mirrors other list/preview GETs). |
| `POST` | `/api/projects/:id/generate-all` | 202 (dispatched), 200 (`dispatched:false, reason:"nothing-to-do"`), 409 (batch already running), 400 (bad UUID / bad body), 401, 404 | Body `{ includeClips: boolean }`. Recomputes targets server-side; never trusts client counts. Sends one `project/batch.generate` Inngest event. `generation` rate-limit preset + CSRF + session, matching every other mutation. |
| `GET` | `/api/projects/:id/shots` | 200, 401, 400, 404 | Full shot list with presigned `imageUrl`/`clipUrl` and status defaults; used by the store's polling loop (also usable standalone). |

## State & Ownership
- **Source of truth:** Neon `entities`/`shots` status + path columns; R2 for
  generated assets. There is no separate "batch" row — a batch's existence
  and progress are entirely inferred from these columns at read time.
- **Cached on client:** `batchActive` (derived boolean) and the polled
  generation fields (`imageStatus`, `imagePath`, `imageUrl`, `clipStatus`,
  `clipPath`, `clipUrl`, `clipDurationSeconds`, `referenceStatus`,
  `referenceSheetUrl`) merged into the same shared `entities`/`shots` state
  in `editor-store.tsx` that Timeline, Storyboard, and the inspector all
  read. The cost preview itself (`GenerateAllPreview`) lives only in the
  dialog's local state — it is fetched fresh every time the dialog opens
  and is never treated as authoritative by the dispatch call.

## Security
- **Auth required:** all three endpoints call `getSession()` → 401.
- **Ownership enforced on:** every read/write via a `projects.userId` join;
  the orchestrator re-verifies the project still exists (and is not
  soft-deleted) as its first step before any paid call.
- **CSRF:** `verifyCsrf()` on `POST /generate-all` (fail-closed), matching
  every other mutation. The two `GET`s carry no CSRF check, consistent with
  the app's existing read-only routes.
- **Rate limiting:** `generation` preset on `POST /generate-all` (same
  preset as the per-item generation routes it fans out to).
- **Server-side recomputation, never client-trusted:** both the preview
  endpoint and the dispatch endpoint call the same `computeBatchTargets()`;
  the dispatch endpoint ignores any counts the client might have cached
  from an earlier preview fetch and recomputes from scratch immediately
  before sending the Inngest event.
- **IDs-only event payload:** the Inngest event `project/batch.generate`
  carries only `{ projectId, includeClips }` — no prompts, no secrets, no
  entity/shot data. Each orchestrator step re-fetches the row it needs by
  id, scoped to `projectId`, immediately before acting on it.
- **Double-dispatch race — documented, and harmless by construction:**
  between a `POST /generate-all` returning 202 and the orchestrator's first
  `step.run` actually flipping a row to `generating`, no row is
  `generating` yet, so a second `POST` in that narrow window would pass the
  409 check and dispatch a second event. This is intentionally not closed
  with a lock, because the Inngest function declares
  `concurrency: [{ scope: "fn", key: "event.data.projectId", limit: 1 }]` —
  the second event queues behind the first rather than running concurrently
  — and by the time it runs, `computeBatchTargets()` is re-evaluated, so it
  finds nothing left to do (or only whatever is still missing). Worst case
  is one wasted `compute-targets` step, not a double bill.
- **Secrets:** `FAL_KEY` read only inside the extracted `src/lib/` services
  (server-side), unchanged from before the refactor.

## Cost estimates module
`src/lib/generation-costs.ts` holds three flat per-unit USD constants
(`SHEET_EST_USD = 0.04`, `IMAGE_EST_USD = 0.04`, `CLIP_EST_USD = 0.25`,
derived from observed fal.ai pricing for FLUX Kontext and LTX-2.3) and
`estimateBatchCost(counts)`, which multiplies and rounds to 2dp. This
module is **display-only**: it feeds the preview endpoint's response and
the dialog's line items, but has no bearing on what the orchestrator
actually does or what fal.ai actually bills — it is not a budget cap, not a
spend limit, and not reconciled against real invoices. The UI labels every
number "estimate."

## Architecture
- **Shared targeting module** (`batch-targeting.ts`) — one
  `computeBatchTargets()` used identically by the preview `GET`, the
  dispatch `POST`, and the orchestrator's `compute-targets` step, so the
  three can never disagree about what a batch covers. Missing = status
  `pending` or `failed` (a `null`/unset status is treated as `pending`);
  `done` is never re-billed; `generating` is skipped (already in flight).
  Sheets target entities that are tagged in ≥1 shot; images target shots
  with a non-empty `imagePrompt`; clips target shots with a non-empty
  `motionPrompt` — image readiness for clips is deliberately **not**
  checked at targeting time (wave 2 may fill it in the same run); the
  orchestrator re-checks `imageStatus === "done" && imagePath` at wave-3
  time instead.
- **Three extracted generation services**, one per asset type
  (`entity-sheet-generation.ts`, `shot-image-generation.ts`,
  `shot-clip-generation.ts`) — each owns its row's full
  `generating → done/failed` status lifecycle and throws after marking
  `failed`. The corresponding per-item route (`POST .../reference`,
  `POST .../image`, `POST .../clip`) and the Inngest orchestrator both call
  the same function — no parallel abstraction for the same concern, and the
  per-item routes' external behavior (response shape, status codes) is
  unchanged by the refactor.
- **Inngest orchestrator** (`generate-batch.ts`, function id
  `generate-batch`) — three sequential waves, each internally chunked at 3
  concurrent paid calls (`CHUNK_SIZE = 3`) to bound fal.ai concurrency:
  1. **Wave 1 (sheets)** — one `step.run` per targeted entity, calling
     `generateEntitySheet`.
  2. **Wave 2 (images)** — one `step.run` per targeted shot, calling
     `generateShotImage`; because wave 1 already finished, any sheet that
     completed conditions its shots for free. If an entity's sheet
     **failed** in wave 1, its shots still generate — unconditioned —
     rather than blocking the batch.
  3. **Wave 3 (clips)**, only when `includeClips` — re-derives the ready
     subset (`imageStatus === "done" && imagePath` at this point in time,
     which may include images that only just finished in wave 2) before
     fanning out `generateShotClip` calls.
  `retries: 1` at the step level (cost-conscious — paid calls are not
  aggressively re-billed on transient failure). A failed item marks its own
  row `failed` and the wave loop continues; nothing in the function halts
  the batch on a single item's failure. Per-project `concurrency: 1` at the
  function level.
- **Polling design** (`editor-store.tsx`) — `batchActive` is
  `anyRowGenerating || graceActive`. `anyRowGenerating` is a live memo over
  the store's own `entities`/`shots` state. `graceActive` is a boolean set
  `true` the instant `POST /generate-all` returns `dispatched: true`,
  covering the gap between the 202 response and the orchestrator's first
  status flip (Inngest pickup delay); it clears on the **first** poll
  response that shows any row actually `generating`, or after a **60s
  timeout** (`setTimeout`, cleared/reset on each dispatch and on unmount) —
  whichever comes first — so it can never stick `true` forever if the
  dispatched run dies before ever flipping a status. While `batchActive` is
  true, an effect polls `GET /shots` + `GET /entities` every 5s and merges
  only generation fields (`imageStatus`/`imagePath`/`imageUrl`/
  `clipStatus`/`clipPath`/`clipUrl`/`clipDurationSeconds`/
  `referenceStatus`/`referenceSheetUrl`) into the store, so in-flight local
  edits (prompts, offsets, tags) are never clobbered by a poll response. An
  `inFlight` guard skips starting a new poll tick while the previous one is
  still awaiting its fetches, so a slow response (dev-mode compile, cold
  route) can never resolve after a later, fresher tick and overwrite newer
  state with a stale snapshot.

## Coding Patterns Used
- **Missing-only targeting as a single shared computation** — the same
  pattern F-16 established for `resolvePrimaryEntity`: compute once, call
  from every caller that needs the same answer, so preview/dispatch/wave
  logic cannot drift apart.
- **Route-thin, service-owns-lifecycle extraction** — each of the three
  extracted `src/lib/` functions owns its row's full status transition
  (`generating` → `done`/`failed`) internally and is called identically by
  a thin HTTP route and a thin Inngest step; this is what let the
  orchestrator reuse F-16's entity-conditioning logic "for free."
- **Derived-state batch progress, no batch entity** — deliberately no new
  table; progress is a query over existing status columns, matching the
  design decision to avoid a parallel state machine.
- **Grace window + timeout escape hatch** — a UI affordance (avoid a
  flicker between dispatch and first visible progress) guarded by a real
  timer rather than an unbounded flag, so a bug in one place (missed
  status flip) can't strand the UI in a "running" state forever.

## Tradeoffs (honest)
- **`batchRemaining` label can undercount during a failed-retry window.**
  `batchRemaining` (TopBar "Generating… N left") counts rows currently
  `generating` plus shots still `pending`/`generating` on image status; a
  shot whose prior attempt ended `failed` is not counted until its
  re-dispatch actually flips it to `generating`, so the visible number can
  briefly read lower than the true remaining work until that row's step
  runs and the next poll picks it up.
- **Single-entity conditioning only** — inherited from F-16, out of scope
  to change here: a shot tagged with more than one entity still conditions
  on one primary entity (character type wins over tag order); multi-entity
  compositing remains backlog #17 (Reference Bible numbering).
- **No cancel-mid-batch.** Once dispatched, a batch runs to completion
  (or until every item has failed/succeeded); there is no cancel action in
  this phase (explicitly out of scope per the design doc).
- **Polling, not SSE.** Progress transport is 5s polling while
  `batchActive`; push-based streaming (SSE) is explicitly deferred to the
  backlog (design doc §2).
- **No batch-level retry UI.** Retry is "re-run Generate all" (picks up
  missing-only) or the existing per-item buttons — there is no dedicated
  "retry failed items" action scoped to one batch run.
- **Estimates are flat per-unit constants**, not live provider pricing —
  they will drift from actual fal.ai billing if per-unit prices change and
  are not designed to be reconciled against invoices; they exist purely to
  give the user an order-of-magnitude sense of spend before confirming.
- **Double-dispatch race is accepted, not eliminated** — see Security
  above; relies on Inngest's per-project function concurrency limit plus
  target recomputation, not a database lock, to make the race harmless.

## Dependencies
- **External services:** fal.ai (FLUX Kontext for sheets/images, LTX-2.3
  for clips — unchanged providers from F-16/existing per-item routes),
  Inngest (durable orchestration; `inngest` upgraded 3.41 → 3.54.2 this
  phase — the local Inngest dev server was blocking app sync on
  CVE-2026-42047 against the older version, commit `1c2e71d`), Cloudflare
  R2.
- **Shared utilities:** `src/lib/api-utils.ts` (session, CSRF, rate-limit,
  UUID validation), `src/lib/db/schema.ts`, `src/lib/r2.ts`
  (`getDownloadUrl`), `src/lib/image-generation.ts`, `src/lib/reference-sheet.ts`.
- **Feature coupling:** F-16 Reference Bible (entity-conditioning logic,
  `resolvePrimaryEntity`, `referenceStatus` lifecycle — reused, not
  reimplemented); F-08 unified editor (shared store, Timeline/Storyboard
  rendering of per-row status); F-04 image generation
  (`generateImage()`/FLUX Kontext).

## Known limitations
- `batchRemaining`'s TopBar count can show a stale/lower number for a
  failed-then-retried row until that row's own status flips (see
  Tradeoffs).
- Multi-entity conditioning per shot remains out of scope (F-16 backlog
  #17), so a batch run inherits the same single-primary-entity limitation
  as per-item generation.
- SSE/push progress transport remains in the backlog; polling is the only
  live-progress transport in this phase.
- No cancel-mid-batch and no batch-level "retry only failed" action —
  retry is always "re-run Generate all" or a per-item button.
