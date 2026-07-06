# v4.0 Phase 3 — Batch "Generate all" (Design)

**Date:** 2026-07-06
**Status:** Approved design, pre-implementation
**Parent spec:** [`2026-06-13-unified-directing-editor-design.md`](2026-06-13-unified-directing-editor-design.md) §7 "Batch Generate all"
**Roadmap:** [`../plans/2026-06-13-v4-unified-editor-roadmap.md`](../plans/2026-06-13-v4-unified-editor-roadmap.md) Phase 3
**Depends on:** Phase 2 (unified editor, shipped 2026-07-03) + Phase 4 (Reference Bible, shipped 2026-07-04)

## 1. Summary

One "Generate all" button in the unified editor turns per-shot assembly into
directing: a cost-preview + confirm dialog, then a server-side fan-out that
generates missing entity reference sheets first, then missing shot images
(entity-conditioned via the existing per-shot route logic), then — if opted
in — missing clips. Per-item status surfaces live in both Timeline and
Storyboard views through the existing shared store.

## 2. Scope decisions (locked with user, 2026-07-06)

| Decision | Choice |
|---|---|
| Clips | **Images + optional clips toggle** in the confirm dialog, itemized separately |
| Targeting | **Missing-only**: items with status `pending` or `failed`; `done` items are never re-billed |
| Retry | Re-running "Generate all" (missing-only picks up failures) + existing per-item generate buttons |
| Orchestration | **Inngest batch** (approach A) — durable, retrying, follows the existing `generate-music` pattern |
| Progress transport | Polling while a batch is live; SSE stays in backlog |

**Out of scope:** VO (re-)generation, multi-entity conditioning, cancel-mid-batch,
SSE streaming, regenerate-everything mode, final render/export.

## 3. Targeting rules (computed server-side, both preview and dispatch)

- **Sheets:** entities that are *tagged in at least one shot* (`referencedEntityIds`)
  with `referenceStatus ≠ done`.
- **Images:** shots with `imageStatus` ∈ {`pending`, `failed`}.
- **Clips** (only when `includeClips`): shots with `clipStatus` ∈ {`pending`,
  `failed`} whose image is `done` *or is being generated in this batch's image
  wave* (evaluated at wave-3 time: clip generates only if the image actually
  ended `done`).

Items already `generating` are skipped (double-dispatch guard).

## 4. API surface (two new routes, no schema changes)

### `GET /api/projects/[id]/generate-all/preview`
Auth + ownership. Returns itemized counts × per-unit estimates:

```json
{
  "sheets": { "count": 3, "estUsd": 0.12 },
  "images": { "count": 41, "estUsd": 1.64 },
  "clips":  { "count": 78, "estUsd": 21.84 },
  "batchRunning": false
}
```

Per-unit prices live in a new `src/lib/generation-costs.ts` constants module
(FLUX sheet, FLUX Kontext image, LTX clip). They are **estimates** and the UI
labels them as such.

### `POST /api/projects/[id]/generate-all`
Body `{ includeClips: boolean }` (manual parse + validation — this repo has
no zod; matches every existing route's body handling). Auth + ownership + CSRF +
rate-limit, matching every existing mutation. Recomputes targeting server-side
(never trusts client counts). **No-op with 409 if a batch is already running**
(any targeted row currently `generating`). Sends one Inngest event
`project/batch.generate` with data `{ projectId, includeClips }` — IDs only,
no prompts/secrets in event payloads. Returns the dispatched counts.

## 5. Inngest orchestrator

One function (`src/inngest/functions/generate-batch.ts`), `retries: 1` at the
step level (cost-conscious: paid calls are not aggressively re-billed).
Follows the `generate-music` pattern: each unit of work is a `step.run` that
flips the existing per-row status column.

Three sequential waves, each internally bounded at **~3 concurrent paid calls**:

1. **Wave 1 — sheets.** For each targeted entity: set `referenceStatus =
   generating`, run the same service logic as
   `POST /entities/[entityId]/reference`, set `done`/`failed`.
2. **Wave 2 — images.** For each targeted shot: same service logic as
   `POST /shots/[shotId]/image` — primary-entity conditioning therefore comes
   for free, including the existing fallback: if an entity's sheet **failed**
   in wave 1, its shots still generate, unconditioned, rather than blocking.
3. **Wave 3 — clips** (only if `includeClips`). Default **LTX** provider
   (same as the editor's default per-shot clip route). Skips shots whose image
   did not end `done`.

A failed item sets its row `failed` and **never halts the batch**. The
function re-verifies the project exists before the first paid call. Batch
progress is **derived from row statuses** — no new tables, no batch entity.

**Refactor note:** where the existing per-item routes hold their generation
logic inline, extract it into shared `src/lib/` service functions so route and
orchestrator call one implementation — no parallel abstractions.

## 6. UI

- **Button** top-right in the unified editor ("Generate all").
- **Confirm dialog:** itemized lines (N sheets ≈ $x, N images ≈ $y), an
  "Also generate clips" checkbox adding its own line, a total, and an
  "estimates" note. Confirm calls the POST; the dialog reflects
  `batchRunning` by disabling dispatch.
- **While running:** the button becomes a progress indicator
  ("Generating 12/86…") driven by polling project shots/entities every few
  seconds. Polling stops when no row is `generating`.
- **On-load batch detection:** the editor starts polling on mount whenever any
  row is already `generating` — a closed and reopened tab resumes showing
  live progress. (The browser is only a viewer; the batch runs server-side.)
- Timeline chips and Storyboard cards already render per-row statuses from the
  shared store, so every shot fills in live in **both views** with no extra
  sync work.
- **Failed items** show through the existing failed-status affordances; retry
  is the existing per-item button or re-running "Generate all".

## 7. Error handling & security

- Per-item failure → row `failed`, surfaced in both views; batch continues.
- POST guards: session auth, project ownership, CSRF, rate limit, zod body
  validation, double-dispatch 409.
- All targeting and cost math server-side; client counts are display-only.
- Inngest event payloads carry only `{ projectId, includeClips }`.
- If the Next.js process restarts mid-batch, the Inngest server retries the
  pending step until the app is reachable, then resumes; completed steps are
  not re-run or re-billed.
- Security review against `security-playbook.md` before merge, per house rules.

## 8. Verification plan (cost-conscious, per house rules)

- `npx tsc --noEmit`, `npm run lint` per task; no schema changes expected.
- Curl the preview endpoint (auth'd) and assert itemization matches a psql
  count.
- Live end-to-end on a **small throwaway project** (2–3 short beats, 1 tagged
  entity): full run with clips toggle off, then a failure-path check, then a
  minimal clips-on run. Requires `npx inngest-cli dev` alongside `next dev`.
- Only after that, a missing-only run sanity check against Project T (should
  be cheap by definition — it only fills gaps).
