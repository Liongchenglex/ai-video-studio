/**
 * POST /api/projects/[id]/shots/recommend
 * AI-suggests a shot breakdown for the project's VO. Calls Claude with
 * the full script, receives ~6-8 second shots with image + motion prompts,
 * replaces any existing shots for this project, returns the new list.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
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
import { recommendShots } from "@/lib/shot-recommendation";

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

  if (!project.script || !project.durationSeconds) {
    return badRequestResponse("Generate script and voiceover before recommending shots");
  }

  try {
    const recommended = await recommendShots({
      script: project.script,
      totalDurationSeconds: project.durationSeconds,
      styleString: project.styleString,
    });

    // Replace existing shots for this project.
    await db.delete(shots).where(eq(shots.projectId, id));

    const rows = recommended.map((r, i) => ({
      projectId: id,
      sortOrder: i,
      startSeconds: r.startSeconds,
      endSeconds: r.endSeconds,
      text: r.text,
      imagePrompt: r.imagePrompt,
      motionPrompt: r.motionPrompt,
    }));

    const inserted = await db.insert(shots).values(rows).returning();

    console.log(`[shots/recommend] inserted ${inserted.length} shots for project ${id}`);
    return NextResponse.json({ shots: inserted });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shots/recommend] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
