# Clip Engine v2 — Model Registry, Chained Clips, SFX

**Date:** 2026-07-08
**Status:** Approved design, pending implementation plan
**Scope decision:** Clip Engine v2 + SFX built together as one feature (docs/feature18). Transitions between clips are explicitly deferred to the future render/assembly feature (Shotstack, per PRD) — chained continuity is this feature's answer to transitions.

## Problem

Clip quality is limited by the single hardcoded model (LTX-2.3 image-to-video), which is weak at complex directed motion and cannot condition on an end frame. Clips are silent. Model experimentation currently happens via the throwaway `clip-hailuo` route, which overwrites `clipPath` and duplicates code.

## Goals

1. **Better clips** — Kling 2.5 Turbo Pro becomes the default clip model (~$0.35–0.42/clip, within the agreed $0.25–0.50 default budget); LTX-2.3 stays for cheap drafts; Veo 3.1 Fast available for hero shots.
2. **Continuous clips** — per-shot "chain to next" (first/last-frame conditioning): clip N animates from shot N's image to shot N+1's image, so consecutive clips flow seamlessly. Combined with the existing shot-split feature, this also covers directed multi-phase animation (e.g. clock swinging → lands on 12:00 = two chained shots).
3. **SFX** — MMAudio v2 (video→audio, ~$0.001/s) as a decoupled, re-rollable post-step per clip.
4. **Model dropdown** — the clip button gains a model selector with per-model cost and "when to use" guidance, replacing the clip-hailuo A/B hack.
5. **Batch integration** — generate-all picks a batch model, can ask AI to suggest which shot pairs to chain, and can add SFX to all clips; cost preview reflects the chosen model.

## Non-goals

- Transitions (crossfades/wipes) — deferred to the render feature; Shotstack supports them natively at assembly time.
- Clip versioning / side-by-side variant comparison (Approach 3, rejected as YAGNI).
- Per-shot dedicated end-frame images (a second image prompt per shot) — "next shot's image" is the only end-frame source in this iteration.
- Auto-invalidation of chained clips when a neighbor's image regenerates (documented limitation, see Known Limitations).

## Architecture

### Model registry — `src/lib/clip-models.ts` (new)

Single source of truth for clip models:

```ts
type ClipModelId = "ltx-2.3" | "kling-2.5-turbo-pro" | "veo-3.1-fast";

interface ClipModelSpec {
  id: ClipModelId;
  label: string;              // "Kling 2.5 Turbo Pro"
  falEndpoint: string;        // e.g. "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"
  durationSeconds: number;    // fixed per model: LTX 6, Kling 5, Veo 8
  supportsEndFrame: boolean;  // Kling ✓ (tail_image_url), Veo 3.1 ✓, LTX ✗
  nativeAudio: boolean;       // Veo ✓
  estUsdPerClip: number;      // drives cost preview + dropdown display
  whenToUse: string;          // one-line guidance shown in the dropdown
  buildInput(args: {
    imageUrl: string;
    prompt: string;
    tailImageUrl?: string;
  }): Record<string, unknown>;
}
```

- `buildInput` absorbs per-model input-shape differences (Kling's `tail_image_url` + `duration: "5"`, LTX's plain shape, etc.), keeping the generation service model-agnostic.
- **Default model: `kling-2.5-turbo-pro`.**
- Initial entries: LTX-2.3 (draft tier), Kling 2.5 Turbo Pro (default), Veo 3.1 Fast (hero tier). Hailuo is not carried over; adding any model later is one registry entry.
- Exact fal endpoint ids and prices are verified against fal.ai during implementation; `estUsdPerClip` values remain labeled as estimates in the UI (consistent with existing cost-preview rules).

### Schema changes (`shots` table, additive migration)

- `clipModel text` — model id used for the current clip; also the shot's sticky dropdown selection.
- `chainToNext boolean default false` — this clip should end at the next shot's image.
- `sfxPath text` — R2 key of the SFX variant (`clip-sfx.mp4`), null when no SFX.
- `sfxStatus generationStatusEnum default 'pending'` — SFX lifecycle, fully independent of `clipStatus`.

No project-level default-model column: the generate-all dialog passes the batch model per run (stateless).

### Shared fal upload helper — `src/lib/fal-upload.ts` (new, extraction)

`uploadImageToFal` is currently duplicated in `shot-clip-generation.ts` and the clip-hailuo route. It moves to a shared helper generalized for images and video (SFX must upload `clip.mp4` to fal). Both existing copies are deleted.

### Clip generation — `src/lib/shot-clip-generation.ts` (refactored)

`generateShotClip(project, shot, { model })`:

1. Resolve the registry spec: explicit `model` param → shot's `clipModel` → registry default. Unknown ids are rejected before any status flip.
2. **Chaining:** if `shot.chainToNext` and spec `supportsEndFrame`: load the next shot by `sortOrder` within the project; if it has a done image, upload it as the tail image. If the next shot's image isn't ready, the shot is last in sequence, or the model lacks end-frame support → generate **without** the tail and include a `chainSkipped` reason in the result. A missing tail degrades to current behavior; it never fails the clip.
3. Upload start image (+ tail) via the shared fal helper, call `spec.falEndpoint` with `spec.buildInput(...)`.
4. Store to the same `projects/{projectId}/shots/{shotId}/clip.mp4` key; persist `clipPath`, `clipStatus`, `clipDurationSeconds`, `clipModel`.
5. **Reset `sfxPath`/`sfxStatus`** — a regenerated clip invalidates previously generated SFX.

Status lifecycle (generating → done/failed, throw after marking failed) is unchanged.

### Clip route — `POST /api/projects/[id]/shots/[shotId]/clip`

Gains an optional JSON body `{ model?: ClipModelId }`, validated against the registry server-side (unknown → 400). Client input can never route to an arbitrary fal endpoint. Auth/ownership join, CSRF, rate limit, UUID validation unchanged.

**`clip-hailuo` route and its inspector button are deleted.**

### SFX — `src/lib/sfx-generation.ts` + `POST /api/projects/[id]/shots/[shotId]/sfx` (new)

- Precondition: `clipPath` set and `clipStatus = done` (400 otherwise).
- Flow: upload `clip.mp4` to fal → call `fal-ai/mmaudio-v2` with the video URL and an optional user steering prompt (length-capped, e.g. 500 chars) → MMAudio returns the video with the audio track merged → store at `projects/{projectId}/shots/{shotId}/clip-sfx.mp4` → set `sfxPath`, `sfxStatus = done`.
- `clip.mp4` is never modified. Re-roll = re-run this step (~$0.01). Remove SFX = `DELETE` on the same route: deletes the R2 object, nulls `sfxPath`, resets `sfxStatus` to `pending`.
- Same security stack as other shot mutation routes. The steering prompt is passed only to fal, never interpolated into storage keys or logged in full.

### Playback rule (inspector preview + beat playback)

If `sfxPath` exists → play `clip-sfx.mp4` with audio audible (mixed under the beat voiceover). Otherwise → play `clip.mp4` muted, as today.

### Batch (generate-all) integration

- **Model:** the generate-all dialog gets a clip-model dropdown (default Kling); the chosen id is passed in the batch request and used by the orchestrator for every clip in the run.
- **AI chain suggestions:** optional checkbox "Suggest chained shots (AI)". When enabled, one Haiku call receives the ordered shot list (image prompts, beat membership, `referencedEntityIds`) and returns chain yes/no per adjacent pair (criteria: same scene/subject, continuous action). Results are written to `chainToNext` before clip generation begins; the dialog reports how many chains were applied. Users can override per shot in the inspector afterward.
- **SFX for all:** optional checkbox; the orchestrator runs the SFX step after each clip completes.
- **Ordering:** the orchestrator already completes all images before starting clips, so tail images exist by clip time. No new ordering machinery.
- **Cost preview:** `src/lib/generation-costs.ts` drops the hardcoded `CLIP_EST_USD` in favor of the registry's `estUsdPerClip` for the selected model, plus an SFX line item (~$0.01/clip) when enabled. The preview endpoint takes the model id as a param.

### Motion-prompt enrichment

The existing `suggest-motion` route's LLM prompt is upgraded to produce structured motion direction — subject action phases ("swings rapidly, decelerates, settles at 12:00"), camera move, pacing — which stronger models follow far better than one-line prompts. No API shape change.

## UI

### Inspector (shot panel)

- The two clip buttons (LTX + Hailuo A/B) collapse into one row: **model dropdown** (registry-driven: label, ~$ estimate, `whenToUse` line, chain-capability badge) + single **Generate/Re-clip** button. Selection persists to `clipModel`.
- **"Chain to next shot" toggle** below the dropdown. Disabled with an explanatory tooltip when the selected model lacks end-frame support or the shot is last in sequence. When on, shows a small thumbnail of the next shot's image (the frame this clip will land on).
- After a clip exists: **"Add SFX"** button with an optional steering-prompt text field; once generated: play / re-roll / remove controls. Status and error surfaces reuse existing `clipStatus`/`sfxStatus` patterns.

### Generate-all dialog

Batch model dropdown (default Kling), "Suggest chained shots (AI)" checkbox, "SFX for all clips" checkbox, cost preview reflecting all three.

## Error handling

- Unknown/unsupported model id → 400 before any status change.
- Chain preconditions unmet → degrade to unchained generation with a `chainSkipped` reason surfaced in the response and UI (toast/inline note), never a failure.
- fal errors → existing pattern: mark `failed`, log, surface message; batch orchestrator's existing per-item failure isolation applies to SFX steps too.
- SFX on a shot without a done clip → 400 with a clear message.

## Security summary

- All new/changed routes: session auth + project-ownership join, CSRF verification, generation rate-limit, UUID validation (existing `api-utils` stack).
- Model id allow-listed via the registry — the only values that ever reach `fal.subscribe` endpoints are registry constants.
- SFX steering prompt: length-capped, forwarded only to fal.
- No new secrets; existing `FAL_KEY` covers all endpoints.

## Testing

Test cases live in `docs/feature18/test-case.md` with acceptance criteria, expected outcomes, and edge cases.

- **Unit:** registry `buildInput` mapping per model; chain-precondition logic (missing next image / unsupported model / last shot / next shot deleted); cost estimation per model + SFX; SFX reset on clip regeneration.
- **Integration (paid, minimal):** one smoke clip per registry model against real fal; one chained pair checked for visual continuity; one MMAudio round-trip — using the established throwaway-project verification pattern.
- **Batch:** small project run with AI chaining + SFX enabled; verify chain flags written, ordering, cost preview accuracy.
- **Playwright:** dropdown renders registry entries with costs; chain toggle disable states; SFX controls appear only after a clip exists.

## Known limitations (documented, accepted)

- Regenerating shot N+1's image leaves clip N (chained to the old image) stale until clip N is regenerated. No auto-invalidation in this iteration.
- End-frame conditioning quality depends on visual proximity of the two stills; chains across scene cuts will look morphy. The AI suggester's same-scene criteria mitigate this; manual toggles are the user's responsibility.
- Clip durations vary by model (5/6/8s); the timeline already stores per-clip `clipDurationSeconds` and handles varying lengths.

## Rejected alternatives

- **Minimal swap (no registry):** doesn't deliver the dropdown; next model experiment recreates the clip-hailuo hack.
- **Clip versioning with side-by-side variants:** variants table + storage lifecycle + picker UI for a workflow approximated by regenerating; YAGNI.
- **ElevenLabs SFX (text→audio):** decoupled but never synced to the video; MMAudio watches the clip so action sounds land on time, at negligible cost. Registry pattern leaves room to add it later.
- **Per-shot dedicated end-frame images:** requires AI to author a second, visually-near image prompt per shot (generative, error-prone, +cost); shot-split + chaining covers the directed two-phase use case.
