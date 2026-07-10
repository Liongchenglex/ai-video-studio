# Clip Engine v3 — Directing Controls

**Date:** 2026-07-10
**Status:** Approved design, pending implementation plan
**Scope decision:** one feature (docs/feature19), one plan with three independently shippable stages: (1) engine + structured controls, (2) entity references in clips, (3) frame staging. UI layout was locked interactively (mockup: `.superpowers/brainstorm/22323-1783695100/content/inspector-layout-v3.html`).

## Problem

Clip quality currently depends on free-text prompts. Camera moves, endings, character consistency during motion, and clip length are all "hope the prompt works." Clip Engine v2 fixed endings between shots (chaining); this feature turns the remaining asks into structured, guaranteed-or-clearly-best-effort controls.

## Goals

1. **Camera as a control** — enum picker (static, push-in, pull-back, pan-left/right, tilt-up/down, orbit) + strength (subtle/medium/strong). Hard `camera_control` params on models that support them (Kling 2.6+/v3 — verify per endpoint); standardized prompt phrase on the rest, with a "guaranteed ✓ / best-effort" hint.
2. **Negative prompt** — project default (editable in a toolbar popover, seeded `"blur, warping, morphing, distorted faces, extra limbs, text artifacts"`) + per-shot Advanced override. Sent only to models that support it.
3. **Duration** — auto-match the shot's timeline slot to the nearest value in the model's `durations` (ties round up), with an explicit per-shot override stepper. Cost becomes duration-aware.
4. **Entity references in clips** — tagged entities' reference sheets ride into video generation (`elements` on Kling v3 / reference inputs) so cast stays on-model during motion. Auto-on, per-clip toggle.
5. **Frame staging via FLUX Kontext editing** — "Edit image…" (instruction-edits the shot's still in place) and a third ends-on mode, **Custom**, which edits the start still into an authored end frame ("hands now at 12:00") the clip must land on.
6. **New default model** — Kling v3 Pro (start+end image, elements, negative prompt, cfg, durations 3–15s, `generate_audio: false` forced). Kling 2.5 Turbo Pro stays (budget chaining), LTX (draft), Veo 3.1 Fast (hero audio).

## Non-goals

- Motion-transfer video-to-video, multi-take variants, draft→hero pipeline, post-processing upscale (future candidates).
- Batch-generating custom end frames (deliberate per-shot directing only).
- Per-shot dedicated end-frame *prompts* (Custom always edits from the start still — that's what keeps drift low).

## UI (locked)

Shot inspector, top to bottom:

- **Cast & locations in this shot** — the existing tag chips, unchanged position and behavior; helper text becomes "★ primary · sheets condition the image **and the clip**". No second chip surface anywhere.
- **Image — what we see**: image prompt, Re-image, **Edit image…** (inline instruction field + Apply → Kontext-edits the still in place; normal re-image consequences).
- **Action — what happens in the shot**: action prompt (placeholder: `e.g. "the boat sails toward the horizon"`), **Camera move** segmented picker + strength + guaranteed/best-effort hint, **Ends on** segmented control `Free | Next shot | Custom…` with the active target's thumbnail; *Custom…* expands instruction field + "Create end frame". Skip notes render as the existing amber inline note.
- **Clip — engine settings**: model dropdown (existing pattern), **Length** stepper `4s (auto)` ↔ explicit values from the model's `durations` with reset-to-auto, **Cast & locations featured** toggle showing derived names ("Keeper, Boat — from your tags"), **Advanced ▸** per-shot negative prompt, Generate button pricing live (`estUsdPerSecond × duration`).
- **Sound**: SFX controls unchanged.

Editor toolbar: settings popover (gear) with the project negative prompt. Batch dialog: structurally unchanged; duration-aware clip estimates; chain suggestions now write `ends_on='next'`. Storyboard: tiny corner badge on tiles with a custom end frame.

### "Ends on" semantics (who decides the final frame)

- **Free** — unconstrained (today's unchained behavior).
- **Next shot** — final frame is the next shot's image by timeline order (v2 chaining).
- **Custom** — final frame is the Kontext-edited start still per the user's instruction.

## Architecture

### Registry (`src/lib/clip-models.ts`, extended)

```ts
interface ClipModelSpec {
  // …existing…
  durations: number[];             // v3: [3..15]; Kling 2.5: [5,10]; LTX: [6]; Veo: [8]
  estUsdPerSecond: number;         // replaces flat estUsdPerClip
  supportsCameraControl: boolean;
  supportsReferences: boolean;
  supportsNegativePrompt: boolean;
  supportsEndFrame: boolean;       // as today
  buildInput(args: {
    imageUrl: string; prompt: string; tailImageUrl?: string;
    camera?: CameraParams; negativePrompt?: string;
    durationSeconds?: number; referenceImageUrls?: string[];
  }): Record<string, unknown>;
}
```

New entry `kling-v3-pro` becomes `DEFAULT_CLIP_MODEL_ID`. Endpoint id, per-second price, and whether v3 exposes hard `camera_control` (vs. camera-in-prompt) are verified against fal live docs at implementation, exactly like v2's Task-2 pattern; capability flags are set to reality, not the spec table.

### Camera module (`src/lib/clip-camera.ts`, new, pure)

`buildCameraInput(move, strength, spec)` → `{ params }` (hard camera_control; strength maps subtle/medium/strong → magnitude 3/6/9) or `{ promptSuffix }` (standardized phrase, e.g. `"Camera: slow push-in."`) or `{}` when move is null. Unit-tested per model class.

### End-frame resolution (`src/lib/clip-chaining.ts`, generalized)

`resolveEndFrame(shot, nextShot, spec)` → `{ tailImagePath? , skipReason? }`. Reasons: existing four plus `custom-frame-not-ready`. Precedence: `ends_on='custom'` → `end_frame_path` if `done`; `'next'` → next shot's done image by **timeline order** (v2 helper); `'free'` → none. Degrade loudly, never fail.

### Frame-edit service (`src/lib/shot-frame-edit.ts`, new) + routes

FLUX Kontext (`fal-ai/flux-pro/kontext`, already used for stills) with `{ image_url: <current still>, prompt: <instruction> }`:
- `POST /shots/[shotId]/image/edit` `{ instruction ≤500 }` → overwrites `image.png` (standard re-image lifecycle/consequences).
- `POST /shots/[shotId]/end-frame` `{ instruction ≤500 }` → stores `end-frame.png`, sets `end_frame_path/status/instruction`. `DELETE` clears the three fields and flips `ends_on` to `'free'`.
Both ~$0.04, SFX-pattern lifecycle (own status, cheap re-roll), full route security stack.

### Clip service (`shot-clip-generation.ts`, extended)

Resolution order per generation: model spec → end frame (above) → camera (above) → references (`use_entity_refs && spec.supportsReferences` → tagged entities with done sheets → sheet R2 keys uploaded via `uploadR2ObjectToFal` → `referenceImageUrls`) → duration (`clip_duration_choice ?? nearest(durations, slotLength)`, ties up). Response gains `refsSkipped?`/`cameraBestEffort?` notes alongside `chainSkippedReason` (renamed field stays for compat within the release). Clip regen still resets SFX.

### Schema (additive; one destructive step staged last)

shots: `camera_move text`, `camera_strength text`, `ends_on text NOT NULL DEFAULT 'free'`, `end_frame_path text`, `end_frame_status generation_status DEFAULT 'pending'`, `end_frame_instruction text`, `clip_duration_choice integer`, `negative_prompt text`, `use_entity_refs boolean NOT NULL DEFAULT true`.
projects: `negative_prompt text`.
Migration: backfill `chain_to_next=true → ends_on='next'`; drop `chain_to_next` only in the final stage after all readers are migrated (routes, store, orchestrator, suggest-chains step).

### Batch

Orchestrator passes nothing new (directing inputs live on shot rows). Chain-suggestion step writes `ends_on='next'`. Cost preview sums `estUsdPerSecond × resolvedDuration` per shot (server-side, still labeled estimates). `ends_on='custom'` shots batch-generate using their end frame if `done`, else degrade with the skip note.

## Error handling

Every directing input degrades independently and loudly: unsupported camera → prompt fallback (hint shows before generating); refs unsupported/missing sheets → skipped with note; custom frame not ready → free with note; invalid enum/duration/ends_on values → 400 at the route (allow-list validation). Hard failures remain only the fal call itself (existing failed-status lifecycle).

## Security

- New routes (`image/edit`, `end-frame`, project negative-prompt PATCH addition): rate-limit → CSRF → session → UUID → ownership join.
- Instructions and negative prompts length-capped (500), forwarded only to fal, never in storage keys or full-text logs.
- `camera_move`/`camera_strength`/`ends_on` validated against enums; duration validated against the model's `durations` list; model ids via registry as today.
- Reference image URLs are always server-derived from the owner's entities — the client never supplies URLs.

## Testing

- **Unit (vitest):** camera mapping (params vs prompt fallback per spec flags, strength magnitudes), `resolveEndFrame` precedence + all skip reasons, duration auto-match incl. tie round-up and fixed-duration models, duration-aware cost estimates, reference resolution (toggle off / unsupported model / missing sheets).
- **test-case.md (docs/feature19):** route validation TCs, UI TCs per the locked mockup (group labels, camera hint, ends-on thumbnails, length stepper auto/override, featured toggle derived names, advanced negative field), paid TCs.
- **Paid smoke (user-gated, ~$3–4):** hero test = one Kling v3 clip combining camera push-in + entity refs + custom end frame (clock-at-midnight directed within a single shot); plus prompt-fallback camera on LTX and a duration auto-match check. Throwaway-project pattern.

## Known limitations (documented, accepted)

- Camera is best-effort on models without hard params; the hint makes the mode visible before spending.
- Custom end frames go stale if the start image is regenerated/edited afterwards — `end_frame_status` resets to flag it; re-create from the saved instruction is one click.
- Reference-conditioning fidelity varies by model generation; the toggle is per-clip an escape hatch.
- Prices per second are estimates verified at implementation; totals remain labeled "~".

## Rejected alternatives

- **Tabs / collapsed-summary inspector layouts** — rejected interactively for discoverability (mockups A/B/C).
- **Second chip row for clip references** — duplicates the existing tags; replaced with a derived toggle line using the "Cast & locations" vocabulary.
- **Chain checkbox + separate end-frame tool** — two controls with precedence conflicts; replaced by the 3-way "Ends on".
- **Prompt-only camera everywhere** — wastes Kling's guaranteed params.
- **Generating end frames from fresh prompts** — drift risk; Custom always edits the existing still.
