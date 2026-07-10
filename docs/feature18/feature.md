# Feature: F-18 Clip Engine v2 — Model Registry, Chained Clips, SFX

> **Status: Implementation complete (Tasks 1–15). Paid smoke tests and final
> merge to master are handled separately by the controller (Task 16 Steps
> 3/6+) — this document ships alongside that hand-off.**
> Branch `feat/clip-engine-v2`. Design:
> [`docs/superpowers/specs/2026-07-08-clip-engine-v2-design.md`](../superpowers/specs/2026-07-08-clip-engine-v2-design.md).
> **Depends on:** F-17 Batch "Generate all" (shipped 2026-07-07) — this
> feature extends the same targeting/orchestrator/cost-preview modules
> rather than replacing them.

## Feature
- **Name:** Clip Engine v2 (model registry, chained clips, SFX)
- **Purpose:** Replace the single hardcoded LTX-2.3 clip path with a
  registry of selectable fal.ai image-to-video models (Kling 2.5 Turbo Pro
  default, LTX-2.3 draft tier, Veo 3.1 Fast hero tier), add per-shot
  "chain to next" end-frame conditioning so consecutive clips flow
  seamlessly, and add MMAudio v2 SFX as a decoupled, re-rollable post-step.
  All three integrate into both the per-shot inspector and the batch
  "Generate all" flow. The clip-hailuo A/B throwaway route is retired.

## Key Files

Frontend:
- `src/components/editor/inspector.tsx` — clip model dropdown (label, ~$
  estimate, `whenToUse` guidance, chain-capability badge), "Chain to next
  shot" toggle (disabled with a tooltip when the selected model has no
  end-frame support, e.g. Veo, or when the shot is last in sequence;
  next-shot thumbnail shown when active), and the SFX row (Add/Re-roll/
  Remove, optional steering-prompt input, only shown once a clip exists
  and is `done`).
- `src/components/editor/generate-all-dialog.tsx` — batch clip-model
  dropdown (default Kling), "Let AI suggest chained shots" checkbox
  (default ON), "Add SFX to all clips (N)" checkbox (default OFF, count
  shown), cost preview reflecting model + SFX.
- `src/components/editor/editor-store.tsx` — `generateClip(shotId, model)`,
  `generateSfx(shotId, prompt)`, `removeSfx(shotId)`, `updateShot` extended
  for `chainToNext`/`clipModel`, `fetchGenerateAllPreview`/`generateAll`
  extended for `clipModel`/`suggestChains`/`includeSfx`; shot serializer
  carries `clipModel`, `chainToNext`, `sfxPath`, `sfxStatus`, `sfxUrl`.

Backend:
- `src/lib/clip-models.ts` — the model registry (new): `ClipModelSpec` per
  model (`falEndpoint`, `durationSeconds`, `supportsEndFrame`,
  `nativeAudio`, `estUsdPerClip`, `whenToUse`, `buildInput()`),
  `DEFAULT_CLIP_MODEL_ID`, `getClipModel`/`isClipModelId` allow-list
  helpers, `SFX_EST_USD`.
- `src/lib/clip-chaining.ts` — `resolveChainDecision()`, pure logic
  deciding whether a clip generation uses the next shot's image as an end
  frame, and if not, why (`ChainSkipReason`).
- `src/lib/chain-suggestion.ts` — `buildChainPairs()` (pure adjacent-pair
  construction), `sanitizeChainSuggestions()` (pure allow-list of model
  output), `suggestChains()` (one Haiku tool-call per batch run;
  best-effort, returns `[]` on any failure).
- `src/lib/fal-upload.ts` — `uploadR2ObjectToFal()` (new, extraction): the
  shared R2→fal storage upload used by clip generation, chain tail-image
  upload, and SFX's clip upload. Replaces two independent duplicates that
  existed in `shot-clip-generation.ts` and the deleted `clip-hailuo` route.
- `src/lib/shot-clip-generation.ts` — `generateShotClip()` (refactored):
  resolves the model from the registry, resolves the chain decision,
  uploads image (+ tail), calls the selected `falEndpoint`, stores
  `clip.mp4`, persists `clipPath`/`clipStatus`/`clipDurationSeconds`/
  `clipModel`, and resets `sfxPath`/`sfxStatus` on every regeneration.
- `src/lib/sfx-generation.ts` — `generateShotSfx()` (new): uploads
  `clip.mp4` to fal, calls `fal-ai/mmaudio-v2` with an optional
  user-steering prompt (falls back to `DEFAULT_SFX_PROMPT` — MMAudio's
  schema requires a non-empty prompt), stores the merged output at
  `clip-sfx.mp4`, owns the `sfxStatus` lifecycle.
- `src/lib/generation-costs.ts` — `estimateBatchCost()` now prices clips
  from the selected model's registry entry (dropped the flat
  `CLIP_EST_USD` constant) and adds an optional SFX line item.
- `src/lib/batch-targeting.ts` — `computeBatchTargets()` gained
  `sfxShotIds` (done clips missing SFX), used for SFX-only batch
  reachability.
- `src/inngest/functions/generate-batch.ts` — orchestrator extended with
  an optional chain-suggestion step (before wave 3) and a wave 4 (SFX,
  chunked, only for clips that are `done`); threads the selected
  `clipModel` into every `generateShotClip` call.
- `src/app/api/projects/[id]/shots/[shotId]/clip/route.ts` — gained
  optional body `{ model?: ClipModelId }`, validated via `isClipModelId`.
- `src/app/api/projects/[id]/shots/[shotId]/sfx/route.ts` — new: `POST`
  (generate/re-roll) + `DELETE` (remove, keeps the clip).
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — `PATCH` gained
  `chainToNext` (boolean) and `clipModel` (id or `null` to reset to
  default) fields.
- `src/app/api/projects/[id]/generate-all/route.ts` — `POST` body gained
  `clipModel`, `suggestChains`, `includeSfx`.
- `src/app/api/projects/[id]/generate-all/preview/route.ts` — `GET` gained
  `clipModel`/`includeSfx` query params; response gained an `sfx` line
  item whose `count` is always the *potential* SFX work (this run's clips
  + already-done clips missing SFX), independent of whether SFX is
  currently checked.
- `src/app/api/projects/[id]/shots/suggest-motion/route.ts` — Haiku
  prompt upgraded to request structured, phased motion direction (subject
  action phases, camera move, pacing) instead of one-line prompts; no API
  shape change.
- `src/lib/db/schema.ts` — `shots` table gained 4 columns (see Data
  Models).
- **Deleted:** `clip-hailuo` route and its inspector A/B button; the two
  duplicated `uploadImageToFal` copies (superseded by `fal-upload.ts`).

## Data Models
`shots` table, additive migration:
- `clipModel text` — model id used for the shot's current/next clip; also
  the dropdown's sticky selection. `null` = "use registry default."
- `chainToNext boolean default false not null` — this shot's clip should
  end on the next shot's image (subject to model support + next-image
  readiness at generation time).
- `sfxPath text` — R2 key of the SFX variant (`clip-sfx.mp4`), `null` when
  no SFX exists.
- `sfxStatus generationStatusEnum default 'pending'` — SFX lifecycle
  (`pending`/`generating`/`done`/`failed`), fully independent of
  `clipStatus`. Reset to `pending` (with `sfxPath` nulled) every time the
  clip is regenerated or SFX is explicitly removed.

No project-level default-model column — the batch dialog passes the model
per run (stateless), matching the design decision to avoid a second
sticky-state surface.

## APIs
| Method | Endpoint | Notes |
|---|---|---|
| `POST` | `/api/projects/:id/shots/:shotId/clip` | Body `{ model?: ClipModelId }` (optional). Unknown id → 400 before any status change. Response includes `clipModel` and optional `chainSkippedReason`. |
| `POST` | `/api/projects/:id/shots/:shotId/sfx` | Body `{ prompt?: string }` (≤500 chars). 400 if clip isn't `done`; 400 if SFX already `generating`. |
| `DELETE` | `/api/projects/:id/shots/:shotId/sfx` | Deletes the R2 object (best-effort — a failed R2 delete still resets the DB row), nulls `sfxPath`, resets `sfxStatus` to `pending`. |
| `PATCH` | `/api/projects/:id/shots/:shotId` | Gained `chainToNext` (boolean) and `clipModel` (id or `null`) fields, validated alongside the route's existing bounds/prompt/tagging fields. |
| `POST` | `/api/projects/:id/generate-all` | Body gained `clipModel`, `suggestChains`, `includeSfx` (only meaningful when `includeClips: true`). |
| `GET` | `/api/projects/:id/generate-all/preview` | Gained `clipModel`/`includeSfx` query params; response gained `sfx: { count, estUsd }`. |

## State & Ownership
- **Source of truth:** Neon `shots` columns (`clipModel`, `chainToNext`,
  `sfxPath`, `sfxStatus`) + R2 (`clip.mp4`, `clip-sfx.mp4` as separate
  objects under the same shot prefix).
- **Cached on client:** the inspector's `clipModelId` local state mirrors
  `shot.clipModel` (reset on shot change or on an external patch, e.g. a
  batch AI-chain write flipping `chainToNext`) and is optimistically
  written to the shot on every dropdown change so the Clip button always
  targets the currently-selected model. The SFX steering-prompt input is
  local-only (never persisted) and clears on shot change but *not* on
  model change (an in-progress steering prompt survives switching clip
  models).

## Security
- **Auth required:** all new/changed routes call `getSession()` → 401
  first, unchanged pattern.
- **Ownership enforced on:** every route via the existing
  `projects.userId` join (404, not 403 — IDOR-hiding convention
  unchanged).
- **CSRF + rate limiting:** `verifyCsrf()` and `applyRateLimit()` (preset
  `"generation"` on clip/sfx `POST` and batch dispatch, `"mutation"` on
  the shot `PATCH` and the sfx `DELETE`) on every new/changed mutation,
  matching every other route in the app.
- **Model id allow-list:** `isClipModelId()` is the *only* gate between a
  client-supplied string and `fal.subscribe(spec.falEndpoint, ...)` — used
  identically in the clip route, the shot `PATCH` route, and the
  generate-all dispatch/preview routes. An unrecognized id is rejected
  with 400 before any DB write or status flip; a client can never reach an
  arbitrary fal endpoint.
- **SFX steering prompt:** length-capped at `SFX_PROMPT_MAX_CHARS = 500`
  server-side (validated in the route, not just the UI's `maxLength`);
  forwarded only to fal, never interpolated into R2 keys or logged in
  full.
- **No new secrets:** existing `FAL_KEY` (fal calls) and Anthropic API key
  (chain-suggestion Haiku call, `suggest-motion`) cover every new
  provider call.

## Cost notes
- Clip cost is registry-driven per model (`estUsdPerClip`), display-only
  and labeled "estimate" in every surface (dropdown, inspector button
  tooltip, batch preview): Kling 2.5 Turbo Pro ~$0.42/clip (default, 5s),
  LTX-2.3 ~$0.36/clip (draft, 6s, `end_image_url` end-frame support,
  `generate_audio` forced off), Veo 3.1 Fast ~$1.20/clip (hero, 8s, native
  audio, **no end-frame support** in this registry).
- SFX is a flat `SFX_EST_USD = 0.01`/clip display estimate (MMAudio v2 is
  priced ~$0.001/s by fal; a clip is a few seconds).
- Batch preview's `sfx.count` is **always** the potential SFX work
  (this-run clips + already-`done` clips still missing SFX) regardless of
  whether the SFX checkbox is checked, so the dialog can offer an
  SFX-only path; `sfx.estUsd` is gated on `includeSfx` (0 unless
  requested). `estimateBatchCost()`'s `sfx` count param independently
  defaults to the `clips` count when omitted (unit-tested).

## Dependencies
- **External services:** fal.ai (`fal-ai/kling-video/v2.5-turbo/pro/image-to-video`,
  `fal-ai/ltx-2.3/image-to-video`, `fal-ai/veo3.1/fast/image-to-video`,
  `fal-ai/mmaudio-v2`), Anthropic (Haiku, `claude-haiku-4-5-20251001`, for
  both chain suggestions and motion-prompt enrichment), Cloudflare R2,
  Inngest (existing orchestrator, extended not replaced).
- **Shared utilities:** `src/lib/api-utils.ts` (session, CSRF, rate-limit,
  UUID validation), `src/lib/db/schema.ts`, `src/lib/r2.ts`
  (`getDownloadUrl`, `deleteObject`), `src/lib/fal-upload.ts` (new shared
  helper this feature introduces and both clip + SFX generation consume).
- **Feature coupling:** F-17 Batch "Generate all" — this feature extends
  `batch-targeting.ts`, `generation-costs.ts`, and
  `generate-batch.ts`'s wave structure rather than introducing a parallel
  batch mechanism; the orchestrator's existing sheets→images ordering is
  unchanged, clips/chain-suggestions/SFX are added as later waves.

## Coding Patterns Used
- **Single registry, single allow-list gate** — `clip-models.ts` is the
  only place a fal endpoint id or per-model input shape is defined;
  `isClipModelId`/`getClipModel` are the only functions any route or
  service calls to resolve a client-supplied model string, so there is
  exactly one place a new model is added and exactly one place client
  input is validated against it (mirrors F-16/F-17's "one shared
  computation, many callers" pattern).
- **Pure-decision / effectful-caller split** — `resolveChainDecision()`
  and `buildChainPairs()`/`sanitizeChainSuggestions()` are pure functions
  with no DB/network access, unit-tested directly; the effectful callers
  (`generateShotClip`, `suggestChains`) are thin wrappers that fetch data
  and hand it to the pure function — same split the design doc's Testing
  section calls out.
- **Route-thin, service-owns-lifecycle extraction** (continued from
  F-17) — `generateShotClip`/`generateShotSfx` each own their row's full
  `generating → done/failed` transition and are called identically by a
  thin HTTP route and a thin Inngest step.
- **Decoupled, re-rollable post-step** — SFX never mutates `clip.mp4`;
  it's a second R2 object gated by its own status column, so re-rolling
  or removing SFX is always cheap and never re-triggers or risks the
  (expensive) clip generation.
- **Degrade-loudly, never fail** — an unmet chain precondition (no
  end-frame support, last shot, next image not ready) downgrades the clip
  to unchained generation and surfaces a reason in the response; it is
  never a generation failure. Same shape as F-17's sheet-failure
  fallback.

## Tradeoffs

```md
## Tradeoffs
- Regenerating shot N+1's image leaves clip N (chained to the old image)
  stale until clip N is explicitly regenerated — no auto-invalidation.
  Accepted scope cut (design doc "Non-goals").
- End-frame conditioning quality depends on visual proximity of the two
  stills; chaining across a scene cut looks morphy. The AI suggester's
  same-scene/continuous-action criteria and the "when in doubt, leave it
  out" system prompt mitigate this for batch runs; manual per-shot toggles
  are the user's responsibility in the inspector.
- Clip durations are fixed per model (LTX 6s, Kling 5s, Veo 8s) rather
  than user-configurable; the existing per-clip `clipDurationSeconds`
  column already handles the resulting variable-length timeline, so this
  is a UX simplicity tradeoff, not a technical gap.
- "SFX-only" batch dispatch is reachable but not a first-class mode: it
  requires `includeClips: true` with zero actual clip targets (the "Also
  generate clips" checkbox becomes checkable once either clips or SFX
  work exists) — the dispatch payload and orchestrator branch are shared
  with the clips-included path rather than a dedicated SFX-only code path.
- Motion-prompt enrichment (`suggest-motion`) is a system-prompt upgrade
  only; there is no structural change to how the resulting text is stored
  or consumed downstream, so quality depends entirely on the underlying
  model following the phased-direction instructions.
```

## Known limitations
- **Stale chained clips after neighbor image regen.** No auto-invalidation
  in this iteration — regenerating shot N+1's image does not touch shot
  N's already-generated (chained) clip.
- **Morphy chains across scene cuts.** End-frame conditioning quality
  depends on visual proximity between the two stills; chaining across a
  scene cut produces visibly morphy interpolation. Mitigated, not
  eliminated, by the AI suggester's same-scene criteria.
- Per-model fixed durations (5/6/8s) — not user-configurable per clip.
