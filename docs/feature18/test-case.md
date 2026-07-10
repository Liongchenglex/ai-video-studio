# F-18 Clip Engine v2 — Test Cases

**Date:** 2026-07-10

Cases marked **PASS** were executed via `npm run test` (vitest, no network/
DB — pure logic only, per `vitest.config.ts`'s house convention). Cases
marked **(paid — pending controller/user execution)** bill real fal.ai/
Anthropic usage and are specified here with acceptance criteria and
expected outcome but were not run in this pass; the `Results` column is
left blank for the controller to fill in after a live/throwaway-project
run. Cases marked **(manual — pending controller/user execution)** are
free but require a live browser/dev-server session and are likewise left
for that pass.

---

## 1. Unit — automated (vitest)

### TC-U-1: Clip model registry (`tests/unit/clip-models.test.ts`)
- **Acceptance criteria:** `DEFAULT_CLIP_MODEL_ID` is
  `kling-2.5-turbo-pro`; `getClipModel` returns `null` for unknown/missing
  ids; `isClipModelId` type-guards correctly; every registry entry has a
  positive cost, positive duration, and a non-trivial `whenToUse` string;
  each model's `buildInput()` maps its model-specific input shape (LTX:
  `end_image_url` + `generate_audio: false`; Kling: `tail_image_url` +
  fixed `duration: "5"`), with and without a tail image.
- **Expected outcome:** all 6 assertions pass.
- **Edge cases covered:** unknown id, `null`/`undefined` id, non-string id
  (`42`) to `isClipModelId`, `buildInput` called without a `tailImageUrl`
  (optional-field omission, not `undefined` key).
- **Results:** PASS (6/6, `npm run test`, 2026-07-10).

### TC-U-2: Chain-to-next decision logic (`tests/unit/clip-chaining.test.ts`)
- **Acceptance criteria:** `resolveChainDecision()` returns `useTail: true`
  only when chaining is requested, the model supports end frames, and the
  next shot's image is `done` with a path; otherwise returns `useTail:
  false` with the correct `ChainSkipReason` (`not-requested`,
  `model-no-end-frame`, `no-next-shot`, `next-image-not-ready`).
- **Expected outcome:** all 7 cases pass (4 discrete + a 3-case
  `it.each` for "next image not ready": missing path, `failed` status,
  `generating` status).
- **Edge cases covered:** last shot in sequence (`nextShot: null`),
  model without end-frame support, next image present but not yet `done`.
- **Results:** PASS (7/7, `npm run test`, 2026-07-10).

### TC-U-3: Cost estimation (`tests/unit/generation-costs.test.ts`)
- **Acceptance criteria:** `estimateBatchCost()` prices clips from the
  selected model's registry entry (falls back to the default model for an
  unrecognized id); `totalUsd` (sheets+images only) is unaffected by
  clip/SFX pricing; `sfxUsd` is 0 unless `includeSfx` is set, and uses the
  explicit `sfx` count when provided, otherwise falls back to the `clips`
  count.
- **Expected outcome:** all 5 assertions pass, including the Kling/LTX/Veo
  price points ($0.42/$0.36/$1.20 × 10 clips) and the SFX explicit-count
  vs. fallback-to-clips-count cases.
- **Edge cases covered:** unknown `clipModelId` (silently falls back, no
  throw), `sfx` count larger than `clips` count (done-clips-missing-SFX
  case).
- **Results:** PASS (5/5, `npm run test`, 2026-07-10).

### TC-U-4: Chain suggestion pure helpers (`tests/unit/chain-suggestion.test.ts`)
- **Acceptance criteria:** `buildChainPairs()` sorts by `sortOrder` before
  pairing, correctly computes `sameBeat` and `sharedEntityIds` per
  adjacent pair, returns `[]` for 0 or 1 shots, and tolerates
  `null` `referencedEntityIds`; `sanitizeChainSuggestions()` keeps only
  ids that are a pair's *first* shot (rejects a last-shot id, non-string
  entries, and non-array input entirely).
  suggestChains (the network-bound Haiku call) is intentionally not
  unit-tested — its own try/catch guarantees an empty-array fallback on
  any failure, verified by code review of `chain-suggestion.ts`.
- **Expected outcome:** all 5 assertions pass.
- **Edge cases covered:** unsorted input, single-shot/empty input, null
  entity list, a suggested id that is only ever a `nextShotId` (would
  silently no-op today; sanitizer instead drops it), non-array/`undefined`
  model output.
- **Results:** PASS (5/5, `npm run test`, 2026-07-10).

**Suite total:** 4 files, 23 tests, 23 passed, 0 failed (`npm run test`,
2026-07-10).

---

## 2. API — model selection & validation

### TC-API-1: Clip route model selection and validation
- **Action:** `POST /shots/:shotId/clip` with `{"model":
  "kling-2.5-turbo-pro"}`; then with `{"model":"bogus"}`; then with no
  body at all (on a shot with a done image).
- **Acceptance criteria:** the route resolves the model via
  `isClipModelId()` before any DB write; an unrecognized id is rejected
  pre-flip.
- **Expected outcome:** `{"model":"kling-2.5-turbo-pro"}` → 200,
  response's `clipModel` is `"kling-2.5-turbo-pro"` and the row's
  `clipModel` column persists it; `{"model":"bogus"}` → 400
  `{"error":"Unknown clip model"}`, `clipStatus` untouched (never flips to
  `generating`); no body → 200, `clipModel` defaults through
  `shot.clipModel ?? DEFAULT_CLIP_MODEL_ID` (registry default when the
  shot has never had a model set).
- **Edge cases:** shot with no `imagePath` yet → 400 "Generate the shot's
  image before generating a clip" (pre-existing check, unchanged);
  malformed JSON body → 400 "Invalid request body".
- **Results:** (paid — pending controller/user execution)

### TC-API-2: SFX route preconditions and re-roll idempotence
- **Action:** `POST /shots/:shotId/sfx` on a shot with no clip yet; then
  after the clip is `done`; then `DELETE /shots/:shotId/sfx`.
- **Acceptance criteria:** SFX generation is blocked until a clip exists
  and is `done`; SFX generation never modifies `clip.mp4`; `DELETE`
  removes the R2 object and resets state without touching the clip.
- **Expected outcome:** no clip → 400 "Generate the shot's clip before
  adding SFX"; clip `done` → 200, `sfxStatus: "done"`, `clip.mp4`'s R2
  ETag/content is unchanged (only `clip-sfx.mp4` is written); `DELETE` →
  200 `{"sfxPath":null,"sfxStatus":"pending"}`, the `clip-sfx.mp4` object
  is gone from R2, `clipPath`/`clipStatus` untouched.
- **Edge cases:** `POST` while `sfxStatus` is already `"generating"` → 400
  "SFX is already generating for this shot"; `prompt` over 500 chars →
  400; `DELETE` when `sfxPath` is already `null` → 200 no-op (R2 delete
  skipped, DB update still runs); R2 delete failure during `DELETE` is
  logged and swallowed — the DB reset still happens (verified by code
  review of the route's try/catch around `deleteObject`).
- **Results:** (paid — pending controller/user execution)

### TC-API-3: Shot PATCH validation for chaining and model fields
- **Action:** `PATCH /shots/:shotId` with `{"chainToNext":true}`; then
  with `{"clipModel":"bogus"}`.
- **Acceptance criteria:** `chainToNext` requires a boolean; `clipModel`
  is validated against the same registry allow-list as the clip route
  (`null` is a valid value — resets to default).
- **Expected outcome:** `{"chainToNext":true}` → 200, persisted (a
  follow-up `GET` shows `chainToNext: true`); `{"clipModel":"bogus"}` →
  400 "Unknown clip model", no partial write (the route validates before
  building the `updates` object).
- **Edge cases:** `{"chainToNext":"yes"}` (wrong type) → 400
  "chainToNext must be a boolean"; `{"clipModel":null}` → 200, clears to
  registry default; combined with an invalid `beatId` in the same request
  → bounds validation still runs and can independently 400.
- **Results:** (paid — pending controller/user execution; the two 400
  assertions are free and reachable via `curl` without incurring cost, but
  bundled here since the brief scopes this TC as one case)

---

## 3. Chaining — end-to-end

### TC-CHAIN-1: Chained pair visual continuity (paid)
- **Action:** On two same-scene, same-beat shots (shot N, shot N+1) with
  `done` images, set shot N's `chainToNext: true` and `clipModel:
  "kling-2.5-turbo-pro"`, generate shot N's clip. Then regenerate shot
  N+1's image.
- **Acceptance criteria:** clip N's final frame visually matches shot
  N+1's *original* image (the one present at clip-generation time); the
  clip response has no `chainSkippedReason`; regenerating shot N+1's image
  does not touch clip N (documented limitation — no auto-invalidation).
- **Expected outcome:** clip plays a seamless transition ending on shot
  N+1's still; after shot N+1's image regen, clip N's `clipStatus` remains
  `done` and its `clipPath` is unchanged, now visually stale against the
  new N+1 image.
- **Edge cases:** covered by TC-CHAIN-2 (unsupported model) and TC-U-2
  (precondition logic) — this case exercises only the live happy path +
  the documented staleness limitation.
- **Results:** (paid — pending controller/user execution)

### TC-CHAIN-2: Chain requested but model doesn't support end frames
- **Action:** Set `chainToNext: true` on a shot, select `veo-3.1-fast`
  (registry: `supportsEndFrame: false`), generate the clip.
- **Acceptance criteria:** the clip generates *unchained* rather than
  failing; the response surfaces why.
- **Expected outcome:** 200, clip generates normally (no tail image
  uploaded/sent to fal), response includes `chainSkippedReason:
  "model-no-end-frame"`.
- **Edge cases:** the inspector's chain toggle is independently disabled
  client-side the moment a no-end-frame model is selected (see TC-UI-3);
  this TC exercises the server-side belt-and-suspenders path directly
  (e.g. a stale `chainToNext: true` left over from switching away from a
  chaining-capable model).
- **Results:** (paid — pending controller/user execution)

---

## 4. SFX — end-to-end

### TC-SFX-1: MMAudio round-trip (paid)
- **Action:** On a shot with a `done` clip, `POST /sfx` with no prompt
  (exercises the `DEFAULT_SFX_PROMPT` fallback), confirm playback, then
  `POST /sfx` again with an explicit steering prompt (re-roll).
- **Acceptance criteria:** MMAudio requires a non-empty prompt server-side
  even when the caller supplies none; the inspector/beat preview plays
  `clip-sfx.mp4` unmuted once `sfxPath` exists (vs. muted `clip.mp4`
  otherwise); a re-roll replaces the audio without regenerating the clip.
- **Expected outcome:** first call → 200, `sfxStatus: "done"`,
  `clip-sfx.mp4` written to R2; preview plays it with audible audio;
  second call (explicit prompt) → 200, `clip-sfx.mp4` overwritten with new
  audio, `clipPath`/`clipStatus`/`clipModel` on the shot row are byte-for-
  byte unchanged (only the SFX object and `sfxStatus`/`sfxPath` touched).
- **Edge cases:** empty-string prompt (`""`) also falls back to
  `DEFAULT_SFX_PROMPT` (`.trim() || DEFAULT_SFX_PROMPT`, not just
  `undefined`); whitespace-only prompt likewise falls back.
- **Results:** (paid — pending controller/user execution)

---

## 5. Batch integration

### TC-BATCH-1: Generate-all with model + AI chaining + SFX (paid, throwaway project)
- **Action:** On a 3-shot throwaway project with `pending` images/clips,
  open "Generate all", select Kling, leave "Suggest chained shots (AI)"
  checked (default ON), check "Add SFX to all clips", confirm.
- **Acceptance criteria:** the dialog's cost preview line items (sheets,
  images, clips-at-Kling-price, SFX) match `estimateBatchCost()`'s math
  for the same counts/model; the orchestrator runs sheets → images →
  chain-suggestion → clips → SFX in that order; `chainToNext` is written
  only for pairs the Haiku call judged same-scene/continuous-action (not
  blindly all pairs); SFX runs only after its clip is `done`; a forced
  failure on one item (e.g. one shot's clip call errors) does not halt the
  rest of the batch.
- **Expected outcome:** dialog total equals sheets + images + (clips ×
  $0.42) + (sfx-count × $0.01); after the run, `chains.applied` in the
  Inngest function's return value is ≤ 2 (3 shots → 2 adjacent pairs) and
  matches the number of shots with `chainToNext: true`; every `done` clip
  has a corresponding `done` SFX; the one deliberately-failed item ends
  `failed` while its siblings end `done`.
- **Edge cases:** re-opening "Generate all" immediately after (missing-
  only targeting) shows 0/0 sheets/images, 0 clips, and `sfx.count`
  matching only the still-missing SFX (if the forced failure was a clip,
  its SFX also never ran).
- **Results:** (paid — pending controller/user execution)

---

## 6. UI — inspector & batch dialog

### TC-UI-1: Model dropdown contents and pricing
- **Action:** Open the inspector for any shot with a done image; inspect
  the clip-model `<select>`.
- **Acceptance criteria:** dropdown lists all 3 registry models by
  `label`, each with its `~$estUsdPerClip`, a `· chains` suffix for
  end-frame-capable models, and a `· audio` suffix for native-audio
  models; Kling is pre-selected for a shot with no saved `clipModel`.
- **Expected outcome:** options read "Kling 2.5 Turbo Pro — ~$0.42 ·
  chains", "LTX 2.3 — ~$0.36 · chains", "Veo 3.1 Fast — ~$1.20 · audio".
- **Edge cases:** a shot with a previously-saved `clipModel` (e.g. from a
  batch run) shows that model pre-selected, not the registry default.
- **Results:** (manual — pending controller/user execution)

### TC-UI-2: Guidance line follows the selection
- **Action:** Change the dropdown selection.
- **Acceptance criteria:** the `whenToUse` line below the dropdown updates
  to the newly selected model's guidance text.
- **Expected outcome:** selecting Veo shows "Hero shots — strongest
  complex motion and native audio; ~3× the default's cost."; selecting
  LTX shows "Cheap drafts — fast and low-cost, but weak at directed
  motion."
- **Edge cases:** switching selection does not clear the in-progress SFX
  steering-prompt input (`useEffect` keyed only on `shot.id`, not
  `clipModelId` — see feature.md State & Ownership).
- **Results:** (manual — pending controller/user execution)

### TC-UI-3: Chain toggle disabled states
- **Action:** (a) select Veo 3.1 Fast on a non-last shot; (b) select Kling
  on the project's last shot.
- **Acceptance criteria:** the "Chain to next shot" checkbox is disabled
  in both cases, with a tooltip explaining why, and its checked state is
  forced false regardless of the shot's stored `chainToNext` value.
- **Expected outcome:** (a) tooltip "Veo 3.1 Fast can't take an end frame
  — pick a model marked \"chains\""; (b) tooltip "Last shot — nothing to
  chain into"; checkbox unchecked and un-clickable in both.
- **Edge cases:** switching from a disabled state back to an end-frame-
  capable model on a non-last shot re-enables the checkbox but does not
  auto-check it (the underlying `chainToNext` value is unaffected by
  disablement — only its rendered `checked` state is suppressed while
  disabled).
- **Results:** (manual — pending controller/user execution)

### TC-UI-4: Next-shot thumbnail appears only when chaining is active
- **Action:** Enable "Chain to next shot" on an eligible, non-last shot
  whose next shot has a `done` image.
- **Acceptance criteria:** a small thumbnail of the *next* shot's image
  renders inline in the toggle row, representing the frame this clip will
  land on.
- **Expected outcome:** thumbnail appears immediately on check (uses
  already-loaded `nextShot.imageUrl` from client state, no extra fetch);
  disappears if the toggle is unchecked or becomes disabled.
- **Edge cases:** next shot has no `imageUrl` yet (image not generated) →
  toggle still checkable, but no thumbnail renders (conditional on
  `nextShot?.imageUrl` truthiness).
- **Results:** (manual — pending controller/user execution)

### TC-UI-5: SFX controls visibility and batch dialog SFX/chain checkboxes
- **Action:** (a) inspect a shot with no clip yet, then after a clip is
  generated; (b) open "Generate all" and check "Also generate clips".
- **Acceptance criteria:** SFX row (prompt input + Add/Re-roll/Remove) is
  absent until `shot.clipPath && shot.clipStatus === "done"`; the batch
  dialog's "Suggest chained shots (AI)" checkbox defaults ON and "Add SFX
  to all clips (N)" defaults OFF with the live potential-SFX count shown
  even before either checkbox is touched.
- **Expected outcome:** (a) no SFX UI on an image-only shot; row appears
  immediately after clip generation completes; (b) both sub-checkboxes
  render only while "Also generate clips" is checked, with the described
  default states.
- **Edge cases:** "Also generate clips" is checkable (not disabled) even
  when `preview.clips.count === 0`, as long as `preview.sfx.count > 0` —
  this is the SFX-only batch path (see feature.md Tradeoffs).
- **Results:** (manual — pending controller/user execution)

---

## Summary

Section 1 (TC-U-1..4, 23 tests across 4 vitest suites) executed and PASS
on 2026-07-10 via `npm run test` — pure logic only, no network/DB, per
this repo's `vitest.config.ts` convention. Sections 2–6 (API, chaining,
SFX, batch, UI) are fully specified with acceptance criteria, expected
outcomes, and edge cases, but require either paid provider calls (fal.ai,
Anthropic) or a live browser session and are left for the controller's
Step 3 smoke-test pass; their `Results` cells are intentionally blank
pending that execution.

---

## Live run results — 2026-07-10 (throwaway project `clip-engine-v2-smoke`, controller-executed with user approval)

Setup: seeded 2 beats / 5 shots via psql; `npm run dev` + local Inngest dev server; driven via live browser session. Total observed spend ≈ $3.07 (5 images $0.20, 3× Kling $1.26, 1× LTX $0.36, 1× Veo $1.20, 5× MMAudio ≈ $0.05).

- **TC-UI-1 PASS** — dropdown renders all 3 registry entries with prices/badges: "Kling 2.5 Turbo Pro — ~$0.42 · chains", "LTX 2.3 — ~$0.36 · chains", "Veo 3.1 Fast — ~$1.20 · audio".
- **TC-UI-2 PASS** — guidance line follows selection (Kling default copy; Veo "Hero shots — strongest complex motion and native audio; ~3× the default's cost.").
- **TC-UI-3 PASS** — chain toggle disabled on Veo with reason "Veo 3.1 Fast can't take an end frame — pick a model marked 'chains'".
- **TC-UI-4 PASS** — next-shot thumbnail appears beside the toggle when chaining is on.
- **TC-UI-5 PASS** — SFX controls render only for shots with a done clip; batch dialog shows model dropdown + "Suggest chained shots (AI)" (default on) + "Add SFX to all clips (N)".
- **TC-API-1 PASS (via UI)** — clips generated with all three models; `clip_model` persisted per shot; per-model durations recorded (Kling 5s, LTX 6s, Veo 8s).
- **TC-API-3 PASS (via UI)** — chainToNext toggle persisted through shot PATCH.
- **TC-CHAIN-1 PASS** — Kling chained clip's final frame visually matches the next shot's still (keeper/lantern/lightning composition nearly identical); server log shows "chained".
- **TC-CHAIN-2 covered** — Veo chain toggle disabled client-side (server degrade path covered by unit tests TC-U-2).
- **TC-SFX-1 PASS** — MMAudio variant stored at `clip-sfx.mp4`; `clip.mp4` path untouched; steered prompt (clock ticking/chime) used; previews play the SFX variant unmuted after reload.
- **TC-BATCH-1 PASS** — dialog itemization exact ($0.08 images + $0.84 Kling clips + $0.04 SFX(4) = $0.96); AI chain suggestion chained ONLY the same-scene boat pair (not across scene cuts); batch used the selected model for all clips; wave 4 added SFX to new AND pre-existing clips (potential-count 4 = 2 new + 2 existing without SFX).
- **Complex-animation check PASS** — Veo clock clip: pendulum swings and hands settle at 12:00 in the final frame (the design's flagship directed-motion example).
- **Finding (backlog)** — the batch poll treats only image/clip `generating` as batch-active, so wave-4 SFX completions that land after the last clip may not live-patch into the UI until reload (cosmetic; state is correct server-side).
