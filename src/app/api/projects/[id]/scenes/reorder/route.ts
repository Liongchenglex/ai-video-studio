/**
 * PUT /api/projects/[id]/scenes/reorder
 * Reorders scenes by accepting an array of scene IDs in the desired order.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
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

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
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

  let body: { sceneIds: string[] };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!Array.isArray(body.sceneIds) || body.sceneIds.length === 0) {
    return badRequestResponse("sceneIds array is required");
  }

  for (const sceneId of body.sceneIds) {
    if (!isValidUUID(sceneId)) {
      return badRequestResponse("Invalid scene ID in array");
    }
  }

  // Verify all scene IDs belong to this project
  const existingScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id));

  const existingIds = new Set(existingScenes.map((s) => s.id));
  for (const sceneId of body.sceneIds) {
    if (!existingIds.has(sceneId)) {
      return badRequestResponse("Scene ID does not belong to this project");
    }
  }

  // Update sort orders
  for (let i = 0; i < body.sceneIds.length; i++) {
    await db
      .update(scenes)
      .set({ sortOrder: i })
      .where(and(eq(scenes.id, body.sceneIds[i]), eq(scenes.projectId, id)));
  }

  return NextResponse.json({ message: "Scenes reordered" });
}
