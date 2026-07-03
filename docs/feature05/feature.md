# Feature: F-05 Voiceover Generation (v4.0 — beat-based, per-beat audio)

> **✅ v4.0 SHIPPED.** Phase 1 (2026-06) landed the `beats` data model and
> per-beat ElevenLabs voicing with prosody continuity; Phase 2 (2026-07-03)
> added the ability to edit a beat's words through the same endpoint. The
> v3.0 continuous-VO model this replaced (one MP3 per project) is fully
> retired — its columns and files are deleted. See the "v3.0 architectural
> shift (historical)" section below for what was removed and why.

## Feature
- **Name:** Voiceover Generation
- **Purpose:** Generate narration audio per **beat** (one sentence/clause of
  the script) via ElevenLabs TTS, with prosody continuity across beat
  boundaries. Editing a beat's text re-voices **only that beat** — later
  beats ripple in time automatically because shot timing is beat-relative
  (see F-08). The timeline's total duration is always the sum of every
  beat's measured audio duration.

## Key Files

Frontend:
- `src/components/editor/unified-editor.tsx` — the "voice the script" gate
  (script exists, no beats yet): renders `VoiceSelector` + a button that
  calls `POST /beats/generate`, then loads beats into the editor.
- `src/components/editor/script-strip.tsx` — inline editable beat text;
  double-click a beat → edit → commit calls `revoiceBeat(beatId, text)`.
- `src/components/editor/inspector.tsx` — beat panel: read-only text
  preview, voice status badge, "Re-voice" button (re-voices unchanged text —
  useful after a failure) and "Play this beat".
- `src/components/editor/editor-store.tsx` — `revoiceBeat()` action: sets
  `voStatus: "generating"` optimistically, `POST`s `{ text }` (or no body)
  to the revoice endpoint, and merges the returned beat (new `voUrl`,
  `voDurationSeconds`) — which the reducer uses to recompute every later
  beat's absolute offset.
- `src/components/voice-selector.tsx` — unchanged: 6 preset voice cards
  (3F/3M) with audio previews.

Backend:
- `src/lib/beat-segmentation.ts` — deterministic sentence/clause-boundary
  segmenter that turns `projects.script` into an ordered list of beat texts.
- `src/lib/beat-voiceover-generation.ts` — `generateBeatVoiceover({
  projectId, beatId, text, voiceId, previousText?, nextText? })`: calls
  ElevenLabs TTS for **one beat's text**, passing the neighbouring beats'
  text as **context-only** (`previous_text`/`next_text` — unbilled, used
  purely so ElevenLabs continues the same prosody/intonation across the cut
  rather than starting cold each time), stores the MP3 in R2 at
  `projects/{projectId}/beats/{beatId}/vo.mp3`, returns `{ r2Key,
  timestamps, durationSeconds }`.
- `src/lib/beat-timing.ts` — `computeBeatOffsets(beats)`: pure function that
  stacks each beat's `voDurationSeconds` into absolute
  `startSeconds`/`endSeconds` in `sortOrder`. `totalDurationSeconds(beats)`
  — sum of all beat durations. This is the *only* place absolute project
  duration is computed; nothing stores it.
- `src/app/api/projects/[id]/beats/generate/route.ts` — segments the script
  into beats (deleting any existing beats for the project first) and voices
  each in order, passing each beat's immediate neighbours as context.
- `src/app/api/projects/[id]/beats/route.ts` — `GET`: lists a project's
  beats with presigned `voUrl` and computed absolute offsets.
- `src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts` — re-voices
  one beat. **Accepts an optional `{ text }` body** (≤2,000 chars,
  non-empty when present) that replaces the beat's text before voicing;
  an absent/empty body just re-voices the existing text (e.g. to retry a
  failure). Uses the beat's actual neighbours (by `sortOrder`) as prosody
  context, same as generation.

## Data Models

**`beats` table** (owns narration text + its own audio):

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| projectId | uuid (FK cascade) | |
| sortOrder | integer | ordering; absolute time is derived from this + duration, never stored |
| text | text NOT NULL | narration for this beat — source of truth for its words |
| voPath | text, nullable | R2 key, e.g. `projects/{id}/beats/{beatId}/vo.mp3` |
| voStatus | enum (pending / generating / done / failed) | |
| voDurationSeconds | double precision, nullable | measured from ElevenLabs' returned timestamps |
| voTimestamps | jsonb | `{ characters, character_start_times_seconds, character_end_times_seconds }`, scoped to this beat only |
| createdAt / updatedAt | timestamp | |

`shots.beatId` (FK cascade → `beats.id`) + `shots.startInBeat` /
`endInBeat` attach visuals to a beat's audio range — see F-08's feature doc
for the shot side of this relationship.

`projects.voiceId` — still present, unchanged: the ElevenLabs voice ID used
for every beat's generation/revoice (default `21m00Tcm4TlvDq8ikWAM`).

## APIs

- `POST /api/projects/:id/beats/generate` — auth required, rate-limited
  (`generation` preset). Requires `projects.script`. Segments the script
  into beats (replacing any existing beats for the project — same
  replace-all semantics as v3.0's continuous generate), voices each in
  order with its neighbours as context. Long-running (30–90s for a full
  script); the UI shows a progress state.
- `POST /api/projects/:id/beats/:beatId/revoice` — auth required,
  rate-limited (`generation` preset). Optional body `{ text?: string }`
  (trimmed, 1–2,000 chars). Re-voices just this one beat using its current
  neighbours as context. Returns the updated beat row + presigned `voUrl`.
- `GET /api/projects/:id/beats` — auth required. Lists beats in order with
  presigned audio URLs and absolute offsets (via `computeBeatOffsets`).

## State & Ownership

- **Source of truth:** each `beats` row (audio path in R2, timestamps in
  Neon, scoped to that beat only). No project-level audio row exists
  anymore.
- **Client state:** `editor-store.tsx`'s `EditorBeat[]` — includes the
  computed `startSeconds`/`endSeconds` the reducer refreshes after every
  beat mutation.
- **Invalidation / ripple:** re-voicing a beat never touches other beats'
  rows — it only changes *that* beat's `voDurationSeconds`, which
  automatically shifts every later beat's *derived* absolute position
  (nothing needs to be "invalidated" the way a continuous VO used to wipe
  itself on script edit).

## Security

- **Auth required:** all endpoints require a BetterAuth session.
- **Ownership enforced:** every route checks `projects.userId ===
  session.user.id` before touching a beat.
- **Rate limiting:** `generation` preset (5/min) on both generate and
  revoice.
- **CSRF:** Origin-header verification on both POST endpoints.
- **Input validation:** the optional revoice `text` is type-checked
  (`typeof === "string"`), trimmed, and capped at **2,000 characters** —
  chosen to comfortably fit one ElevenLabs request. Malformed JSON bodies
  return 400.
- **Secrets:** `ELEVENLABS_API_KEY` in env, never exposed to the client.
- **Audio storage:** R2 bucket private; client receives time-limited
  presigned URLs only (unchanged from v3.0).

## Dependencies

- **External services:** ElevenLabs TTS (`convertWithTimestamps`,
  `eleven_multilingual_v2`, mp3_44100_128), called once per beat instead of
  once per project.
- **Libraries:** `@elevenlabs/elevenlabs-js`, `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`.
- **Shared utilities:** `src/lib/r2.ts` for R2 put/presigned GET;
  `src/lib/beat-timing.ts` for offset math.

## Coding Patterns Used

- **Context-only neighbour text for prosody:** `previousText`/`nextText`
  are passed to ElevenLabs purely to condition intonation across the cut —
  they are never billed or stored as part of the beat's own text, and never
  written back to the neighbour beats.
- **Duration as the only stored timing fact:** a beat stores its own
  `voDurationSeconds`; absolute position is *always* derived
  (`computeBeatOffsets`), never stored, so an edit to one beat can't leave
  another beat's stored position stale.
- **Optional body = "same text, fresh audio":** the revoice endpoint
  overloads presence/absence of `text` in the body rather than adding a
  second endpoint — re-voicing after a failure and editing words are the
  same operation with an optional extra step.
- **Status lifecycle unchanged from v3.0:** `pending → generating → done |
  failed`, now scoped per-beat instead of per-project, so one failed beat
  doesn't block the rest of the timeline from playing.

## Tradeoffs

- **Beats segment on sentence/clause boundaries, not user-chosen points.**
  Editing inside a beat keeps it one beat; creating a new beat boundary is
  not exposed in the UI yet (design decision — see F-08's "Deferred to
  Phase 3/4," backlog #14).
- **Voice library capped at 6.** Unchanged from v3.0. Full voice library +
  cloning still deferred.
- **No speech marks at word granularity.** Unchanged — ElevenLabs returns
  character-level timings per beat; word boundaries derived by splitting at
  whitespace when needed.
- **Whole-project voice change re-voices every beat.** Changing the voice
  ID still means re-generating every beat's audio (one call per beat now,
  rather than one call for the whole project) — acceptable for typical
  video lengths.

## v3.0 architectural shift (historical — fully removed)

The v3.0 continuous-VO model has been **deleted**, not just deprecated:
- `src/lib/voiceover-generation.ts` and `src/lib/vo-text.ts` — deleted.
- `src/app/api/projects/[id]/voiceover/generate/route.ts` — deleted.
- `projects.voiceoverPath`, `voiceoverStatus`, `voiceoverTimestamps`,
  `durationSeconds` — dropped from the schema.

**What v3.0 did, for historical reference:** one continuous MP3 per
project, `projects.voiceoverPath` etc. holding the path/status/timestamps,
generated in one ElevenLabs call for the whole script. Editing the script
invalidated (nulled) these fields and forced a full re-generation, and shot
timestamps did not auto-realign to the new audio (this was backlog #10 —
now moot, since the beat model makes an edited line a scoped ~1s
re-voice instead of a whole-project rebuild).

**Why the shift happened:** the whole-project rebake-on-edit problem was
the single biggest editing-friction issue in the v3.0 product. Beats fix it
structurally: each beat owns its own audio, so a one-word edit is a
one-beat re-voice, and every later beat's position updates for free via
`computeBeatOffsets` rather than needing an explicit re-alignment step.
