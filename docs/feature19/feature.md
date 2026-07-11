# Feature: F-19 Directing Controls (Clip Engine v3)

> **Status: Implementation complete (Tasks 1–16). Paid smoke tests, live
> browser verification, and final merge to master are handled separately by
> the controller (Task 17 Step 5) — this document ships alongside that
> hand-off.**
> Branch `feat/directing-controls`. Design:
> [`docs/superpowers/specs/2026-07-10-directing-controls-design.md`](../superpowers/specs/2026-07-10-directing-controls-design.md).
> **Depends on:** F-18 Clip Engine v2 (shipped 2026-07-10, merged to
> master as `20ce050`) — this feature extends the same registry/chaining/
> batch modules rather than replacing them, and performs the release's only
> destructive migration (dropping `chain_to_next`) after all readers moved
> to `ends_on`.

## Feature
- **Name:** Directing Controls (camera, negative prompt, duration, entity
  references in clips, frame staging)
- **Purpose:** Turn free-text-only clip direction into structured, guaranteed-
  or-clearly-best-effort controls: a camera move + strength picker, a
  project/shot negative prompt, a duration stepper that auto-matches the
  shot's timeline slot, cast reference sheets riding into video generation
  so characters stay on-model during motion, and FLUX-Kontext-backed frame
  staging (in-place image edits + an authored "Custom" end frame as a third
  ends-on mode alongside Free/Next-shot). New default clip model: Kling v3
  Pro.

## Key Files

Frontend:
- `src/components/editor/inspector.tsx` — regrouped shot panel (Image /
  Action / Clip / Sound), "Edit image…" inline instruction + Apply; Camera
  move segmented `<select>` + strength (hidden for `static`) + guaranteed/
  best-effort hint (`selectedModel.supportsCameraControl`); "Ends on"
  3-way `Free | Next shot | Custom…` with the active target's thumbnail,
  amber skip note (`END_SKIPPED_COPY`), and the Custom instruction field +
  Create/Re-create/Remove end-frame controls; Clip group's model dropdown
  (unchanged pattern), Length stepper (`resolvedDuration`s, `(auto)` suffix,
  reset-to-auto link), "Cast & locations featured" toggle (derived names in
  tag order, "not supported by this model" when the model can't take refs),
  Advanced ▸ per-shot negative-prompt textarea, Generate button priced
  `estClipUsd(selectedModel, resolvedDuration)`; post-generation
  `cameraBestEffort` and `refsSkippedReason` (`REFS_SKIPPED_COPY`) notes.
- `src/components/editor/unified-editor.tsx` — toolbar gear icon opens
  `ProjectSettingsDialog` (project-default negative prompt). The seed text
  `"blur, warping, morphing, distorted faces, extra limbs, text artifacts"`
  (`SUGGESTED_NEGATIVE_PROMPT`) is the field's placeholder AND a one-click
  "use suggested" fill button — it is **not** auto-written to
  `projects.negative_prompt` on project creation; a new project's default
  stays `null` until the user opens the popover and explicitly saves
  (clicking "use suggested" then Save, or typing their own text). This is
  a deliberate reading of the spec's "seeded" language as UI convenience
  copy, not a DB-level default — documented here since the design doc's
  wording could be read either way. Dialog copy: "The project default
  applies to every clip whose shot doesn't set its own negative prompt
  (Advanced ▸ in the inspector)."
- `src/components/editor/storyboard-view.tsx` — tiny `▸▮` corner badge
  ("Directed ending") on a tile when `shot.endsOn === "custom" &&
  shot.endFramePath` (badge is independent of `endFrameStatus` — see
  Tradeoffs).
- `src/components/editor/generate-all-dialog.tsx` — cost preview now reads
  duration-aware `clips.estUsd`/`sfx.estUsd` from the preview endpoint;
  structurally unchanged otherwise (model dropdown, AI-chain checkbox, SFX
  checkbox).
- `src/components/editor/editor-store.tsx` — shot fields extended
  (`cameraMove`, `cameraStrength`, `endsOn`, `endFramePath`,
  `endFrameStatus`, `endFrameInstruction`, `endFrameUrl`,
  `clipDurationChoice`, `negativePrompt`, `useEntityRefs`,
  `endFrameSkippedReason`, `cameraBestEffort`, `refsApplied`,
  `refsSkippedReason`); `updateShot` extended for all new PATCH-able
  fields; `projectNegativePrompt` state + `saveProjectSettings()`;
  `editShotImage(shotId, instruction)`, `createEndFrame(shotId,
  instruction)`, `removeEndFrame(shotId)` actions wired to the new routes.

Backend:
- `src/lib/clip-models.ts` — registry extended: `durations: number[]`
  (replaces the single `durationSeconds` as the priced default),
  `estUsdPerSecond` (replaces flat `estUsdPerClip`), `supportsCameraControl`/
  `supportsReferences`/`supportsNegativePrompt` flags, `buildInput()`
  gains `camera`/`negativePrompt`/`durationSeconds`/`referenceImageUrls`
  params. New entry `kling-v3-pro` is `DEFAULT_CLIP_MODEL_ID`. New pure
  helpers: `estClipUsd(spec, seconds?)` (per-second × duration, rounds to
  cents) and `resolveClipDuration(spec, slotSeconds, explicit)` (explicit-
  if-listed → nearest-listed-ties-up → nearest-to-slot-ties-up → model
  default).
- `src/lib/clip-camera.ts` — new, pure. `CameraMove`/`CameraStrength`
  types, `CAMERA_MOVES` (8, labeled), `CAMERA_MAGNITUDE` (subtle/medium/
  strong → 3/6/9), `isCameraMove`/`isCameraStrength` type guards,
  `cameraPromptSuffix(move, strength)` → deterministic phrase (e.g.
  `"Camera: slow push-in."`, `"Camera: locked off, no camera movement."`
  for static).
- `src/lib/clip-chaining.ts` — generalized from Clip Engine v2's
  `resolveChainDecision`. `resolveEndFrame({ endsOn, endFramePath,
  endFrameStatus, spec, nextShot })` → `{ tailImagePath? , skipReason? }`.
  `EndFrameSkipReason` = `model-no-end-frame | no-next-shot |
  next-image-not-ready | custom-frame-not-ready`. Precedence: `free` → no
  tail, no reason; else model-support check; `custom` → `endFramePath` if
  `endFrameStatus === "done"`, else `custom-frame-not-ready`; `next` → the
  timeline-next shot's image if `done`, else `no-next-shot` /
  `next-image-not-ready`.
- `src/lib/clip-references.ts` — new, pure.
  `resolveClipReferences({ useEntityRefs, spec, taggedEntities })` → ready
  sheets (`referenceStatus === "done" && referenceSheetPath`), tag order
  preserved, capped at 4 (fal's Kling `elements` limit).
  `RefsSkipReason` = `disabled | model-no-references | no-ready-sheets`.
- `src/lib/shot-frame-edit.ts` — new. `editShotImage(project, shot,
  instruction)`: FLUX Kontext (`fal-ai/flux-pro/kontext`, `{ prompt,
  image_url }`, same endpoint as `image-generation.ts`'s reference-
  conditioned path) overwrites `image.png` in place; if the shot already
  has an end frame, stale-flags it (`endFrameStatus: "pending"`) on the
  success path only. `createShotEndFrame(project, shot, instruction)`:
  same Kontext call, always sourced from the shot's *current* `imagePath`,
  stores a separate `end-frame.png`, persists the instruction for re-rolls.
  Both own their own `generating → done/failed` lifecycle;
  `FRAME_EDIT_INSTRUCTION_MAX_CHARS = 500`.
- `src/lib/shot-clip-generation.ts` — `generateShotClip()` extended:
  resolves the model, resolves `nextShot` via `orderShotsByTimeline`
  (true timeline order, not `sortOrder`), calls `resolveEndFrame` keyed on
  `shot.endsOn`, resolves + uploads entity references
  (`resolveAndUploadReferences`, uploads each ready sheet as
  `entity-ref-{i}.png`), appends the camera prompt suffix when the model
  has no hard camera param (`cameraBestEffort`), resolves the negative
  prompt (shot override → project default → none, only when
  `supportsNegativePrompt`), resolves duration via `resolveClipDuration`
  (shot's beat slot vs. `clipDurationChoice`). Regenerating a clip still
  resets SFX (`sfxPath: null, sfxStatus: "pending"`). 146 LOC.
- `src/lib/generation-costs.ts` — `estimateBatchCost()` gained
  `clipSecondsTotal` (prices clips by summed resolved duration when the
  caller supplies it, else falls back to `count × durationSeconds`);
  `estUsdPerClip` flat pricing is gone.
- `src/lib/chain-suggestion.ts` — Haiku suggestion output now writes
  `endsOn: "next"` (via the batch orchestrator) instead of the retired
  `chainToNext` boolean.
- `src/lib/shot-beat-mapping.ts` — new `orderShotsByTimeline(shots,
  beats)`: deterministic timeline order (beat's own `sortOrder` → shot's
  `startInBeat` → shot `sortOrder` → shot `id` as tie-breakers), replacing
  a naive `sortOrder`-only "next shot" lookup that could pick the wrong
  shot after a split (final-review finding from Clip Engine v2).
  Consumed identically by the clip service, the inspector's next-shot
  thumbnail, and the batch orchestrator.
- `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts` — response
  gains `endFrameSkippedReason`, `cameraBestEffort`, `refsApplied`,
  `refsSkippedReason` alongside the existing `clipModel`.
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — `PATCH` gained
  `cameraMove`/`cameraStrength` (allow-listed enums or `null`), `endsOn`
  (`free | next | custom`), `clipDurationChoice` (integer 1–15 or `null`),
  `negativePrompt` (≤500 chars or `null`, trimmed-to-`null` on empty),
  `useEntityRefs` (boolean).
- `src/app/api/projects/[id]/route.ts` — `PATCH` gained `negativePrompt`
  (project default; same ≤500/`null` validation and empty-string-to-`null`
  normalization as the shot route).
- `src/app/api/projects/[id]/shots/[shotId]/image/edit/route.ts` — new.
  `POST { instruction }` → `editShotImage`. In-flight guard
  (`imageStatus === "generating"` → 400) checked before the "must have a
  done image" precondition so a concurrent edit gets a specific message.
- `src/app/api/projects/[id]/shots/[shotId]/end-frame/route.ts` — new.
  `POST { instruction }` → `createShotEndFrame`; in-flight guard on
  `endFrameStatus === "generating"`. `DELETE` best-effort R2 delete, nulls
  `endFramePath`/`endFrameInstruction`, resets `endFrameStatus` to
  `"pending"`, and flips `endsOn` `custom → free` (only when it was
  `custom`).
- `src/app/api/projects/[id]/generate-all/preview/route.ts` — clip cost
  now sums each target shot's `resolveClipDuration`-resolved seconds
  (`clipSecondsTotal`) instead of `count × fixed duration`.
- `src/inngest/functions/generate-batch.ts` — chain-suggestion step writes
  `ends_on = 'next'` (was `chain_to_next = true`); `ends_on='custom'`
  shots batch-generate using their end frame if `done`, else degrade with
  the skip note (no orchestrator code path change needed — `resolveEndFrame`
  is called identically from the route and the orchestrator's shared
  `generateShotClip`).
- `src/lib/db/schema.ts` — `shots` table gained 8 columns, `projects`
  gained 1 (see Data Models). `chain_to_next` dropped (see Migration).

## Data Models
`shots` table, additive-then-one-destructive-drop migration:
- `cameraMove text` — one of `CAMERA_MOVES`' ids, or `null` (no override;
  camera comes from the prompt as written).
- `cameraStrength text` — `'subtle' | 'medium' | 'strong'`, or `null`.
- `endsOn text NOT NULL DEFAULT 'free'` — `'free' | 'next' | 'custom'`.
  Replaced `chainToNext boolean` (Clip Engine v2). Backfill: `chain_to_next
  = true → ends_on = 'next'`, then the column was dropped in the final
  stage after every reader (routes, store, orchestrator, chain-suggestion
  step) moved to `endsOn`.
- `endFramePath text` — R2 key of the authored custom end frame
  (`end-frame.png`), `null` until one exists.
- `endFrameStatus generationStatusEnum DEFAULT 'pending'` — independent
  lifecycle from `imageStatus`/`clipStatus`; reset to `'pending'` (stale-
  flag) whenever the shot's primary image is edited via `editShotImage`
  (see Tradeoffs for the one path that does NOT do this).
- `endFrameInstruction text` — the instruction last used to author the end
  frame, kept for one-click re-rolls.
- `clipDurationChoice integer` — explicit override seconds; `null` = auto-
  match the shot's timeline slot.
- `negativePrompt text` — per-shot override of the project default.
- `useEntityRefs boolean NOT NULL DEFAULT true` — "Cast & locations
  featured" toggle; per-clip escape hatch for reference conditioning.

`projects` table:
- `negativePrompt text` — project-wide default, nullable (unset until the
  gear popover's seed is saved), applied to every clip whose shot doesn't
  set its own.

No project-level default clip model column (unchanged from Clip Engine
v2) — the model choice stays per-shot/per-batch-run, stateless at the
project level.

### Deploy sequence

The `chain_to_next → ends_on` migration above is this release's only
destructive schema change, so it must run in order:
1. **Backfill** — run the `UPDATE` in
   [`docs/feature19/migration-backfill.sql`](./migration-backfill.sql)
   against production to fold `chain_to_next = true` rows into
   `ends_on = 'next'`. Idempotent — safe to re-run.
2. **Verify** — run the `SELECT count(*)` in the same file; it must return
   `0` before proceeding. A non-zero count means the backfill didn't
   converge and the drop must NOT proceed.
3. **Push** — only then run `drizzle-kit push` to apply the schema
   migration that drops `chain_to_next`.

## APIs
| Method | Endpoint | Notes |
|---|---|---|
| `POST` | `/api/projects/:id/shots/:shotId/clip` | Response gains `endFrameSkippedReason`, `cameraBestEffort`, `refsApplied`, `refsSkippedReason`. |
| `POST` | `/api/projects/:id/shots/:shotId/image/edit` | New. Body `{ instruction: string }` (required, ≤500 chars). 400 if image not `done`, 400 if already `generating`. Overwrites `image.png`; stale-flags an existing end frame. |
| `POST` | `/api/projects/:id/shots/:shotId/end-frame` | New. Body `{ instruction: string }` (≤500 chars). 400 if primary image not `done`, 400 if already `generating`. Stores `end-frame.png`. |
| `DELETE` | `/api/projects/:id/shots/:shotId/end-frame` | New. Best-effort R2 delete; nulls the three end-frame fields; flips `endsOn` `custom → free`. |
| `PATCH` | `/api/projects/:id/shots/:shotId` | Gained `cameraMove`/`cameraStrength` (enums or `null`), `endsOn` (`free\|next\|custom`), `clipDurationChoice` (1–15 or `null`), `negativePrompt` (≤500 or `null`), `useEntityRefs` (boolean). Validated before any DB write (all-or-nothing). |
| `PATCH` | `/api/projects/:id` | Gained `negativePrompt` (≤500 chars or `null`). |
| `GET` | `/api/projects/:id/generate-all/preview` | Clip cost now duration-aware (`clipSecondsTotal` sums each target's `resolveClipDuration`). |

## State & Ownership
- **Source of truth:** Neon `shots`/`projects` columns above + R2
  (`image.png`, `end-frame.png`, `clip.mp4`, `clip-sfx.mp4` as separate
  objects under the shot's prefix).
- **Cached on client:** the inspector's `clipModelId`, `negativePromptDraft`,
  `editImageInstruction`, `endFrameInstructionDraft`, `sfxPrompt` local
  state mirror/derive from the shot row and reset on shot change
  (`useEffect` keyed on `shot.id` + the mirrored field); `resolvedDuration`
  and `durationIndex` are derived (not stored) from `selectedModel` +
  `shot.clipDurationChoice`; `projectNegativePrompt` lives in the editor
  store, refreshed into the gear popover's draft every time it opens.

## Security
- **Auth required:** all new/changed routes call `getSession()` → 401
  first, unchanged pattern.
- **Ownership enforced on:** every route via the existing
  `projects.userId` join (404, not 403 — IDOR-hiding convention
  unchanged) — grep-verified on `clip`, `image/edit`, `end-frame` (both
  verbs).
- **CSRF + rate limiting:** `verifyCsrf()` + `applyRateLimit()` (preset
  `"generation"` on every paid `POST` — clip, image/edit, end-frame;
  `"mutation"` on the shot/project `PATCH` and the end-frame `DELETE`) —
  grep-verified present on all three new/changed route files.
- **In-flight guards on every paid POST:** `imageStatus === "generating"`
  (image/edit) and `endFrameStatus === "generating"` (end-frame POST) are
  checked and 400 before the fal call, mirroring the SFX route's
  double-click idiom from Clip Engine v2.
- **Length caps:** `FRAME_EDIT_INSTRUCTION_MAX_CHARS = 500` enforced
  server-side in both frame-edit routes (not just the UI's `maxLength`);
  `negativePrompt` capped at 500 chars server-side at both the shot and
  project `PATCH` routes.
- **Enum/allow-list validation:** `cameraMove`/`cameraStrength` validated
  via `isCameraMove`/`isCameraStrength`; `endsOn` against a fixed
  `VALID_ENDS_ON` array; `clipDurationChoice` bounds-checked (integer,
  1–15) at the route, independent of the per-model `durations` list
  (out-of-range values degrade via `resolveClipDuration`'s nearest-match,
  never a 500); model ids via the registry as in Clip Engine v2.
- **No client-supplied URLs:** reference image URLs are always
  server-derived from the owner's tagged entities
  (`loadTaggedEntities` → `resolveClipReferences` → `uploadR2ObjectToFal`)
  — the client never supplies a URL that reaches fal.
- **No new secrets:** `FAL_KEY` (Kontext + Kling calls) covers every new
  provider call; no new environment variables.

## Cost notes
- Clip cost is now per-second: `estClipUsd(spec, seconds) =
  round2(estUsdPerSecond × seconds)`. Kling v3 Pro (default) $0.112/s,
  Kling 2.5 Turbo Pro $0.084/s, LTX 2.3 $0.06/s, Veo 3.1 Fast $0.15/s — all
  display-only, labeled "~" in every surface.
- Duration auto-matches the shot's timeline slot to the nearest value in
  the model's `durations` list (ties round up); a 3.2s slot on Kling v3
  Pro (`durations: [3..15]`) resolves to 3s (~$0.34) vs. the flat 5s
  default (~$0.56) it would have cost under the old fixed-duration
  pricing — verified live in the Task 11 Stage-1 gate.
- Batch preview sums `estUsdPerSecond × resolvedDuration` **per shot**
  (`clipSecondsTotal`, computed server-side in the preview route), not
  `count × one duration`, so mixed-length shots price accurately.
- Frame-edit calls (`image/edit`, `end-frame`) are ~$0.04 each (same FLUX
  Kontext pricing as reference-sheet conditioning), independent of clip
  cost.
- SFX pricing (`SFX_EST_USD = 0.01`/clip) is unchanged from Clip Engine v2.

## Dependencies
- **External services:** fal.ai (`fal-ai/kling-video/v3/pro/image-to-video`
  — new default; `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`;
  `fal-ai/ltx-2.3/image-to-video`; `fal-ai/veo3.1/fast/image-to-video`;
  `fal-ai/flux-pro/kontext` — reused for both frame-edit verbs, same
  endpoint image-generation.ts already verified; `fal-ai/mmaudio-v2`),
  Anthropic (Haiku, chain suggestions / motion enrichment, unchanged),
  Cloudflare R2, Inngest orchestrator (extended, not replaced).
- **Shared utilities:** `src/lib/api-utils.ts`, `src/lib/db/schema.ts`,
  `src/lib/r2.ts` (`getDownloadUrl`, `deleteObject`),
  `src/lib/fal-upload.ts` (`uploadR2ObjectToFal`, reused for reference
  sheet uploads), `src/lib/shot-beat-mapping.ts` (new
  `orderShotsByTimeline`, also consumed by the inspector's next-shot
  thumbnail).
- **Feature coupling:** F-18 Clip Engine v2 — this feature is a strict
  extension of its registry (`clip-models.ts`), chaining module
  (`clip-chaining.ts`, generalized from boolean to 3-way `endsOn`), and
  batch cost/orchestrator modules; no parallel abstraction was introduced
  for any of the three.

## Coding Patterns Used
- **Pure-decision / effectful-caller split, continued** —
  `resolveEndFrame`, `resolveClipReferences`, `resolveClipDuration`,
  `cameraPromptSuffix`, and `orderShotsByTimeline` are all pure, unit-
  tested directly with no DB/network; `generateShotClip` /
  `editShotImage` / `createShotEndFrame` are the only effectful callers,
  each owning one row's full lifecycle.
- **Degrade-loudly, never fail, extended to three more axes** — an
  unsupported camera falls back to a prompt phrase
  (`cameraBestEffort: true`); missing/unsupported references skip with a
  reason (`refsSkippedReason`); an end frame that isn't ready skips with a
  reason (`endFrameSkippedReason`) — same shape as Clip Engine v2's
  chain-skip pattern, now applied uniformly across camera/refs/ends-on.
- **Single registry, single allow-list gate, continued** —
  `clip-models.ts` remains the only place a fal endpoint id or per-model
  input shape is defined; no route or service builds a fal input shape by
  hand.
- **Decoupled, re-rollable frame assets** — `end-frame.png` is a separate
  R2 object from `image.png`, gated by its own `endFrameStatus` column,
  mirroring the SFX pattern's "own status, cheap re-roll, never blocks
  the parent asset" shape.
- **Timeline-order over storage-order** — `orderShotsByTimeline` replaces
  a `sortOrder`-only "next shot" lookup with the beat-anchored true
  timeline position, fixing a final-review-caught correctness bug
  (duplicate `sortOrder` after a split could resolve the wrong "next"
  shot) rather than patching around it in three call sites independently.

## Tradeoffs

```md
## Tradeoffs
- Camera is best-effort on every model today — no fal image-to-video
  endpoint currently verified (v3 Pro and 2.6 both checked) exposes a hard
  `camera_control` param, so `supportsCameraControl` is `false` across the
  entire registry. The params code path exists and is exercised by unit
  tests, but is unreachable in production until a model ships the param;
  the UI's "best-effort — written into the prompt" hint is the only signal
  a user gets today (there is currently no model showing "guaranteed ✓").
- Custom end frames stale-flag correctly when the start image is
  re-authored via "Edit image…" (editShotImage resets endFrameStatus to
  "pending" on the success path) but NOT when it's regenerated via the
  plain "Re-image" button (generateShotImage, src/lib/shot-image-
  generation.ts, never touches endFramePath/endFrameStatus at all — no
  stale-flag fires). A user who re-images a shot with an authored custom
  end frame gets a silently-stale end frame with no amber note until they
  separately notice or re-create it. This is an inconsistency between the
  two image-changing paths, not a deliberate design choice, and is the
  single biggest gap left by this feature.
- "Custom…" authoring is not gated on the selected model's
  `supportsEndFrame` — a user can author a paid ($0.04) custom end frame
  on a model that will never use it (e.g. Veo 3.1 Fast); the skip note
  (`model-no-end-frame`) only fires at generation time. Treated as
  intentional (author now, switch models later) rather than a bug, per
  Task 15's final-review triage.
- `clipDurationChoice` is validated server-side as "integer 1–15" at the
  shot PATCH route — a fixed bound independent of the selected model's
  actual `durations` list (e.g. LTX only accepts `[6]`). An in-range but
  unlisted value (e.g. 7 on LTX) never 400s; `resolveClipDuration`
  silently substitutes the nearest listed value at generation time. Users
  never see a rejected duration, only a possibly-different one applied.
- Reference-conditioning fidelity varies by model generation and is
  unverified beyond Kling v3 Pro's `elements` schema — the per-clip
  `useEntityRefs` toggle is the accepted escape hatch when it drifts.
- Prices per second are estimates verified against fal's disclosed
  pricing at implementation time (Task 2); totals remain labeled "~" in
  every surface, unchanged from Clip Engine v2's convention.
```

## Known limitations
- **Camera best-effort everywhere.** No verified fal i2v endpoint exposes
  hard camera params yet; every model uses the deterministic prompt-suffix
  fallback (see Tradeoffs).
- **Re-image/end-frame staleness asymmetry (confirmed).** "Edit image…"
  stale-flags a custom end frame; the plain "Re-image" button does not —
  documented above under Tradeoffs, not fixed in this release.
- **Custom… authoring not gated on model support.** A user can pay for an
  end frame a model will ignore; the skip note only surfaces at generation.
- **`clipDurationChoice`'s server bound (1–15) is broader than any single
  model's `durations` list** — an unlisted-but-in-range value is silently
  substituted, not rejected.
