# Feature: F-08 Timeline Editor (v3.0 — editor-first product surface)

> **⚠ PLANNED v4.0 EVOLUTION — design approved 2026-06-13.**
> The sections below document the **current v3.0 implementation** and remain
> accurate for the code on disk. A major redesign is specced but **not yet
> built**: see
> [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md).
> Headline changes when v4.0 lands — update this doc then:
> - **Unified editor:** the separate VO step folds in; script is editable in
>   place. One screen for writing + voicing + storyboarding.
> - **Two-layer timeline:** **beats** (own their text + VO clip) over
>   **shots** (visuals under a beat). `shots` gains `beatId`, offset-in-beat
>   timing, and `referencedEntityIds` (see F-16).
> - **Two views over one shared store:** Timeline (timing) ⇄ Storyboard
>   (scannable card grid + batch-review). This realizes backlog **#9**.
> - **"Generate all"** batch directing flow replaces the one-shot-at-a-time grind.
> - **Reference Bible** left rail for character/setting consistency (**F-16**).

## Feature
- **Name:** Timeline Editor
- **Purpose:** Full-page workspace where the user places shots on a
  timeline over the project voiceover. Each shot is a user-defined time
  range paired with an image prompt, a motion prompt, a generated image
  (FLUX.1 Kontext), and an animated clip (LTX-2.3 or Hailuo 02). The editor
  is the core product surface for v3.0 — it replaced both the old Visuals
  and Assembly steps.

## Scope of this doc

F-08 absorbs work that was previously spread across:
- v2.0 "Visuals" step (per-scene image + clip preview)
- v2.0 "Editor" step (timeline mockup)
- v2.0 Assembly feature (Shotstack render) — still pending in v3.0; this
  feature.md covers the editor UX only. A separate feature.md for Final
  Render will exist when F-08 rendering is built.

## Key Files

Frontend:
- `src/components/step-editor.tsx` — the stepper node. VO-gate before the
  editor is usable; renders `EditorPrototype` once VO is ready.
- `src/components/editor-prototype.tsx` — the entire editor component.
  Timeline, playhead, clip blocks, drag/trim interactions, Recommend
  button, shot edit / gap create side panel, main video preview synced to
  playhead.
- `src/components/project-workspace.tsx` — orchestrator; owns
  `shots: ShotData[]`, all shot CRUD handlers, `generateShotImage`,
  `generateShotClip` (both LTX and Hailuo variants), and the
  `handleRecommendShots` entry point.

Backend:
- `src/lib/shot-recommendation.ts` — two-stage shot recommendation.
  Stage 1: deterministic script split at punctuation boundaries under a
  char-per-second cap derived from the actual VO duration. Stage 2:
  Claude Sonnet 4.5 generates one image prompt per fragment; motion
  prompts default to a placeholder.
- `src/lib/shot-timing.ts` — (deleted in the pivot; functionality inlined
  into `shot-recommendation.ts`'s `assignTimings`).
- `src/lib/vo-text.ts` — `deriveVOText(script, totalDurationSeconds, start, end)`:
  proportional char-to-second mapping used to derive the VO fragment that
  plays during a given shot's time range.
- `src/lib/image-generation.ts` — `generateImage(r2Key, stillImagePrompt, styleString)`.
  Used by the shot image endpoint.
- `src/app/api/projects/[id]/shots/**` — all shot CRUD + asset endpoints
  (see APIs section).

## Data Models

**`shots` table (v3.0 shape).** Attaches directly to projects; the
`scenes` layer was removed during the pivot.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| projectId | uuid (FK cascade) | |
| sortOrder | integer | monotonic only; actual order is `startSeconds` |
| startSeconds | integer NOT NULL | position on the project timeline |
| endSeconds | integer NOT NULL | must be > startSeconds |
| text | text | cached VO fragment for display (derived from `projects.script` + bounds) |
| imagePrompt | text NOT NULL | subject + composition; no colors/style per v3.0 rules |
| motionPrompt | text NOT NULL | subject action + subtle camera |
| imagePath | text | R2 key of the generated still |
| imageStatus | enum | pending / generating / done / failed |
| clipPath | text | R2 key of the generated clip (LTX or Hailuo) |
| clipStatus | enum | pending / generating / done / failed |
| clipDurationSeconds | integer | measured from the clip output |
| createdAt / updatedAt | timestamp | |

Index: `shots_project_id_sort_order_idx` on (projectId, sortOrder).

## APIs

All routes are auth-required and ownership-scoped via a join from
`shots → projects` where `projects.userId === session.user.id`.

### Shot CRUD
- `POST /api/projects/:id/shots` — create a shot in an empty gap. Rejects
  on overlap.
- `PATCH /api/projects/:id/shots/:shotId` — update bounds and/or prompts.
  Re-validates overlap on bounds change; re-derives cached `text` from
  the new range.
- `DELETE /api/projects/:id/shots/:shotId` — delete a shot.
- `POST /api/projects/:id/shots/:shotId/split` — split at `atSeconds`;
  left half reuses the existing row with new `endSeconds`, right half is
  a fresh row that inherits prompts + imagePath + clipPath.

### Recommend + Suggest
- `POST /api/projects/:id/shots/recommend` — replaces all existing shots.
  Uses `src/lib/shot-recommendation.ts`; see that file for the two-stage
  architecture.
- `POST /api/projects/:id/shots/suggest-image` — Haiku generates one image
  prompt for the given `voText`. Used by the "AI suggest" button next to
  the image prompt field in both shot-edit and gap-create forms.
- `POST /api/projects/:id/shots/suggest-motion` — Haiku generates one motion
  prompt. Requires both `voText` and `imagePrompt` so the motion fits the
  actual visual. Disabled in the UI until an image prompt exists.

### Asset generation per shot (synchronous, server awaits fal.ai)
- `POST /api/projects/:id/shots/:shotId/image` — FLUX.1 Kontext. ~20–30s.
- `POST /api/projects/:id/shots/:shotId/clip` — LTX-2.3. ~60–120s.
- `POST /api/projects/:id/shots/:shotId/clip-hailuo` — MiniMax Hailuo 02
  Standard 768p. A/B test alternative. ~60–90s. Writes to a distinct R2
  key (`clip-hailuo.mp4`); shot.clipPath points at whichever was
  generated last.

## State & Ownership

- **Source of truth:** Neon `shots` table + R2 assets.
- **Client state:** `ProjectWorkspace.shots` is the canonical client
  mirror; `EditorPrototype` keeps an internal sibling (`shots`) synced via
  `useEffect(() => setShots(propShots), [propShots])` and persists
  changes back to the server on drag-end, blur, or button click.
- **Mutation flow:** endpoint → database → response with the canonical row
  → client merges server fields onto its local copy with spread
  (`{ ...s, ...updated }`) so presigned URLs survive.

## Security

- **Auth required:** every endpoint.
- **Ownership:** shot mutations join `shots → projects` and filter by
  `projects.userId`. Direct-by-id shot access that bypasses the project
  ownership check is impossible.
- **Rate limiting:** `generation` preset (5/min) on all generative
  endpoints (image, clip, clip-hailuo, suggest-image, suggest-motion,
  recommend). `mutation` preset (30/min) on CRUD endpoints.
- **CSRF:** Origin header verification on all mutations.
- **Input validation:**
  - UUIDs validated on all path params.
  - Bounds must satisfy `0 <= startSeconds < endSeconds`.
  - Non-empty imagePrompt required on create.
  - Overlap with other shots rejected.
  - Split `atSeconds` must leave ≥ 1s on each side.
- **Error handling:** server logs full error detail; client sees generic
  messages. Failed generation calls flip `imageStatus`/`clipStatus` to
  `failed` so the UI can surface a retry affordance without leaking the
  reason.
- **Secrets:** `FAL_KEY` (fal.ai) and `ANTHROPIC_API_KEY` (Claude) are
  server-side only; never exposed to the client bundle.
- **R2 access:** all image + clip URLs are time-limited presigned; R2
  bucket is private.

## Dependencies

- **External services:**
  - Anthropic API (Claude Sonnet 4.5 for Recommend, Haiku 4.5 for suggest).
  - fal.ai (FLUX.1 Kontext for images, LTX-2.3 for clips, MiniMax Hailuo
    02 Standard for A/B clip test).
  - Cloudflare R2 for asset storage.
- **Libraries:**
  - `@anthropic-ai/sdk`
  - `@fal-ai/client`
  - `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
  - `wavesurfer.js` — NOT currently a dep; waveform is rendered as a
    simple colored bar in the prototype. Full waveform will be added
    when we swap the prototype for the real editor.
- **Shared utilities:**
  - `src/lib/api-utils.ts` — session, CSRF, rate-limit, validation.
  - `src/lib/r2.ts` — R2 client + `getDownloadUrl()` for presigned GET.
  - `src/lib/vo-text.ts` — script → VO text slicing by time bounds.

## Coding Patterns Used

- **Two-stage recommendation:** deterministic text split first, then
  Claude for creative prompts only. Avoids text-drift hallucinations
  (Claude can duplicate or drop sentences when asked to both split AND
  prompt in one shot).
- **Proportional char-to-time mapping:** accurate enough for ±1s
  boundaries on typical narrations; avoids the cost and fragility of
  mapping ElevenLabs character timestamps directly.
- **Optimistic local state + persist on interaction-end:** drag moves
  update `shots` every mousemove (instant visual feedback); only the
  final mouseup triggers the PATCH.
- **Spread-merge for server responses:** client always does
  `{ ...s, ...updated }` rather than `updated` wholesale, because server
  responses lack client-only derived fields like `imageUrl` and `clipUrl`
  (those are computed post-fetch in the GET path).
- **Playhead-driven preview:** main video preview always follows
  `playheadShot` (the shot under the playhead), never `selectedShot`.
  Selection is for editing, playhead is for playback.
- **Selection-aware side panel:** one panel serves three states —
  shot-selected (edit mode), gap-selected (create mode), nothing
  selected (playhead-driven preview).
- **Image vs clip preview toggle:** when both exist on a shot, the side
  panel has tabs; auto-switches to whichever was just regenerated so
  results are always visible.

## Tradeoffs

- **No Inngest orchestration yet.** All generation is synchronous. Works
  for single-shot clicks but awkward for parallel batch generation.
  Deferred; will re-evaluate once user tries to bulk-generate.
- **Waveform is a colored bar, not a real waveform.** Sufficient for
  scrubbing in prototype; replace with wavesurfer.js when the editor
  graduates from "prototype".
- **Shot text doesn't refresh in local state after drag-resize.** Known
  bug; see backlog #1. The R2 text column updates server-side but the
  client mirror stays stale until page reload. Fixing it introduced drag
  flicker; deferred.
- **sortOrder not maintained after mutations.** Monotonic on insert;
  mutations leave it stale. UI and GET both order by `startSeconds`, so
  this is fine in practice — documented only to prevent future confusion.
- **Hailuo A/B button stays in the UI.** Low ongoing cost, useful for
  non-character shots; revisit when multi-keyframe feature (backlog #8)
  subsumes model selection.
- **No character / setting consistency across shots.** The biggest
  remaining quality gap. Tracked in backlog #7a (entity reference images)
  as the planned fix.
- **No undo/redo.** Destructive operations are one-way. Backlog #2.
- **Per-shot Inngest not used — sync calls only.** Fine for now; could
  cause UI lockups if a user wanted to queue 60 image generations in
  parallel. Use Inngest if that flow becomes real.

## Known incomplete items referenced by this feature

- Backlog #1 — stale shot.text after drag-resize
- Backlog #7a — entity reference images (character/setting consistency)
- Backlog #8 — multi-keyframe transformation clips
- Backlog #2 — undo/redo
