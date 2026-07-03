/**
 * POST /api/projects/[id]/script/generate
 * Generates a plain-text script (F-03, PRD v3.0) and persists it to
 * project.script.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
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
  console.log("[script/generate] POST received");

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
    const script = await generateScript({
      brief: project.brief,
      targetDurationMinutes: project.targetDuration ?? 5,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
    });

    await db
      .update(projects)
      .set({ script })
      .where(eq(projects.id, id));

    console.log(`[script/generate] saved ${script.length} chars to project ${id}`);
    return NextResponse.json({ script });
  } catch (error) {
    console.error("Script generation failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Script generation failed. Please try again." },
      { status: 500 },
    );
  }
}
