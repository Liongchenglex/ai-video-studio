# F-19 Directing Controls — Test Cases

**Date:** 2026-07-11

Cases marked **PASS** were executed via `npm run test` (vitest, no network/
DB — pure logic only, per `vitest.config.ts`'s house convention). Cases
marked **(paid — pending controller/user execution)** bill real fal.ai
usage and are specified here with acceptance criteria and expected outcome
but were not run in this pass; the `Results` column is left blank for the
controller to fill in after a live/throwaway-project run. Cases marked
**(manual — pending controller/user execution)** are free but require a
live browser/dev-server session and are likewise left for that pass.

---

## 1. Unit — automated (vitest)

### TC-U-1: Clip model registry + duration resolution (`tests/unit/clip-models.test.ts`)
- **Acceptance criteria:** `DEFAULT_CLIP_MODEL_ID` is `kling-v3-pro`;
  `getClipModel`/`isClipModelId` type-guard correctly for unknown/missing/
  non-string ids; every registry entry has cost, duration, and guidance;
  every entry exposes `estUsdPerSecond`, `durations[]`, and the three
  capability flags with real (not placeholder) values; `estClipUsd` prices
  by an explicit seconds arg and falls back to `durationSeconds`; Kling v3
  Pro's `buildInput` maps `start_image_url`, string `duration`,
  `generate_audio: false` forced, `end_image_url` only when a tail is
  given, `negative_prompt` only when supplied, `elements` as
  `{frontal_image_url}` objects from `referenceImageUrls`; Kling 2.5's
  `buildInput` maps `tail_image_url` + negative prompt + duration; LTX's
  `buildInput` maps `end_image_url` and forces `generate_audio: false`;
  `resolveClipDuration` follows explicit → nearest-listed(ties up) →
  nearest-to-slot(ties up) → model default precedence.
- **Expected outcome:** all 12 assertions pass.
- **Edge cases covered:** unknown/`null`/non-string ids; `buildInput`
  called with no tail image / no negative prompt / no refs (optional-field
  omission, not `undefined` keys); Kling v3 Pro `buildInput` with every
  optional field omitted still forces `generate_audio: false`; an explicit
  duration that ties exactly between two listed values rounds up; a slot
  duration outside any listed value snaps to nearest, ties up.
- **Results:** PASS (12/12, `npm run test`, 2026-07-11).

### TC-U-2: Camera module (`tests/unit/clip-camera.test.ts`)
- **Acceptance criteria:** `isCameraMove`/`isCameraStrength` reject
  invalid/non-string values; `CAMERA_MOVES` has exactly 8 entries and
  `CAMERA_MAGNITUDE` exactly 3 (subtle=3, medium=6, strong=9);
  `cameraPromptSuffix` builds deterministic phrases per (move, strength)
  pair, with `static` short-circuiting to a fixed no-movement phrase
  regardless of strength.
- **Expected outcome:** all 3 assertions pass.
- **Edge cases covered:** static + any strength value collapses to the
  same phrase; every non-static move × every strength combination produces
  a distinct, deterministic string (no randomness).
- **Results:** PASS (3/3, `npm run test`, 2026-07-11).

### TC-U-3: `resolveEndFrame` precedence + all skip reasons (`tests/unit/clip-chaining.test.ts`)
- **Acceptance criteria:** `free` → always `{}` (no tail, no reason,
  regardless of model/next-shot state); `next` → the timeline-next shot's
  `imagePath` when `imageStatus === "done"`, else degrades with
  `no-next-shot` (null nextShot) or `next-image-not-ready` (present but
  not done); model-support gate applies to both `next` and `custom`
  (`model-no-end-frame` when `!spec.supportsEndFrame`); `custom` → the
  shot's own `endFramePath` when `endFrameStatus === "done"`, else
  `custom-frame-not-ready`.
- **Expected outcome:** all 3 grouped assertions (one per `endsOn` value,
  each covering its full degrade tree) pass.
- **Edge cases covered:** `free` ignores an unsupported model and a
  ready next shot alike; `custom` with a `pending`/`failed`/`generating`
  `endFrameStatus` all fall to `custom-frame-not-ready`; `next` with a
  next shot present but `imagePath: null` or `imageStatus !== "done"`.
- **Results:** PASS (3/3, `npm run test`, 2026-07-11).

### TC-U-4: Entity reference resolution (`tests/unit/clip-references.test.ts`)
- **Acceptance criteria:** `useEntityRefs: false` → `disabled`, no further
  checks; `!spec.supportsReferences` → `model-no-references`; no tagged
  entities, or none with `referenceStatus === "done"` + a path →
  `no-ready-sheets`; happy path returns ready sheets in tag order with no
  skip reason; 5 ready entities cap at 4, tag order preserved (not
  re-sorted).
- **Expected outcome:** all 6 assertions pass.
- **Edge cases covered:** zero tagged entities at all (vs. tagged-but-not-
  ready) both resolve to `no-ready-sheets`; the 4-cap keeps the *first*
  four in tag order, not an arbitrary subset.
- **Results:** PASS (6/6, `npm run test`, 2026-07-11).

### TC-U-5: Duration-aware cost estimation (`tests/unit/generation-costs.test.ts`)
- **Acceptance criteria:** `estimateBatchCost()` prices clips from the
  selected model's `estUsdPerSecond` (falls back to the default model for
  an unknown id); `clipSecondsTotal`, when provided, prices clips by
  summed resolved seconds rather than `count × durationSeconds`; `sfxUsd`
  is 0 unless `includeSfx`, uses the explicit `sfx` count when given, else
  falls back to the `clips` count; `totalUsd` (sheets+images only) is
  unaffected by clip/SFX pricing.
- **Expected outcome:** all 6 assertions pass.
- **Edge cases covered:** unknown `clipModelId` (silent fallback, no
  throw); `sfx` count larger than `clips` count (done-clips-missing-SFX
  case); `clipSecondsTotal` present vs. absent (duration-aware vs. legacy
  count×default paths both still work).
- **Results:** PASS (6/6, `npm run test`, 2026-07-11).

### TC-U-6: Chain-suggestion pure helpers (`tests/unit/chain-suggestion.test.ts`)
- **Acceptance criteria:** `buildChainPairs()` pairs adjacent shots
  *in input order* (does NOT sort — unordered input is documented as the
  caller's responsibility), computes `sameBeat`/`sharedEntityIds`
  correctly, returns `[]` for 0–1 shots, tolerates `null`
  `referencedEntityIds`; `sanitizeChainSuggestions()` keeps only ids that
  are a pair's first shot and returns `[]` for non-array input.
- **Expected outcome:** all 6 assertions pass.
- **Edge cases covered:** deliberately-unordered input (proves the "no
  sort" contract, a deviation this task's test suite calls out
  explicitly since F-18's version did sort); empty/single-shot input;
  null entity list; a suggested id that's only ever a pair's *second*
  shot; non-array model output.
- **Results:** PASS (6/6, `npm run test`, 2026-07-11).

### TC-U-7: Timeline ordering (`tests/unit/shot-beat-mapping.test.ts`)
- **Acceptance criteria:** `orderShotsByTimeline()` orders shots across
  beats by the beat's own `sortOrder` (ignoring shot `sortOrder`
  entirely at that level), then by `startInBeat` within a beat, using
  shot `sortOrder` then `id` only to break exact ties; a post-split
  scenario with duplicate `sortOrder` in the same beat is resolved
  correctly by `startInBeat`; shots with a `null` or unknown `beatId`
  sort after every anchored shot; the function does not mutate its input.
- **Expected outcome:** all 6 assertions pass.
- **Edge cases covered:** the exact "split creates duplicate sortOrder"
  bug this helper was written to fix (Clip Engine v2 final-review finding
  #1); a full 4-way tie chain (beat → start → sortOrder → id); dangling
  `beatId` references (deleted/never-migrated beat).
- **Results:** PASS (6/6, `npm run test`, 2026-07-11).

**Suite total:** 7 files, 42 tests, 42 passed, 0 failed (`npm run test`,
2026-07-11).

---

## 2. API — routes & validation

### TC-API-1: Shot PATCH allow-lists for directing fields
- **Action:** `PATCH /shots/:shotId` with each of: `{"cameraMove":
  "push-in"}`, `{"cameraMove":"bogus"}`, `{"cameraStrength":"medium"}`,
  `{"cameraStrength":"extreme"}`, `{"endsOn":"next"}`,
  `{"endsOn":"maybe"}`, `{"clipDurationChoice":8}`,
  `{"clipDurationChoice":0}`, `{"clipDurationChoice":16}`,
  `{"clipDurationChoice":5.5}`, `{"negativePrompt":"blurry, low detail"}`,
  `{"negativePrompt":"x".repeat(501)}`, `{"negativePrompt":""}`,
  `{"useEntityRefs":false}`, `{"useEntityRefs":"yes"}`.
- **Acceptance criteria:** every enum/bounds check runs and 400s *before*
  any DB write (all-or-nothing update object, matching the route's
  existing bounds/prompt validation pattern); an empty-string
  `negativePrompt` normalizes to `null`, not an empty string, in the
  persisted row.
- **Expected outcome:** valid values → 200, persisted (follow-up `GET`
  reflects them); `cameraMove:"bogus"` / `cameraStrength:"extreme"` → 400
  (enum guard); `endsOn:"maybe"` → 400 `"endsOn must be one of: free,
  next, custom"`; `clipDurationChoice` of `0`, `16`, or `5.5` → 400
  `"clipDurationChoice must be an integer between 1 and 15, or null"`;
  `negativePrompt` over 500 chars → 400; `negativePrompt:""` → 200,
  persisted row's `negative_prompt` is `null`; `useEntityRefs:"yes"` → 400
  `"useEntityRefs must be a boolean"`.
- **Edge cases:** `clipDurationChoice:null` → 200, clears to auto-match;
  a combined request mixing one valid and one invalid field (e.g.
  `{"endsOn":"next","cameraMove":"bogus"}`) → 400, neither field is
  written (verified by code review: all `body.X !== undefined` checks run
  before any `db.update` call in this route).
- **Results:** (paid — pending controller/user execution; all 400
  assertions are free and reachable via `curl` without incurring cost)

### TC-API-2: Project PATCH negativePrompt
- **Action:** `PATCH /api/projects/:id` with `{"negativePrompt":"blur,
  warping, morphing, distorted faces, extra limbs, text artifacts"}`;
  then `{"negativePrompt":"x".repeat(501)}`; then
  `{"negativePrompt":null}`; then `{"negativePrompt":"  "}`.
- **Acceptance criteria:** same ≤500-char / `null`-allowed validation as
  the shot route; whitespace-only input normalizes to `null`.
- **Expected outcome:** seed text → 200, persisted; 501-char string → 400
  `"negativePrompt must be a string of at most 500 characters, or null"`;
  explicit `null` → 200, clears the project default; whitespace-only →
  200, persisted row is `null` (`.trim() || null`).
- **Edge cases:** a shot with its own `negativePrompt` unset falls back to
  this project value at generation time (`shot.negativePrompt?.trim() ||
  project.negativePrompt?.trim() || undefined` in
  `shot-clip-generation.ts`) — covered structurally here, exercised live
  in TC-PAID-1.
- **Results:** (paid — pending controller/user execution; both 400/200
  assertions are free via `curl`)

### TC-API-3: Image edit route preconditions
- **Action:** `POST /shots/:shotId/image/edit` on a shot with no image
  yet; then with `{"instruction":""}` on a shot with a done image; then
  `{"instruction":"x".repeat(501)}`; then a valid instruction while a
  prior edit is still `imageStatus: "generating"`.
- **Acceptance criteria:** the route requires a `done` primary image
  before allowing an edit; in-flight edits are rejected with a specific
  message (checked before the generic precondition, per the route's doc
  comment, so it's reachable even though editing shares `imageStatus`
  with generation); instruction is required, non-empty, ≤500 chars.
- **Expected outcome:** no image → 400 "Generate the shot's image before
  editing it"; empty instruction → 400 "instruction is required"; 501-char
  instruction → 400 "instruction must be at most 500 characters";
  `imageStatus: "generating"` → 400 "Image is already generating for this
  shot" (checked first, before the done-image precondition); valid case →
  200, `imagePath`/`imageUrl` returned, `image.png` overwritten in R2.
- **Edge cases:** a shot with an existing custom end frame — verified by
  code review (`shot-frame-edit.ts`'s `editShotImage`) that a successful
  edit sets `endFrameStatus: "pending"` only when `shot.endFramePath` was
  already non-null, and does so only on the success path (a failed edit
  does not stale-flag). See also the Re-image asymmetry documented in
  feature.md Tradeoffs and exercised in TC-PAID-3.
- **Results:** (paid — pending controller/user execution; the 400 cases
  are free via `curl`)

### TC-API-4: End-frame route preconditions + DELETE semantics
- **Action:** `POST /shots/:shotId/end-frame` on a shot with no image
  yet; then with a valid instruction on a shot with a done image; then
  again while the first is still `endFrameStatus: "generating"`; then
  `DELETE /shots/:shotId/end-frame` on the resulting shot (with `endsOn:
  "custom"`); then `DELETE` again on a shot that never had an end frame.
- **Acceptance criteria:** `POST` requires a `done` primary image
  (independent of `endFrameStatus`); in-flight `POST`s are rejected;
  `DELETE` best-effort deletes the R2 object (a failed R2 delete is
  logged and swallowed, DB reset still happens — same idiom as SFX's
  `DELETE`), nulls `endFramePath`/`endFrameInstruction`, resets
  `endFrameStatus` to `"pending"`, and flips `endsOn` from `"custom"` to
  `"free"` **only when it was `"custom"`** (a `DELETE` on a shot whose
  `endsOn` is already `"free"`/`"next"` leaves `endsOn` untouched).
- **Expected outcome:** no image → 400 "Generate the shot's image before
  authoring an end frame"; valid `POST` → 200, `endFramePath`/
  `endFrameUrl` returned, `endFrameStatus: "done"`; concurrent `POST` →
  400 "End frame is already generating for this shot"; `DELETE` on a
  `custom` shot → 200 `{"endFramePath":null,"endFrameInstruction":null,
  "endFrameStatus":"pending","endsOn":"free"}`; `DELETE` with no end frame
  → 200 no-op (R2 delete skipped since `shot.endFramePath` is falsy, DB
  reset still runs, `endsOn` unchanged).
- **Edge cases:** `DELETE`'s R2 failure path is swallowed with a
  `console.warn`, verified by code review of the route's try/catch (not
  independently testable without simulating an R2 outage); `DELETE` on a
  shot with `endsOn: "next"` and a leftover `endFramePath` from a prior
  `custom` session (e.g. the user switched away without deleting) — DB
  reset still runs, `endsOn` stays `"next"` (only flips when currently
  `"custom"`).
- **Results:** (paid — pending controller/user execution; the no-image
  400 and the no-op `DELETE` are free)

---

## 3. UI — inspector, toolbar, storyboard (per the locked mockup)

### TC-UI-1: Four groups, verbatim labels
- **Action:** Select any shot with a done image.
- **Acceptance criteria:** the inspector renders exactly four groups in
  order — **"Image — what we see"**, **"Action — what happens in the
  shot"**, **"Clip — engine settings"**, **"Sound"** (verbatim, including
  the em dashes).
- **Expected outcome:** all four `InspectorGroup` labels match verbatim;
  no fifth group, no stray "Chain to next shot" checkbox (the F-18
  control it replaced).
- **Edge cases:** the motion-prompt placeholder reads verbatim `e.g. "the
  boat sails toward the horizon"`.
- **Results:** (manual — pending controller/user execution)

### TC-UI-2: Camera picker + guaranteed/best-effort hint
- **Action:** In the Action group, open the Camera move `<select>`; pick
  `push-in`; observe the strength selector and hint line; switch back to
  `static`.
- **Acceptance criteria:** the picker lists exactly the 8
  `CAMERA_MOVES` labels (Static, Push in, Pull back, Pan left, Pan right,
  Tilt up, Tilt down, Orbit); a strength `<select>` (Subtle/Medium/Strong)
  appears only when the move is not `static`; the hint line reads
  `"best-effort — written into the prompt"` for every model in the current
  registry (none has `supportsCameraControl: true` yet — see feature.md
  Known limitations) — never `"guaranteed ✓"` today; switching back to
  `static` clears any previously-chosen `cameraStrength` on the shot.
- **Expected outcome:** hint text flips deterministically with
  `selectedModel.supportsCameraControl`, currently always false;
  strength selector's visibility is keyed on `cameraMove !== "static"`.
- **Edge cases:** picking a non-static move defaults the strength
  `<select>` to "Medium" (`cameraStrength ?? "medium"`) until the row is
  explicitly persisted with a strength.
- **Results:** (manual — pending controller/user execution)

### TC-UI-3: "Ends on" thumbnails, including Custom
- **Action:** (a) click "Next shot" on a non-last shot whose next shot
  has a done image; (b) click "Custom…", author an end frame, observe the
  thumbnail; (c) click "Free".
- **Acceptance criteria:** exactly one of `Free | Next shot | Custom…` is
  highlighted at a time; a small thumbnail renders inline for the active
  non-Free target — the *next* shot's image for "Next shot", the
  *authored end frame* for "Custom…" (only once `endFrameStatus ===
  "done"` and `endFrameUrl` exists); "Next shot" is disabled with a
  tooltip when the selected model has `supportsEndFrame: false` or the
  shot is last in sequence; "Custom…" is always clickable regardless of
  model support (per the accepted "author now, switch later" tradeoff).
- **Expected outcome:** (a) thumbnail = next shot's `imageUrl`; (b) after
  "Create end frame" completes, thumbnail = `shot.endFrameUrl`, and the
  storyboard tile gains the `▸▮` corner badge; (c) both control rows
  (Custom's instruction field, both thumbnails) disappear.
- **Edge cases:** selecting "Custom…" on a model with
  `supportsEndFrame: false` shows no disabled state on the segment itself
  (only "Next shot" is capability-gated) — the skip note
  (`model-no-end-frame`) only appears after a clip generation attempt;
  an `endFrameStatus: "pending"` with a non-null `endFrameInstruction`
  (post stale-flag from an image edit) shows "End frame out of date —
  re-create it" instead of the thumbnail.
- **Results:** (manual — pending controller/user execution)

### TC-UI-4: Length stepper — auto, override, reset
- **Action:** On a shot with no `clipDurationChoice`, observe the Length
  row; click `+`/`−` to step; click "auto" to reset.
- **Acceptance criteria:** with no explicit choice, the label reads
  `"{resolvedDuration}s (auto)"` where `resolvedDuration` comes from
  `resolveClipDuration` against the shot's beat slot; stepping writes an
  explicit `clipDurationChoice` (label drops the "(auto)" suffix and an
  "auto" reset link appears); `−`/`+` are disabled at the ends of the
  selected model's `durations` list; switching to a fixed-duration model
  (LTX, `durations: [6]`) disables both stepper buttons (nothing to step
  to).
- **Expected outcome:** stepper always shows one of the model's listed
  durations, never an arbitrary value; the reset link only appears when
  `clipDurationChoice != null`.
- **Edge cases:** switching models while an explicit `clipDurationChoice`
  is set does not clear it — if the new model doesn't list that exact
  value, `resolveClipDuration`'s nearest-match silently substitutes at
  generation time (server-side; the stepper's own `durationIndex` uses
  `indexOf` and would show no highlighted position for an unlisted value,
  a UI-only cosmetic gap noted for the backlog, not a correctness bug).
- **Results:** (manual — pending controller/user execution)

### TC-UI-5: Cast & locations featured toggle states
- **Action:** (a) on a model with `supportsReferences: true`, tag two
  entities in a specific order, observe the derived line; (b) untag all;
  (c) switch to a model with `supportsReferences: false` (e.g. Kling 2.5,
  LTX, Veo).
- **Acceptance criteria:** the toggle defaults checked (`useEntityRefs`
  DB default `true`); the derived text below it reads `"{Name1}, {Name2}
  — from your tags"` in **tag order** (not alphabetical or DB-row order);
  zero tagged entities shows `"(none tagged)"`; an unsupported model
  disables the checkbox and shows `"not supported by this model"`
  regardless of the underlying `useEntityRefs` value or tag state.
- **Expected outcome:** exact text matches above; disabling by model
  switch does not clear the stored `useEntityRefs` value (only its
  rendered/interactive state).
- **Edge cases:** switching from an unsupported back to a supported model
  re-enables the checkbox showing whatever `useEntityRefs` was last
  persisted (not forced back to the `true` default).
- **Results:** (manual — pending controller/user execution)

### TC-UI-6: Advanced negative-prompt field
- **Action:** Expand "Advanced ▸"; observe the placeholder with no
  project default set, then with one set; type a shot-level override and
  blur.
- **Acceptance criteria:** the `<details>` element is collapsed by
  default (`▸` marker); the textarea's placeholder is the project default
  (empty string if unset); typing + blur persists `negativePrompt` via
  `updateShot` only when the trimmed value differs from the shot's
  current stored value (no-op writes avoided); `maxLength=500` client-side
  (server enforces independently, per feature.md Security).
- **Expected outcome:** placeholder text updates live if the project
  default changes (via the gear popover) while the panel is open, since
  it reads `projectNegativePrompt` directly, not a snapshot.
- **Edge cases:** clearing the field entirely and blurring persists
  `negativePrompt: null` (empty string is normalized before the PATCH),
  matching the server's own empty-string-to-`null` normalization.
- **Results:** (manual — pending controller/user execution)

### TC-UI-7: Project settings gear popover
- **Action:** Open the toolbar gear icon on a brand-new project (never
  saved a negative prompt); observe the empty field + placeholder; click
  "use suggested"; Save; reopen.
- **Acceptance criteria:** dialog title "Project settings"; description
  "The project default applies to every clip whose shot doesn't set its
  own negative prompt (Advanced ▸ in the inspector)."; a new project's
  textarea is **empty** (not pre-filled) with placeholder text
  `"blur, warping, morphing, distorted faces, extra limbs, text
  artifacts"` (`SUGGESTED_NEGATIVE_PROMPT`); a "use suggested" link fills
  the draft with that exact string but does not save it; the draft
  resyncs to the store's current value every time the popover re-opens (a
  previous unsaved edit does not linger).
- **Expected outcome:** before any save, `projects.negative_prompt` stays
  `null` for a new project (confirms the seed is placeholder/convenience
  copy, not an auto-applied DB default — see feature.md Key Files for the
  reasoning); clicking "use suggested" then Save persists the seed text;
  reopening after Save shows the saved value in the field itself (no
  longer just the placeholder).
- **Edge cases:** opening, editing, closing without saving (Cancel/click-
  outside), reopening shows the *original* (pre-edit, possibly still
  empty) value — proven by the resync-on-open effect; "use suggested"
  clicked twice is idempotent (same string).
- **Results:** (manual — pending controller/user execution)

### TC-UI-8: Storyboard "directed ending" badge
- **Action:** Author a custom end frame on one shot (`endsOn: "custom"`,
  `endFramePath` set); view the storyboard grid.
- **Acceptance criteria:** only that tile shows the small `▸▮` badge
  (title "Directed ending") in its bottom-left corner, alongside the
  existing status badge; the condition is `endsOn === "custom" &&
  endFramePath` — independent of `endFrameStatus`, so a stale
  (`"pending"`) end frame still shows the badge as long as a path exists.
- **Expected outcome:** deleting the end frame (which also flips `endsOn`
  back to `"free"`) removes the badge; switching `endsOn` to `"free"`/
  `"next"` without deleting the end frame data (not reachable through the
  current UI, which only clears via DELETE) would also remove it per the
  same condition.
- **Edge cases:** a shot mid-generation (`endFrameStatus: "generating"`)
  with no prior `endFramePath` yet shows no badge (path is still null).
- **Results:** (manual — pending controller/user execution)

### TC-UI-9: Edit image… inline flow
- **Action:** On a shot with a done image, click "Edit image…", type an
  instruction, click Apply.
- **Acceptance criteria:** the link toggles an inline instruction input +
  Apply button; Apply is disabled until the instruction is non-empty and
  `imageStatus !== "generating"`; on success the still updates in place
  (same R2 key, new content) and, if the shot had an authored end frame,
  the "End frame out of date — re-create it" note appears under Custom…
  (endFrameStatus flipped to `pending` server-side).
- **Expected outcome:** the edited image replaces the preview without a
  full page reload; the input field text is preserved (not cleared) if
  the edit fails, so the user can retry without retyping (per Task 15's
  fix — `editShotImage` preserves the instruction on failure).
- **Edge cases:** clicking "Hide edit image" collapses the input without
  discarding an in-progress instruction draft (toggled visibility only).
- **Results:** (manual — pending controller/user execution)

---

## 4. Paid — end-to-end (throwaway project, user-gated)

### TC-PAID-1: Hero test — camera + refs + custom end frame in one Kling v3 clip
- **Action:** On a throwaway project, tag 2 entities with done reference
  sheets onto one shot ("a clock striking midnight" premise). Set Camera
  move = Push in, strength = Medium; Ends on = Custom…, instruction
  "the clock hands land exactly at 12:00, pendulum settling to a stop";
  Create end frame. Leave Cast & locations featured ON. Generate the clip
  with Kling v3 Pro (default).
- **Acceptance criteria:** the response's `clipModel` is `"kling-v3-pro"`;
  `refsApplied` is 2 (or fewer with `refsSkippedReason` explaining any
  gap, e.g. a sheet not yet done); `cameraBestEffort` is `true` (v3 has
  no hard camera param) and the stored motion prompt used for the fal
  call included the camera phrase `"Camera: steady push-in."`;
  `endFrameSkippedReason` is absent (the custom frame was `done` at
  generation time); the clip's final frame visually lands on the
  authored end-frame still (hands at 12:00, pendulum stopped); both
  reference entities are visibly on-model through the motion (not just
  the first/last frame).
- **Expected outcome:** 200, `clipStatus: "done"`; total shot cost ≈
  duration(s) × $0.112 (Kling v3 Pro rate) + the ~$0.04 end-frame Kontext
  call already paid during authoring.
- **Edge cases:** if a reference sheet isn't `done` yet, `refsApplied`
  should reflect only the ready one(s) with no clip failure (degrade,
  not fail) — worth confirming even though the primary scenario assumes
  both are ready.
- **Results:** (paid — pending controller/user execution)

### TC-PAID-2: LTX prompt-fallback camera clip
- **Action:** On a shot, select LTX 2.3 (`supportsCameraControl: false`,
  same as every model), set Camera move = Orbit, strength = Strong,
  generate.
- **Acceptance criteria:** `cameraBestEffort: true`; the fal call's
  `prompt` field ends with `"Camera: fast orbit around the subject."`;
  clip generates successfully at LTX's fixed 6s duration regardless of
  the shot's timeline slot (`durations: [6]`).
- **Expected outcome:** 200, visually the camera makes some orbiting
  attempt (LTX's own motion-following fidelity is out of scope — this
  test only confirms the prompt phrase reached fal and didn't break
  generation).
- **Edge cases:** LTX has `supportsNegativePrompt: false` — confirm no
  `negative_prompt` key is sent even if the shot/project has one set
  (silently dropped, not an error).
- **Results:** (paid — pending controller/user execution)

### TC-PAID-3: Duration auto-match check + Re-image/end-frame staleness live confirmation
- **Action:** (a) On a shot whose timeline slot is ~3.2s, leave
  `clipDurationChoice` unset, generate with Kling v3 Pro; confirm the
  billed/returned duration is 3s (nearest-listed) not the model's 5s
  default. (b) On a separate shot with an authored custom end frame,
  click plain "Re-image" (not "Edit image…"); confirm `endFrameStatus`
  does NOT flip to `pending` (live-confirms the documented asymmetry in
  feature.md Tradeoffs) — then click "Edit image…" instead and confirm it
  DOES flip.
- **Acceptance criteria:** (a) `clipDurationSeconds` in the response is
  3 (or fal's actual returned duration, rounded); estimated cost matches
  `3 × $0.112`, not `5 × $0.112`. (b) after plain Re-image, a follow-up
  `GET` shows `endFrameStatus` unchanged (still `"done"` from before);
  after "Edit image…" with the same starting state, `endFrameStatus`
  flips to `"pending"` and the inspector shows "End frame out of date —
  re-create it".
- **Expected outcome:** confirms `resolveClipDuration`'s slot-matching in
  a live fal call, and confirms/denies the asymmetry finding with real
  data (code review already confirms it structurally — see
  `src/lib/shot-image-generation.ts`'s `generateShotImage`, which never
  references `endFramePath`/`endFrameStatus`).
- **Edge cases:** none beyond the two paths compared directly.
- **Results:** (paid — pending controller/user execution)

### TC-PAID-4: Batch run with duration-aware preview
- **Action:** On a 3-shot throwaway project with varied beat-slot
  lengths (e.g. 3s / 5s / 8s), open "Generate all" with Kling v3 Pro
  selected, no per-shot duration overrides; compare the dialog's clip
  cost line to a manual `Σ resolveClipDuration(spec, slot, null) ×
  $0.112` calculation; confirm.
- **Acceptance criteria:** the preview's `clips.estUsd` equals the
  duration-aware sum, not `3 × modelDefault × $0.112`; after the run,
  each shot's `clipDurationSeconds` matches its own resolved duration
  (not a uniform value across all three).
- **Expected outcome:** dialog total itemization exact; three clips of
  visibly different lengths.
- **Edge cases:** one shot with an explicit `clipDurationChoice` set
  before the batch run — its resolved duration should come from the
  explicit choice, not its slot, and the preview sum should reflect that
  override.
- **Results:** (paid — pending controller/user execution)

---

## Summary

Section 1 (TC-U-1..7, 42 tests across 7 vitest suites) executed and PASS
on 2026-07-11 via `npm run test` — pure logic only, no network/DB, per
this repo's `vitest.config.ts` convention. Section 2 (API) is fully
specified with acceptance criteria, expected outcomes, and edge cases; its
400-only assertions are free and reachable via `curl`, but the full cases
are left blank pending the controller's paid/live pass since they're
bundled with 200-path assertions that touch paid image/clip generation.
Sections 3 (UI) and 4 (paid end-to-end, incl. the hero test) require
either a live browser session or real fal.ai spend and are left for the
controller's Task 17 Step 5 smoke-test + live-verification pass; their
`Results` cells are intentionally blank pending that execution.
