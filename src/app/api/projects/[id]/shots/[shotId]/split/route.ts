/**
 * POST /api/projects/[id]/shots/[shotId]/split
 * Body: { atInBeat } — offset relative to the shot's ANCHOR beat.
 * Splits a shot in two. Both halves inherit the prompts and image/clip
 * paths of the original. Shots may span beats (anchor-beat spillover), so
 * the right half re-anchors to whichever beat contains the split point.
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
import { anchorForTime } from "@/lib/shot-beat-mapping";
import { computeBeatOffsets } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string; shotId: string }> };

const MIN_HALF_SECONDS = 0.25;

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const [shot] = await db
    .select()
    .from(shots)
    .where(and(eq(shots.id, shotId), eq(shots.projectId, id)))
    .limit(1);
  if (!shot) return notFoundResponse();

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
    return badRequestResponse("Shot has no anchor beat");
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

  // The right half starts at the split point, which may lie past the
  // original anchor's end — re-anchor it to the beat containing that time.
  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));
  const offsets = computeBeatOffsets(beatRows);
  const anchor = offsets.find((o) => o.id === shot.beatId);
  if (!anchor) return badRequestResponse("Shot has no anchor beat");
  const absSplit = anchor.startSeconds + at;
  const absEnd = anchor.startSeconds + end;
  const rightAnchor = anchorForTime(absSplit, offsets) ?? anchor;

  const [left] = await db
    .update(shots)
    .set({ endInBeat: at })
    .where(eq(shots.id, shotId))
    .returning();

  const [right] = await db
    .insert(shots)
    .values({
      projectId: id,
      beatId: rightAnchor.id,
      sortOrder: shot.sortOrder + 1,
      startInBeat: absSplit - rightAnchor.startSeconds,
      endInBeat: absEnd - rightAnchor.startSeconds,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      imagePath: shot.imagePath,
      imageStatus: shot.imageStatus,
      clipPath: shot.clipPath,
      clipStatus: shot.clipStatus,
    })
    .returning();

  return NextResponse.json({ left, right });
}
