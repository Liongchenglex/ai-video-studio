/**
 * API routes for a project's shots.
 * GET  /api/projects/[id]/shots — list all shots with presigned URLs and
 *      status defaults, ordered by sortOrder; used for polling during batch runs.
 * POST /api/projects/[id]/shots — creates a shot anchored to a beat
 *      (anchor-beat spillover model). The shot STARTS inside its anchor beat
 *      (0 ≤ startInBeat < anchor duration) but may spill past the anchor's end
 *      into following beats. Overlap is forbidden against every other shot on
 *      the timeline (absolute ranges).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { MIN_SHOT_SECONDS, shotAbsoluteRange } from "@/lib/shot-beat-mapping";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string }> };

const DEFAULT_MOTION_PROMPT =
  "the subject holds its pose while the scene breathes — faint ambient motion, minimal camera drift";

export async function GET(_request: NextRequest, { params }: Params) {
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

  const rows = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id))
    .orderBy(asc(shots.sortOrder));

  const list = await Promise.all(
    rows.map(async (shot) => ({
      id: shot.id,
      beatId: shot.beatId,
      sortOrder: shot.sortOrder,
      startInBeat: shot.startInBeat,
      endInBeat: shot.endInBeat,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      imagePath: shot.imagePath,
      imageStatus: shot.imageStatus ?? "pending",
      imageUrl: shot.imagePath ? await getDownloadUrl(shot.imagePath) : null,
      clipPath: shot.clipPath,
      clipStatus: shot.clipStatus ?? "pending",
      clipUrl: shot.clipPath ? await getDownloadUrl(shot.clipPath) : null,
      clipDurationSeconds: shot.clipDurationSeconds,
      referencedEntityIds: shot.referencedEntityIds ?? [],
    })),
  );

  return NextResponse.json({ shots: list });
}

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
  // Cross-table authorization: the anchor beat must belong to this project.
  // All beats are loaded so the anchor's absolute offset and the timeline
  // end can be computed (shots may spill past their anchor).
  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));
  const offsets = computeBeatOffsets(beatRows);
  const anchor = offsets.find((o) => o.id === body.beatId);
  if (!anchor) return badRequestResponse("beatId does not belong to this project");

  const anchorDur = anchor.endSeconds - anchor.startSeconds;
  const timelineEnd = totalDurationSeconds(beatRows);
  if (
    typeof body.startInBeat !== "number" ||
    typeof body.endInBeat !== "number" ||
    !Number.isFinite(body.startInBeat) ||
    !Number.isFinite(body.endInBeat) ||
    body.startInBeat < 0 ||
    body.startInBeat >= anchorDur || // the shot must START inside its anchor
    body.endInBeat - body.startInBeat < MIN_SHOT_SECONDS ||
    anchor.startSeconds + body.endInBeat > timelineEnd + 0.05
  ) {
    return badRequestResponse("Invalid startInBeat/endInBeat for this beat");
  }
  if (typeof body.imagePrompt !== "string") {
    return badRequestResponse("imagePrompt must be a string");
  }
  const trimmedImagePrompt = body.imagePrompt.trim();
  if (trimmedImagePrompt.length === 0) {
    return badRequestResponse("imagePrompt is required");
  }
  if (trimmedImagePrompt.length > 2000) {
    return badRequestResponse("imagePrompt too long (max 2000 characters)");
  }
  if (body.motionPrompt !== undefined) {
    if (typeof body.motionPrompt !== "string") {
      return badRequestResponse("motionPrompt must be a string");
    }
    if (body.motionPrompt.trim().length > 2000) {
      return badRequestResponse("motionPrompt too long (max 2000 characters)");
    }
  }

  // Overlap check against EVERY shot on the timeline (absolute ranges) —
  // shots can span beats, so per-beat checks are not sufficient.
  const offsetById = new Map(offsets.map((o) => [o.id, o]));
  const newStart = anchor.startSeconds + body.startInBeat;
  const newEnd = anchor.startSeconds + body.endInBeat;
  const existing = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id));
  const overlap = existing.find((s) => {
    const r = shotAbsoluteRange(s, offsetById);
    return r !== null && r.start < newEnd && r.end > newStart;
  });
  if (overlap) {
    return badRequestResponse("Shot overlaps an existing shot");
  }

  const [created] = await db
    .insert(shots)
    .values({
      projectId: id,
      beatId: body.beatId,
      sortOrder: existing.length,
      startInBeat: body.startInBeat,
      endInBeat: body.endInBeat,
      imagePrompt: trimmedImagePrompt,
      motionPrompt: body.motionPrompt?.trim() || DEFAULT_MOTION_PROMPT,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
