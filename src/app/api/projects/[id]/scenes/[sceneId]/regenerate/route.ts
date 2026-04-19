/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate
 * Regenerates only the image prompt for a scene.
 * Voiceover and scene description are user-owned and not modified.
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
import { regenerateImagePrompt } from "@/lib/script-generation";

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

  try {
    const newImagePrompt = await regenerateImagePrompt({
      sceneDescription: scene.sceneDescription,
      voiceover: scene.voiceover,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
    });

    const [updated] = await db
      .update(scenes)
      .set({ imagePrompt: newImagePrompt })
      .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Image prompt regeneration failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Image prompt regeneration failed. Please try again." },
      { status: 500 },
    );
  }
}
