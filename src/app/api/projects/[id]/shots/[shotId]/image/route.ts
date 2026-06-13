/**
 * POST /api/projects/[id]/shots/[shotId]/image
 * Generates (or regenerates) the image for a single shot using FLUX.1 Kontext
 * with the project's style string as conditioning. Stores in R2 and persists
 * the path on the shot row. Returns the new presigned download URL so the
 * client can update without a refresh.
 *
 * Synchronous: awaits fal.ai. Typical latency 20-30s per image.
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
import { generateImage } from "@/lib/image-generation";
import { getDownloadUrl } from "@/lib/r2";

type Params = { params: Promise<{ id: string; shotId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const [row] = await db
    .select({ shot: shots, project: projects })
    .from(shots)
    .innerJoin(projects, eq(shots.projectId, projects.id))
    .where(and(eq(shots.id, shotId), eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!row) return notFoundResponse();
  const { shot, project } = row;

  if (!shot.imagePrompt?.trim()) {
    return badRequestResponse("Shot has no image prompt");
  }

  await db.update(shots).set({ imageStatus: "generating" }).where(eq(shots.id, shotId));

  try {
    console.log(
      `[shot/image] project=${id} shot=${shotId} | prompt: ${shot.imagePrompt.substring(0, 120)}...`,
    );

    const r2Key = `projects/${project.id}/shots/${shot.id}/image.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: shot.imagePrompt,
      styleString: project.styleString,
    });

    await db
      .update(shots)
      .set({ imagePath: result.r2Key, imageStatus: "done" })
      .where(eq(shots.id, shotId));

    console.log(`[shot/image] done: ${result.r2Key}`);
    return NextResponse.json({
      imagePath: result.r2Key,
      imageUrl: result.downloadUrl,
      imageStatus: "done",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/image] failed:`, msg);
    await db.update(shots).set({ imageStatus: "failed" }).where(eq(shots.id, shotId)).catch(() => {});
    return NextResponse.json({ error: msg, imageStatus: "failed" }, { status: 500 });
  }
}
