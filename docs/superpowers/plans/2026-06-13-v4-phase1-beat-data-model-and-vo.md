# v4.0 Phase 1 — Beat Data Model + Per-Beat Voiceover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single continuous project voiceover with a **beat-based** model — each beat (one sentence/clause) owns its own text and its own ElevenLabs audio clip — and add the `entities` table + `shots` columns the rest of v4.0 needs.

**Architecture:** Additive migration first. Add `beats` and `entities` tables and new `shots` columns alongside the existing continuous-VO fields (which stay until Phase 2's editor cutover). A deterministic segmenter splits a project's prose `script` into beat texts at sentence/clause boundaries. A per-beat ElevenLabs service generates each beat's audio, passing the neighbouring beat texts as `previousText`/`nextText` (context-only, unbilled) so prosody chains smoothly. Timeline position is derived by stacking beat durations sequentially, not from absolute offsets into one file.

**Tech Stack:** Drizzle ORM + Neon Postgres, ElevenLabs JS SDK (`convertWithTimestamps`, `eleven_multilingual_v2`), Cloudflare R2 (`@aws-sdk/client-s3`), Next.js App Router route handlers.

**Spec:** [`docs/superpowers/specs/2026-06-13-unified-directing-editor-design.md`](../specs/2026-06-13-unified-directing-editor-design.md) (Pillars B & C, §6 data model). **Roadmap:** [`2026-06-13-v4-unified-editor-roadmap.md`](2026-06-13-v4-unified-editor-roadmap.md).

**Repo conventions:** No unit-test harness — verification is `npx tsc --noEmit`, `npm run db:push`, `npm run lint`, and manual curl/e2e. Helpers available: `getSession`, `unauthorizedResponse`, `notFoundResponse`, `badRequestResponse`, `isValidUUID`, `verifyCsrf`, `applyRateLimit` from `@/lib/api-utils`; `r2Client`, `getDownloadUrl` from `@/lib/r2`; `db` from `@/lib/db`.

---

## File Structure

```
src/
├── lib/
│   ├── db/schema.ts                  # MODIFY — add beats + entities tables, new shots columns
│   ├── beat-segmentation.ts          # CREATE — split prose script into beat texts
│   ├── beat-voiceover-generation.ts  # CREATE — per-beat ElevenLabs VO with prev/next context
│   └── beat-timing.ts                # CREATE — stack beat durations into absolute offsets
└── app/api/projects/[id]/beats/
    ├── generate/route.ts             # CREATE — POST: segment script + voice every beat
    ├── route.ts                      # CREATE — GET: list beats (with presigned URLs + offsets)
    └── [beatId]/revoice/route.ts     # CREATE — POST: regenerate one beat's VO
```

Legacy continuous-VO fields on `projects` and the absolute `shots.startSeconds`/`endSeconds` are **kept** in Phase 1; they are removed in Phase 2 once the editor reads beats.

---

## Task 1: Schema — beats table, entities table, shots columns

**Files:**
- Modify: `src/lib/db/schema.ts`

Adds the two new tables and the new `shots` columns. Additive only — nothing is dropped.

- [ ] **Step 1: Add the `doublePrecision` import**

In `src/lib/db/schema.ts`, update the import from `drizzle-orm/pg-core` to include `doublePrecision`:

```typescript
import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  pgEnum,
  jsonb,
  integer,
  doublePrecision,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Add the entity-type enum**

In `src/lib/db/schema.ts`, after the `projectStatusEnum` definition (around line 91), add:

```typescript
export const entityTypeEnum = pgEnum("entity_type", [
  "character",
  "location",
  "object",
]);
```

- [ ] **Step 3: Add the `beats` table**

At the end of `src/lib/db/schema.ts`, append:

```typescript
// ─── Beats (v4.0) ────────────────────────────────────────────────────
// A beat is one sentence/clause of narration. It owns its own text and
// its own voiceover audio clip. Beats stack sequentially: a beat's
// absolute start = sum of prior beats' voDurationSeconds. Shots are the
// visuals under a beat (see shots.beatId).

export const beats = pgTable(
  "beats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),

    // Narration text — source of truth for this beat's words.
    text: text("text").notNull(),

    // Per-beat voiceover audio.
    voPath: text("vo_path"),
    voStatus: generationStatusEnum("vo_status").default("pending"),
    voDurationSeconds: doublePrecision("vo_duration_seconds"),
    voTimestamps: jsonb("vo_timestamps").$type<{
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    }>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("beats_project_id_sort_order_idx").on(table.projectId, table.sortOrder),
  ],
);

export type Beat = typeof beats.$inferSelect;
export type NewBeat = typeof beats.$inferInsert;
```

- [ ] **Step 4: Add the `entities` table (Reference Bible — F-16)**

Append to `src/lib/db/schema.ts`:

```typescript
// ─── Entities / Reference Bible (F-16, v4.0) ─────────────────────────
// Recurring characters / locations / objects. Each has one multi-view
// reference-sheet image used to condition FLUX so the entity looks
// consistent across shots. Tagging lives on shots.referencedEntityIds.

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: entityTypeEnum("type").notNull(),
    description: text("description"),
    referenceSheetPath: text("reference_sheet_path"),
    referenceStatus: generationStatusEnum("reference_status").default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("entities_project_id_idx").on(table.projectId)],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
```

- [ ] **Step 5: Add the new `shots` columns**

In the `shots` table definition in `src/lib/db/schema.ts`, add these columns immediately after `clipDurationSeconds` (around line 204), before `createdAt`:

```typescript
    // ── v4.0: beat membership + sub-beat offsets ──
    // beatId is nullable during the additive migration; backfilled in Task 7.
    beatId: uuid("beat_id").references(() => beats.id, { onDelete: "cascade" }),
    startInBeat: doublePrecision("start_in_beat"),
    endInBeat: doublePrecision("end_in_beat"),

    // ── v4.0: Reference Bible tagging (F-16) ──
    referencedEntityIds: jsonb("referenced_entity_ids")
      .$type<string[]>()
      .default([]),
```

> Note: `beats` is declared after `shots` in the file, but Drizzle resolves the
> `references(() => beats.id, …)` thunk lazily, so forward order is fine.

- [ ] **Step 6: Push the schema and verify types**

Run: `npm run db:push`
Expected: drizzle-kit reports creating `beats`, `entities`, the `entity_type`
enum, and altering `shots` (4 new columns). Accept the changes.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema.ts
git commit -m "feat(v4-p1): add beats + entities tables and beat/entity columns on shots"
```

---

## Task 2: Beat segmentation utility

**Files:**
- Create: `src/lib/beat-segmentation.ts`

Splits a project's prose `script` into beat texts at sentence/clause boundaries. Never cuts mid-sentence (so per-beat audio seams fall on natural pauses). Merges slivers shorter than a floor into the previous beat so beats aren't two-word fragments.

- [ ] **Step 1: Create the segmenter**

Create `src/lib/beat-segmentation.ts`:

```typescript
/**
 * Beat segmentation (v4.0).
 * Splits a prose script into ordered "beat" texts — one sentence or major
 * clause each — at natural prosodic boundaries. Each beat becomes its own
 * voiceover clip, so cuts must land on punctuation (never mid-sentence) to
 * keep concatenation seams inaudible. Deterministic; no AI involved.
 */

/** Minimum characters for a standalone beat; shorter tails merge backwards. */
const MIN_BEAT_CHARS = 25;

/**
 * Splits `script` into beat texts in document order.
 * Boundaries: sentence terminators (. ! ?) and major clause marks (; : —),
 * each followed by whitespace or end-of-text. Whitespace is normalised and
 * surrounding spaces trimmed; the original wording is otherwise preserved.
 */
export function segmentIntoBeats(script: string): string[] {
  const normalised = script.replace(/\s+/g, " ").trim();
  if (normalised.length === 0) return [];

  // Split *after* a boundary mark + trailing space, keeping the mark with its
  // sentence. The capturing group keeps delimiters; we re-join mark+clause.
  const pieces = normalised.split(/([.!?;:—]+\s+)/);

  const raw: string[] = [];
  let current = "";
  for (const piece of pieces) {
    current += piece;
    // A piece that *is* a boundary delimiter closes the current beat.
    if (/[.!?;:—]+\s+$/.test(piece)) {
      raw.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length > 0) raw.push(current.trim());

  // Merge slivers (e.g. "Yes." or "But—") into the previous beat.
  const beats: string[] = [];
  for (const beat of raw) {
    if (
      beats.length > 0 &&
      beat.replace(/[.!?;:—\s]/g, "").length < MIN_BEAT_CHARS
    ) {
      beats[beats.length - 1] = `${beats[beats.length - 1]} ${beat}`.trim();
    } else {
      beats.push(beat);
    }
  }

  return beats;
}
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Sanity-check the output (temporary script)**

Create a throwaway file `scratch-seg.ts` at the repo root:

```typescript
import { segmentIntoBeats } from "./src/lib/beat-segmentation";
const demo =
  "In 206 BC, a peasant named Liu Bang rose against the Qin. He was no general — just a man with nerve and timing. Yes. Within four years, he would wear the emperor's crown.";
console.log(JSON.stringify(segmentIntoBeats(demo), null, 2));
```

Run: `npx tsx scratch-seg.ts` (or `npx ts-node scratch-seg.ts`)
Expected: 3 beats — the "Yes." sliver merges into the "He was no general…" beat;
no beat is split mid-sentence.

Delete the scratch file afterwards: `rm scratch-seg.ts`

- [ ] **Step 4: Commit**

```bash
git add src/lib/beat-segmentation.ts
git commit -m "feat(v4-p1): add deterministic beat segmenter (sentence/clause boundaries)"
```

---

## Task 3: Per-beat voiceover generation service

**Files:**
- Create: `src/lib/beat-voiceover-generation.ts`

Generates one beat's audio via ElevenLabs `convertWithTimestamps`, passing the neighbouring beat texts as `previousText`/`nextText` so prosody carries across the cut. Stores the clip in R2 at `projects/{projectId}/beats/{beatId}.mp3` and returns precise (fractional) duration. Mirrors the existing `src/lib/voiceover-generation.ts` (camelCase SDK fields).

- [ ] **Step 1: Create the service**

Create `src/lib/beat-voiceover-generation.ts`:

```typescript
/**
 * Per-beat voiceover generation (v4.0).
 * One short ElevenLabs clip per beat. previousText/nextText are passed as
 * CONTEXT ONLY (not re-voiced, not billed) so intonation and pacing carry
 * across beat boundaries — the key to seamless concatenation. Duration is
 * kept fractional for accurate sequential stacking on the timeline.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

export interface BeatVoiceoverTimestamps {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface GenerateBeatVoiceoverInput {
  projectId: string;
  beatId: string;
  text: string;
  voiceId: string;
  /** Preceding beat text, for prosody continuity (context only). */
  previousText?: string;
  /** Following beat text, for prosody continuity (context only). */
  nextText?: string;
}

interface GenerateBeatVoiceoverResult {
  r2Key: string;
  timestamps: BeatVoiceoverTimestamps;
  durationSeconds: number;
}

/**
 * Generates one beat's voiceover and stores it in R2.
 * Caller persists r2Key + timestamps + durationSeconds onto the beat row.
 */
export async function generateBeatVoiceover(
  input: GenerateBeatVoiceoverInput,
): Promise<GenerateBeatVoiceoverResult> {
  const result = await elevenlabs.textToSpeech.convertWithTimestamps(
    input.voiceId,
    {
      text: input.text,
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
      previousText: input.previousText,
      nextText: input.nextText,
    },
  );

  if (!result.audioBase64) {
    throw new Error("ElevenLabs returned no audio");
  }

  const audioBuffer = Buffer.from(result.audioBase64, "base64");

  const r2Key = `projects/${input.projectId}/beats/${input.beatId}.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  const timestamps: BeatVoiceoverTimestamps = {
    characters: result.alignment?.characters || [],
    character_start_times_seconds:
      result.alignment?.characterStartTimesSeconds || [],
    character_end_times_seconds:
      result.alignment?.characterEndTimesSeconds || [],
  };

  const endTimes = timestamps.character_end_times_seconds;
  const durationSeconds =
    endTimes.length > 0 ? endTimes[endTimes.length - 1] : 0;

  return { r2Key, timestamps, durationSeconds };
}
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors. (If the SDK rejects `previousText`/`nextText`, confirm the
installed `@elevenlabs/elevenlabs-js` version exposes them on
`convertWithTimestamps`; they are standard text-to-speech context fields.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/beat-voiceover-generation.ts
git commit -m "feat(v4-p1): add per-beat voiceover service with prosody-continuity context"
```

---

## Task 4: Sequential timing helper

**Files:**
- Create: `src/lib/beat-timing.ts`

Pure functions that turn per-beat durations into absolute timeline positions, and a shot's in-beat offset into an absolute time. No I/O.

- [ ] **Step 1: Create the helper**

Create `src/lib/beat-timing.ts`:

```typescript
/**
 * Beat timing (v4.0).
 * The timeline stacks beats sequentially: a beat's absolute start is the sum
 * of all prior beats' durations. These pure helpers convert per-beat
 * durations into absolute offsets used by the editor and exporter.
 */

export interface BeatLike {
  id: string;
  sortOrder: number;
  voDurationSeconds: number | null;
}

export interface BeatOffset {
  id: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Returns each beat's absolute [startSeconds, endSeconds] in sortOrder.
 * Beats with no measured duration yet contribute 0 length.
 */
export function computeBeatOffsets(beats: BeatLike[]): BeatOffset[] {
  const ordered = [...beats].sort((a, b) => a.sortOrder - b.sortOrder);
  const offsets: BeatOffset[] = [];
  let cursor = 0;
  for (const beat of ordered) {
    const dur = beat.voDurationSeconds ?? 0;
    offsets.push({ id: beat.id, startSeconds: cursor, endSeconds: cursor + dur });
    cursor += dur;
  }
  return offsets;
}

/** Total timeline duration = sum of beat durations. */
export function totalDurationSeconds(beats: BeatLike[]): number {
  return beats.reduce((sum, b) => sum + (b.voDurationSeconds ?? 0), 0);
}

/**
 * Absolute time of a shot given its parent beat's absolute start and the
 * shot's offset within the beat.
 */
export function absoluteShotTime(
  beatStartSeconds: number,
  offsetInBeat: number,
): number {
  return beatStartSeconds + offsetInBeat;
}
```

- [ ] **Step 2: Verify types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/beat-timing.ts
git commit -m "feat(v4-p1): add sequential beat-timing helpers"
```

---

## Task 5: Generate-beats endpoint (segment + voice all)

**Files:**
- Create: `src/app/api/projects/[id]/beats/generate/route.ts`

`POST` — the directing action for narration. Segments the project's `script` into beats, replaces any existing beats, then voices each beat in order (passing neighbour text for continuity). Returns the beats with presigned audio URLs and computed offsets.

- [ ] **Step 1: Create the endpoint**

Create `src/app/api/projects/[id]/beats/generate/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/beats/generate
 * Segments the project's prose script into beats and generates a voiceover
 * clip for each (in order, with previous/next context for smooth prosody).
 * Replaces any existing beats for the project. Auth + ownership enforced.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats } from "@/lib/db/schema";
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
import { getDownloadUrl } from "@/lib/r2";
import { segmentIntoBeats } from "@/lib/beat-segmentation";
import { generateBeatVoiceover } from "@/lib/beat-voiceover-generation";
import { computeBeatOffsets } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
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
  if (!project.script || project.script.trim().length === 0) {
    return badRequestResponse("Generate a script first");
  }

  const beatTexts = segmentIntoBeats(project.script);
  if (beatTexts.length === 0) {
    return badRequestResponse("Script produced no beats");
  }

  const voiceId = project.voiceId || "21m00Tcm4TlvDq8ikWAM";

  // Replace existing beats (regen semantics, mirrors recommend-shots).
  await db.delete(beats).where(eq(beats.projectId, id));

  // Insert all beats as pending so the rows (and ids) exist before voicing.
  const inserted = await db
    .insert(beats)
    .values(
      beatTexts.map((text, i) => ({
        projectId: id,
        sortOrder: i,
        text,
        voStatus: "generating" as const,
      })),
    )
    .returning();

  const ordered = [...inserted].sort((a, b) => a.sortOrder - b.sortOrder);

  // Voice each beat in order, with neighbour text as context (not billed).
  for (let i = 0; i < ordered.length; i++) {
    const beat = ordered[i];
    try {
      const result = await generateBeatVoiceover({
        projectId: id,
        beatId: beat.id,
        text: beat.text,
        voiceId,
        previousText: ordered[i - 1]?.text,
        nextText: ordered[i + 1]?.text,
      });
      await db
        .update(beats)
        .set({
          voPath: result.r2Key,
          voStatus: "done",
          voDurationSeconds: result.durationSeconds,
          voTimestamps: result.timestamps,
        })
        .where(eq(beats.id, beat.id));
    } catch (err) {
      console.error(`Beat voiceover failed for ${beat.id}:`, err);
      await db
        .update(beats)
        .set({ voStatus: "failed" })
        .where(eq(beats.id, beat.id));
    }
  }

  // Return fresh rows with presigned URLs + computed offsets.
  const finalBeats = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const offsets = computeBeatOffsets(finalBeats);
  const offsetById = new Map(offsets.map((o) => [o.id, o]));

  const withUrls = await Promise.all(
    finalBeats.map(async (b) => ({
      ...b,
      voUrl: b.voPath ? await getDownloadUrl(b.voPath) : null,
      startSeconds: offsetById.get(b.id)?.startSeconds ?? 0,
      endSeconds: offsetById.get(b.id)?.endSeconds ?? 0,
    })),
  );

  return NextResponse.json({ beats: withUrls });
}
```

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors for the new file.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/[id]/beats/generate/route.ts
git commit -m "feat(v4-p1): add POST /beats/generate — segment script + voice every beat"
```

---

## Task 6: List beats + re-voice a single beat

**Files:**
- Create: `src/app/api/projects/[id]/beats/route.ts`
- Create: `src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts`

`GET /beats` returns beats with presigned URLs + offsets (for the editor to load). `POST /beats/[beatId]/revoice` regenerates one beat's audio (with neighbour context) — the "fix one flat line" path.

- [ ] **Step 1: Create the list endpoint**

Create `src/app/api/projects/[id]/beats/route.ts`:

```typescript
/**
 * GET /api/projects/[id]/beats
 * Lists a project's beats in order, with presigned audio URLs and absolute
 * timeline offsets (stacked from per-beat durations). Auth + ownership.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { computeBeatOffsets } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
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

  const rows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const offsets = computeBeatOffsets(rows);
  const offsetById = new Map(offsets.map((o) => [o.id, o]));

  const withUrls = await Promise.all(
    rows.map(async (b) => ({
      ...b,
      voUrl: b.voPath ? await getDownloadUrl(b.voPath) : null,
      startSeconds: offsetById.get(b.id)?.startSeconds ?? 0,
      endSeconds: offsetById.get(b.id)?.endSeconds ?? 0,
    })),
  );

  return NextResponse.json({ beats: withUrls });
}
```

- [ ] **Step 2: Create the re-voice endpoint**

Create `src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/beats/[beatId]/revoice
 * Regenerates a single beat's voiceover, using its neighbour beats' text as
 * prosody context. Used to fix one line without re-voicing the whole script.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats } from "@/lib/db/schema";
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
import { getDownloadUrl } from "@/lib/r2";
import { generateBeatVoiceover } from "@/lib/beat-voiceover-generation";

type Params = { params: Promise<{ id: string; beatId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, beatId } = await params;
  if (!isValidUUID(id) || !isValidUUID(beatId)) {
    return badRequestResponse("Invalid ID");
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();

  // Load the project's beats in order to find this beat + its neighbours.
  const rows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const idx = rows.findIndex((b) => b.id === beatId);
  if (idx === -1) return notFoundResponse();

  const beat = rows[idx];
  const voiceId = project.voiceId || "21m00Tcm4TlvDq8ikWAM";

  await db.update(beats).set({ voStatus: "generating" }).where(eq(beats.id, beatId));

  try {
    const result = await generateBeatVoiceover({
      projectId: id,
      beatId,
      text: beat.text,
      voiceId,
      previousText: rows[idx - 1]?.text,
      nextText: rows[idx + 1]?.text,
    });
    const [updated] = await db
      .update(beats)
      .set({
        voPath: result.r2Key,
        voStatus: "done",
        voDurationSeconds: result.durationSeconds,
        voTimestamps: result.timestamps,
      })
      .where(eq(beats.id, beatId))
      .returning();

    return NextResponse.json({
      ...updated,
      voUrl: updated.voPath ? await getDownloadUrl(updated.voPath) : null,
    });
  } catch (err) {
    console.error(`Beat re-voice failed for ${beatId}:`, err);
    await db.update(beats).set({ voStatus: "failed" }).where(eq(beats.id, beatId));
    return NextResponse.json({ error: "Voiceover generation failed" }, { status: 502 });
  }
}
```

- [ ] **Step 3: Verify types and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run lint`
Expected: no errors for the new files.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/projects/[id]/beats/route.ts" "src/app/api/projects/[id]/beats/[beatId]/revoice/route.ts"
git commit -m "feat(v4-p1): add GET /beats and POST /beats/[beatId]/revoice"
```

---

## Task 7: End-to-end verification + backfill existing projects

No new code — exercises the foundation and migrates existing projects' scripts into beats. (The generate endpoint *is* the backfill: it segments the existing `script` and voices it.)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Confirm it boots with no type errors.

- [ ] **Step 2: Generate beats for a project that already has a script + voice**

In the browser, sign in and open an existing project that has a `script` and a
`voiceId`. Copy its project id from the URL. Then, from the browser devtools
console on that same origin (so the session cookie + Origin header are sent):

```javascript
await fetch(`/api/projects/${PROJECT_ID}/beats/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
}).then((r) => r.json());
```

Expected: a JSON `{ beats: [...] }` array. Verify:
- One beat per sentence/clause, in order, none split mid-sentence.
- Each beat has `voStatus: "done"`, a non-null `voUrl`, and a positive
  `voDurationSeconds`.
- `startSeconds`/`endSeconds` increase monotonically and are contiguous
  (each beat's `startSeconds` equals the previous beat's `endSeconds`).

- [ ] **Step 3: Listen to two consecutive beats for seam quality**

Open two consecutive `voUrl`s and play them back-to-back. Confirm the prosody
carries across the boundary (no jarring reset). If a seam is harsh, note the
beat — it usually means the segmenter cut at a weak boundary; revisit
`MIN_BEAT_CHARS` or the boundary regex in `beat-segmentation.ts`.

- [ ] **Step 4: Re-voice a single beat**

Pick a `beatId` from Step 2 and run in the console:

```javascript
await fetch(`/api/projects/${PROJECT_ID}/beats/${BEAT_ID}/revoice`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
}).then((r) => r.json());
```

Expected: the single beat returns `voStatus: "done"` with a fresh `voUrl`; other
beats are untouched.

- [ ] **Step 5: Backfill the rest**

Repeat Step 2 for each remaining existing project that has a script. (There is
no shared multi-project endpoint by design — backfill is per project and
explicit, so you can spot-check each.)

- [ ] **Step 6: Final verification commit (docs only, if anything was tuned)**

If Step 3 led you to tune `beat-segmentation.ts`, commit that:

```bash
git add src/lib/beat-segmentation.ts
git commit -m "fix(v4-p1): tune beat segmentation after seam review"
```

If nothing changed, there is nothing to commit — Phase 1 is complete.

---

## Self-Review (against the spec)

- **Spec §6 data model** — `beats` table ✅ (Task 1.3), `entities` table ✅
  (Task 1.4), `shots.beatId` + `startInBeat`/`endInBeat` + `referencedEntityIds`
  ✅ (Task 1.5). Legacy continuous-VO fields intentionally retained (additive
  migration; removed in Phase 2 — noted in File Structure).
- **Spec Pillar B — beat-based VO** — per-beat service ✅ (Task 3),
  `previous_text`/`next_text` continuity ✅ (Task 3 + Tasks 5/6 wiring),
  sentence-boundary segmentation ✅ (Task 2), sequential stacking ✅ (Task 4),
  cheap one-beat re-voice ✅ (Task 6).
- **Spec Pillar C — entities** — table only this phase (CRUD + reference
  generation are Phase 4). Intentional; the column/table must exist now so
  Phase 2's tagging UI and Phase 1's `shots` change line up.
- **Migration (spec §9)** — backfill via generate endpoint ✅ (Task 7).
- **Out of scope here:** editor UI, two views, batch image/clip generation,
  entity CRUD/conditioning — Phases 2–4.

**Type consistency check:** `generateBeatVoiceover` input/return shape is used
identically in Tasks 5 and 6; `BeatLike`/`computeBeatOffsets` consumed in Tasks
5 and 6; `voDurationSeconds` is `doublePrecision` (fractional) everywhere it is
read or summed. No name drift found.
