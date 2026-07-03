/**
 * POST /api/projects/[id]/shots
 * Creates a shot inside a beat (v4.0 beat-relative model). The shot is a
 * sub-range [startInBeat, endInBeat) of its beat's audio; it must not
 * overlap another shot in the same beat.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats } from "@/lib/db/schema";
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
import { MIN_SHOT_SECONDS } from "@/lib/shot-beat-mapping";

type Params = { params: Promise<{ id: string }> };

const DEFAULT_MOTION_PROMPT =
  "the subject holds its pose while the scene breathes — faint ambient motion, minimal camera drift";

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
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

  let body: {
    beatId: string;
    startInBeat: number;
    endInBeat: number;
    imagePrompt: string;
    motionPrompt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (typeof body.beatId !== "string" || !isValidUUID(body.beatId)) {
    return badRequestResponse("Invalid beatId");
  }
  // Cross-table authorization: the beat must belong to this project.
  const [beat] = await db
    .select()
    .from(beats)
    .where(and(eq(beats.id, body.beatId), eq(beats.projectId, id)))
    .limit(1);
  if (!beat) return badRequestResponse("beatId does not belong to this project");

  const beatDur = beat.voDurationSeconds ?? 0;
  if (
    typeof body.startInBeat !== "number" ||
    typeof body.endInBeat !== "number" ||
    !Number.isFinite(body.startInBeat) ||
    !Number.isFinite(body.endInBeat) ||
    body.startInBeat < 0 ||
    body.endInBeat - body.startInBeat < MIN_SHOT_SECONDS ||
    body.endInBeat > beatDur + 0.05
  ) {
    return badRequestResponse("Invalid startInBeat/endInBeat for this beat");
  }
  if (!body.imagePrompt || body.imagePrompt.trim().length === 0) {
    return badRequestResponse("imagePrompt is required");
  }

  // Overlap check against shots in the SAME beat only.
  const siblings = await db
    .select()
    .from(shots)
    .where(and(eq(shots.projectId, id), eq(shots.beatId, body.beatId)));
  const overlap = siblings.find(
    (s) =>
      s.startInBeat != null &&
      s.endInBeat != null &&
      s.startInBeat < body.endInBeat &&
      s.endInBeat > body.startInBeat,
  );
  if (overlap) {
    return badRequestResponse("Shot overlaps an existing shot in this beat");
  }

  const [created] = await db
    .insert(shots)
    .values({
      projectId: id,
      beatId: body.beatId,
      sortOrder: siblings.length,
      startInBeat: body.startInBeat,
      endInBeat: body.endInBeat,
      imagePrompt: body.imagePrompt.trim(),
      motionPrompt: body.motionPrompt?.trim() || DEFAULT_MOTION_PROMPT,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
