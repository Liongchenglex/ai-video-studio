# Cross-Beat Shots (anchor-beat spillover) — Implementation Plan

**Status:** Approved 2026-07-03 (follow-up to v4.0 Phase 2). Mockup 01 shows shots
spanning beat boundaries; Phase 2 implemented the spec text's stricter
"shot is a sub-range of one beat" model. This change reconciles them.

**Goal:** A shot may span beat boundaries. Storage is unchanged — `beatId` is the
**anchor** (the beat containing the shot's start), `startInBeat` stays within the
anchor, but `endInBeat` may exceed the anchor's duration (spilling into following
beats). No schema change, no migration.

## Rules

- Anchor invariant: `0 ≤ startInBeat < anchorDuration` at write time.
- Length: `endInBeat − startInBeat ≥ MIN_SHOT_SECONDS (0.25)`.
- Absolute end (`anchorStart + endInBeat`) ≤ total timeline duration + 0.05.
- Overlap checks are **global** (absolute ranges across all shots), no longer per-beat.
- A write that moves a shot's start into a different beat **re-anchors** it
  (PATCH accepts an optional `beatId`, validated to belong to the project).
- Split: `atInBeat` stays anchor-relative; the right half re-anchors to the beat
  containing the absolute split point.
- Ripple: a shot moves with its anchor beat and keeps its length in seconds.
- Narration ("VO") for a shot = concatenated text of every beat its absolute
  range overlaps; labels read "beat N" or "beats N–M". Same rule for gaps in the
  create form and for storyboard cards.
- Gap picking is continuous: previous shot end → next shot start in absolute
  time, crossing beat boundaries; the gap anchors to the beat containing its start.
- Unchanged: recommend (still proposes per-beat shots), revoice, playback, schema.

## Files

- `src/lib/shot-beat-mapping.ts` — add pure helpers: `anchorForTime(seconds, offsets)`,
  `shotAbsoluteRange(shot, offsetById)`.
- `src/app/api/projects/[id]/shots/route.ts` — POST: anchor-invariant + global
  overlap validation (loads all beats + all shots).
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — PATCH: optional `beatId`
  re-anchor + global overlap excluding self.
- `src/app/api/projects/[id]/shots/[shotId]/split/route.ts` — right half re-anchors.
- `src/components/editor/editor-store.tsx` — `updateShot` accepts `beatId`; new
  exported `beatsSpanned(shot, beats)` helper.
- `src/components/editor/timeline-view.tsx` — absolute-space drag clamps +
  continuous gap picking + re-anchor on drag-end.
- `src/components/editor/inspector.tsx` — spanned narration + beats N–M labels
  (shot panel and gap create form; AI-suggest voText = joined narration).
- `src/components/editor/storyboard-view.tsx` — spanned narration + label.
- Docs: `docs/feature08/feature.md` model note, `docs/feature08/testcase-v4-phase2.md`
  cross-beat cases, `docs/backlog.md` #19 cross-beat item resolved.

## Verification

`npx tsc --noEmit` + lint; authenticated curl: create a shot spanning two beats
(201), start beyond anchor end (400), global overlap across beats (400), PATCH
re-anchor (200), split across the boundary (right half anchored to second beat);
browser e2e: drag a shot across a beat boundary, gap picking across boundary,
storyboard/inspector show "Beats N–M" + joined narration.
