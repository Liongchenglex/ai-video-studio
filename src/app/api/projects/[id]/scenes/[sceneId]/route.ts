/**
 * PATCH  /api/projects/[id]/scenes/[sceneId] — update scene fields inline
 * DELETE /api/projects/[id]/scenes/[sceneId] — remove a scene
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
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

type Params = { params: Promise<{ id: string; sceneId: string }> };

async function verifyOwnership(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return project && !project.deletedAt ? project : null;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  if (!await verifyOwnership(id, session.user.id)) return notFoundResponse();

  let body: { voiceover?: string; sceneDescription?: string; imagePrompt?: string; durationSeconds?: number };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const updates: Record<string, unknown> = {};

  if (body.voiceover !== undefined) {
    const v = body.voiceover.trim();
    if (v.length === 0) return badRequestResponse("Voiceover cannot be empty");
    if (v.length > 5000) return badRequestResponse("Voiceover must be under 5000 characters");
    updates.voiceover = v;
  }
  if (body.sceneDescription !== undefined) {
    const d = body.sceneDescription.trim();
    if (d.length === 0) return badRequestResponse("Scene description cannot be empty");
    if (d.length > 2000) return badRequestResponse("Scene description must be under 2000 characters");
    updates.sceneDescription = d;
  }
  if (body.imagePrompt !== undefined) {
    const p = body.imagePrompt.trim();
    if (p.length === 0) return badRequestResponse("Image prompt cannot be empty");
    if (p.length > 2000) return badRequestResponse("Image prompt must be under 2000 characters");
    updates.imagePrompt = p;
  }
  if (body.durationSeconds !== undefined) {
    if (body.durationSeconds < 1 || body.durationSeconds > 120) {
      return badRequestResponse("Duration must be between 1 and 120 seconds");
    }
    updates.durationSeconds = body.durationSeconds;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(scenes)
    .set(updates)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .returning();

  if (!updated) return notFoundResponse();

  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  if (!await verifyOwnership(id, session.user.id)) return notFoundResponse();

  const [deleted] = await db
    .delete(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .returning();

  if (!deleted) return notFoundResponse();

  // Re-number remaining scenes
  const remaining = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].sortOrder !== i) {
      await db.update(scenes).set({ sortOrder: i }).where(eq(scenes.id, remaining[i].id));
    }
  }

  return NextResponse.json({ message: "Scene deleted" });
}
