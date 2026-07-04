/**
 * POST /api/projects/[id]/entities/extract
 * Claude auto-extract + auto-tag for the Reference Bible (F-16, v4.0).
 *
 * Flow: load the project's beats (joined script text), existing entities,
 * and all shots with their spanned-beat narration (anchor-beat spillover
 * model, computed server-side — mirrors beatsSpanned in editor-store.tsx) ->
 * extractEntities(script, existingNames) — the pre-insert existing entity
 * names are passed so Claude's prompt excludes them (and their aliases) from
 * re-proposal -> insert entities whose lowercased name isn't already present
 * (exact-string dedup as a second-layer safety net; sheets are NOT generated
 * here — explicit per-entity, Task 2) -> tagShots(...) -> overwrite
 * referencedEntityIds only for the shots the tagger actually returned an
 * entry for.
 *
 * Response: { entities, taggedShots, created, skipped, shotTags } where
 * shotTags is { [shotId]: string[] } — the entity-id arrays written per
 * tagged shot, so the client store can update without refetching (Task 5).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats, entities, shots } from "@/lib/db/schema";
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
import { computeBeatOffsets, type BeatOffset } from "@/lib/beat-timing";
import { shotAbsoluteRange } from "@/lib/shot-beat-mapping";
import { extractEntities, tagShots, type TaggableEntity } from "@/lib/entity-extraction";

type Params = { params: Promise<{ id: string }> };

type BeatRow = typeof beats.$inferSelect;
type ShotRow = typeof shots.$inferSelect;

/**
 * A shot's narration = joined text of every beat overlapping its absolute
 * range (anchor offset + startInBeat/endInBeat), skipping zero-duration
 * (unvoiced) beats — the server twin of beatsSpanned in editor-store.tsx.
 */
function computeShotNarration(
  shot: ShotRow,
  beatRows: BeatRow[],
  offsetById: Map<string, BeatOffset>,
): string {
  const range = shotAbsoluteRange(shot, offsetById);
  if (!range) return "";
  const spanned = beatRows.filter((b) => {
    const off = offsetById.get(b.id);
    if (!off) return false;
    return off.endSeconds > off.startSeconds && off.startSeconds < range.end && off.endSeconds > range.start;
  });
  return spanned
    .map((b) => b.text)
    .join(" ")
    .trim();
}

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

  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const existingEntities = await db
    .select()
    .from(entities)
    .where(eq(entities.projectId, id))
    .orderBy(asc(entities.createdAt));

  const shotRows = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id))
    .orderBy(asc(shots.sortOrder));

  const fullScript = beatRows
    .map((b) => b.text)
    .join(" ")
    .trim();

  let created = 0;
  let skipped = 0;
  const tagMap = new Map<string, string[]>();
  let allEntities = existingEntities;

  if (fullScript.length > 0) {
    try {
      const existingNames = existingEntities.map((e) => e.name);
      const extracted = await extractEntities(fullScript, existingNames);

      const nameSeen = new Set(existingEntities.map((e) => e.name.trim().toLowerCase()));
      const inserted: (typeof entities.$inferSelect)[] = [];
      for (const ext of extracted) {
        const lower = ext.name.toLowerCase();
        if (nameSeen.has(lower)) {
          skipped += 1;
          continue;
        }
        nameSeen.add(lower);
        const [row] = await db
          .insert(entities)
          .values({
            projectId: id,
            name: ext.name,
            type: ext.type,
            description: ext.description.length > 0 ? ext.description : null,
          })
          .returning();
        inserted.push(row);
      }
      created = inserted.length;
      allEntities = [...existingEntities, ...inserted];

      if (allEntities.length > 0 && shotRows.length > 0) {
        const offsets = computeBeatOffsets(beatRows);
        const offsetById = new Map(offsets.map((o) => [o.id, o]));

        const taggableEntities: TaggableEntity[] = allEntities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
        }));
        const taggableShots = shotRows.map((s) => ({
          id: s.id,
          imagePrompt: s.imagePrompt,
          narration: computeShotNarration(s, beatRows, offsetById),
        }));

        const result = await tagShots(taggableEntities, taggableShots);
        for (const [shotId, entityIds] of result) {
          tagMap.set(shotId, entityIds);
          await db.update(shots).set({ referencedEntityIds: entityIds }).where(eq(shots.id, shotId));
        }
      }
    } catch (err) {
      console.error(`Entity auto-extract/tag failed for project ${id}:`, err);
      return NextResponse.json({ error: "Auto-extract failed" }, { status: 502 });
    }
  }

  // shotCount reflects the just-applied tagging: shots the tagger returned
  // use the fresh ids; every other shot keeps its prior referencedEntityIds.
  const shotCountById = new Map<string, number>();
  for (const s of shotRows) {
    const ids = tagMap.get(s.id) ?? s.referencedEntityIds ?? [];
    for (const entityId of ids) {
      shotCountById.set(entityId, (shotCountById.get(entityId) ?? 0) + 1);
    }
  }

  const withUrls = await Promise.all(
    allEntities.map(async (e) => ({
      ...e,
      referenceSheetUrl: e.referenceSheetPath ? await getDownloadUrl(e.referenceSheetPath) : null,
      shotCount: shotCountById.get(e.id) ?? 0,
    })),
  );

  return NextResponse.json({
    entities: withUrls,
    taggedShots: tagMap.size,
    created,
    skipped,
    shotTags: Object.fromEntries(tagMap),
  });
}
