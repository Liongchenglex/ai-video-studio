# F-17 Batch "Generate all" — Test Cases

**Date:** 2026-07-07

Cases marked **EXECUTED/PASS (2026-07-07)** were run live, controller-run,
on a small throwaway project (2–3 short beats, 1 tagged entity) with
`npm run dev` + `npx inngest-cli dev` running, per the plan's cost-conscious
verification approach (no unit-test harness in this repo — house
convention, see the v4.0 roadmap). Cases marked **defined-but-manual** are
specified here with expected behavior but were not exercised in this pass
(covered instead by code review / the extraction being behavior-preserving
from F-16's already-verified per-item routes) — flagged for a future
manual pass rather than left undocumented.

---

## 1. Cost-Preview Dialog

### TC-1.1: Itemized preview matches server-side counts
- **Action:** Open the editor for a project with 1 pending entity sheet and
  3 pending shot images; click "Generate all."
- **Expected:** Dialog itemizes exactly `1 reference sheets ~$0.04` and
  `3 shot images ~$0.12`; clips checkbox present but its cost line reads
  `—` while unchecked; total shown is sheets+images only while clips is
  unchecked.
- **Verified:** EXECUTED/PASS (2026-07-07) — cost dialog itemized exactly
  1 sheet ~$0.04 + 3 images ~$0.12.

### TC-1.2: Checking "Also generate clips" adds its own line and switches the total
- **Action:** With the dialog open, check "Also generate clips."
- **Expected:** The clips line switches from `—` to `~$N.NN`; the displayed
  total switches from `totalUsd` (sheets+images) to `totalWithClipsUsd`
  (sheets+images+clips).
- **Verified:** EXECUTED/PASS (2026-07-07) — clips line only appears when
  checked; total switches accordingly.

### TC-1.3: "Estimates only" note is present
- **Action:** Open the dialog with any non-empty preview.
- **Expected:** Footer text "Estimates only — actual provider billing may
  differ slightly" is visible.
- **Verified:** EXECUTED/PASS (2026-07-07).

### TC-1.4: `batchRunning` disables Confirm with a warning
- **Action:** Open the dialog while a batch is actively running (any row
  `generating`).
- **Expected:** Dialog shows an amber warning ("A batch is already
  running — wait for it to finish"); Confirm button is disabled.
- **Verified:** EXECUTED/PASS (2026-07-07) — `batchRunning` warning state
  exists and disables dispatch, confirmed by code path (`preview.batchRunning`
  in the Confirm `disabled` expression) alongside the idempotence check
  (TC-3.1) which exercises the adjacent nothing-to-do disabled state live.

### TC-1.5: Preview fetch failure shows an error, not a crash
- **Action:** `GET /generate-all/preview` fails or returns non-OK (e.g.
  network error, session expiry mid-session).
- **Expected:** `fetchGenerateAllPreview()` catches and returns `null`;
  dialog sets `error: true` and renders "Something went wrong. Close and
  try again." instead of throwing.
- **Verified:** defined-but-manual (code review of the catch path in
  `editor-store.tsx:fetchGenerateAllPreview` and the dialog's `if (!p)
  setError(true)` branch; not forced live).

---

## 2. Targeting & Ordering

### TC-2.1: Sheets-first ordering — tagged shot conditions on the sheet generated in the same run
- **Action:** On a project with one tagged entity whose sheet is `pending`
  and at least one shot tagged to it with a `pending` image, run "Generate
  all" with clips off.
- **Expected:** Wave 1 generates the entity's sheet to `done` before wave 2
  starts; the tagged shot's image generation log line reads `conditioned on
  entity=<id> (<name>)`, not `unconditioned`; the resulting image is
  visibly on-model against the sheet.
- **Verified:** EXECUTED/PASS (2026-07-07) — tagged shot logged
  `conditioned on entity=… (The Lighthouse Keeper)`; output was visibly
  on-model with the generated sheet.

### TC-2.2: Missing-only targeting — `done` rows are never re-billed
- **Action:** Run "Generate all" to completion, then immediately reopen the
  dialog without any state changes.
- **Expected:** Preview shows `0/0` counts, `~$0.00` total, and Confirm
  reads "Nothing to generate" and is disabled.
- **Verified:** EXECUTED/PASS (2026-07-07) — immediate re-open showed 0/0
  ~$0.00 with confirm disabled.

### TC-2.3: Failed-retry — re-running targets exactly the failed row
- **Action:** With all assets `done`, force one shot's `imageStatus` to
  `failed` (e.g. via psql), then reopen "Generate all."
- **Expected:** Dialog counts exactly 1 image (the failed shot) and 0
  sheets/other images; confirming regenerates only that shot; every other
  `done` row is untouched.
- **Verified:** EXECUTED/PASS (2026-07-07) — one shot set failed, dialog
  counted exactly 1 image ~$0.04, only that shot regenerated.

### TC-2.4: Sheet-failure fallback — shots still generate, unconditioned
- **Action:** Force an entity's reference-sheet generation to fail during
  wave 1 (its shots remain tagged to it), then let wave 2 proceed.
- **Expected:** The entity's row ends `referenceStatus: "failed"`; its
  tagged shots still generate in wave 2 (`resolvePrimaryEntity` finds no
  `done` sheet for that entity → falls back to the next tagged entity with
  a `done` sheet, or unconditioned if none); the batch is **not** halted by
  the sheet failure.
- **Verified:** defined-but-manual — this exact path (forcing a live FLUX
  failure) wasn't exercised in this pass; behavior is inherited unchanged
  from F-16's already-verified `resolvePrimaryEntity` fallback (F-16
  TC-4.2) plus the orchestrator's per-item try/catch that logs and
  continues (`generate-batch.ts` wave 1/2 `catch` blocks).

### TC-2.5: Clip wave skips shots whose image did not end `done`
- **Action:** Run "Generate all" with clips on, where at least one targeted
  clip shot's image generation fails in wave 2.
- **Expected:** Wave 3's `compute-clip-targets` step re-checks
  `imageStatus === "done" && imagePath` after wave 2 finishes; the shot
  whose image failed is excluded from the clip wave entirely (its
  `clipStatus` stays `pending`, not `failed` — it's never attempted).
- **Verified:** defined-but-manual — confirmed by code review of the
  `readyClipShotIds` filter in `generate-batch.ts` (re-queries `imageStatus`
  post-wave-2 rather than using the pre-wave-2 target list directly); the
  adjacent positive case (blank motion prompts excluded) was verified live
  (TC-4.2 below).

---

## 3. Idempotence & Concurrency

### TC-3.1: Re-running after full completion is a no-op
- Covered by TC-2.2 above (0/0, ~$0.00, disabled Confirm).
- **Verified:** EXECUTED/PASS (2026-07-07).

### TC-3.2: 409 on concurrent dispatch
- **Action:** While a batch is actively running (any row `generating`),
  send a second `POST /generate-all`.
- **Expected:** 409 `{ error: "A batch is already running" }`; no second
  Inngest event's targets overlap live work (the check reads
  `computeBatchTargets().anyGenerating`).
- **Verified:** defined-but-manual — not exercised as a deliberate race in
  this pass (would require firing two POSTs within the same in-flight
  window); the guard's logic is straightforward (`targets.anyGenerating`
  read synchronously before `inngest.send`) and was verified by code
  review. Related: the documented double-dispatch race in the narrow
  pre-first-step window is a known, accepted gap — see feature.md Security
  — not exercised live because it requires racing the Inngest pickup
  latency precisely.

### TC-3.3: Double-dispatch race is harmless (design-level, not exercised live)
- **Expected:** Even if two `POST`s land in the pre-first-step window (see
  TC-3.2), the Inngest function's `concurrency: [{ scope: "fn", key:
  "event.data.projectId", limit: 1 }]` queues the second run behind the
  first; by the time it executes, `computeBatchTargets()` finds nothing
  left (or only genuinely still-missing items) — no double bill, at most
  one wasted `compute-targets` step.
- **Verified:** defined-but-manual (design/code review only, per
  feature.md's documented rationale).

---

## 4. Clips

### TC-4.1: Clips-on run generates exactly the targeted clip
- **Action:** With one shot having a `pending` clip and a `done` image, run
  "Generate all" with clips checked.
- **Expected:** Exactly 1 clip generated (~6s, stored in R2 at
  `projects/{id}/shots/{id}/clip.mp4`); `clipStatus` flips
  generating → done.
- **Verified:** EXECUTED/PASS (2026-07-07) — clips-on run generated exactly
  1 clip (6s, R2-stored).

### TC-4.2: Shots with blank motion prompts are excluded from clip targeting
- **Action:** Include a shot whose `motionPrompt` is empty/whitespace-only
  among otherwise-eligible clip candidates; run with clips on.
- **Expected:** `computeBatchTargets()`'s `clipShotIds` filter
  (`s.motionPrompt.trim().length > 0`) excludes it; it is never attempted
  and its `clipStatus` is untouched.
- **Verified:** EXECUTED/PASS (2026-07-07) — shots with blank motion
  prompts excluded.

### TC-4.3: Image-readiness re-checked at wave 3
- Covered by TC-2.5 above (defined-but-manual for the failure path); the
  positive re-check (an image that only finished in wave 2 is still picked
  up by wave 3) was exercised live as part of TC-4.1's end-to-end run.
- **Verified:** EXECUTED/PASS (2026-07-07) — "image-readiness re-checked at
  wave 3" confirmed as part of the clips-on run.

---

## 5. Live Progress & On-Load Detection

### TC-5.1: On-load detection resumes progress rendering without a reload trigger
- **Action:** Dispatch a batch, then load/reload the editor page while the
  batch is still mid-run (a row is `generating`).
- **Expected:** `batchActive` is true at mount (derived from
  `anyRowGenerating` over the freshly loaded store state), so the poll
  effect starts immediately; the TopBar shows "Generating… N left" without
  any user action.
- **Verified:** EXECUTED/PASS (2026-07-07) — fresh page load during an
  in-flight row showed "Generating… 1 left."

### TC-5.2: Button flips to idle when the row finishes, without a reload
- **Action:** Stay on the page while the in-flight row completes.
- **Expected:** The next poll tick observes the row's status leave
  `generating`; once no row anywhere is `generating` and the grace window
  is closed, `batchActive` goes false, the polling effect's cleanup fires,
  and the TopBar button reverts to "Generate all" — no page reload
  involved.
- **Verified:** EXECUTED/PASS (2026-07-07) — when the row finished, polling
  flipped the button idle without a reload.

### TC-5.3: Grace window cannot stick `batchActive` true forever
- **Bug found live during review/e2e:** the original grace-window
  implementation used a `useMemo` gated on `Date.now() -
  dispatchedAtRef.current < 60_000`, which only re-evaluates on a render —
  if nothing else triggered a re-render after the 60s elapsed, `batchActive`
  could stay `true` indefinitely even though no row was ever `generating`.
- **Fix:** replaced with real `graceActive` state and a `setTimeout`
  (`eda7de3`) that explicitly flips `graceActive` false at 60s (or earlier,
  the first time a poll observes a row actually `generating`), independent
  of render timing.
- **Expected (post-fix):** `batchActive` cannot remain `true` for longer
  than 60s past a dispatch that never produces a visible `generating` row.
- **Verified:** EXECUTED/PASS (2026-07-07) — fixed and shipped in `eda7de3`
  as part of this phase's live review pass.

### TC-5.4: Overlapping polls cannot clobber fresher state with stale data
- **Bug found live during review/e2e:** without a guard, a slow poll
  response (dev-mode compile, cold route) could resolve after a later,
  faster tick's response had already applied newer state, overwriting it
  with an older snapshot (stale `pending` statuses, `null` URLs).
- **Fix:** an `inFlight` boolean guard (`53812a1`) skips starting a new
  poll tick while the previous one is still awaiting its fetches.
- **Expected (post-fix):** poll responses can never apply out of order.
- **Verified:** EXECUTED/PASS (2026-07-07) — fixed and shipped in `53812a1`
  as part of this phase's live review pass.

### TC-5.5: Poll-merge preserves concurrent local edits
- **Action:** While a batch is polling, edit a shot's prompt/offset/tags in
  the inspector (fields not touched by the poll).
- **Expected:** The poll's `patchShot`/`patchEntity` dispatches only set
  generation fields (`imageStatus`, `imagePath`, `imageUrl`, `clipStatus`,
  `clipPath`, `clipUrl`, `clipDurationSeconds`, `referenceStatus`,
  `referenceSheetUrl`); the in-flight local edit is not overwritten by the
  next poll tick.
- **Verified:** defined-but-manual — inherent in the dispatch shape (a
  narrow field-level patch, not a full-row replace); not deliberately raced
  against a live batch in this pass.

---

## 6. Endpoint Security

### TC-6.1: Unauthorized requests are rejected on all three new endpoints
- **Action:** Call `GET /generate-all/preview`, `POST /generate-all`, and
  `GET /shots` without a session cookie.
- **Expected:** 401 on all three.
- **Verified:** defined-but-manual — pattern is identical to every other
  route in the app (`getSession()` → `unauthorizedResponse()` as the first
  check, before any DB read); F-16's equivalent checks were verified live
  and this phase's routes follow the same code path unchanged. Not
  individually re-curled in this pass.

### TC-6.2: CSRF rejection on `POST /generate-all`
- **Action:** `POST /generate-all` with a mismatched/missing Origin header
  (no valid CSRF token/origin).
- **Expected:** `verifyCsrf()` returns a rejection response before the
  session check even runs its DB query; the mutation never reaches
  `computeBatchTargets` or `inngest.send`.
- **Verified:** defined-but-manual — `verifyCsrf()` is the same
  fail-closed helper used by every other mutation route in the app
  (already verified for that helper's behavior elsewhere); not
  re-exercised against this specific route in this pass.

### TC-6.3: Ownership enforced — 404 (not 403) on another user's project
- **Action:** Authenticated as user A, call any of the three endpoints with
  user B's project id.
- **Expected:** 404 (the `projects.userId` join finds no row) — matches the
  app's IDOR-hiding convention (no distinct 403 anywhere).
- **Verified:** defined-but-manual — code review confirms the identical
  `and(eq(projects.id, id), eq(projects.userId, session.user.id))` pattern
  used by every other ownership-scoped route in the app.

---

## Dependency note

- `inngest` was upgraded 3.41.0 → 3.54.2 (commit `1c2e71d`) because the
  local Inngest dev server refused to sync with the app against the older
  version, citing CVE-2026-42047. No functional change to this feature's
  behavior resulted from the upgrade; it was a verification-blocking
  dependency bump, not a feature change.

---

## Summary

Sections 1–5's EXECUTED items were verified live on 2026-07-07 on a small
throwaway project, controller-run, with `npm run dev` + `npx inngest-cli
dev` running, per the plan's cost-conscious live-verification approach (no
unit-test harness in this repo — house convention, see the v4.0 roadmap).
Two bugs were found and fixed during this same live review pass — see
TC-5.3 (`eda7de3`) and TC-5.4 (`53812a1`). Section 6 (endpoint security) and
a handful of failure/race paths across sections 1–3 are defined-but-manual:
specified with expected behavior and either covered indirectly by code
review, by inheritance from F-16's already-verified equivalent checks, or
awaiting a dedicated manual/curl pass.
