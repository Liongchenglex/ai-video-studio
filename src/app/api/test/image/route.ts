/**
 * POST /api/test/image
 * Direct test endpoint for image generation — no Inngest.
 * Body: { projectId, sceneId }
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSession, unauthorizedResponse, badRequestResponse } from "@/lib/api-utils";
import { generateSceneImage } from "@/lib/image-generation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { projectId, sceneId } = await request.json();
  if (!projectId || !sceneId) return badRequestResponse("projectId and sceneId required");

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project) return badRequestResponse("Project not found");

  const [scene] = await db.select().from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, projectId)))
    .limit(1);
  if (!scene) return badRequestResponse("Scene not found");

  try {
    console.log(`[test/image] Generating image for scene ${scene.sortOrder}...`);

    const result = await generateSceneImage({
      projectId,
      sceneId,
      sceneDescription: scene.sceneDescription,
      styleString: project.styleString,
    });

    await db.update(scenes).set({
      imagePath: result.r2Key,
      imageStatus: "done",
    }).where(eq(scenes.id, sceneId));

    console.log(`[test/image] Done: ${result.r2Key}`);
    return NextResponse.json({ success: true, r2Key: result.r2Key, downloadUrl: result.downloadUrl });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[test/image] Failed:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
