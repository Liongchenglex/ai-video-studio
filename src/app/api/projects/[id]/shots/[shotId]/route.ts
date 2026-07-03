/**
 * PATCH  /api/projects/[id]/shots/[shotId] — update bounds and/or prompts
 * DELETE /api/projects/[id]/shots/[shotId] — remove a shot
 *
 * PATCH validates bounds against the anchor-beat spillover model: the shot
 * must start inside its (possibly re-anchored) beat, may spill past it, and
 * must not overlap any other shot on the timeline (absolute ranges).
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
import { MIN_SHOT_SECONDS, shotAbsoluteRange } from "@/lib/shot-beat-mapping";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string; shotId: string }> };

async function loadOwnedProjectAndShot(projectId: string, shotId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project || project.deletedAt) return { project: null, shot: null };

  const [shot] = await db
    .select()
    .from(shots)
    .where(and(eq(shots.id, shotId), eq(shots.projectId, projectId)))
    .limit(1);
  return { project, shot: shot ?? null };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const { project, shot } = await loadOwnedProjectAndShot(id, shotId, session.user.id);
  if (!project || !shot) return notFoundResponse();

  let body: Partial<{
    beatId: string;
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
    body.beatId !== undefined ||
    body.startInBeat !== undefined ||
    body.endInBeat !== undefined;

  if (boundsChanged) {
    // A bounds change may re-anchor the shot: dragging its start into a
    // different beat sends the new anchor's beatId along with the offsets.
    if (body.beatId !== undefined && (typeof body.beatId !== "string" || !isValidUUID(body.beatId))) {
      return badRequestResponse("Invalid beatId");
    }
    const anchorId = body.beatId ?? shot.beatId;
    if (!anchorId) return badRequestResponse("Shot has no anchor beat");

    const beatRows = await db
      .select()
      .from(beats)
      .where(eq(beats.projectId, id))
      .orderBy(asc(beats.sortOrder));
    const offsets = computeBeatOffsets(beatRows);
    const anchor = offsets.find((o) => o.id === anchorId);
    // Cross-table authorization: the anchor must belong to this project.
    if (!anchor) return badRequestResponse("beatId does not belong to this project");

    const anchorDur = anchor.endSeconds - anchor.startSeconds;
    const timelineEnd = totalDurationSeconds(beatRows);
    const newStart = body.startInBeat ?? shot.startInBeat ?? 0;
    const newEnd = body.endInBeat ?? shot.endInBeat ?? anchorDur;
    if (
      !Number.isFinite(newStart) ||
      !Number.isFinite(newEnd) ||
      newStart < 0 ||
      newStart >= anchorDur || // the shot must START inside its anchor
      newEnd - newStart < MIN_SHOT_SECONDS ||
      anchor.startSeconds + newEnd > timelineEnd + 0.05
    ) {
      return badRequestResponse("Invalid bounds for this beat");
    }

    // Overlap check against every other shot on the timeline (absolute
    // ranges) — shots can span beats.
    const offsetById = new Map(offsets.map((o) => [o.id, o]));
    const absStart = anchor.startSeconds + newStart;
    const absEnd = anchor.startSeconds + newEnd;
    const others = await db
      .select()
      .from(shots)
      .where(eq(shots.projectId, id));
    const overlap = others.find((s) => {
      if (s.id === shotId) return false;
      const r = shotAbsoluteRange(s, offsetById);
      return r !== null && r.start < absEnd && r.end > absStart;
    });
    if (overlap) return badRequestResponse("Bounds overlap another shot");

    updates.beatId = anchorId;
    updates.startInBeat = newStart;
    updates.endInBeat = newEnd;
  }

  if (body.imagePrompt !== undefined) {
    if (typeof body.imagePrompt !== "string") {
      return badRequestResponse("imagePrompt must be a string");
    }
    const p = body.imagePrompt.trim();
    if (p.length === 0) return badRequestResponse("imagePrompt cannot be empty");
    if (p.length > 2000) {
      return badRequestResponse("imagePrompt too long (max 2000 characters)");
    }
    updates.imagePrompt = p;
  }
  if (body.motionPrompt !== undefined) {
    if (typeof body.motionPrompt !== "string") {
      return badRequestResponse("motionPrompt must be a string");
    }
    const p = body.motionPrompt.trim();
    if (p.length === 0) return badRequestResponse("motionPrompt cannot be empty");
    if (p.length > 2000) {
      return badRequestResponse("motionPrompt too long (max 2000 characters)");
    }
    updates.motionPrompt = p;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(shots)
    .set(updates)
    .where(eq(shots.id, shotId))
    .returning();

  // sortOrder is not maintained after bounds changes — the UI and API GET
  // order by startInBeat, so a stale sortOrder is harmless.

  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const { project, shot } = await loadOwnedProjectAndShot(id, shotId, session.user.id);
  if (!project || !shot) return notFoundResponse();

  await db.delete(shots).where(eq(shots.id, shotId));
  return NextResponse.json({ ok: true });
}
