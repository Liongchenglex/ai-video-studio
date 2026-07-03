# v4.0 Phase 2 — Unified Editor + Two Views — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stepper's separate Script + Editor steps with one unified directing editor: inline-editable script (per-beat re-voice), a two-layer beat/shot timeline, and a Timeline⇄Storyboard toggle — both views over one shared client store — then retire the legacy continuous-VO model.

**Architecture:** Shots move from absolute timeline seconds to **beat-relative offsets** (`beatId` + `startInBeat`/`endInBeat`) — the offsets are the *only* source of truth; absolute times are always computed by stacking beat durations (`computeBeatOffsets`, shipped in Phase 1). One React context store (`editor-store.tsx`, no new dependencies) owns beats/shots/selection/playhead; Timeline, Storyboard, Script strip, and Inspector are four renderers of that store. Playback chains per-beat audio clips sequentially. At the end of the phase the continuous-VO fields on `projects` and the legacy absolute columns on `shots` are dropped, per the roadmap's additive-first migration convention.

**Tech Stack:** Next.js 15 (App Router), React 19, Tailwind CSS v4 + shadcn/ui, Drizzle + Neon Postgres, ElevenLabs (existing `beat-voiceover-generation.ts`), Cloudflare R2, Anthropic SDK (existing `shot-recommendation.ts` pattern).

**Visual reference (follow these):** `docs/superpowers/specs/mockups/01-timeline-view.png` and `02-storyboard-view.png`. Layout: top bar (view toggle · project stats · play) · left rail (Cast & Locations — Phase 4 placeholder) · center column (video preview → inline script strip → timeline OR storyboard) · right inspector. Beats get cycling accent colors shared between script segments and timeline beat blocks. "Generate all" (mockup, top-right) is **Phase 3 — do not build it now**, and entity chips in the inspector are **Phase 4 — do not build them now**.

## Global Constraints

- **No new npm dependencies.** State = React context + `useReducer`.
- **Security on every mutation** (security-playbook.md): `applyRateLimit` (`mutation` or `generation` preset) → `verifyCsrf` → `getSession` → ownership via `projects.userId` join → UUID validation on all path params → body shape/length validation → generic client errors (no internals).
- **Cross-table authorization:** any endpoint accepting a `beatId` MUST verify `beat.projectId === project.id` before use.
- **No unit-test harness in this repo.** Verification per task = `npx tsc --noEmit`, `npm run lint`, `npm run db:push` where schema changes, plus curl / browser e2e. (House convention from the roadmap.)
- **Commit per task:** `feat(v4-p2): …`
- **File header comments** on every new file describing what it does (CLAUDE.md).
- **Functions < ~150 LOC**, no dead code, match existing naming/patterns.
- Beat text edit limit: **2,000 chars** (matches one ElevenLabs request comfortably); shot prompt fields non-empty when provided (existing rule).
- Deferred (do NOT build): batch generate-all (Phase 3), Reference Bible CRUD/tagging (Phase 4), beat add/delete/split/merge (spec §8.1 — editing inside a beat keeps it one beat), cross-beat shot drag, sub-beat narration slicing (shot narration = its beat's text).

## File Structure

```
src/
├── lib/
│   ├── shot-beat-mapping.ts            # CREATE — pure helpers: map absolute ranges onto beats
│   ├── shot-recommendation.ts          # REWRITE — per-beat fragments + prompts (keeps splitter + Claude tool)
│   ├── db/schema.ts                    # MODIFY — legacy shot cols nullable (T1), then dropped w/ projects VO fields (T12)
│   ├── vo-text.ts                      # DELETE (T12)
│   └── voiceover-generation.ts         # DELETE (T12)
├── app/api/projects/[id]/
│   ├── beats/[beatId]/revoice/route.ts # MODIFY — optional { text } body
│   ├── shots/route.ts                  # REWRITE — create beat-relative
│   ├── shots/[shotId]/route.ts         # REWRITE — PATCH offsets / DELETE
│   ├── shots/[shotId]/split/route.ts   # REWRITE — split at offset-in-beat
│   ├── shots/adopt-beats/route.ts      # CREATE — one-time legacy-shot adoption
│   ├── shots/recommend/route.ts        # MODIFY — insert beat-relative rows
│   └── voiceover/generate/route.ts     # DELETE (T12)
├── components/
│   ├── editor/
│   │   ├── editor-store.tsx            # CREATE — shared store: state, reducer, API actions, beat colors
│   │   ├── use-beat-playback.ts        # CREATE — sequential per-beat audio playback
│   │   ├── unified-editor.tsx          # CREATE — shell: top bar, rail, preview, views, inspector, gates
│   │   ├── script-strip.tsx            # CREATE — inline editable beats (blur → revoice)
│   │   ├── timeline-view.tsx           # CREATE — beats/shots/voice rows + playhead + drag/trim
│   │   ├── storyboard-view.tsx         # CREATE — card grid, statuses, per-card actions
│   │   └── inspector.tsx               # CREATE — beat panel / shot panel / gap create
│   ├── project-workspace.tsx           # REWRITE — 3 steps: Concept → Style → Editor
│   ├── step-script.tsx                 # DELETE (T11)
│   ├── step-editor.tsx                 # DELETE (T11)
│   └── editor-prototype.tsx            # DELETE (T11)
└── app/projects/[id]/page.tsx          # MODIFY — load beats server-side; drop VO fields (T11/T12)
```

Execution order note: Tasks 1–5 are server-side and independently curl-testable. Tasks 6–11 build the UI bottom-up (store → hooks → views → shell). Task 12 is teardown + e2e + docs and MUST run last, after adoption (T3) has been executed against every existing project.

---

## Task 1: Schema loosening + shot↔beat mapping helpers

**Files:**
- Modify: `src/lib/db/schema.ts:195-199`
- Create: `src/lib/shot-beat-mapping.ts`

**Interfaces:**
- Produces: `assignRangeToBeat(startSec: number, endSec: number, offsets: BeatOffset[]): { beatId: string; startInBeat: number; endInBeat: number } | null` and `MIN_SHOT_SECONDS = 0.25` — used by Task 3 (adoption) and Task 5 (recommend).
- Consumes: `BeatOffset` from `src/lib/beat-timing.ts` (Phase 1): `{ id, startSeconds, endSeconds }`.

- [ ] **Step 1: Make legacy shot columns nullable**

In `src/lib/db/schema.ts`, the shots table currently has:

```typescript
    // ── Position on the global project timeline ──
    startSeconds: integer("start_seconds").notNull(),
    endSeconds: integer("end_seconds").notNull(),
```

Replace with:

```typescript
    // ── DEPRECATED v3.0 absolute position — superseded by beatId +
    // startInBeat/endInBeat. Nullable during Phase 2; dropped at the end
    // of the phase (see the teardown task). Do not write in new code. ──
    startSeconds: integer("start_seconds"),
    endSeconds: integer("end_seconds"),
```

- [ ] **Step 2: Push and verify**

Run: `npm run db:push` → expect the two columns to become nullable, no data loss.
Run: `npx tsc --noEmit` → expect errors in files that assume non-null `startSeconds` (editor-prototype, shot routes, etc.) — **that is expected and temporary**; note them, they are all rewritten/deleted by Tasks 4, 5, 11, 12. If the error list contains files NOT in this plan's File Structure, stop and re-check.

(Because tsc is red between T1 and T4, run per-task type checks scoped: `npx tsc --noEmit 2>&1 | grep -v -E "editor-prototype|shots/route|shots/\[shotId\]|recommend"` until Task 5, after which tsc must be fully green again except the components deleted in T11.)

- [ ] **Step 3: Create the mapping helper**

Create `src/lib/shot-beat-mapping.ts`:

```typescript
/**
 * Shot ↔ beat mapping (v4.0 Phase 2).
 * Pure helpers that place an absolute [start, end] second range onto the
 * beat timeline: pick the beat with maximum overlap and clamp the range
 * into offsets within that beat. Used by the legacy-shot adoption
 * migration and by per-beat shot recommendation.
 */
import type { BeatOffset } from "@/lib/beat-timing";

/** Shots shorter than this (after clamping) are stretched to it. */
export const MIN_SHOT_SECONDS = 0.25;

export interface BeatRelativeRange {
  beatId: string;
  startInBeat: number;
  endInBeat: number;
}

/**
 * Maps an absolute range onto the beat with which it overlaps most.
 * Returns null when there are no beats or the range has no positive
 * overlap with any beat (e.g. it lies entirely past the timeline end —
 * callers should then clamp to the last beat themselves or skip).
 */
export function assignRangeToBeat(
  startSec: number,
  endSec: number,
  offsets: BeatOffset[],
): BeatRelativeRange | null {
  if (offsets.length === 0 || endSec <= startSec) return null;

  let best: BeatOffset | null = null;
  let bestOverlap = 0;
  for (const o of offsets) {
    const overlap =
      Math.min(endSec, o.endSeconds) - Math.max(startSec, o.startSeconds);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = o;
    }
  }
  if (!best) return null;

  const beatDur = best.endSeconds - best.startSeconds;
  let startInBeat = Math.max(0, startSec - best.startSeconds);
  let endInBeat = Math.min(beatDur, endSec - best.startSeconds);

  // Enforce a minimum length, clamped inside the beat.
  if (endInBeat - startInBeat < MIN_SHOT_SECONDS) {
    endInBeat = Math.min(beatDur, startInBeat + MIN_SHOT_SECONDS);
    startInBeat = Math.max(0, endInBeat - MIN_SHOT_SECONDS);
  }
  if (endInBeat <= startInBeat) return null; // beat shorter than the minimum

  return { beatId: best.id, startInBeat, endInBeat };
}
```

- [ ] **Step 4: Sanity-check (temporary script, not committed)**

Write `/tmp-check.ts` in the repo root:

```typescript
import { assignRangeToBeat } from "./src/lib/shot-beat-mapping";
const offsets = [
  { id: "a", startSeconds: 0, endSeconds: 5 },
  { id: "b", startSeconds: 5, endSeconds: 12 },
];
console.log(assignRangeToBeat(1, 4, offsets));   // → a, 1..4
console.log(assignRangeToBeat(4, 9, offsets));   // → b (3s overlap beats 1s), 0..4
console.log(assignRangeToBeat(11.9, 20, offsets)); // → b, clamped near end
console.log(assignRangeToBeat(50, 60, offsets)); // → null (no overlap)
```

Run: `npx tsx tmp-check.ts` → verify the four outcomes, then `rm tmp-check.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts src/lib/shot-beat-mapping.ts
git commit -m "feat(v4-p2): deprecate absolute shot bounds; add shot-beat mapping helpers"
```

---

## Task 2: Beat text edit via the revoice endpoint

**Files:**
- Modify: `src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts`

**Interfaces:**
- Produces: `POST /api/projects/:id/beats/:beatId/revoice` now accepts an **optional** JSON body `{ text?: string }`. When present: trimmed, 1–2000 chars, replaces `beats.text` before voicing. Response unchanged: the updated beat row + `voUrl`. Consumed by the script strip (Task 9) and inspector (Task 11).

- [ ] **Step 1: Parse and validate the optional body**

In the POST handler, after the beat lookup (`const beat = rows[idx];`) and before the `voiceId` line, insert:

```typescript
  // Optional body: { text } — edit the beat's words, then re-voice.
  // An empty/absent body means "re-voice the existing text".
  let newText: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { text?: unknown };
      if (body.text !== undefined) {
        if (typeof body.text !== "string") {
          return badRequestResponse("text must be a string");
        }
        const trimmed = body.text.trim();
        if (trimmed.length === 0) {
          return badRequestResponse("text cannot be empty");
        }
        if (trimmed.length > 2000) {
          return badRequestResponse("text too long (max 2000 characters)");
        }
        newText = trimmed;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }

  const effectiveText = newText ?? beat.text;
```

- [ ] **Step 2: Persist the text with the generating status, voice the new text**

Replace:

```typescript
  await db.update(beats).set({ voStatus: "generating" }).where(eq(beats.id, beatId));
```

with:

```typescript
  await db
    .update(beats)
    .set({ voStatus: "generating", ...(newText ? { text: newText } : {}) })
    .where(eq(beats.id, beatId));
```

and in the `generateBeatVoiceover({ ... })` call change `text: beat.text,` to `text: effectiveText,`.

- [ ] **Step 3: Verify types + curl**

Run: `npx tsc --noEmit` (scoped grep from Task 1 note) and `npm run lint`.
With the dev server running and a browser session, from the project page devtools console:

```javascript
await fetch(`/api/projects/${PID}/beats/${BID}/revoice`, {
  method: "POST", headers: {"Content-Type":"application/json"},
  body: JSON.stringify({ text: "A brand new line of narration for this beat." }),
}).then(r => r.json());
```

Expected: beat returns with the new `text`, `voStatus: "done"`, fresh `voUrl`, changed `voDurationSeconds`. Also verify `{ text: "" }` → 400 and a 2001-char string → 400.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts"
git commit -m "feat(v4-p2): revoice endpoint accepts edited beat text"
```

---

## Task 3: Legacy shot adoption endpoint (+ run it)

**Files:**
- Create: `src/app/api/projects/[id]/shots/adopt-beats/route.ts`

**Interfaces:**
- Consumes: `assignRangeToBeat` (Task 1), `computeBeatOffsets` (Phase 1).
- Produces: `POST /api/projects/:id/shots/adopt-beats` → `{ adopted: number, skipped: number, dropped: number }`. Idempotent: shots that already have `beatId` are skipped; shots that cannot be mapped (no overlap even after rescale) are deleted (`dropped`) — they pointed at audio that no longer exists.

- [ ] **Step 1: Create the endpoint**

Create `src/app/api/projects/[id]/shots/adopt-beats/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/shots/adopt-beats
 * One-time v3.0 → v4.0 migration for a project's shots: rescales each
 * legacy shot's absolute [startSeconds, endSeconds] (measured against the
 * old continuous voiceover) onto the new beat timeline and stores
 * beatId + startInBeat/endInBeat. Idempotent — shots that already have a
 * beatId are left untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";
import { assignRangeToBeat } from "@/lib/shot-beat-mapping";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));
  if (beatRows.length === 0) {
    return badRequestResponse("Generate beats before adopting shots");
  }

  const offsets = computeBeatOffsets(beatRows);
  const newTotal = totalDurationSeconds(beatRows);

  const shotRows = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id));

  // Old timeline length: prefer the recorded continuous-VO duration, fall
  // back to the furthest shot end. Guard against zero.
  const maxShotEnd = shotRows.reduce((m, s) => Math.max(m, s.endSeconds ?? 0), 0);
  const oldTotal = project.durationSeconds || maxShotEnd;
  if (!oldTotal || newTotal <= 0) {
    return badRequestResponse("Nothing to adopt: no legacy timing available");
  }
  const scale = newTotal / oldTotal;

  let adopted = 0;
  let skipped = 0;
  let dropped = 0;

  for (const shot of shotRows) {
    if (shot.beatId) {
      skipped++;
      continue;
    }
    if (shot.startSeconds == null || shot.endSeconds == null) {
      dropped++;
      await db.delete(shots).where(eq(shots.id, shot.id));
      continue;
    }
    const mapped = assignRangeToBeat(
      shot.startSeconds * scale,
      shot.endSeconds * scale,
      offsets,
    );
    if (!mapped) {
      dropped++;
      await db.delete(shots).where(eq(shots.id, shot.id));
      continue;
    }
    await db
      .update(shots)
      .set({
        beatId: mapped.beatId,
        startInBeat: mapped.startInBeat,
        endInBeat: mapped.endInBeat,
      })
      .where(eq(shots.id, shot.id));
    adopted++;
  }

  console.log(
    `[shots/adopt-beats] project ${id}: adopted=${adopted} skipped=${skipped} dropped=${dropped} (scale=${scale.toFixed(3)})`,
  );
  return NextResponse.json({ adopted, skipped, dropped });
}
```

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit` (scoped) and `npm run lint`. Expect clean for this file.

- [ ] **Step 3: Run the adoption for the existing project**

From the signed-in browser console on the project page:

```javascript
await fetch(`/api/projects/${PID}/shots/adopt-beats`, { method: "POST" }).then(r => r.json());
```

Expected: `{ adopted: 84, skipped: 0, dropped: 0 }` (or a small `dropped` count for shots past the old timeline end). Re-run → `{ adopted: 0, skipped: 84, ... }` (idempotent). Spot-check in psql:

```sql
SELECT count(*) FILTER (WHERE beat_id IS NULL) AS unadopted,
       count(*) FILTER (WHERE start_in_beat IS NULL) AS missing_offsets
FROM shots;
-- expect 0 | 0
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/projects/[id]/shots/adopt-beats/route.ts"
git commit -m "feat(v4-p2): adopt legacy absolute shots onto the beat timeline"
```

---

## Task 4: Beat-relative shot CRUD

**Files:**
- Rewrite: `src/app/api/projects/[id]/shots/route.ts` (POST create)
- Rewrite: `src/app/api/projects/[id]/shots/[shotId]/route.ts` (PATCH/DELETE)
- Rewrite: `src/app/api/projects/[id]/shots/[shotId]/split/route.ts`

**Interfaces:**
- Produces (consumed by the store, Task 6):
  - `POST /shots` body `{ beatId: string; startInBeat: number; endInBeat: number; imagePrompt: string; motionPrompt?: string }` → 201 raw shot row.
  - `PATCH /shots/:shotId` body any of `{ startInBeat?: number; endInBeat?: number; imagePrompt?: string; motionPrompt?: string }` → 200 raw shot row.
  - `POST /shots/:shotId/split` body `{ atInBeat: number }` → `{ left, right }` shot rows (right inherits prompts + asset paths).
  - `DELETE /shots/:shotId` → `{ ok: true }` (unchanged).
- Rules: `beatId` must belong to the project; `0 ≤ startInBeat < endInBeat ≤ beat.voDurationSeconds + 0.05`; a shot's `[startInBeat, endInBeat)` must not overlap another shot **in the same beat**; `shots.text` is no longer written (narration is the beat's text); legacy `startSeconds/endSeconds` are no longer written.

- [ ] **Step 1: Rewrite the create route**

Replace the body of `src/app/api/projects/[id]/shots/route.ts` with:

```typescript
/**
 * POST /api/projects/[id]/shots
 * Creates a shot inside a beat (v4.0 beat-relative model). The shot is a
 * sub-range [startInBeat, endInBeat) of its beat's audio; it must not
 * overlap another shot in the same beat.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { MIN_SHOT_SECONDS } from "@/lib/shot-beat-mapping";

type Params = { params: Promise<{ id: string }> };

const DEFAULT_MOTION_PROMPT =
  "the subject holds its pose while the scene breathes — faint ambient motion, minimal camera drift";

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  let body: {
    beatId: string;
    startInBeat: number;
    endInBeat: number;
    imagePrompt: string;
    motionPrompt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (typeof body.beatId !== "string" || !isValidUUID(body.beatId)) {
    return badRequestResponse("Invalid beatId");
  }
  // Cross-table authorization: the beat must belong to this project.
  const [beat] = await db
    .select()
    .from(beats)
    .where(and(eq(beats.id, body.beatId), eq(beats.projectId, id)))
    .limit(1);
  if (!beat) return badRequestResponse("beatId does not belong to this project");

  const beatDur = beat.voDurationSeconds ?? 0;
  if (
    typeof body.startInBeat !== "number" ||
    typeof body.endInBeat !== "number" ||
    !Number.isFinite(body.startInBeat) ||
    !Number.isFinite(body.endInBeat) ||
    body.startInBeat < 0 ||
    body.endInBeat - body.startInBeat < MIN_SHOT_SECONDS ||
    body.endInBeat > beatDur + 0.05
  ) {
    return badRequestResponse("Invalid startInBeat/endInBeat for this beat");
  }
  if (!body.imagePrompt || body.imagePrompt.trim().length === 0) {
    return badRequestResponse("imagePrompt is required");
  }

  // Overlap check against shots in the SAME beat only.
  const siblings = await db
    .select()
    .from(shots)
    .where(and(eq(shots.projectId, id), eq(shots.beatId, body.beatId)));
  const overlap = siblings.find(
    (s) =>
      s.startInBeat != null &&
      s.endInBeat != null &&
      s.startInBeat < body.endInBeat &&
      s.endInBeat > body.startInBeat,
  );
  if (overlap) {
    return badRequestResponse("Shot overlaps an existing shot in this beat");
  }

  const [created] = await db
    .insert(shots)
    .values({
      projectId: id,
      beatId: body.beatId,
      sortOrder: siblings.length,
      startInBeat: body.startInBeat,
      endInBeat: body.endInBeat,
      imagePrompt: body.imagePrompt.trim(),
      motionPrompt: body.motionPrompt?.trim() || DEFAULT_MOTION_PROMPT,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
```

- [ ] **Step 2: Rewrite PATCH in the single-shot route**

In `src/app/api/projects/[id]/shots/[shotId]/route.ts`: remove the `deriveVOText` import; replace the PATCH body-handling block (from `let body: Partial<...>` through the `updates.text` assignment) with:

```typescript
  let body: Partial<{
    startInBeat: number;
    endInBeat: number;
    imagePrompt: string;
    motionPrompt: string;
  }>;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const updates: Record<string, unknown> = {};
  const boundsChanged =
    body.startInBeat !== undefined || body.endInBeat !== undefined;

  if (boundsChanged) {
    if (!shot.beatId) return badRequestResponse("Shot has no beat — run adopt-beats first");
    const [beat] = await db
      .select()
      .from(beats)
      .where(and(eq(beats.id, shot.beatId), eq(beats.projectId, id)))
      .limit(1);
    if (!beat) return notFoundResponse();

    const beatDur = beat.voDurationSeconds ?? 0;
    const newStart = body.startInBeat ?? shot.startInBeat ?? 0;
    const newEnd = body.endInBeat ?? shot.endInBeat ?? beatDur;
    if (
      !Number.isFinite(newStart) ||
      !Number.isFinite(newEnd) ||
      newStart < 0 ||
      newEnd - newStart < MIN_SHOT_SECONDS ||
      newEnd > beatDur + 0.05
    ) {
      return badRequestResponse("Invalid bounds for this beat");
    }

    const siblings = await db
      .select()
      .from(shots)
      .where(and(eq(shots.projectId, id), eq(shots.beatId, shot.beatId)));
    const overlap = siblings.find(
      (s) =>
        s.id !== shotId &&
        s.startInBeat != null &&
        s.endInBeat != null &&
        s.startInBeat < newEnd &&
        s.endInBeat > newStart,
    );
    if (overlap) return badRequestResponse("Bounds overlap another shot in this beat");

    updates.startInBeat = newStart;
    updates.endInBeat = newEnd;
  }
```

Add imports: `beats` from schema and `MIN_SHOT_SECONDS` from `@/lib/shot-beat-mapping`. The imagePrompt/motionPrompt handling, empty-update guard, update+return, and DELETE handler stay as they are.

- [ ] **Step 3: Rewrite the split route**

In `src/app/api/projects/[id]/shots/[shotId]/split/route.ts`: remove `deriveVOText`; body becomes `{ atInBeat: number }`; replace validation + the two writes with:

```typescript
  let body: { atInBeat: number };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  const at = body.atInBeat;
  const start = shot.startInBeat;
  const end = shot.endInBeat;
  if (start == null || end == null || !shot.beatId) {
    return badRequestResponse("Shot has no beat — run adopt-beats first");
  }
  if (
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    at < start + MIN_HALF_SECONDS ||
    at > end - MIN_HALF_SECONDS
  ) {
    return badRequestResponse(
      `atInBeat must be between ${(start + MIN_HALF_SECONDS).toFixed(2)} and ${(end - MIN_HALF_SECONDS).toFixed(2)}`,
    );
  }

  const [left] = await db
    .update(shots)
    .set({ endInBeat: at })
    .where(eq(shots.id, shotId))
    .returning();

  const [right] = await db
    .insert(shots)
    .values({
      projectId: id,
      beatId: shot.beatId,
      sortOrder: shot.sortOrder + 1,
      startInBeat: at,
      endInBeat: end,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      imagePath: shot.imagePath,
      imageStatus: shot.imageStatus,
      clipPath: shot.clipPath,
      clipStatus: shot.clipStatus,
    })
    .returning();

  return NextResponse.json({ left, right });
```

Change `const MIN_HALF_SECONDS = 1;` to `const MIN_HALF_SECONDS = 0.25;` (beat-relative ranges are sub-10s; 1s halves are too coarse).

- [ ] **Step 4: Verify with curl**

`npx tsc --noEmit` (scoped) + `npm run lint`. Then in the browser console: create a shot in a known beat, PATCH its bounds to overlap a sibling (expect 400), PATCH valid bounds (200), split it (200, two rows), create with a `beatId` from a *different* project id if one exists — expect 400 (authorization check). Delete one (200).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/projects/[id]/shots/route.ts" "src/app/api/projects/[id]/shots/[shotId]/route.ts" "src/app/api/projects/[id]/shots/[shotId]/split/route.ts"
git commit -m "feat(v4-p2): shot CRUD moves to beat-relative offsets"
```

---

## Task 5: Per-beat shot recommendation

**Files:**
- Modify: `src/lib/shot-recommendation.ts` (new entry point; keep `splitScriptDeterministic`, the Claude tool, and the system prompt)
- Modify: `src/app/api/projects/[id]/shots/recommend/route.ts`

**Interfaces:**
- Consumes: `Beat` rows (Phase 1), `splitScriptDeterministic(script, maxChars)` (existing, already exported).
- Produces: `recommendShotsForBeats(input: { beats: Array<{ id: string; text: string; voDurationSeconds: number | null }>; styleString?: string | null }): Promise<Array<{ beatId: string; startInBeat: number; endInBeat: number; imagePrompt: string; motionPrompt: string }>>`. The route replaces all existing shots with the result (existing behavior).

- [ ] **Step 1: Add the per-beat entry point to the lib**

In `src/lib/shot-recommendation.ts`, delete the old `RecommendedShot`, `assignTimings`, and `recommendShots` (the route is their only caller and is updated in the same task) and add:

```typescript
export interface BeatRecommendedShot {
  beatId: string;
  startInBeat: number;
  endInBeat: number;
  imagePrompt: string;
  motionPrompt: string;
}

interface BeatsInput {
  beats: Array<{ id: string; text: string; voDurationSeconds: number | null }>;
  styleString?: string | null;
}

/**
 * v4.0 recommendation: fragments are computed per beat (a beat longer than
 * MAX_SHOT_SECONDS is split into ~equal sub-shots at punctuation), offsets
 * are proportional to character position within the beat, and Claude
 * writes one image prompt per fragment exactly as before.
 */
export async function recommendShotsForBeats(
  input: BeatsInput,
): Promise<BeatRecommendedShot[]> {
  // 1. Deterministic per-beat fragmenting.
  const placed: Array<{ beatId: string; startInBeat: number; endInBeat: number; text: string }> = [];
  for (const beat of input.beats) {
    const dur = beat.voDurationSeconds ?? 0;
    if (dur <= 0 || beat.text.trim().length === 0) continue;
    const charsPerSecond = beat.text.length / dur;
    const maxChars = Math.max(20, Math.floor(charsPerSecond * MAX_SHOT_SECONDS));
    const fragments = splitScriptDeterministic(beat.text, maxChars);
    let charCursor = 0;
    for (const frag of fragments) {
      const pos = beat.text.indexOf(frag, charCursor);
      const startChar = pos >= 0 ? pos : charCursor;
      const endChar = startChar + frag.length;
      charCursor = endChar;
      placed.push({
        beatId: beat.id,
        startInBeat: (startChar / beat.text.length) * dur,
        endInBeat: (endChar / beat.text.length) * dur,
        text: frag,
      });
    }
  }
  if (placed.length === 0) throw new Error("No voiced beats to recommend shots for");

  // 2. One image prompt per fragment (unchanged Claude call).
  const fullScript = input.beats.map((b) => b.text).join(" ");
  const fragmentTexts = placed.map((p) => p.text);
  const tStart = Date.now();
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 16000,
    system: buildSystemPrompt(fullScript, input.styleString),
    tools: [PROMPTS_TOOL],
    tool_choice: { type: "tool", name: "save_image_prompts" },
    messages: [
      {
        role: "user",
        content: `Here are ${fragmentTexts.length} voiceover fragments. Return an array of ${fragmentTexts.length} image prompts in the same order.\n\n${JSON.stringify(fragmentTexts, null, 2)}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  console.log(
    `[shot-recommend] Claude returned | stop=${response.stop_reason} | ${((Date.now() - tStart) / 1000).toFixed(1)}s | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens generating image prompts — very long script.");
  }
  const saveToolUse = response.content.find(
    (b) => b.type === "tool_use" && b.name === "save_image_prompts",
  );
  if (!saveToolUse || saveToolUse.type !== "tool_use") {
    throw new Error("Claude didn't call save_image_prompts");
  }
  const { image_prompts: rawPrompts } = saveToolUse.input as { image_prompts: string[] };
  if (!rawPrompts || rawPrompts.length !== fragmentTexts.length) {
    console.warn(
      `[shot-recommend] prompt count mismatch — got ${rawPrompts?.length ?? 0}, expected ${fragmentTexts.length}. Using fallback for missing.`,
    );
  }

  return placed.map((p, i) => {
    const raw = rawPrompts?.[i];
    const imagePrompt =
      typeof raw === "string" && raw.trim().length > 0
        ? raw
        : `A cinematic still capturing the moment: ${p.text.slice(0, 80)}`;
    return {
      beatId: p.beatId,
      startInBeat: p.startInBeat,
      endInBeat: p.endInBeat,
      imagePrompt,
      motionPrompt: DEFAULT_MOTION_PROMPT,
    };
  });
}
```

Update the file's header comment to describe the per-beat model.

- [ ] **Step 2: Update the recommend route**

In `src/app/api/projects/[id]/shots/recommend/route.ts`: import `beats` + `asc`, import `recommendShotsForBeats`. Replace the script/duration guard and the try block's first half with:

```typescript
  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));
  const voiced = beatRows.filter((b) => b.voStatus === "done" && b.voDurationSeconds);
  if (voiced.length === 0) {
    return badRequestResponse("Voice the script into beats before recommending shots");
  }

  try {
    const recommended = await recommendShotsForBeats({
      beats: voiced.map((b) => ({
        id: b.id,
        text: b.text,
        voDurationSeconds: b.voDurationSeconds,
      })),
      styleString: project.styleString,
    });

    // Replace existing shots for this project.
    await db.delete(shots).where(eq(shots.projectId, id));

    const rows = recommended.map((r, i) => ({
      projectId: id,
      beatId: r.beatId,
      sortOrder: i,
      startInBeat: r.startInBeat,
      endInBeat: r.endInBeat,
      imagePrompt: r.imagePrompt,
      motionPrompt: r.motionPrompt,
    }));

    const inserted = await db.insert(shots).values(rows).returning();
```

Rest of the route unchanged.

- [ ] **Step 3: Verify end-to-end**

`npx tsc --noEmit` — from this task on it must be green **except** errors inside `editor-prototype.tsx` / `project-workspace.tsx` / `step-editor.tsx` / `page.tsx` (UI not yet rewritten; they still read fields that are now nullable). `npm run lint`.
Browser console: `POST /shots/recommend` → expect ~40–70 shots, every row with `beatId` set and `endInBeat ≤` its beat's duration (+0.05). psql spot-check:

```sql
SELECT count(*) FROM shots s JOIN beats b ON s.beat_id = b.id
WHERE s.end_in_beat > b.vo_duration_seconds + 0.05;  -- expect 0
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/shot-recommendation.ts "src/app/api/projects/[id]/shots/recommend/route.ts"
git commit -m "feat(v4-p2): shot recommendation works per beat"
```

---

## Task 6: Editor store (shared state, one source of truth)

**Files:**
- Create: `src/components/editor/editor-store.tsx`

**Interfaces:**
- Consumes: `computeBeatOffsets`, `totalDurationSeconds` (Phase 1); the API contracts from Tasks 2 and 4.
- Produces (consumed by every editor component):

```typescript
// Types
export interface EditorBeat {   // beat row + presigned url + computed offsets
  id: string; sortOrder: number; text: string;
  voStatus: string; voDurationSeconds: number | null; voUrl: string | null;
  startSeconds: number; endSeconds: number;   // computed, kept fresh by the reducer
}
export interface EditorShot {
  id: string; beatId: string | null; sortOrder: number;
  startInBeat: number | null; endInBeat: number | null;
  imagePrompt: string; motionPrompt: string;
  imagePath: string | null; imageStatus: string; imageUrl: string | null;
  clipPath: string | null; clipStatus: string; clipUrl: string | null;
  clipDurationSeconds: number | null;
}
export type EditorView = "timeline" | "storyboard";
export type EditorSelection =
  | { type: "beat"; beatId: string }
  | { type: "shot"; shotId: string }
  | { type: "gap"; beatId: string; startInBeat: number; endInBeat: number }
  | null;

// Hook + provider
export function EditorProvider(props: { projectId: string; initialBeats: EditorBeat[]; initialShots: EditorShot[]; children: React.ReactNode }): JSX.Element;
export function useEditor(): {
  projectId: string;
  beats: EditorBeat[]; shots: EditorShot[];
  totalDuration: number;
  view: EditorView; setView(v: EditorView): void;
  selection: EditorSelection; select(s: EditorSelection): void;
  // async actions (all optimistic where sensible, all revert on failure)
  revoiceBeat(beatId: string, text?: string): Promise<void>;
  createShot(beatId: string, startInBeat: number, endInBeat: number, imagePrompt: string, motionPrompt?: string): Promise<void>;
  updateShot(shotId: string, patch: Partial<Pick<EditorShot, "startInBeat" | "endInBeat" | "imagePrompt" | "motionPrompt">>): Promise<void>;
  deleteShot(shotId: string): Promise<void>;
  splitShot(shotId: string, atInBeat: number): Promise<void>;
  generateImage(shotId: string): Promise<void>;
  generateClip(shotId: string, model?: "ltx" | "hailuo"): Promise<void>;
  recommendShots(): Promise<void>;
  recommending: boolean;
};
export function beatColor(index: number): { block: string; textUnderline: string };
export function absoluteShotRange(shot: EditorShot, beats: EditorBeat[]): { start: number; end: number } | null;
```

- [ ] **Step 1: Create the store**

Create `src/components/editor/editor-store.tsx`. Implementation notes the code must follow — the reducer recomputes every beat's `startSeconds/endSeconds` (via `computeBeatOffsets`) whenever beats change, so a re-voiced beat's new duration ripples automatically; API mutations mirror the fetch patterns currently in `editor-prototype.tsx` (plain `fetch`, `console.warn` on failure, state revert on non-OK):

```tsx
/**
 * Unified-editor shared store (v4.0 Pillar A/B).
 * One React context owns beats, shots, selection, and view; Timeline,
 * Storyboard, Script strip, and Inspector are all renderers of this state
 * — the spec §5 "two views over one source of truth" invariant. All API
 * mutations live here so no view talks to the network directly.
 */
"use client";

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  useState,
} from "react";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";

/* …types exactly as in the Interfaces block above… */

interface State {
  beats: EditorBeat[];
  shots: EditorShot[];
  view: EditorView;
  selection: EditorSelection;
}

type Action =
  | { type: "setBeats"; beats: EditorBeat[] }
  | { type: "patchBeat"; beatId: string; patch: Partial<EditorBeat> }
  | { type: "setShots"; shots: EditorShot[] }
  | { type: "addShot"; shot: EditorShot }
  | { type: "patchShot"; shotId: string; patch: Partial<EditorShot> }
  | { type: "removeShot"; shotId: string }
  | { type: "setView"; view: EditorView }
  | { type: "select"; selection: EditorSelection };

function withOffsets(beats: EditorBeat[]): EditorBeat[] {
  const offsets = computeBeatOffsets(beats);
  const byId = new Map(offsets.map((o) => [o.id, o]));
  return [...beats]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => ({
      ...b,
      startSeconds: byId.get(b.id)?.startSeconds ?? 0,
      endSeconds: byId.get(b.id)?.endSeconds ?? 0,
    }));
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "setBeats":
      return { ...state, beats: withOffsets(action.beats) };
    case "patchBeat":
      return {
        ...state,
        beats: withOffsets(
          state.beats.map((b) => (b.id === action.beatId ? { ...b, ...action.patch } : b)),
        ),
      };
    case "setShots":
      return { ...state, shots: action.shots };
    case "addShot":
      return { ...state, shots: [...state.shots, action.shot] };
    case "patchShot":
      return {
        ...state,
        shots: state.shots.map((s) => (s.id === action.shotId ? { ...s, ...action.patch } : s)),
      };
    case "removeShot":
      return {
        ...state,
        shots: state.shots.filter((s) => s.id !== action.shotId),
        selection:
          state.selection?.type === "shot" && state.selection.shotId === action.shotId
            ? null
            : state.selection,
      };
    case "setView":
      return { ...state, view: action.view };
    case "select":
      return { ...state, selection: action.selection };
  }
}
```

Then the provider: initialize `useReducer` with `withOffsets(initialBeats)` + `initialShots`; implement each action as a `useCallback` that dispatches an optimistic patch, `fetch`es, merges the JSON response on OK (spread-merge so client-only `imageUrl`/`clipUrl`/`voUrl` survive — same trick as `editor-prototype.tsx` uses today), and reverts/logs on failure. `revoiceBeat` sets `voStatus: "generating"` optimistically, POSTs `{ text }` (or empty body) to `/beats/{id}/revoice`, then patches the returned beat (including new `voUrl` + duration → offsets ripple). `generateImage`/`generateClip`/`deleteShot`/`splitShot` port their logic verbatim from `editor-prototype.tsx` (`generateShotImage`, `generateShotClip`, `deleteShot`, `splitShot`) with `startSeconds` maths removed. `recommendShots` ports `handleRecommendShots` from `project-workspace.tsx` and `setShots` with the response. Finally:

```tsx
const BEAT_HUES = [258, 38, 152, 205, 328, 96]; // purple, amber, green, blue, pink, lime — mockup palette

export function beatColor(index: number) {
  const h = BEAT_HUES[index % BEAT_HUES.length];
  return {
    block: `hsl(${h} 45% 38%)`,
    textUnderline: `hsl(${h} 70% 55%)`,
  };
}

export function absoluteShotRange(shot: EditorShot, beats: EditorBeat[]) {
  if (!shot.beatId || shot.startInBeat == null || shot.endInBeat == null) return null;
  const beat = beats.find((b) => b.id === shot.beatId);
  if (!beat) return null;
  return { start: beat.startSeconds + shot.startInBeat, end: beat.startSeconds + shot.endInBeat };
}
```

`useEditor()` throws if used outside the provider (standard context guard).

- [ ] **Step 2: Verify + commit**

`npx tsc --noEmit` (green except the three not-yet-rewritten UI files) and `npm run lint`.

```bash
git add src/components/editor/editor-store.tsx
git commit -m "feat(v4-p2): shared editor store — beats/shots single source of truth"
```

---

## Task 7: Sequential beat playback hook

**Files:**
- Create: `src/components/editor/use-beat-playback.ts`

**Interfaces:**
- Consumes: `EditorBeat[]` (Task 6) — needs `voUrl`, `startSeconds`, `endSeconds`.
- Produces: `useBeatPlayback(beats: EditorBeat[]): { playing: boolean; playheadSeconds: number; play(fromSeconds?: number): void; pause(): void; seek(seconds: number): void }` — consumed by the shell (preview sync), timeline (playhead), and script strip (click-to-seek).

- [ ] **Step 1: Create the hook**

```typescript
/**
 * Sequential per-beat audio playback (v4.0). The timeline has no single
 * master audio file any more — each beat owns a clip. This hook plays
 * beat N and chains into beat N+1 on `ended`, exposing one global
 * playhead in absolute timeline seconds. The next beat's clip is
 * preloaded while the current one plays so seams stay tight.
 */
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { EditorBeat } from "@/components/editor/editor-store";

export function useBeatPlayback(beats: EditorBeat[]) {
  const [playing, setPlaying] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const beatIndexRef = useRef(0);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const playBeat = useCallback(
    (index: number, offsetInBeat: number) => {
      const list = beatsRef.current;
      const beat = list[index];
      if (!beat) {
        setPlaying(false);
        return;
      }
      if (!beat.voUrl) {
        // Unvoiced beat: skip forward.
        playBeat(index + 1, 0);
        return;
      }
      stopAudio();
      beatIndexRef.current = index;
      const a = new Audio(beat.voUrl);
      audioRef.current = a;
      a.currentTime = offsetInBeat;
      a.ontimeupdate = () => setPlayheadSeconds(beat.startSeconds + a.currentTime);
      a.onended = () => playBeat(index + 1, 0);
      a.play().catch(() => setPlaying(false));
      // Preload the next beat's audio for a tight seam.
      const next = list[index + 1];
      if (next?.voUrl) {
        const pre = new Audio(next.voUrl);
        pre.preload = "auto";
      }
    },
    [stopAudio],
  );

  const findBeatAt = useCallback((seconds: number) => {
    const list = beatsRef.current;
    const i = list.findIndex((b) => seconds >= b.startSeconds && seconds < b.endSeconds);
    return i === -1 ? (seconds <= 0 ? 0 : list.length) : i;
  }, []);

  const play = useCallback(
    (fromSeconds?: number) => {
      const from = fromSeconds ?? playheadSeconds;
      const i = findBeatAt(from);
      const beat = beatsRef.current[i];
      setPlaying(true);
      setPlayheadSeconds(from);
      playBeat(i, beat ? Math.max(0, from - beat.startSeconds) : 0);
    },
    [findBeatAt, playBeat, playheadSeconds],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const total = beatsRef.current.at(-1)?.endSeconds ?? 0;
      const t = Math.max(0, Math.min(seconds, total));
      setPlayheadSeconds(t);
      if (playing) {
        const i = findBeatAt(t);
        const beat = beatsRef.current[i];
        playBeat(i, beat ? t - beat.startSeconds : 0);
      } else {
        stopAudio();
      }
    },
    [playing, findBeatAt, playBeat, stopAudio],
  );

  useEffect(() => () => stopAudio(), [stopAudio]);

  return { playing, playheadSeconds, play, pause, seek };
}
```

- [ ] **Step 2: Verify + commit**

`npx tsc --noEmit` (same scoping) + `npm run lint`.

```bash
git add src/components/editor/use-beat-playback.ts
git commit -m "feat(v4-p2): sequential per-beat playback hook"
```

---

## Task 8: Timeline view (two-layer)

**Files:**
- Create: `src/components/editor/timeline-view.tsx`

**Interfaces:**
- Consumes: `useEditor()` (Task 6) and playback props `{ playheadSeconds, onSeek }` passed from the shell.
- Produces: `<TimelineView playheadSeconds={number} onSeek={(s: number) => void} />`.

Layout per mockup 01: labeled rows `BEATS` / `SHOTS` / `VOICE` + a ruler on top and a red playhead across all rows.

- [ ] **Step 1: Create the component**

Port constants and interaction machinery from `editor-prototype.tsx` (`PX_PER_SECOND = 14`, `xToSeconds`, ruler rendering, playhead drag, window-level `mousemove/mouseup` drag effect, keyboard S/Del handler) with these changes:

- **BEATS row** (height 40px): one block per beat at `left = beat.startSeconds * PX_PER_SECOND`, `width = (endSeconds - startSeconds) * PX_PER_SECOND`, background `beatColor(index).block`, label `Beat {sortOrder + 1} · {first 4 words of text}`, a `Loader2` spinner overlay when `voStatus === "generating"`, red left border when `"failed"`. Click → `select({ type: "beat", beatId })`.
- **SHOTS row** (height 110px, unchanged): shot blocks positioned by `absoluteShotRange(shot, beats)`; skip shots where it returns null. Drag-move and both trim handles operate in absolute px but persist beat-relative: on drag-end compute `newStartInBeat = clamp(absStart - beat.startSeconds, 0, beatDur)` (same for end) and call `updateShot(shotId, { startInBeat, endInBeat })` — movement is clamped to the shot's own beat (cross-beat drag is deferred, Global Constraints). Click empty row space → derive the gap **within the beat under the cursor**: gap = the largest free sub-range of that beat containing the click (compute from siblings' offsets), then `select({ type: "gap", beatId, startInBeat, endInBeat })`.
- **VOICE row** (height 40px): one slim bar per beat (same x-geometry as the beat block, blue like the current VO bar) so audio visibly stops/starts with beats.
- Keyboard: `S` split → `splitShot(selectedShot.id, playheadSeconds - beatStart)` when the playhead is ≥ `MIN_HALF` inside the selected shot; `Del` delete — both via store actions.
- Ruler click / playhead drag → `onSeek(xToSeconds(...))`.

All state comes from `useEditor()`; this component holds only drag-interaction state. Keep it under ~350 lines by extracting nothing — it is one cohesive view.

- [ ] **Step 2: Verify + commit**

`npx tsc --noEmit` + `npm run lint` (component compiles standalone; it is mounted in Task 11).

```bash
git add src/components/editor/timeline-view.tsx
git commit -m "feat(v4-p2): two-layer beat/shot timeline view"
```

---

## Task 9: Inline script strip

**Files:**
- Create: `src/components/editor/script-strip.tsx`

**Interfaces:**
- Consumes: `useEditor()` — `beats`, `selection`, `select`, `revoiceBeat`; props `{ onSeek: (s: number) => void }`.
- Produces: `<ScriptStrip onSeek={...} />` — the mockup's "SCRIPT — EDIT IN PLACE, RE-VOICES ONLY THE BEAT YOU TOUCH" band.

- [ ] **Step 1: Create the component**

```tsx
/**
 * Inline editable script (v4.0 Pillar B). Renders every beat's text as a
 * flowing paragraph of segments, each underlined in its beat's accent
 * color. Click a segment → seek + select the beat; double-click → edit in
 * a textarea; committing a change re-voices ONLY that beat.
 */
"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useEditor, beatColor } from "@/components/editor/editor-store";

export function ScriptStrip({ onSeek }: { onSeek: (s: number) => void }) {
  const { beats, selection, select, revoiceBeat } = useEditor();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = async (beatId: string, original: string) => {
    setEditingId(null);
    const next = draft.trim();
    if (next.length === 0 || next === original) return;
    if (next.length > 2000) return; // mirror the server cap
    await revoiceBeat(beatId, next);
  };

  return (
    <div className="rounded border bg-muted/20 p-3 text-sm leading-7">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Script — edit in place, re-voices only the beat you touch
      </p>
      <p>
        {beats.map((beat, i) =>
          editingId === beat.id ? (
            <textarea
              key={beat.id}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(beat.id, beat.text)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit(beat.id, beat.text);
                }
                if (e.key === "Escape") setEditingId(null);
              }}
              rows={2}
              maxLength={2000}
              className="my-1 w-full rounded border bg-background p-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span
              key={beat.id}
              onClick={() => {
                select({ type: "beat", beatId: beat.id });
                onSeek(beat.startSeconds);
              }}
              onDoubleClick={() => {
                setEditingId(beat.id);
                setDraft(beat.text);
              }}
              title="Click to select · double-click to edit (re-voices this beat)"
              className={`cursor-pointer rounded-sm px-0.5 transition-colors hover:bg-muted ${
                selection?.type === "beat" && selection.beatId === beat.id ? "bg-muted" : ""
              }`}
              style={{
                boxShadow: `inset 0 -2px 0 ${beatColor(i).textUnderline}`,
              }}
            >
              {beat.text}{" "}
              {beat.voStatus === "generating" && (
                <Loader2 className="inline h-3 w-3 animate-spin text-muted-foreground" />
              )}
              {beat.voStatus === "failed" && (
                <span className="text-[10px] text-destructive">(voice failed — see inspector)</span>
              )}
            </span>
          ),
        )}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify + commit**

`npx tsc --noEmit` + `npm run lint`.

```bash
git add src/components/editor/script-strip.tsx
git commit -m "feat(v4-p2): inline editable script strip with per-beat revoice"
```

---

## Task 10: Storyboard view

**Files:**
- Create: `src/components/editor/storyboard-view.tsx`

**Interfaces:**
- Consumes: `useEditor()` — beats, shots, selection, select, generateImage, generateClip.
- Produces: `<StoryboardView />` per mockup 02: responsive card grid (`grid gap-4 sm:grid-cols-2 xl:grid-cols-3`), one card per shot ordered by `(beat.sortOrder, startInBeat)`.

- [ ] **Step 1: Create the component**

Each card (use shadcn `Card`):
- **Thumbnail band** (aspect-video): `clipUrl` → looping muted `<video>`; else `imageUrl` → `<img>`; else the status placeholder. Status badge top-right: `imageStatus`/`clipStatus` roll-up — `generating` (amber, spinner) if either is generating, `failed` (red) if either failed, `ready` (green check) if image is done, else `pending` chip.
- **Meta line:** `Shot {n} · Beat {beat.sortOrder + 1}` left, absolute `m:ss–m:ss` right (from `absoluteShotRange`, format helper inline).
- **DESCRIPTION (VISUAL)** — `shot.imagePrompt` (label styled like the mockup: tiny uppercase, accent color).
- **SCRIPT (NARRATION)** — the parent beat's `text` in quotes, clamped to 3 lines (`line-clamp-3`).
- **Actions row:** `Re-image` (→ `generateImage(shot.id)`, disabled while generating) and `Clip` (→ `generateClip(shot.id)`, disabled until `imagePath` exists); a failed card swaps these for `Retry` (re-runs whichever failed) and `Edit` (→ `select({ type: "shot", shotId })` — prompts are edited in the inspector, same data, two views).
- Card click (not buttons) → `select({ type: "shot", shotId })` so the inspector follows.
- Header strip above the grid: `{shots.length} shots · {done}/{shots.length} imaged · {failed} failed` (computed counts — the Phase 3 queue will replace this).

- [ ] **Step 2: Verify + commit**

`npx tsc --noEmit` + `npm run lint`.

```bash
git add src/components/editor/storyboard-view.tsx
git commit -m "feat(v4-p2): storyboard card view over the shared store"
```

---

## Task 11: Inspector, unified shell, workspace rewiring

**Files:**
- Create: `src/components/editor/inspector.tsx`
- Create: `src/components/editor/unified-editor.tsx`
- Rewrite: `src/components/project-workspace.tsx`
- Modify: `src/app/projects/[id]/page.tsx` (load beats; pass through)
- Delete: `src/components/step-script.tsx`, `src/components/step-editor.tsx`, `src/components/editor-prototype.tsx`

**Interfaces:**
- Consumes: everything above; `VoiceSelector` (existing); `GET /beats` (Phase 1) response shape `{ beats: [{...beat, voUrl, startSeconds, endSeconds}] }`; `POST /beats/generate`; `POST /script/generate`; `POST /shots/adopt-beats` (Task 3).
- Produces: `<UnifiedEditor projectId script voiceId initialBeats initialShots onVoiceChange />` mounted as stepper step 2; `ShotData` type export moves from `project-workspace.tsx` to the store — update the import in any file that still references it.

- [ ] **Step 1: Inspector**

`src/components/editor/inspector.tsx` — renders by `selection`:
- `shot` → port `ShotEditPanel` from `editor-prototype.tsx` nearly verbatim (image/clip preview toggle, prompt textareas with blur-persist via `updateShot`, AI-suggest buttons calling the existing `suggest-image`/`suggest-motion` endpoints **with `voText` = the parent beat's text**, generate image/clip/hailuo buttons, split/delete). Time badge shows the beat-relative range (`{startInBeat.toFixed(1)}–{endInBeat.toFixed(1)}s in beat {n}`).
- `beat` → beat panel: full text (read-only preview), voice status badge, `Re-voice` button (→ `revoiceBeat(beatId)`) for failed/stale audio, `▶ Play this beat` (→ `onSeek(beat.startSeconds)` + play), and hint copy "Double-click the script text above to edit the words."
- `gap` → port `GapCreateForm` (voText = parent beat text; create calls `createShot(beatId, startInBeat, endInBeat, imagePrompt, motionPrompt)`).
- `null` → the playhead-shot preview (port `ActiveShotPreview`).

- [ ] **Step 2: Unified shell**

`src/components/editor/unified-editor.tsx`:

```
<EditorProvider projectId initialBeats initialShots>
  <TopBar>   view toggle (Timeline | Storyboard) · "{beats} beats · {shots} shots" ·
             total m:ss · Play/Stop (useBeatPlayback) · VoiceSelector · Recommend shots
  <div flex> LeftRail (w-56, "Cast & Locations" heading + muted copy:
             "Recurring characters & places get reference sheets that keep
             every shot on-model. Arrives with the Reference Bible (F-16).")
             │ Center: video preview (port the preview-video sync effects from
             │   editor-prototype.tsx, driven by playheadShot = shot whose
             │   absoluteShotRange contains playheadSeconds)
             │   → <ScriptStrip onSeek={seek} />
             │   → view === "timeline" ? <TimelineView playheadSeconds onSeek/> : <StoryboardView/>
             │ Right: <Inspector playheadSeconds onSeek/> (w-[22rem], sticky)
</EditorProvider>
```

The shell also owns the **gates** (replacing `step-editor.tsx`):
1. No `script` → "Generate script" card (ports `handleGenerateScript` from the old workspace: `POST /script/generate`, then continue to gate 2). Regenerating an existing script is intentionally NOT offered once beats exist — beats own the text (spec §6).
2. Script but no beats → "Voice the script" card with `VoiceSelector` + button → `POST /beats/generate` (30–90s progress state), then fetch `GET /beats` and enter the editor.
3. Beats exist but any shot has `beatId === null` → auto-call `POST /shots/adopt-beats` once on mount, then refresh shots via `router.refresh()`.

- [ ] **Step 3: Rewire the workspace + page**

`project-workspace.tsx` — now three steps: **Concept → Style → Editor**. Keep the brief/style state + handlers exactly as they are; delete script/voiceover/shot state and handlers (they live in the store/shell now); `steps` array becomes 3 entries (Editor completed when `initialBeats.length > 0 && initialShots.length > 0`); step 2 renders `<UnifiedEditor projectId={project.id} script={project.script} voiceId={voiceId} initialBeats={initialBeats} initialShots={initialShots} onVoiceChange={handleVoiceChange} />`. `containerMax` widens on step 2. Move the `ShotData` interface into the store as `EditorShot` and update imports.

`page.tsx` — add the beats query alongside shots (mirror `GET /beats`: order by `sortOrder`, presign `voPath` → `voUrl`, attach `startSeconds/endSeconds` via `computeBeatOffsets`) and pass `initialBeats` through. Keep the legacy `voiceoverUrl` lines for now (Task 12 removes them).

Delete `step-script.tsx`, `step-editor.tsx`, `editor-prototype.tsx`.

- [ ] **Step 4: Full e2e check**

`npx tsc --noEmit` → **fully green now**. `npm run lint` → clean. Dev server + signed-in browser:
1. Project loads directly into the editor (script + beats exist) with 39 beat blocks, adopted shots, script strip colored.
2. Play → audio chains across ≥3 beats, playhead moves continuously, preview swaps clips.
3. Double-click a beat's text, change a word, Enter → spinner on that beat only → new audio, later beat blocks shift.
4. Toggle Storyboard → same shots as cards; click a card → inspector shows it; back to Timeline → still selected (shared store).
5. Click a gap in a beat → create a shot → appears in both views; trim it; split it; delete it.
6. Generate image on one shot → thumbnail appears in timeline block, storyboard card, and inspector.

- [ ] **Step 5: Commit**

```bash
git add -A src/components src/app/projects
git commit -m "feat(v4-p2): unified directing editor — one screen, two views, inspector"
```

---

## Task 12: Legacy teardown, verification, docs

**Files:**
- Modify: `src/lib/db/schema.ts` — drop `projects.voiceoverPath/voiceoverStatus/voiceoverTimestamps/durationSeconds` and `shots.startSeconds/endSeconds/text`
- Delete: `src/app/api/projects/[id]/voiceover/generate/route.ts`, `src/lib/voiceover-generation.ts`, `src/lib/vo-text.ts`
- Modify: `src/app/projects/[id]/page.tsx`, `src/components/project-workspace.tsx` — remove dead VO props
- Docs: `docs/feature05/feature.md`, `docs/feature08/feature.md`, `docs/feature03/feature.md`, `docs/feature08/testcase-v4-phase2.md` (new), `docs/feature08/security-review.md` (new), `docs/backlog.md`, `docs/superpowers/plans/2026-06-13-v4-unified-editor-roadmap.md`, `product-requirement.md`

**PRECONDITION:** adopt-beats (Task 3) has been run for every project that has shots — verify with the Task 3 psql query before pushing the schema (the drop is destructive for unadopted rows' timing).

- [ ] **Step 1: Drop the columns and dead code**

Schema: remove the four `projects` VO fields (keep `voiceId` — still used) and the three deprecated `shots` columns with their comments. Delete the three dead files. Fix every resulting tsc error — expected sites: `page.tsx` (voiceoverUrl presign + props), `project-workspace.tsx` (prop types), possibly `restore/route.ts` or others revealed by tsc; do NOT silence errors, remove the dead reads. Run `npm run db:push` (confirm the destructive prompt for the dropped columns), then `npx tsc --noEmit` green + `npm run lint` clean.

- [ ] **Step 2: Re-run the e2e pass from Task 11 Step 4**

All six checks must still pass — proves the editor runs entirely on beats with the legacy model gone.

- [ ] **Step 3: Security review + docs (CLAUDE.md workflow steps 5–7)**

- Run an **independent security review** of the phase's diff against `security-playbook.md` (fresh agent; checklist: authN on every route, ownership joins, the `beatId`-belongs-to-project checks in Tasks 3/4, input validation incl. the 2000-char text cap, rate limits, CSRF, generic errors, no secrets). Record findings + resolutions in `docs/feature08/security-review.md` (append a "v4.0 Phase 2" section to the existing file).
- `docs/feature08/testcase-v4-phase2.md`: acceptance criteria + expected outcomes + edge cases for: beat text edit (revoice one beat; empty/2001-char rejected), ripple after duration change, shot create/trim/split within beat (overlap + bounds rejections), cross-project beatId rejected, adoption idempotency, playback chaining incl. unvoiced-beat skip, view toggle state sharing.
- Update feature docs: `feature05` (beat VO is now the implementation — banner content moves into the body), `feature08` (unified editor is current; two views; store), `feature03` (script step folded in; keep generation-in-setup description). Update the roadmap table (Phase 2 ✅, plan file linked) and PRD §3 v4.0 note (Phase 2 shipped). Add a backlog entry: "drop-deferred: cross-beat shot drag + beat add/split/merge UI (spec §8.1)".

- [ ] **Step 4: Pre-commit checklist (CLAUDE.md) then commit**

Walk the mandatory checklist (no secrets; auth on every mutation; inputs validated; explicit errors; functions <150 LOC; no dead code — the deleted files; pattern consistency). Then:

```bash
git add -A
git commit -m "feat(v4-p2): retire continuous-VO model; Phase 2 docs, tests, security review"
```

---

## Self-Review (against the spec)

- **Spec §4 Pillar A** (one screen: rail/center/inspector) → T11. "Generate all" explicitly deferred to Phase 3 (roadmap). Rail is a placeholder per Phase 4 dependency note ("Phase 2 (UI rail)").
- **Spec §4 Pillar B** (beat = narration unit owning audio; shots under beats; text edit re-voices one beat; visual re-cut touches no audio) → T2 (revoice text), T4 (shot CRUD without audio), T8/T9.
- **Spec §5** (two renderers, one store, no sync layer) → T6 store; T8/T10 views; e2e check 4 verifies.
- **Spec §6** (offsets within beat; absolute computed; projects VO fields removed; `text` derived) → T1, T4, T12.
- **Spec §7 voiceover** rules already shipped in Phase 1; recommend flow adapted in T5.
- **Spec §8 deferred items** stay deferred — re-segmentation policy honored (edit inside a beat keeps it one beat, T9), no multi-entity work, backlog entry added in T12.
- **Spec §9 migration** (segment existing script — done in Phase 1; recompute shot offsets relative to beats; preserve images/clips) → T3 preserves asset paths; split (T4) carries paths to both halves.
- **Type consistency check:** `startInBeat`/`endInBeat` (schema, T4 routes, T6 `EditorShot`, T8 drag persistence, T10 ordering) — consistent. `revoiceBeat(beatId, text?)` matches T2's optional body. `assignRangeToBeat` consumed with `BeatOffset[]` in T3/T5 — consistent with Phase 1's export.
