/**
 * PATCH  /api/projects/[id]/shots/[shotId] — update bounds and/or prompts
 * DELETE /api/projects/[id]/shots/[shotId] — remove a shot
 *
 * PATCH validates overlaps against other shots in the same beat when
 * bounds change (v4.0 beat-relative model).
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

  if (body.imagePrompt !== undefined) {
    const p = body.imagePrompt.trim();
    if (p.length === 0) return badRequestResponse("imagePrompt cannot be empty");
    updates.imagePrompt = p;
  }
  if (body.motionPrompt !== undefined) {
    const p = body.motionPrompt.trim();
    if (p.length === 0) return badRequestResponse("motionPrompt cannot be empty");
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
