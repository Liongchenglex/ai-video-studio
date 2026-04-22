/**
 * POST /api/test/voiceover
 * Direct test endpoint for voiceover generation — no Inngest.
 * Body: { projectId, sceneId }
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSession, unauthorizedResponse, badRequestResponse } from "@/lib/api-utils";
import { generateSceneVoiceover } from "@/lib/voiceover-generation";

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
    console.log(`[test/voiceover] Generating voiceover for scene ${scene.sortOrder}...`);

    const result = await generateSceneVoiceover({
      projectId,
      sceneId,
      text: scene.voiceover,
      voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
    });

    await db.update(scenes).set({
      voiceoverPath: result.r2Key,
      voiceoverStatus: "done",
      voiceoverTimestamps: result.timestamps,
      durationSeconds: result.durationSeconds,
    }).where(eq(scenes.id, sceneId));

    console.log(`[test/voiceover] Done: ${result.r2Key} (${result.durationSeconds}s)`);
    return NextResponse.json({
      success: true,
      r2Key: result.r2Key,
      durationSeconds: result.durationSeconds,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[test/voiceover] Failed:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
