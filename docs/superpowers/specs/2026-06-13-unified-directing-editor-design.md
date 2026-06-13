# Design Spec — Unified Directing Editor + Reference Bible (v4.0)

**Date:** 2026-06-13
**Status:** Approved (high-level direction). Details flagged as deferred are intentionally out of scope for the first iteration.
**Supersedes / extends:** v3.0 editor-first pivot (commit `c370150`). Touches F-03 (Script), F-05 (Voiceover), F-08 (Timeline Editor), and introduces a new feature (Reference Bible).

---

## 1. Problem

The product makes good AI-animated videos but the workflow has two felt problems:

1. **It feels too step-by-step.** The friction is *not* the upstream setup wizard (style → brief → script → VO is a genuine dependency chain). The friction is the **editor's per-shot grind**: a ~40-shot video means repeating "select gap → write/suggest image prompt → generate image → write motion → generate clip → review" forty times, serially, with no batch generation and no scannable overview.
2. **No visual consistency.** There is no concept of recurring characters/locations/objects. FLUX redraws "Liu Bang" as a different person in every shot. This is the core *quality* gap.

A third, structural problem surfaced during design: **voiceover and storyboarding are walled off from the editor.** In real production these are iterated *together* — you hear a flat line while editing and want to rewrite it then and there. v3.0's single continuous VO file makes that expensive (any text edit forces a full re-bake that scrambles every downstream shot's timing).

## 2. Goals

- Turn the editor from **assembly** (user performs every atomic action) into **directing** (user describes intent; the system fans out; user reviews and refines).
- Merge **writing + voicing + storyboarding** into one screen.
- Make **visual consistency** a first-class, mostly-automated feature.
- Keep upstream first-run setup (style + brief) as a light guided path — do not collapse it for its own sake.

## 3. Non-Goals (this iteration)

- Final render/export pipeline (already pending, unchanged by this spec).
- Multi-pose character sheets (we start with a single coherent multi-view reference *sheet image* per entity; richer turnarounds later).
- Robust multi-entity-per-shot conditioning (built single-entity-first; see §7).
- Auto re-segmentation of script as the user types (see §8 Deferred).

---

## 4. The Three Pillars

### Pillar A — The Unified Editor (one screen)

Replaces the separate "Voiceover step" and "Editor step." After first-run setup (style + brief → script), the user lives in one screen with:

- **Reference Bible** (left rail) — always visible; cast & locations.
- **Center column** — video preview → **inline editable script** → **two-layer timeline**.
- **Inspector** (right) — the selected beat/shot: entity tags, image/motion prompts, per-shot fix actions.
- **"Generate all"** (top-right) — the directing action: batch every image/clip, show a queue, review results.

### Pillar B — Beat-Based Timeline + Script-in-Editor

The timeline becomes **two layers over a voice track**:

- **Beat** = one sentence/clause. Owns its **text** and **its own VO audio clip**. The narration unit.
- **Shots** = the visuals *under* a beat. A beat holds 1+ shots; each shot is a sub-range with its own image + motion + clip.

Editing a beat's words re-voices **only that beat**; later beats ripple in time. Re-cutting visuals (splitting a sentence into two angles) touches **no audio**. This is the merge of writing/voicing/storyboarding, and it is *why* we move off the continuous master VO.

### Pillar C — The Reference Bible (new feature)

A per-project "show bible" of recurring entities, modeled on a classic reference sheet (characters, locations, objects), each rendered as one coherent multi-view sheet image. Flow (directing, not data-entry):

1. **Auto-extract** entities from the script (Claude).
2. **Auto-generate** one multi-view reference-sheet image per entity (FLUX, in project style, seeded from an editable description).
3. **Auto-tag** which beats/shots each entity appears in.
4. **User curates** — rename, redraw, delete, fix tags.
5. **Condition at generation** — a tagged shot's image generation conditions FLUX.1 Kontext on the entity's reference sheet → on-model every time.

Scope: model + UI hold **characters, locations, objects** from day one (no later migration), but we *build and prove* in order of payoff: **characters → locations → objects**.

---

## 5. Two Views Over One Source of Truth

Timeline and Storyboard are **two renderers of the same beats/shots state**, never duplicated data.

- **Timeline view** — timing, trimming, fine cuts. Horizontal, time-accurate.
- **Storyboard view** — a scannable card grid; each card shows **description (visual)** beside **script (narration)**, entity tags, and status. This is the **batch-review surface**: "Generate all" fills it; ready/generating/failed statuses and per-card retry live here.

**Invariant:** one shared client store + DB as source of truth; both views read it. Adding/removing a shot or beat in one view appears in the other for free — no sync/reconciliation layer. (Confirmed sufficient for the "edits propagate across views" hurdle.)

---

## 6. Data Model

> Migration from v3.0. The continuous per-project voiceover is replaced by per-beat voiceover.

### New: `beats`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| projectId | uuid FK → projects (cascade) | |
| sortOrder | int | sequential order |
| text | text | the narration for this beat — **source of truth for script text after initial segmentation** |
| voPath | text | R2 key of this beat's audio clip |
| voStatus | enum(pending\|generating\|done\|failed) | |
| voDurationSeconds | numeric | actual clip length; drives timeline layout |
| voTimestamps | jsonb | char-level alignment *within the beat* (for sub-shot timing) |
| createdAt / updatedAt | timestamptz | |

### Changed: `shots`
- **+ `beatId`** uuid FK → beats (cascade). A shot belongs to a beat.
- Times stored as **offsets within the beat** (`startInBeat`, `endInBeat`); absolute time computed at render = (sum of prior beats' durations) + offset.
- **+ `referencedEntityIds`** jsonb<string[]> — entities tagged in this shot.
- Retains: `imagePrompt`, `motionPrompt`, `imagePath`, `imageStatus`, `clipPath`, `clipStatus`, `clipDurationSeconds`. (Cached `text` becomes a derived display value.)

### New: `entities` (Reference Bible)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| projectId | uuid FK → projects (cascade) | |
| name | text | e.g. "Liu Bang", "Imperial Palace" |
| type | enum(character\|location\|object) | |
| description | text | user-editable; seeds the reference sheet |
| referenceSheetPath | text | R2 key of the multi-view sheet image |
| referenceStatus | enum(pending\|generating\|done\|failed) | |
| createdAt / updatedAt | timestamptz | |

### Changed: `projects`
- Deprecate/remove continuous-VO fields (`voiceoverPath`, `voiceoverStatus`, `voiceoverTimestamps`, `durationSeconds` as a stored bake). Total duration becomes the computed sum of beat durations.
- `script` retained for first-run/reference; **beats own text** once segmented.

### Timing model
- Beat absolute start = Σ durations of prior beats (sequential stacking, not absolute offsets into one file).
- Shot absolute time = beat start + shot offset-in-beat.
- Any add/remove/edit of a beat = regenerate affected beat audio + recompute running offsets. Local ripple, never a full re-bake.

---

## 7. Generation Flows

### Batch "Generate all" (directing)
Server-side fan-out over all beats/shots. From the user's view: one button + a progress queue. Surfaces in the Storyboard view with per-item status and retry. (Backlog already notes SSE streaming for long videos — applies here.)

### Voiceover (per beat)
- Each beat → `convertWithTimestamps` (existing `eleven_multilingual_v2`).
- **Prosody continuity:** pass `previous_text` / `next_text` (context only, not billed) and optionally `previous_request_ids` stitching so beats chain smoothly.
- **Segment on sentence/clause boundaries only** — never mid-sentence — so concatenation seams fall on natural pauses.
- Cost: ElevenLabs bills per character, so N segments ≈ same cost as one call; re-voicing one beat re-bills only that beat. Segmentation is *more* cost-efficient for iteration.

### Image (per shot, with consistency)
- Tagged shot conditions FLUX.1 Kontext on the referenced entity's `referenceSheetPath`.
- **Single-entity shots: build first, rock-solid.**
- **Multi-entity shots (genuine technical risk):** a shot with both a character and a location needs both references. Kontext is strongest with one reference. Approach: composite the references into one conditioning image, or primary-reference + describe-the-rest fallback. **Explicitly built after single-entity works.**

---

## 8. Known Hurdles — Deferred to Later Iterations

These are understood and the foundation handles them; details are intentionally postponed.

1. **Script re-segmentation policy.** When does *typing* create a new beat vs. lengthen the current one? v1 rule: editing inside a beat keeps it one beat; creating a beat is an explicit action (like the existing shot-split). Avoids surprising auto-resplit. Revisit later.
2. **Multi-entity-per-shot conditioning** (see §7) — single-entity first.
3. **Multi-pose / turnaround sheets** — start with one coherent multi-view sheet image; richer per-pose anchoring later.
4. **View-sync edge cases** — the single-source-of-truth invariant covers add/remove/edit across Timeline/Storyboard; specific interactions (e.g. trimming a beat that shrinks its shots) get fleshed out in implementation.
5. **Render/export** — unchanged, still pending.

---

## 9. Migration Notes (v3.0 → v4.0)

- v3.0 projects have one `voiceover.mp3` + project-level timestamps and absolute-offset shots. Migration: segment existing script into beats, regenerate per-beat audio (or lazily on first edit), recompute shot offsets relative to their beat. Existing images/clips are preserved (visual assets are independent of the audio split).
- New tables: `beats`, `entities`. New column on `shots`: `beatId`, `referencedEntityIds`, offset-in-beat fields.

---

## 10. Doc Propagation (next)

This spec is the source of truth. It propagates to:
- **New feature doc** for the Reference Bible (next feature number).
- **Revisions** to F-05 (continuous → beat-based VO) and F-08 (unified editor, two views, batch generate).
- **`backlog.md`** — fold/replace F-07a (entity reference sheets) into the Reference Bible feature; add the §8 deferred items as explicit entries.
