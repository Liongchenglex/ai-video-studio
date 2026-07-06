/**
 * POST /api/projects/[id]/shots/[shotId]/image
 * Generates (or regenerates) the image for a single shot using FLUX.1 Kontext
 * with the project's style string as conditioning. Stores in R2 and persists
 * the path on the shot row. Returns the new presigned download URL so the
 * client can update without a refresh.
 *
 * Reference Bible conditioning (F-16): if the shot is tagged with entities
 * (`referencedEntityIds`), resolves the primary tagged entity — the first
 * tagged entity of type `character` with a `done` reference sheet, else the
 * first tagged entity with a `done` sheet — and conditions generation on its
 * presigned reference-sheet URL via Kontext's image+prompt mode. Untagged or
 * not-yet-ready entities fall back to unconditioned generation, unchanged.
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
import { generateShotImage } from "@/lib/shot-image-generation";

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

  try {
    const result = await generateShotImage(project, shot);
    return NextResponse.json({
      imagePath: result.imagePath,
      imageUrl: result.imageUrl,
      imageStatus: "done",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/image] failed:`, msg);
    return NextResponse.json({ error: msg, imageStatus: "failed" }, { status: 500 });
  }
}
