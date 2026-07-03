# Backlog

Non-blocking polish items, known bugs, and deferred features. Each entry is
structured so someone new to the codebase can pick it up without extra
context from the author.

Entries are grouped by feature area (F-XX IDs match product-requirement.md)
and ordered roughly by impact within each group. Items marked **Blocks**
are pre-requisites for another backlog item or future feature; **Standalone**
can be picked up independently.

---

## F-08 Timeline Editor

### 1. Shot `text` cache stays stale after drag-resize (bug)

**Status:** Known bug, introduced + reverted during Iter 1.5. Documented here
so the next attempt doesn't rediscover the same trap.

**User impact:** After dragging a shot's edge to resize it (e.g. shrinking a
6s shot to 4s), the "VO" text shown in the side panel still displays the
*original* wider slice of narration. The actual shot bounds persist
correctly to the server; only the cached `text` column isn't reflected in
local state until the user reloads the page.

**Current behavior:**
- `src/components/editor-prototype.tsx` — `persistBounds` sends PATCH with
  new `startSeconds`/`endSeconds` but ignores the response.
- `src/app/api/projects/[id]/shots/[shotId]/route.ts` — PATCH correctly
  re-derives and persists `text` via `deriveVOText()`.
- Page reload calls the server component which re-reads from DB → correct
  text appears.

**Why the previous fix was reverted:** The natural fix is to merge the PATCH
response into local state:
```ts
const updated = await res.json();
setShots(prev => prev.map(s => s.id === shotId ? {...s, ...updated} : s));
```
This caused unrelated drag flicker — the shot would bounce briefly back to
its pre-drag size before settling. Likely a race between the optimistic
local update (during drag) and the server-response merge (after drag-end).

**Proposed approach:**
1. Keep the optimistic local update on mousemove (current behavior).
2. On `mouseup`, send PATCH. On response, update ONLY the `text` field of
   the local shot (not the whole shot), since bounds are already correct
   locally:
   ```ts
   setShots(prev => prev.map(s => s.id === shotId ? {...s, text: updated.text} : s));
   ```
3. If the response's `startSeconds`/`endSeconds` differ from what we sent
   (e.g. server clamped), reconcile — but don't overwrite local values that
   are already correct.

Also worth investigating: whether React 18's strict mode or a double effect
run contributed to the flicker.

**Files:** `src/components/editor-prototype.tsx` (persistBounds, ~line 175).
**Effort:** ~1 hour including manual regression testing.
**Tag:** bug, editor

---

### 2. Undo/redo

**User impact:** Any destructive action (delete, split, trim, reposition) is
one-way. Users must manually recreate state if they make a mistake.

**Current behavior:** No history tracking. All mutations hit the DB and
update local state immediately.

**Proposed approach:**
- Client-side command pattern: each mutation is recorded as an inverse
  operation (e.g. "delete" records the deleted shot's full data; "undo"
  POSTs back to create).
- Keep last ~20 operations in a stack. `Cmd+Z` / `Ctrl+Z` triggers the
  inverse; `Cmd+Shift+Z` redoes.
- The server doesn't need to know about undo — each undo is just a regular
  API call using the stored inverse.

**Edge cases:**
- Undo after `Recommend shots` would need to either replay the previous
  shot list (store it in memory) or be disabled.
- If a shot was deleted on the server and another client modified the
  project, undo might fail — show a toast, drop the entry from the stack.

**Files:** new hook `src/hooks/use-editor-history.ts`; wire into
`editor-prototype.tsx`.
**Effort:** 1-2 days for a solid first cut.
**Tag:** feature, editor

---

### 3. SSE streaming for "Recommend shots"

**User impact:** Current implementation waits ~15-30 seconds with a spinner
before all shots appear at once. At scale (10-min videos → ~80 shots),
this is a visible hang.

**Current behavior:**
`POST /api/projects/[id]/shots/recommend` uses `anthropic.messages.stream()`
internally but awaits `stream.finalMessage()` before responding. Client gets
everything in a single JSON blob.

**Proposed approach:**
1. Convert the endpoint to SSE (`Content-Type: text/event-stream`). Each
   Claude output chunk is parsed and, when a complete image prompt is
   detected, immediately:
   - Inserted into the DB (with its derived timing)
   - Emitted as an `event: shot` with the full shot row.
2. Client uses `EventSource` (or fetch + ReadableStream) to consume events
   and append each shot to the timeline as it arrives.

**Gotchas:**
- Claude's tool_use output is one JSON blob; streaming gives chunks of JSON
  text. Need an incremental JSON parser (or do a simple regex-based scan
  for complete `{...}` entries in the `image_prompts` array).
- Timings depend on the full fragment list (computed after Claude finishes)
  — for streaming, we already know fragments from Stage 1 (deterministic
  split), so timings can be set immediately and prompts filled in as they
  arrive.

**Files:** `src/app/api/projects/[id]/shots/recommend/route.ts`,
`src/lib/shot-recommendation.ts`, and the client handler in
`src/components/project-workspace.tsx` (`handleRecommendShots`).
**Effort:** 1 day.
**Tag:** perf, editor

---

### 4. Keyboard shortcuts beyond S/Del

**User impact:** Power users want to edit without reaching for the mouse.

**Current behavior:**
- `S` splits selected shot at playhead.
- `Del`/`Backspace` deletes selected shot.

**Proposed additions:**
- Arrow keys (←/→): nudge selected shot by 1s per press; Shift+arrows for
  10s jumps.
- `[`/`]`: trim selected shot's left/right edge by 1s.
- Space: toggle playback.
- `Esc`: deselect.
- `J`/`L`: jump playhead by 5s back/forward.

All handled in the existing keyboard useEffect at
`src/components/editor-prototype.tsx:~380`. Follow the existing pattern:
check `target.tagName` to avoid firing during textarea edits.

**Effort:** 2-3 hours.
**Tag:** polish, editor

---

### 5. Side panel collapse state — persist in localStorage

**User impact:** Panel reopens every page load even if user explicitly
collapsed it.

**Current behavior:** `panelOpen` is component-local state, initialized to
`true` on every mount.

**Proposed:** Read/write `localStorage['editor-panel-open']` on mount and
on toggle.

**Files:** `src/components/editor-prototype.tsx`.
**Effort:** 15 minutes.
**Tag:** polish, editor

---

### 6. Split-clip and duplicate-clip actions

**User impact:** Split currently duplicates the original shot's prompts
into both halves. Users might want a full "clone" (separate copy of a shot
somewhere else on the timeline) or want both halves to have distinct
prompts from the start.

**Current behavior:** Split inherits prompts verbatim. No duplicate action.

**Proposed:**
- **Duplicate:** a "Copy" button in the shot side panel; creates an
  identical shot positioned at the nearest available gap (or appends to
  end).
- **Auto-suggest on split:** after split, auto-fire
  `/shots/suggest-prompt` for the RIGHT half using its new VO fragment,
  so the user doesn't get two shots with the same visual.

**Files:** `src/components/editor-prototype.tsx` (ShotEditPanel),
maybe a new endpoint `/shots/[shotId]/duplicate` or reuse `POST /shots`.
**Effort:** 4-6 hours.
**Tag:** feature, editor

---

### 7. Snap-to-grid and snap-to-shot-boundary

**User impact:** Dragging shots doesn't snap to anything — users have to
align by eye or zoom in.

**Current behavior:** Drag updates `startSeconds` to `Math.round(x / PX_PER_SECOND)`.

**Proposed:**
- When dragging near another shot's edge (within ~5px), snap to that edge.
- Optional: snap to 0.5s grid (toggleable).
- Visual indicator (blue line) when snap is active.

**Files:** `src/components/editor-prototype.tsx` (drag handlers).
**Effort:** 3-4 hours.
**Tag:** polish, editor

---

### 7a. Entity reference images → PROMOTED to feature F-16 (Reference Bible)

**Status:** ✅ Promoted 2026-06-13. This proposal was the narrow first draft of
what is now a full feature — the **Reference Bible** (characters, locations,
objects as multi-view reference sheets; auto-extract + auto-tag + curate;
FLUX.1 Kontext conditioning).

**Do not implement from this entry.** The authoritative spec and navigation
map now live here:
- Design: [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md) (Pillar C)
- Feature doc: [`docs/feature16/feature.md`](feature16/feature.md)

What changed vs this draft: `type` enum became `character|location|object`
(was `character|setting|object`); the canonical reference is **one coherent
multi-view sheet image** per entity (not a single portrait); the column is
`referenceSheetPath`/`referenceStatus`; and the FLUX per-call reference cap +
**multi-entity-per-shot conditioning** are tracked as explicit risks in the
feature doc (build single-entity first).

**Tag:** feature, quality, editor — superseded by F-16

---

### 8. Multi-keyframe "transformation" clips

**User impact:** Current shots are one-image-one-clip using LTX-2.3 image-to-video,
which animates what's in the starting frame. It can't reliably produce
transformations (e.g. "ashes become phoenix") because LTX can't materialize
new subjects from nothing. Users resort to splitting such moments into two
shots with a hard cut between, which kills the storytelling.

**Current behavior:** `POST /api/projects/[id]/shots/[shotId]/clip` sends
one image + one motion prompt to `fal-ai/ltx-2.3/image-to-video`, gets back
one ~6s clip. All or nothing.

**Proposed:** add a "Clip mode" toggle in the shot edit panel:

- **Simple** (default) — current behavior, single image + motion prompt.
- **Advanced** — 2–5 user-defined keyframe images; the system generates the
  in-between motion using a first-frame-and-last-frame video model and
  concatenates the sub-clips.

UX shape:
- A keyframes carousel below the prompt fields in the shot panel.
- Each keyframe has: generated image (regeneratable), optional motion
  prompt describing the transition INTO that keyframe.
- "Generate advanced clip" button takes all keyframes + motion prompts
  and produces one stitched clip.
- Cost estimate shown before generating (advanced clips are ~$2 each vs
  $0.24 for simple; model with explicit message).

Technical stack:
- **Image keyframes:** reuse existing FLUX.1 Kontext endpoint. Each keyframe
  can reference the previous one via img2img to keep backgrounds consistent.
- **In-between video:** requires a model with first-frame + last-frame
  support. Candidates:
  - `fal-ai/kling-video/v2.1/pro/image-to-video` — supports start and end
    images, ~$0.28/sec.
  - `fal-ai/runway-gen3/turbo/image-to-video` — supports both, similar price.
  - `fal-ai/pika/v2.2/image-to-video` — cheaper option, variable quality.
- **Concatenation:** ffmpeg server-side (via `@ffmpeg/ffmpeg` WASM or a
  lightweight Node ffmpeg wrapper); or Shotstack with multiple clip
  segments in the timeline JSON.

Schema changes:
- Add `shots.clipMode` enum (`simple` | `advanced`), default `simple`.
- Add `shots.keyframes` jsonb: `[{ imagePath: string, motionPrompt: string | null }]`.
  Null for the first keyframe (it's the starting state).
- Existing `imagePath` becomes the first keyframe for simple mode or is
  ignored for advanced (keyframes is the source of truth).
- `clipPath` remains the final stitched clip.

Rough implementation outline:
1. Schema migration + `clipMode` toggle UI.
2. Keyframe generation endpoint:
   `POST /api/projects/[id]/shots/[shotId]/keyframes` — body `{ index, imagePrompt }`.
   Generates one keyframe image, optionally img2img-conditioned on the
   previous keyframe for continuity.
3. Advanced clip endpoint:
   `POST /api/projects/[id]/shots/[shotId]/clip-advanced` — generates all
   in-between sub-clips with Kling/Runway, stitches via ffmpeg, stores in R2.
4. UI: keyframe carousel with add/remove/regen; motion prompt per gap.

Related to backlog #1 (reference-image conditioning) — once character/scene
reference sheets exist, keyframes can condition on them for even stronger
identity preservation.

**Files:** new migration + endpoints; `src/components/editor-prototype.tsx`
(`ShotEditPanel` gets the keyframe carousel); `src/lib/image-generation.ts`
(add img2img chaining variant).
**Effort:** 3–5 days for a solid first cut.
**Tag:** feature, quality, editor
**Depends on:** pipeline-complete (F-06, F-08 assembly) — don't build this
until you can actually ship a video end-to-end.

---

### 9. Drag-reorder via list view → SUBSUMED by v4.0 Storyboard view

**Status:** Folded into the v4.0 **Storyboard view** (a scannable card grid
that is a peer to the Timeline, over one shared store). See
[`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md)
§5 and the F-08 v4.0 notice. Keep this entry only for the *drag-reorder*
nuance below; the view itself is now part of the editor redesign.

**User impact:** With 60+ shots, the horizontal timeline gets unwieldy.
A collapsed list view (like a script table) with thumbnails would help
bulk operations.

**Current behavior:** Only the timeline view exists.

**Proposed:** A toggle in the editor toolbar to switch between timeline
and list views. List view shows rows with thumbnail + VO excerpt + prompts,
drag-handle to reorder.

**Files:** new `src/components/shot-list-view.tsx`; toggle state in
`editor-prototype.tsx`.
**Effort:** 1-2 days.
**Tag:** feature, editor

---

## F-05 Voiceover

### 10. VO regeneration on script edit → SUPERSEDED by v4.0 beat-based VO

**Status:** Superseded by the v4.0 **beat-based voiceover** redesign. When VO
becomes per-beat, editing a beat's text re-voices only that beat and later
beats ripple in time — the whole "re-bake + re-align all shots" problem
below stops existing for the common case. See
[`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md)
(Pillar B) and the F-05 v4.0 notice. The proportional/text-anchored approach
below is only relevant to the legacy continuous-VO path.

**User impact:** If the user edits the script and regenerates VO, the new
VO has a different duration. Existing shots still point at old timestamps —
they may no longer align with the narration they describe.

**Current behavior:** Script edit invalidates the VO (sets
`voiceoverPath = null`). Shot timestamps are left as-is. After the user
re-generates VO, shots may be "orphaned" relative to the new audio.

**Proposed fix (PRD v3.0 open question #3):**
- Simple: proportional scaling. If new VO is 10% longer, multiply every
  `startSeconds` and `endSeconds` by 1.1.
- Better: text-anchored. Find each shot's cached `text` fragment in the
  new VO's character timestamps; remap to new seconds.
- Fallback if text-anchor fails: proportional.

**Files:** `src/app/api/projects/[id]/voiceover/generate/route.ts` — after
VO generates, iterate `shots`, recompute timings.
**Effort:** 1 day.
**Tag:** feature, vo

---

### 11. Script drift detection + tighten-length action

**User impact:** PRD v3.0 F-03 AC says "if VO drifts >10% from target, offer
tighten/expand regen action." Not implemented yet.

**Current behavior:** After VO generates, `durationSeconds` is measured but
no warning or action is surfaced to the user.

**Proposed:**
- In the editor header, show `{actualSeconds} / {targetSeconds}` with a
  badge color-coded by drift (green <10%, yellow 10-20%, red >20%).
- If drift >10%, show a "Tighten script" button that calls a new endpoint
  `/script/retarget` — Claude rewrites the script at the measured
  chars-per-second rate to hit the target duration.

**Files:** new endpoint, UI surface in `step-editor.tsx` or a dedicated
header component.
**Effort:** 4-6 hours.
**Tag:** feature, script

---

## v4.0 Unified Editor — deferred details

These are understood and the v4.0 foundation handles them; details are
intentionally postponed per the design spec §8
([`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../superpowers/specs/2026-06-13-unified-directing-editor-design.md)).

### 14. Script re-segmentation policy (when typing creates a new beat)

**Open question:** When a user edits beat text, when does typing create a
*new* beat vs. just lengthen the current one? v1 rule (chosen): editing
inside a beat keeps it one beat (one VO clip); creating a beat is an explicit
action (like the existing shot-split). This avoids surprising auto-resplit
mid-type. Revisit if users want paragraph-paste to auto-segment.
**Tag:** design-decision, editor, vo — flesh out during implementation.

### 15. Multi-entity-per-shot conditioning (F-16)

A shot featuring two entities at once (e.g. a character *in* a location)
needs conditioning on both reference sheets; FLUX.1 Kontext is strongest
with a single reference. Build single-entity conditioning first; layer
multi-entity after (composite references, or primary-reference +
describe-the-rest). Full detail in [`docs/feature16/feature.md`](feature16/feature.md).
**Tag:** feature, quality, F-16 — phase 2 of the Reference Bible.

### 16. True multi-pose / turnaround sheets (F-16)

v1 of the Reference Bible uses one coherent multi-view sheet image per
entity. Richer per-pose anchoring (front/side/back/expressions selectable
per shot) is deferred until we see where single-sheet conditioning breaks.
**Tag:** feature, quality, F-16 — later iteration.

### 17. Timeline ⇄ Storyboard view-sync edge cases

The single-source-of-truth invariant (one shared store, two renderers)
covers add/remove/edit propagation for free. Specific interactions still to
flesh out during implementation: trimming a beat that shrinks its child
shots' offsets; re-fitting shots when a beat's audio duration changes after
re-voice; selection/playhead continuity when toggling views.
**Tag:** editor — implementation detail, not an architectural blocker.

---

### 18. v4.0 Phase 2 drop-deferred items

**Status:** Phase 2 (unified editor) shipped 2026-07-03. These items were
explicitly scoped out of the plan (`docs/superpowers/plans/2026-07-02-v4-phase2-unified-editor.md`,
Global Constraints) and remain open:

- **Cross-beat shot drag.** A shot's drag/trim in the Timeline view is
  clamped to its own beat; moving a shot's visuals into a different beat
  isn't supported. Revisit alongside #17 above.
- **Beat add/split/merge UI (spec §8.1).** Editing inside a beat keeps it
  one beat by design (see #14); creating, splitting, or merging beats
  themselves has no UI yet.
- **`adopt-beats` endpoint removed after one-time use.**
  `src/app/api/projects/[id]/shots/adopt-beats/route.ts` migrated the one
  existing project's 84 legacy (absolute-timed) shots onto the beat
  timeline and was deleted once that migration ran (see
  `docs/feature08/testcase-v4-phase2.md` §8 for the run record). If a
  similar legacy-shot migration is ever needed again, re-create it from git
  history (commit `52952ee`) rather than reinventing it.

**Tag:** editor, vo, migration — deferred, not blocking.

---

### 19. v4.0 Phase 2 final-review follow-ups

**Status:** Logged 2026-07-03 from the Phase 2 (unified editor) final review.
None of these block the Phase 2 ship; the Cmd/Ctrl+S split-hijack bug found
in the same review was fixed directly (see `timeline-view.tsx` keydown
handler). Remaining items to pick up:

- Split right-half should inherit `imageUrl`/`clipUrl` client-side in
  `editor-store` `splitShot` (server already copies asset paths; client
  nulls them until reload); align `docs/feature08/testcase-v4-phase2.md`
  TC-4.3 wording.
- ~~Reword two stale error strings referencing the removed `adopt-beats`
  endpoint~~ — done 2026-07-03 (now "Shot has no anchor beat") as part of
  the cross-beat shots change.
- Enforce `MIN_SHOT_SECONDS` on recommend-inserted fragments (sub-0.25s
  beats can yield sub-minimum shots).
- Wrap recommend's delete-then-insert in a DB transaction (failed insert
  after delete loses shots).
- Clear superseded Audio `onended`/`onerror` handlers in
  `use-beat-playback` `stopAudio` (late-firing handler could advance with
  stale index).
- Surface `voStatus` "failed" client-side after a failed revoice instead
  of reverting to the prior status.
- Add a DB-level overlap constraint for shots within a beat (TOCTOU race
  in the app-level check).
- Docs sweep: feature16 "editor-prototype successor" phrasing; roadmap
  line "Phases 2–4 are deliberately not written yet"; delete pre-existing
  dead `src/lib/scene-utils.ts`.

**Tag:** editor, vo, bug, docs — deferred, not blocking.

---

## Ops / Dev UX

### 12. HMR warning on dep-array changes during hot reload

**User impact:** When modifying useEffect deps in editor-prototype.tsx,
the dev server emits: *"The final argument passed to useEffect changed
size between renders."* This is a dev-only artifact of React hot-reload
comparing pre- and post-edit versions of the same mounted component.

**Fix:** No code change needed — a hard refresh (Cmd+Shift+R) clears it.
Consider documenting in CONTRIBUTING.md or the README.

**Tag:** docs, dev-ux

---

### 13. localStorage CSRF / session sync

**Not investigated yet but likely present** given BetterAuth's cookie
semantics — if a user has the app open in two tabs and logs out in one,
the other doesn't notice until next API call. Low priority until we have
multiple users.

**Tag:** future, auth

---

## Triage Notes

- **Highest-impact pickups next:** #1 (shot text cache) and #10 (VO regen
  shot re-align). These are bugs that affect day-to-day usage.
- **Highest-leverage feature:** #2 (undo/redo) — after you destroy a shot
  you can't recover, which will bite users the moment they start editing.
- **Nice-to-have polish that'd ship in a day:** #4 (more keyboard
  shortcuts) + #5 (localStorage persist).
- **Biggest quality lift, but wait:** #8 (multi-keyframe transformation
  clips). Do NOT start this until the base pipeline is end-to-end shippable
  (F-06 music, F-08 Shotstack assembly, F-11 YouTube publish).
