# Feature: F-08 Unified Directing Editor (v4.0 Phase 2 — CURRENT)

> **✅ v4.0 Phase 2 SHIPPED 2026-07-03.** This doc now documents the
> **unified directing editor** as the current implementation. The v3.0
> Timeline Editor it replaced (separate Script step + `editor-prototype.tsx`
> over a continuous project-level voiceover) is retired; its section below
> is kept only as historical context. Design spec:
> [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md).
> Plan executed: [`docs/superpowers/plans/2026-07-02-v4-phase2-unified-editor.md`](../superpowers/plans/2026-07-02-v4-phase2-unified-editor.md).

## Feature
- **Name:** Unified Directing Editor
- **Purpose:** One screen — replacing the old separate Script and Editor
  stepper steps — where the user reads/edits the script inline, watches
  narration and shots stack on a two-layer beat/shot timeline (or a
  Storyboard card grid, same data), and generates images/clips per shot.
  The stepper shrank to **Concept → Style → Editor**.

## Scope of this doc

F-08 now covers:
- The two-layer **beat/shot timeline** and its peer, the **Storyboard**
  view — both renderers over one shared client store.
- The **inline editable script strip** (re-voices only the beat you touch —
  see F-05 for the voicing mechanics).
- Beat-relative shot CRUD, split, and recommend.
- The editor's two entry gates (generate script → voice the script) and the
  "Cast & Locations" left-rail placeholder for the F-16 Reference Bible
  (Phase 4 — not built yet).

Batch "Generate all" (Phase 3) and the Reference Bible itself (Phase 4) are
explicitly **out of scope** — see "Deferred to Phase 3/4" below.

## Key Files

Frontend — `src/components/editor/`:
- `editor-store.tsx` — `EditorProvider` + `useEditor()`. The single source
  of truth: beats, shots, selection, active view. Every API mutation
  (revoice, shot create/update/delete/split, image/clip generation,
  recommend) lives here as an action; no other component talks to the
  network directly. The reducer recomputes every beat's absolute
  `startSeconds`/`endSeconds` (via `computeBeatOffsets`) whenever beats
  change, so a re-voiced beat's new duration ripples automatically to every
  later beat and to the project total. Also exports `beatColor(index)`
  (cycling accent colors shared between the script strip and timeline beat
  blocks) and `absoluteShotRange(shot, beats)` (beat-relative → absolute
  seconds).
- `use-beat-playback.ts` — `useBeatPlayback(beats)`. Sequential per-beat
  `<audio>` playback: plays beat N's clip, chains into beat N+1 on `ended`,
  preloads the next beat's audio for a tight seam, skips beats with no
  `voUrl` (unvoiced/failed), and exposes one global playhead in absolute
  timeline seconds (`play`, `pause`, `seek`).
- `timeline-view.tsx` — the two-layer timeline: `BEATS` row (one block per
  beat, colored by `beatColor`, spinner while `voStatus: "generating"`,
  red border on `"failed"`), `SHOTS` row (drag/trim persisted as anchor +
  offsets; shots may span beat boundaries — anchor-beat spillover — and a
  drag that moves a shot's start across a boundary re-anchors it; clamps
  run against neighboring shots and the timeline ends in absolute space),
  `VOICE` row (a slim per-beat audio bar). Click-to-select, continuous gap
  picking across beat boundaries, ruler + playhead drag, keyboard `S`
  (split) / `Del` (delete).
- `storyboard-view.tsx` — responsive card grid, one card per shot ordered by
  `(beat.sortOrder, startInBeat)`. Each card shows the clip/image thumbnail,
  a status badge, the shot's image prompt, the parent beat's narration
  (clamped), and per-card Re-image/Clip/Retry/Edit actions.
- `script-strip.tsx` — renders every beat's text as a colored, clickable
  segment; double-click to edit inline; Enter commits (exactly once — see
  test cases), Escape cancels with no request sent. Committing calls
  `revoiceBeat(beatId, text)`.
- `inspector.tsx` — one panel, three states driven by `selection`: shot
  panel (prompt fields, image/clip preview + generation buttons, split/
  delete), beat panel (read-only text preview, voice status, re-voice/play
  actions), gap panel (create-shot form for an empty range within a beat).
  No selection → the playhead-shot preview.
- `unified-editor.tsx` — the shell. Owns the two entry gates (below), the
  top bar (view toggle, beat/shot counts, total duration, play/stop, voice
  selector, Recommend), the static Cast & Locations left rail, the center
  column (video preview → script strip → Timeline/Storyboard), and the
  sticky right Inspector.

Frontend — orchestration:
- `src/components/project-workspace.tsx` — now a **3-step** stepper
  (Concept → Style → Editor, down from 4); owns brief/style state only —
  script, voiceover, and shot state all moved into `editor-store.tsx`.
- `src/app/projects/[id]/page.tsx` — loads beats server-side (presigned
  `voUrl`, `computeBeatOffsets` for absolute times) alongside shots, and
  passes both through as `initialBeats`/`initialShots`.

Backend:
- `src/lib/beat-timing.ts` — `computeBeatOffsets`, `totalDurationSeconds`
  (Phase 1; unchanged) — the sequential-stacking math every absolute time in
  the editor is derived from.
- `src/lib/shot-beat-mapping.ts` — `MIN_SHOT_SECONDS = 0.25`, the shared
  minimum-shot-length constant consumed by create/update/split.
- `src/lib/shot-recommendation.ts` — `recommendShotsForBeats()`: per-beat
  deterministic fragment splitting (proportional char-to-time mapping
  within each beat) + one Claude-written image prompt per fragment.
- `src/app/api/projects/[id]/beats/route.ts` — `GET`, lists beats with
  presigned audio + absolute offsets.
- `src/app/api/projects/[id]/beats/generate/route.ts` — segments the script
  into beats and voices each (Phase 1).
- `src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts` — re-voices
  one beat; **Phase 2 addition:** accepts an optional `{ text }` body
  (≤2,000 chars) to edit the beat's words before voicing.
- `src/app/api/projects/[id]/shots/route.ts` — `POST`, beat-relative create.
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — `PATCH` (offsets
  and/or prompts) / `DELETE`.
- `src/app/api/projects/[id]/shots/[shotId]/split/route.ts` — split at
  `atInBeat`.
- `src/app/api/projects/[id]/shots/recommend/route.ts` — replaces all shots
  with per-beat recommended rows.
- `src/app/api/projects/[id]/shots/[shotId]/{image,clip,clip-hailuo}/route.ts`
  — unchanged asset-generation endpoints (still per-shot, still synchronous).

**Removed in this phase:** `src/components/step-script.tsx`,
`src/components/step-editor.tsx`, `src/components/editor-prototype.tsx`,
`src/app/api/projects/[id]/shots/adopt-beats/route.ts` (one-time migration
endpoint, removed after the 84 legacy shots on the one existing project were
adopted — see `docs/backlog.md` if it's ever needed again).

## Data Models

**`shots` table (v4.0 Phase 2 shape).** Legacy absolute columns
(`startSeconds`, `endSeconds`, `text`) are **dropped** (not just nullable —
the additive-first migration convention completed its teardown this phase).

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| projectId | uuid (FK cascade) | |
| sortOrder | integer | monotonic only; actual order is beat sortOrder + `startInBeat` |
| **beatId** | uuid (FK cascade → `beats.id`) | nullable at the column level (additive-first), but every reachable code path requires it — a shot with no beat can't be created, and the migration that back-filled `beatId` for pre-Phase-2 shots has run ; since 2026-07-03 the beat is the shot's ANCHOR: the shot starts inside it but may spill past its end into following beats |
| **startInBeat** | double precision | offset in seconds from the parent beat's start; source of truth for shot timing |
| **endInBeat** | double precision | must be `> startInBeat`, `≤ beat.voDurationSeconds + 0.05` |
| imagePrompt | text NOT NULL | subject + composition; ≤2,000 chars |
| motionPrompt | text NOT NULL | subject action + subtle camera; ≤2,000 chars |
| imagePath / imageStatus | text / enum | unchanged from v3.0 |
| clipPath / clipStatus / clipDurationSeconds | text / enum / integer | unchanged from v3.0 |
| referencedEntityIds | jsonb, default `[]` | F-16 tagging column, unused until Phase 4 |
| createdAt / updatedAt | timestamp | |

No more `shots.text` cache — narration is always the parent beat's `text`.

**`beats` table (Phase 1, unchanged this phase).** See F-05's feature doc
for the full shape; Phase 2 only adds the optional-text-edit path onto the
existing revoice endpoint.

**`projects` table.** The continuous-VO fields — `voiceoverPath`,
`voiceoverStatus`, `voiceoverTimestamps`, `durationSeconds` — are **dropped**
this phase. `voiceId` is retained (still selects the ElevenLabs voice used
for `beats/generate` and revoice).

## APIs

All routes are auth-required and ownership-scoped via a join from
`shots`/`beats` → `projects` where `projects.userId === session.user.id`.
Any endpoint accepting a `beatId` additionally verifies
`beat.projectId === project.id` before use (closes a cross-project IDOR —
see the security section below).

### Shot CRUD (beat-relative)
- `POST /api/projects/:id/shots` — body
  `{ beatId, startInBeat, endInBeat, imagePrompt, motionPrompt? }`. Rejects
  on overlap **within the same beat**, on offsets outside `[0,
  beat.voDurationSeconds + 0.05]`, on a `beatId` not owned by the project,
  and on a non-string/over-length `imagePrompt`.
- `PATCH /api/projects/:id/shots/:shotId` — any of `{ startInBeat?,
  endInBeat?, imagePrompt?, motionPrompt? }`. Re-validates overlap (within
  the shot's beat) on bounds change.
- `DELETE /api/projects/:id/shots/:shotId` — unchanged.
- `POST /api/projects/:id/shots/:shotId/split` — body `{ atInBeat }`;
  `atInBeat` must leave ≥0.25s on each side; right half inherits prompts +
  `imagePath`/`clipPath` from the original.

### Recommend
- `POST /api/projects/:id/shots/recommend` — replaces all existing shots
  with rows computed per-beat by `recommendShotsForBeats()`. Requires at
  least one beat with `voStatus: "done"`.

### Beat voicing (Phase 1, extended)
- `POST /api/projects/:id/beats/:beatId/revoice` — **new in Phase 2:**
  optional body `{ text?: string }`. When present: trimmed, 1–2,000 chars,
  replaces `beats.text` before re-voicing. Absent/empty body re-voices the
  existing text unchanged.

## State & Ownership

- **Source of truth:** Neon `beats` + `shots` tables + R2 assets. Shot
  timing is **beat-relative only** — `startInBeat`/`endInBeat` are the only
  numbers ever written; absolute timeline seconds are *always* computed
  on read via `computeBeatOffsets` (`beat-timing.ts`) + `absoluteShotRange`
  (`editor-store.tsx`). No code path stores an absolute second value.
- **Client state:** `editor-store.tsx`'s `useReducer` state (beats, shots,
  selection, view) is the single client-side mirror. Timeline, Storyboard,
  Script strip, and Inspector are four renderers of this one state — none
  of them fetch independently or keep a sibling copy (this is the "two
  views over one shared store" invariant from the design spec §5).
- **Mutation flow:** store action → optimistic patch → `fetch` → spread-merge
  the server response onto local state (so presigned URLs and other
  client-only derived fields survive) → revert + `console.warn` on failure.
- **Ripple:** editing a beat's duration (via revoice) never touches shot
  rows — because shot offsets are beat-relative, they're automatically
  correct after the beat's `voDurationSeconds` changes; only the *derived*
  absolute positions of that beat and every later beat change, which the
  reducer recomputes for free.

## Security

- **Auth required:** every endpoint (`getSession()` → 401).
- **Ownership:** every shot/beat query joins to `projects` and filters by
  `projects.userId`.
- **Cross-table authorization:** any endpoint accepting a `beatId` verifies
  `beat.projectId === project.id` before use — this is what closes the
  cross-project IDOR that an independent review flagged and confirmed fixed
  (see `security-review.md`, "v4.0 Phase 2" section).
- **Rate limiting:** `generation` preset (5/min) on revoice and recommend;
  `mutation` preset (30/min) on shot create/update/delete/split.
- **CSRF:** Origin header verification (`verifyCsrf()`) on every mutation,
  fail-closed.
- **Input validation:**
  - UUIDs validated on all path params.
  - Beat-relative offsets: `Number.isFinite`, `startInBeat ≥ 0`,
    `endInBeat - startInBeat ≥ MIN_SHOT_SECONDS (0.25)`,
    `endInBeat ≤ beat.voDurationSeconds + 0.05`.
  - Overlap-with-siblings check scoped **per beat**, not per project.
  - `imagePrompt`/`motionPrompt`: typed (`typeof === "string"`) before
    `.trim()`, non-empty on create, capped at **2,000 characters** (closes
    security finding F3 — a non-string value previously threw an uncaught
    `TypeError` and produced a 500; lengths were previously unbounded).
  - Revoice `{ text }`: typed, trimmed, 1–2,000 characters.
  - Malformed JSON bodies → 400 everywhere.
- **Error handling:** generic client-facing messages; detail logged
  server-side only (closes security finding F1 — `shots/recommend`
  previously returned raw `error.message`).
- **Secrets:** unchanged — `FAL_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`
  server-side only.
- **R2 access:** unchanged — time-limited presigned URLs, private bucket.
- **Full independent review:** see `docs/feature08/security-review.md` §
  "v4.0 Phase 2 (2026-07-03)" — verdict SHIP WITH FIXES, all three findings
  (F1, F2, F3) fixed in commit `4ab994b` before merge.

## Dependencies

- **External services:** Anthropic API (Claude Sonnet 4.5 for Recommend),
  ElevenLabs (per-beat VO, via `beat-voiceover-generation.ts` — see F-05),
  fal.ai (FLUX.1 Kontext, LTX-2.3, Hailuo — unchanged), Cloudflare R2.
- **Libraries:** unchanged from v3.0 (`@anthropic-ai/sdk`, `@fal-ai/client`,
  `@aws-sdk/client-s3` + presigner). **No new npm dependencies this
  phase** — the shared store is plain React context + `useReducer`.
- **Shared utilities:** `src/lib/api-utils.ts`, `src/lib/r2.ts`,
  `src/lib/beat-timing.ts`, `src/lib/shot-beat-mapping.ts`.

## Coding Patterns Used

- **One store, many renderers:** `editor-store.tsx` is the only place that
  talks to the network; Timeline/Storyboard/Script-strip/Inspector are pure
  consumers of `useEditor()`. This is what makes selection, mutations, and
  playback state automatically consistent across the view toggle (verified
  in test cases §7).
- **Beat-relative-only timing:** no code path ever writes an absolute
  second value for a shot; absolute time is always *derived*
  (`computeBeatOffsets` + `absoluteShotRange`), so a beat duration change
  ripples for free instead of requiring a re-write of every later shot.
- **Sequential audio chaining with preload:** `useBeatPlayback` plays one
  `<audio>` element per beat and starts loading the *next* beat's clip while
  the current one is still playing, keeping the cross-beat seam tight; it
  also transparently skips unvoiced/failed beats rather than pausing.
  Hardened iteratively (commits `235710c` et al.) after early versions
  stalled on a skip chain or dropped the preloaded element.
- **Cross-table authorization as a first-class rule:** every route that
  accepts a `beatId` re-derives it must belong to the requesting project —
  called out explicitly in the plan's Global Constraints and confirmed by
  the independent security review.
- **Optimistic local state + spread-merge on response:** ported from
  `editor-prototype.tsx`'s pattern (`{ ...local, ...serverResponse }`) so
  client-only derived fields (presigned URLs) survive a mutation response.
- **Guarded double-commit on inline edit:** the script strip's Enter/blur
  interplay initially fired two revoice requests for one edit; fixed with
  an explicit commit guard (see test case TC-1.7 and commits
  `f0b0ff0`/`fc7eb1f`).

## Tradeoffs / Debt

- **Ripple can strand a spilled shot's anchor offsets.** Re-voicing a beat
  changes its duration but never rewrites shot offsets, so a shot anchored
  near the end of a beat that shrinks can be left with
  `startInBeat ≥ anchor duration` in storage. Display and playback are pure
  offset math and tolerate it; the next drag self-heals by re-anchoring
  from the absolute position. Accepted tradeoff of the anchor-beat
  spillover model (2026-07-03).
- **No beat add/split/merge UI.** Editing inside a beat keeps it one beat
  (design decision, spec §8.1/backlog #14) — creating/splitting/merging
  beats themselves is not exposed in the UI.
- **No batch "Generate all."** Deferred to Phase 3 — images/clips are still
  generated one shot at a time from the Inspector or a Storyboard card.
- **No Reference Bible.** The left rail is a static placeholder; F-16
  (character/location consistency) is Phase 4.
- **Asset generation is still synchronous per shot.** Unchanged tradeoff
  from v3.0 — see the historical section below.
- **No undo/redo.** Unchanged from v3.0.
- **Waveform per beat is a colored bar, not a real waveform.** Unchanged
  tradeoff, now scoped per-beat instead of per-project.

## Deferred to Phase 3 / Phase 4

Per the v4.0 roadmap and design spec §8, explicitly **not built** in this
phase:
- **Phase 3 — Batch "Generate all":** server-side fan-out for all
  images/clips with per-item status in the Storyboard view, plus retry.
- **Phase 4 — Reference Bible (F-16):** `entities` CRUD, multi-view
  reference-sheet generation, auto-extract/auto-tag, FLUX conditioning.
  `shots.referencedEntityIds` exists as a column but is unused until then.
- Beat add/split/merge UI and sub-beat narration slicing (a shot's
  narration is the whole text of every beat it overlaps — cross-beat shots
  shipped 2026-07-03 with the anchor-beat spillover model, see
  `docs/superpowers/plans/2026-07-03-cross-beat-shots.md`).

---

## Historical: v3.0 Timeline Editor (retired)

The section below documents the **v3.0 implementation that this phase
replaced.** Kept for historical reference only — do not use these file
paths or data shapes; they no longer exist on disk.

- **Frontend:** `step-editor.tsx` (VO-gate + stepper node),
  `editor-prototype.tsx` (single-file editor: continuous timeline, playhead,
  clip blocks, drag/trim, Recommend, side panel), `project-workspace.tsx`
  (owned `shots: ShotData[]` directly).
- **Data model:** `shots.startSeconds`/`endSeconds` (absolute project-timeline
  seconds), `shots.text` (cached VO fragment derived from
  `projects.script` + bounds), `projects.voiceoverPath` +
  `voiceoverStatus` + `voiceoverTimestamps` + `durationSeconds` (one
  continuous voiceover per project).
- **Why it was replaced:** a continuous VO meant any script edit forced a
  whole-project re-bake and left shot timestamps orphaned relative to the
  new audio (tracked as backlog #10 under v3.0). The beat model makes
  editing one line of narration a scoped, ~1s operation instead.
- **What was preserved through the migration:** every v3.0 shot's
  `imagePath`/`clipPath` (generated images and clips) carried over
  unchanged — the one-time adoption endpoint (now removed) only computed
  new `beatId`/`startInBeat`/`endInBeat`, never touched asset paths.

## Known incomplete items referenced by this feature

- Backlog: "v4.0 Phase 2 drop-deferred" entry (cross-beat shot drag, beat
  add/split/merge UI, adopt-beats endpoint removal note) — see
  `docs/backlog.md`.
- Backlog #7a / F-16 — Reference Bible (Phase 4).
- Backlog #8 — multi-keyframe transformation clips (unaffected by this
  phase).
- Backlog #2 — undo/redo (unaffected by this phase).
