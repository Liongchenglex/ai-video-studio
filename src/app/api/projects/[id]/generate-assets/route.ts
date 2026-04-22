/**
 * POST /api/projects/[id]/generate-assets
 * Triggers Inngest to generate all assets for every scene.
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

  const sceneCount = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id));

  if (sceneCount.length === 0) {
    return badRequestResponse("Generate a script first");
  }

  // Reset all scene asset statuses
  await db
    .update(scenes)
    .set({ imageStatus: "pending", voiceoverStatus: "pending" })
    .where(eq(scenes.projectId, id));

  await db
    .update(projects)
    .set({ musicStatus: "pending" })
    .where(eq(projects.id, id));

  try {
    await inngest.send({
      name: "project/assets.generate",
      data: { projectId: id },
    });
  } catch (error) {
    console.error("Failed to send Inngest event:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Failed to start asset generation. Check Inngest Dev Server is running." },
      { status: 500 },
    );
  }

  return NextResponse.json({ message: "Asset generation started" });
}
