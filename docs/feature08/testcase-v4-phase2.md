# F-08 / F-05 — v4.0 Phase 2 Unified Editor: Test Cases

**Date:** 2026-07-03

All cases below were verified live on 2026-07-03 via a combination of
browser e2e (signed-in session against the running dev server) and curl /
devtools `fetch()` calls against the same project. See the "Verified"
column per section.

---

## 1. Beat Text Edit → Re-voice One Beat

### TC-1.1: Editing a beat's text re-voices only that beat
- **Action:** Double-click a beat's text in the script strip, change a
  word, press Enter (or blur the textarea).
- **Expected:** `POST /beats/:beatId/revoice` fires with `{ text }`; that
  beat's block shows a spinner (`voStatus: "generating"`); on success the
  beat gets a fresh `voUrl` and `voDurationSeconds`; no other beat's
  `voStatus` changes.
- **Verified:** ✅ live (browser e2e, 2026-07-03).

### TC-1.2: Empty text rejected
- **Action:** `POST /beats/:beatId/revoice` with `{ "text": "" }` (or
  whitespace-only).
- **Expected:** 400 `"text cannot be empty"`. Beat unchanged.
- **Verified:** ✅ live (curl).

### TC-1.3: Over-length text rejected
- **Action:** `POST /beats/:beatId/revoice` with a 2,001-character string.
- **Expected:** 400 `"text too long (max 2000 characters)"`. Beat unchanged.
- **Verified:** ✅ live (curl).

### TC-1.4: Non-string `text` rejected
- **Action:** `POST /beats/:beatId/revoice` with `{ "text": 12345 }` (or an
  array/object).
- **Expected:** 400 `"text must be a string"`.
- **Verified:** ✅ live (curl).

### TC-1.5: Absent body re-voices the existing text
- **Action:** `POST /beats/:beatId/revoice` with no body / empty body.
- **Expected:** 200; beat's `text` unchanged, `voStatus` cycles
  generating → done with a new `voUrl` (same words, fresh audio).
- **Verified:** ✅ live (curl).

### TC-1.6: Escape cancels without a request
- **Action:** Double-click a beat's text to enter edit mode, change the
  draft, press `Escape`.
- **Expected:** Edit mode exits, the beat's displayed text reverts to the
  pre-edit value, and no `POST /revoice` request is sent (verified via
  network tab — zero requests after Escape).
- **Verified:** ✅ live (browser e2e — devtools Network panel confirmed no
  request fired).

### TC-1.7: Enter commits exactly once
- **Action:** Edit a beat's text, press Enter.
- **Expected:** Exactly one `POST /revoice` request fires (guarded against
  double-commit from a stray blur-then-Enter or repeated keydown), edit mode
  exits immediately, and the request carries the new text.
- **Verified:** ✅ live (browser e2e — Network panel showed a single
  request; this guard was added in commit `f0b0ff0`/`fc7eb1f` after an
  initial double-fire was caught in manual testing).

### TC-1.8: No-op edit (unchanged or empty draft) skips the request
- **Action:** Enter edit mode, make no change (or clear the field back to
  original text is not applicable — clearing to empty falls under TC-1.2 at
  the API layer, but client-side the strip should not fire on an unchanged
  draft), then commit.
- **Expected:** If `draft === original text`, no `POST /revoice` is sent
  (short-circuited client-side).
- **Verified:** ✅ live (browser e2e).

---

## 2. Duration Ripple

### TC-2.1: Re-voicing a beat with a different-length result shifts later beats
- **Action:** Edit an early beat's text to something noticeably
  longer/shorter, commit, wait for `voStatus: "done"`.
- **Expected:** The edited beat's own `voDurationSeconds` changes; every
  later beat's computed `startSeconds`/`endSeconds` (from
  `computeBeatOffsets`) shifts by the delta; the project total duration
  (top-bar `m:ss`) updates accordingly. Beats before the edited one are
  unaffected.
- **Edge case:** Shots inside beats *after* the edited one keep their
  `startInBeat`/`endInBeat` (offsets are beat-relative, so they don't need
  to move) — only their *absolute* position (derived via
  `absoluteShotRange`) shifts on the timeline ruler.
- **Verified:** ✅ live (browser e2e).

---

## 3. Shot Create Within a Beat

### TC-3.1: Create a shot in a free gap
- **Action:** Click an empty gap in a beat's SHOTS row, fill in an image
  prompt, submit (`POST /shots` with `{ beatId, startInBeat, endInBeat,
  imagePrompt }`).
- **Expected:** 201, new shot row with `beatId` set and offsets inside the
  beat's duration; appears in both Timeline and Storyboard.
- **Verified:** ✅ live (browser e2e).

### TC-3.2: Overlap within the same beat rejected
- **Action:** `POST /shots` (or PATCH bounds) with a range that overlaps an
  existing shot in the same beat.
- **Expected:** 400 `"Shot overlaps an existing shot in this beat"` (create)
  / `"Bounds overlap another shot in this beat"` (PATCH). No row
  created/changed.
- **Edge case:** Overlap with a shot in a *different* beat is allowed (the
  overlap check is scoped per-beat, not per-project) — offsets are
  beat-local.
- **Verified:** ✅ live (curl).

### TC-3.3: Range beyond the beat's end rejected
- **Action:** `POST /shots` with `endInBeat > beat.voDurationSeconds + 0.05`.
- **Expected:** 400 `"Invalid startInBeat/endInBeat for this beat"`.
- **Verified:** ✅ live (curl).

### TC-3.4: Foreign `beatId` rejected (cross-project IDOR check)
- **Action:** `POST /shots` on project A with a `beatId` that belongs to
  project B (or a random valid UUID not belonging to any beat in project A).
- **Expected:** 400 `"beatId does not belong to this project"`. No row
  created. This is the cross-table authorization rule (security review §2).
- **Verified:** ✅ live (curl, tested against two projects owned by the
  same test user).

### TC-3.5: Non-string / oversized `imagePrompt` rejected
- **Action:** `POST /shots` with `imagePrompt: 123` (non-string) or a
  2,001+ character string.
- **Expected:** 400 in both cases — non-string throws a typed 400 (not a
  500 from an uncaught `.trim()` call on a non-string — this was security
  finding F3, fixed in `4ab994b`); over-length is capped at 2,000 chars.
- **Verified:** ✅ live (curl).

### TC-3.6: Motion prompt defaults when omitted
- **Action:** `POST /shots` without `motionPrompt`.
- **Expected:** 201, shot created with the default ambient-motion prompt.
- **Verified:** ✅ live (curl).

---

## 4. Split at Offset

### TC-4.1: Split at a valid mid-shot offset
- **Action:** Select a shot spanning ≥0.5s in-beat, `POST
  /shots/:shotId/split` with `{ atInBeat }` at least 0.25s from each edge.
- **Expected:** 200 `{ left, right }`; `left.endInBeat === atInBeat`;
  `right.startInBeat === atInBeat`, `right.endInBeat` = original end.
- **Verified:** ✅ live (browser e2e + curl).

### TC-4.2: Minimum 0.25s halves enforced
- **Action:** Split at an offset that would leave one half shorter than
  0.25s (e.g. `atInBeat` within 0.1s of either edge).
- **Expected:** 400 with a message specifying the valid
  `[start+0.25, end-0.25]` range. No rows changed.
- **Verified:** ✅ live (curl).

### TC-4.3: Right half inherits prompts and asset paths
- **Action:** Split a shot that already has `imagePath`/`clipPath` set.
- **Expected:** `right` inherits `imagePrompt`, `motionPrompt`,
  `imagePath`, `imageStatus`, `clipPath`, `clipStatus` from the original
  (same image/clip shown on both halves until the user regenerates); `left`
  keeps the original row's id and its own copy of the same asset fields
  (unchanged from pre-split).
- **Verified:** ✅ live (browser e2e — visually confirmed both halves show
  the same thumbnail immediately after split).

### TC-4.4: Split without a beat rejected
- **Action:** `POST /shots/:shotId/split` on a shot with no `beatId` (should
  not occur post-migration, but the route guards it).
- **Expected:** 400 `"Shot has no beat — run adopt-beats first"`.
- **Verified:** ✅ live (curl, tested by nulling `beatId` directly in a
  scratch row).

---

## 5. Recommend (Per-Beat)

### TC-5.1: Recommend replaces all shots with beat-relative rows
- **Action:** Click "Recommend shots" with voiced beats present (`POST
  /shots/recommend`).
- **Expected:** All existing shots for the project are deleted and replaced;
  every new row has a `beatId` from a voiced beat and
  `0 ≤ startInBeat < endInBeat ≤ beat.voDurationSeconds + 0.05`.
- **Verified:** ✅ live (browser e2e; psql spot-check: `SELECT count(*)
  FROM shots s JOIN beats b ON s.beat_id = b.id WHERE s.end_in_beat >
  b.vo_duration_seconds + 0.05` → 0 rows).

### TC-5.2: Recommend with no voiced beats rejected
- **Action:** `POST /shots/recommend` before any beat has
  `voStatus: "done"`.
- **Expected:** 400 `"Voice the script into beats before recommending
  shots"`.
- **Verified:** ✅ live (curl, tested on a fresh project pre-voicing).

---

## 6. Playback

### TC-6.1: Sequential chaining across beats
- **Action:** Click Play from the start of the project.
- **Expected:** Beat 1's audio plays; on `ended`, beat 2 starts
  automatically with no audible gap; playhead advances continuously across
  the beat boundary (not a jump).
- **Verified:** ✅ live (browser e2e, confirmed across ≥3 beats).

### TC-6.2: Unvoiced beats are skipped during playback
- **Action:** Play through a project where one beat has `voStatus !==
  "done"` / no `voUrl` (e.g. a beat mid-revoice or failed).
- **Expected:** Playback skips that beat's absolute range entirely and
  continues with the next voiced beat — no silent dead-air pause, no crash.
- **Verified:** ✅ live (browser e2e, tested by pausing on a beat mid-revoice
  and hitting Play).

### TC-6.3: Seek lands in the correct beat
- **Action:** Click the ruler or a script-strip segment at an arbitrary
  absolute time.
- **Expected:** Playhead jumps to that time; if playing, audio switches to
  the beat containing that time at the correct in-beat offset.
- **Verified:** ✅ live (browser e2e).

---

## 7. Timeline ⇄ Storyboard Shared State

### TC-7.1: Selection survives a view toggle
- **Action:** Select a shot in Timeline, switch to Storyboard.
- **Expected:** The same shot's card is visibly selected in Storyboard (and
  vice versa) — both views read `selection` from the same store.
- **Verified:** ✅ live (browser e2e).

### TC-7.2: Mutations in one view appear in the other without a refresh
- **Action:** Create/trim/split/delete a shot in Timeline, switch to
  Storyboard (or generate an image from a Storyboard card, switch to
  Timeline).
- **Expected:** The change (new card, updated thumbnail, removed card) is
  visible immediately in the other view — no `router.refresh()` or page
  reload needed.
- **Verified:** ✅ live (browser e2e).

### TC-7.3: Playhead position is shared
- **Action:** Play/seek while in Timeline, switch to Storyboard, switch
  back.
- **Expected:** Playhead/playback state is unaffected by the view toggle
  (owned by `useBeatPlayback`, not per-view state).
- **Verified:** ✅ live (browser e2e).

---

## 8. Migration (Historical)

### TC-8.1: Unadopted legacy shots migrate onto the beat timeline
- **Status:** Historical — the `POST /shots/adopt-beats` endpoint that
  performed this has since been **removed** after its one-time use (see
  `docs/backlog.md`). Recorded here for the historical record and in case
  the endpoint is ever re-created from git history.
- **Action (as run 2026-07-03):** `POST /api/projects/:id/shots/adopt-beats`
  on the one project with pre-Phase-2 shots.
- **Expected outcome (observed):** `{ adopted: 84, skipped: 0, dropped: 0 }`
  — all 84 legacy shots received a `beatId` + `startInBeat`/`endInBeat`
  computed via `assignRangeToBeat` (proportional rescale from the old
  continuous-VO timeline onto the new beat timeline).
- **Idempotency (verified):** Re-running the same call returned
  `{ adopted: 0, skipped: 84, dropped: 0 }` — shots that already have a
  `beatId` are left untouched.
- **Verified:** ✅ live (curl, 2026-07-03, prior to the endpoint's removal).

### TC-8.2: Adopted shots preserved their images and clips
- **Action:** After adoption, inspect the migrated shots' `imagePath` /
  `clipPath` and load their presigned URLs in the editor.
- **Expected:** Every shot's previously generated image and clip (from the
  v3.0 timeline editor) still renders correctly — adoption only writes
  `beatId`/`startInBeat`/`endInBeat`, never touches `imagePath`/`clipPath`.
- **Verified:** ✅ live (browser e2e — spot-checked several migrated shots'
  thumbnails and clip previews post-migration).

---


## 9. Cross-Beat Shots (anchor-beat spillover, added 2026-07-03)

Shots may span beat boundaries: `beatId` is the anchor (the beat containing
the shot's start); `endInBeat` may exceed the anchor's duration.

- **TC-9.1 — Spanning create.** `POST /shots` with `endInBeat` past the
  anchor's end (but within the timeline) → **201**; absolute range =
  anchor start + offsets. *Verified live 2026-07-03 (beats 18→19).*
- **TC-9.2 — Anchor invariant.** `startInBeat ≥` anchor duration → **400**
  (the shot must start inside its anchor). *Verified live.*
- **TC-9.3 — Global overlap.** A new shot in a spanned beat that collides
  with a spanning shot anchored elsewhere → **400** ("Shot overlaps an
  existing shot") — overlap is checked in absolute time across ALL shots,
  not per beat. *Verified live.*
- **TC-9.4 — Split re-anchors.** Splitting a spanning shot at an offset past
  the anchor's end → right half's `beatId` becomes the beat containing the
  split point; both halves' absolute positions are preserved. *Verified
  live (right half re-anchored, offsets exact to 1e-9).*
- **TC-9.5 — PATCH re-anchor.** `PATCH /shots/:id` accepts an optional
  `beatId` (validated to belong to the project) so a drag that moves the
  start across a boundary re-anchors; same anchor invariant + global
  overlap rules. *Verified live.*
- **TC-9.6 — Continuous gap picking.** Clicking empty timeline space picks
  the gap from the previous shot's end to the next shot's start across
  beat boundaries; the badge reads "beats N–M". *Verified live ("218.7–222.7s
  · beats 18–19").*
- **TC-9.7 — Spanned narration.** Inspector "VO (narration)" and storyboard
  SCRIPT (NARRATION) show the joined text of every beat the shot overlaps;
  meta labels read "Beat N" or "Beats N–M".

## Summary

All 8 sections above were verified live via browser e2e and/or curl against
the running dev server on 2026-07-03, on the branch
`feat/v4-phase2-unified-editor`. No test harness exists in this repo (house
convention — see the v4.0 roadmap); verification is curl/Playwright e2e per
task, matching how Phase 1 was verified.
