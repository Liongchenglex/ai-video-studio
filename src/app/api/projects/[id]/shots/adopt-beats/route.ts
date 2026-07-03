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
