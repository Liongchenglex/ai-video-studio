/**
 * GET  /api/projects/[id]/scenes — list all scenes ordered by sortOrder
 * POST /api/projects/[id]/scenes — add a new scene
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

  const projectScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  return NextResponse.json(projectScenes);
}

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
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    insertAfter?: number;
  };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!body.voiceover?.trim() || !body.sceneDescription?.trim() || !body.imagePrompt?.trim()) {
    return badRequestResponse("voiceover, sceneDescription, and imagePrompt are required");
  }
  if (!body.durationSeconds || body.durationSeconds < 1 || body.durationSeconds > 120) {
    return badRequestResponse("durationSeconds must be between 1 and 120");
  }

  // Get existing scenes to determine insert position
  const existing = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  const insertAt = (body.insertAfter ?? existing.length - 1) + 1;

  // Insert the new scene
  const [newScene] = await db
    .insert(scenes)
    .values({
      projectId: id,
      sortOrder: insertAt,
      voiceover: body.voiceover.trim(),
      sceneDescription: body.sceneDescription.trim(),
      imagePrompt: body.imagePrompt.trim(),
      durationSeconds: body.durationSeconds,
      isHook: false,
    })
    .returning();

  // Re-number all scenes to ensure contiguous order
  const allScenes = [...existing.slice(0, insertAt), newScene, ...existing.slice(insertAt)];
  for (let i = 0; i < allScenes.length; i++) {
    if (allScenes[i].sortOrder !== i) {
      await db
        .update(scenes)
        .set({ sortOrder: i })
        .where(eq(scenes.id, allScenes[i].id));
    }
  }

  return NextResponse.json(newScene, { status: 201 });
}
