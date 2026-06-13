# Feature: F-05 Voiceover Generation (v3.0 — continuous, project-level)

> **⚠ PLANNED v4.0 EVOLUTION — design approved 2026-06-13.**
> The sections below document the **current v3.0 continuous-VO implementation**
> and remain accurate for the code on disk. A redesign is specced but **not yet
> built**: see
> [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md)
> (Pillar B). Headline change — update this doc when it lands:
> - **Beat-based VO:** the single continuous `projects.voiceover*` bake is
>   replaced by **per-beat** audio. Each `beats` row owns its own `voPath` +
>   `voTimestamps` + `voDurationSeconds`. Timeline duration = sum of beat
>   durations (sequential stacking).
> - **Cheap in-place iteration:** editing a beat's text re-voices **only that
>   beat**; later beats ripple. This supersedes backlog **#10** (whole-project
>   regen + shot re-alignment).
> - **Smooth chaining:** per-beat calls pass `previous_text`/`next_text`
>   (context-only, unbilled) + request-id stitching; segment only on
>   sentence/clause boundaries. ElevenLabs bills per character, so N segments
>   ≈ one call in cost.

## Feature
- **Name:** Voiceover Generation
- **Purpose:** Generate a single continuous MP3 voiceover for the entire
  project script via ElevenLabs TTS, along with character-level timestamps
  used by the editor to render a scrubbable waveform and derive shot time
  ranges.

## v3.0 architectural shift

- **v2.0:** One VO per scene. Each scene row had its own
  `voiceoverPath` / `voiceoverStatus` / `voiceoverTimestamps`.
- **v3.0:** One continuous VO per project. `projects.voiceoverPath` etc.
  replaces the scene-level fields. The scenes table was dropped.

Reasons for the shift (see PRD v3.0 changelog):
- The editor-first model needs a single scrubbable waveform, not several
  chained clips.
- Continuous VO has consistent ElevenLabs pacing (no audible seams between
  scene-level calls).
- Single ElevenLabs call per project is cheaper and simpler.

## Key Files

Frontend:
- `src/components/step-editor.tsx` — the VO-generation gate. When the
  project has a script but no VO, renders the "Generate voiceover" button
  and the voice selector. On success, the timeline editor becomes accessible.
- `src/components/voice-selector.tsx` — 6 preset voice cards (3F/3M) with
  audio previews.
- `src/components/project-workspace.tsx` — owns the VO state
  (`voiceoverUrl`, `voiceoverStatus`, `durationSeconds`, `voiceId`); its
  `handleGenerateVoiceover` handler calls the generation endpoint.

Backend:
- `src/lib/voiceover-generation.ts` — `generateProjectVoiceover(projectId, text, voiceId)`:
  calls ElevenLabs TTS with char-level timestamps, stores MP3 in R2 at
  `projects/{projectId}/voiceover.mp3`, returns `{ r2Key, timestamps,
  durationSeconds }`.
- `src/app/api/projects/[id]/voiceover/generate/route.ts` — endpoint that
  orchestrates the call, persists the result on the project row, returns
  a presigned download URL so the client can update UI without a refresh.
- `src/lib/voice-presets.ts` — the 6 curated voice IDs used in v1.0.

## Data Models

Fields on `projects` (added during v3.0 migration):

| Column | Type | Notes |
|---|---|---|
| `voiceoverPath` | text, nullable | R2 key, e.g. `projects/{id}/voiceover.mp3` |
| `voiceoverStatus` | enum (pending / generating / done / failed) | |
| `voiceoverTimestamps` | jsonb | `{ characters, character_start_times_seconds, character_end_times_seconds }` from ElevenLabs |
| `durationSeconds` | integer, nullable | measured from the last timestamp |
| `voiceId` | text | ElevenLabs voice ID, defaults to `21m00Tcm4TlvDq8ikWAM` |

## APIs

- `POST /api/projects/:id/voiceover/generate` — auth required,
  rate-limited (`generation` preset). Requires `projects.script` to be set.
  On start: `voiceoverStatus = 'generating'`. On success: writes path,
  timestamps, duration; status `done`; returns
  `{ r2Key, durationSeconds, voiceoverUrl }`. On failure: status `failed`.

- `PATCH /api/projects/:id` — accepts `voiceId` changes (validates length).

## State & Ownership

- **Source of truth:** `projects` row (audio path in R2, timestamps in Neon).
- **Client state:** `voiceoverUrl` (presigned), `voiceoverStatus`,
  `durationSeconds` held in `ProjectWorkspace`; propagated to
  `StepEditor` and `EditorPrototype`.
- **Invalidation:** any script change via `PATCH /projects/:id` or the
  regenerate-script endpoint clears these fields to force re-generation.

## Security

- **Auth required:** All endpoints require a BetterAuth session.
- **Ownership enforced:** Generate endpoint checks `projects.userId ===
  session.user.id` before calling ElevenLabs.
- **Rate limiting:** `generation` preset on the generate endpoint.
- **CSRF:** Origin-header verification on POST.
- **Secrets:** `ELEVENLABS_API_KEY` in env, never exposed to the client.
- **Audio storage:** R2 bucket private; client receives time-limited
  presigned URLs only.

## Dependencies

- **External services:** ElevenLabs TTS (`convertWithTimestamps` with
  `eleven_multilingual_v2` model, mp3_44100_128 format).
- **Libraries:** `@elevenlabs/elevenlabs-js`, `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`.
- **Shared utilities:** `src/lib/r2.ts` for R2 put / presigned GET.

## Coding Patterns Used

- **Character-level timestamps stored raw:** preserved as-is in jsonb so
  any downstream consumer (editor, future captions feature) can re-derive
  word-level or segment-level timings without re-calling ElevenLabs.
- **Presigned URL returned by generate:** response includes
  `voiceoverUrl` so the client can set its state directly without a full
  page refresh (router.refresh() doesn't re-run useState initializers).
- **Status lifecycle:** `pending → generating → done | failed`, persisted
  on every transition so the UI can always derive the right button/spinner.

## Tradeoffs

- **Whole-project regen on voice change.** Changing voice mid-project
  re-generates the entire VO. Acceptable for 5-min videos; would be
  painful for feature-length content.
- **No partial regen.** Per-paragraph VO regeneration is not supported —
  see backlog #10 ("VO regeneration on script edit — text-anchored shot
  re-alignment") for the eventual fix.
- **Voice library capped at 6.** v1.0 scope. Full voice library + cloning
  deferred to v1.1.
- **No speech marks at word granularity.** ElevenLabs returns
  character-level timings; word boundaries are derived by splitting at
  whitespace when needed. Accurate enough for editor scrubbing.
- **Shot `startSeconds`/`endSeconds` don't auto-update on VO regen.** If
  the user regenerates VO after creating shots, the shot timings don't
  re-align. Documented in backlog #10.
