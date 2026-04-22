/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate-image
 * Triggers regeneration of a single scene's image via Inngest.
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
import { inngest } from "@/inngest";

type Params = { params: Promise<{ id: string; sceneId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();

  const [scene] = await db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .limit(1);

  if (!scene) return notFoundResponse();

  await db
    .update(scenes)
    .set({ imageStatus: "pending" })
    .where(eq(scenes.id, sceneId));

  await inngest.send({
    name: "scene/image.generate",
    data: {
      sceneId,
      projectId: id,
      sceneDescription: scene.sceneDescription,
      styleString: project.styleString,
    },
  });

  return NextResponse.json({ message: "Image regeneration started" });
}
