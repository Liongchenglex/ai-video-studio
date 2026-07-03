/**
 * POST /api/test/music
 * Direct test endpoint for music generation — no Inngest.
 * Body: { projectId }
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  badRequestResponse,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { generateMusic } from "@/lib/music-generation";
import { totalDurationSeconds } from "@/lib/beat-timing";

export async function POST(request: NextRequest) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { projectId } = await request.json();
  if (!projectId) return badRequestResponse("projectId required");

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project) return badRequestResponse("Project not found");

  const beatRows = await db.select().from(beats).where(eq(beats.projectId, projectId));
  const totalDuration = totalDurationSeconds(beatRows);
  if (!totalDuration) {
    return badRequestResponse("Voice the script into beats first — music duration is derived from beat VO length");
  }

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
    console.error(`[test/music] Failed:`, error);
    return NextResponse.json({ error: "Music generation failed" }, { status: 500 });
  }
}
