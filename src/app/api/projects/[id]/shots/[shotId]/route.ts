/**
 * PATCH  /api/projects/[id]/shots/[shotId] — update bounds and/or prompts
 * DELETE /api/projects/[id]/shots/[shotId] — remove a shot
 *
 * PATCH validates overlaps and re-derives cached VO text when bounds change.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
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
import { deriveVOText } from "@/lib/vo-text";

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
    startSeconds: number;
    endSeconds: number;
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
    body.startSeconds !== undefined || body.endSeconds !== undefined;

  if (boundsChanged) {
    const newStart = body.startSeconds ?? shot.startSeconds;
    const newEnd = body.endSeconds ?? shot.endSeconds;
    if (newStart < 0 || newEnd <= newStart) {
      return badRequestResponse("Invalid bounds");
    }

    // Overlap check against other shots
    const others = await db
      .select()
      .from(shots)
      .where(eq(shots.projectId, id));
    const overlap = others.find(
      (s) => s.id !== shotId && s.startSeconds < newEnd && s.endSeconds > newStart,
    );
    if (overlap) {
      return badRequestResponse(
        `Bounds overlap shot at ${overlap.startSeconds}s–${overlap.endSeconds}s`,
      );
    }

    updates.startSeconds = newStart;
    updates.endSeconds = newEnd;
    // Re-derive cached VO text for the new range
    if (project.script && project.durationSeconds) {
      updates.text = deriveVOText(project.script, project.durationSeconds, newStart, newEnd);
    }
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
  // order by startSeconds, so a stale sortOrder is harmless.

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
