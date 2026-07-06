/**
 * POST /api/projects/[id]/shots/[shotId]/clip
 * Generates (or regenerates) the animation clip for a shot using LTX-2.3
 * image-to-video via fal.ai. Delegates to generateShotClip service which
 * handles the upload, fal.ai call, and R2 storage.
 *
 * Synchronous: awaits fal.ai. Typical latency 60-120s per clip.
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
import { generateShotClip } from "@/lib/shot-clip-generation";

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

  if (!shot.imagePath) {
    return badRequestResponse("Generate the shot's image before generating a clip");
  }

  try {
    const result = await generateShotClip(project, shot);
    return NextResponse.json({ ...result, clipStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/clip] failed:`, msg);
    return NextResponse.json({ error: msg, clipStatus: "failed" }, { status: 500 });
  }
}
