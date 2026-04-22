/**
 * POST /api/test/music
 * Direct test endpoint for music generation — no Inngest.
 * Body: { projectId }
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getSession, unauthorizedResponse, badRequestResponse } from "@/lib/api-utils";
import { generateMusic } from "@/lib/music-generation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { projectId } = await request.json();
  if (!projectId) return badRequestResponse("projectId required");

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project) return badRequestResponse("Project not found");

  const projectScenes = await db.select().from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.sortOrder));

  const totalDuration = projectScenes.reduce((sum, s) => sum + s.durationSeconds, 0);

  try {
    console.log(`[test/music] Generating music for project (${totalDuration}s, mood: ${project.musicMood})...`);

    const result = await generateMusic({
      projectId,
      mood: project.musicMood || "ambient",
      durationSeconds: totalDuration,
    });

    await db.update(projects).set({
      musicPath: result.r2Key,
      musicStatus: "done",
    }).where(eq(projects.id, projectId));

    console.log(`[test/music] Done: ${result.r2Key}`);
    return NextResponse.json({ success: true, r2Key: result.r2Key });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[test/music] Failed:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
