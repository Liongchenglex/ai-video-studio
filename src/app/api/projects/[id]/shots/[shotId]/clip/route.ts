/**
 * POST /api/projects/[id]/shots/[shotId]/clip
 * Generates (or regenerates) the animation clip for a shot. Supports multi-model via registry;
 * routes to the appropriate model handler (e.g., LTX-2.3 via fal.ai).
 * Optional body: { model?: ClipModelId }. Absent/empty body defaults to registry.
 * Delegates to generateShotClip service which handles the upload, API call, and R2 storage.
 *
 * Synchronous: awaits API. Typical latency 60-120s per clip.
 * Response: includes clipModel and, when relevant, endFrameSkippedReason /
 * cameraBestEffort (why a requested end frame was skipped; whether the
 * camera move was written into the prompt rather than sent as params).
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
import { isClipModelId } from "@/lib/clip-models";

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

  // Optional body: { model?: ClipModelId }. Absent/empty body = defaults.
  let model: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { model?: unknown };
      if (body.model !== undefined) {
        if (!isClipModelId(body.model)) return badRequestResponse("Unknown clip model");
        model = body.model;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }

  try {
    const result = await generateShotClip(project, shot, { model });
    return NextResponse.json({ ...result, clipStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/clip] failed:`, msg);
    return NextResponse.json({ error: msg, clipStatus: "failed" }, { status: 500 });
  }
}
