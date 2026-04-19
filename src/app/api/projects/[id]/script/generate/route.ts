/**
 * POST /api/projects/[id]/script/generate
 * Generates a full video script from the project's brief using Claude.
 * Replaces any existing scenes for this project.
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
import { generateScript } from "@/lib/script-generation";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
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

  if (!project.brief || project.brief.trim().length === 0) {
    return badRequestResponse("A video brief is required before generating a script");
  }

  try {
    const generatedScenes = await generateScript({
      brief: project.brief,
      targetDurationMinutes: project.targetDuration ?? 5,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
    });

    // Delete existing scenes for this project
    await db.delete(scenes).where(eq(scenes.projectId, id));

    // Insert new scenes
    const sceneRows = generatedScenes.map((s, i) => ({
      projectId: id,
      sortOrder: i,
      voiceover: s.voiceover,
      sceneDescription: s.scene_description,
      imagePrompt: s.image_prompt,
      durationSeconds: s.duration_seconds,
      isHook: s.is_hook,
    }));

    const inserted = await db.insert(scenes).values(sceneRows).returning();

    return NextResponse.json({ scenes: inserted });
  } catch (error) {
    console.error("Script generation failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Script generation failed. Please try again." },
      { status: 500 },
    );
  }
}
