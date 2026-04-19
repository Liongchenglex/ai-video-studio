/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate
 * Regenerates a single scene using Claude, preserving surrounding context.
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
import { regenerateScene } from "@/lib/script-generation";

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

  if (!project.brief) {
    return badRequestResponse("Project has no brief");
  }

  const allScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  const sceneIndex = allScenes.findIndex((s) => s.id === sceneId);
  if (sceneIndex === -1) return notFoundResponse();

  const currentScene = allScenes[sceneIndex];
  const prevScene = sceneIndex > 0 ? allScenes[sceneIndex - 1] : undefined;
  const nextScene = sceneIndex < allScenes.length - 1 ? allScenes[sceneIndex + 1] : undefined;

  try {
    const regenerated = await regenerateScene({
      brief: project.brief,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
      sceneNumber: sceneIndex + 1,
      totalScenes: allScenes.length,
      previousSceneVoiceover: prevScene?.voiceover,
      nextSceneVoiceover: nextScene?.voiceover,
      currentVoiceover: currentScene.voiceover,
      currentSceneDescription: currentScene.sceneDescription,
    });

    const [updated] = await db
      .update(scenes)
      .set({
        voiceover: regenerated.voiceover,
        sceneDescription: regenerated.scene_description,
        imagePrompt: regenerated.image_prompt,
        durationSeconds: regenerated.duration_seconds,
      })
      .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Scene regeneration failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Scene regeneration failed. Please try again." },
      { status: 500 },
    );
  }
}
