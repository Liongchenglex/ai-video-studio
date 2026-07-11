/**
 * PATCH  /api/projects/[id]/shots/[shotId] — update bounds, prompts, the
 *        tagged reference-bible entities, clip model, and/or directing
 *        controls (camera, end-frame chaining, duration, negative prompt,
 *        entity-ref usage)
 * DELETE /api/projects/[id]/shots/[shotId] — remove a shot
 *
 * PATCH validates bounds against the anchor-beat spillover model: the shot
 * must start inside its (possibly re-anchored) beat, may spill past it, and
 * must not overlap any other shot on the timeline (absolute ranges).
 *
 * `referencedEntityIds` (Reference Bible tagging, F-16) is validated
 * independently of bounds/prompts: at most 8 UUIDs, every id must belong to
 * an entity in this same project (cross-table authorization).
 *
 * `clipModel` (ClipModelId | null) selects which fal.ai model to use, or null
 * to reset to the registry default (Clip Engine v2).
 *
 * Directing controls (Task 8): `cameraMove`/`cameraStrength` (allow-listed
 * enums or null), `endsOn` ("free" | "next" | "custom" — supersedes the
 * legacy boolean chain-to-next flag, which this route no longer accepts),
 * `clipDurationChoice` (integer seconds 1–15, or null to auto-match),
 * `negativePrompt` (string ≤500 chars, or null), `useEntityRefs` (boolean).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats, entities } from "@/lib/db/schema";
import { eq, and, asc, inArray } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { MIN_SHOT_SECONDS, shotAbsoluteRange } from "@/lib/shot-beat-mapping";
import { computeBeatOffsets, totalDurationSeconds } from "@/lib/beat-timing";
import { isClipModelId } from "@/lib/clip-models";
import { isCameraMove, isCameraStrength } from "@/lib/clip-camera";

const VALID_ENDS_ON = ["free", "next", "custom"] as const;

type Params = { params: Promise<{ id: string; shotId: string }> };

async function loadOwnedProjectAndShot(projectId: string, shotId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project || project.deletedAt) return { project: null, shot: null };

  const [shot] = await db
    .select()
    .from(shots)
    .where(and(eq(shots.id, shotId), eq(shots.projectId, projectId)))
    .limit(1);
  return { project, shot: shot ?? null };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const { project, shot } = await loadOwnedProjectAndShot(id, shotId, session.user.id);
  if (!project || !shot) return notFoundResponse();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return badRequestResponse("Invalid request body");
  }
  const body = rawBody as Partial<{
    beatId: string;
    startInBeat: number;
    endInBeat: number;
    imagePrompt: string;
    motionPrompt: string;
    referencedEntityIds: string[];
    clipModel: string | null;
    cameraMove: string | null;
    cameraStrength: string | null;
    endsOn: string;
    clipDurationChoice: number | null;
    negativePrompt: string | null;
    useEntityRefs: boolean;
  }>;

  const updates: Record<string, unknown> = {};
  const boundsChanged =
    body.beatId !== undefined ||
    body.startInBeat !== undefined ||
    body.endInBeat !== undefined;

  if (boundsChanged) {
    // A bounds change may re-anchor the shot: dragging its start into a
    // different beat sends the new anchor's beatId along with the offsets.
    if (body.beatId !== undefined && (typeof body.beatId !== "string" || !isValidUUID(body.beatId))) {
      return badRequestResponse("Invalid beatId");
    }
    const anchorId = body.beatId ?? shot.beatId;
    if (!anchorId) return badRequestResponse("Shot has no anchor beat");

    const beatRows = await db
      .select()
      .from(beats)
      .where(eq(beats.projectId, id))
      .orderBy(asc(beats.sortOrder));
    const offsets = computeBeatOffsets(beatRows);
    const anchor = offsets.find((o) => o.id === anchorId);
    // Cross-table authorization: the anchor must belong to this project.
    if (!anchor) return badRequestResponse("beatId does not belong to this project");

    const anchorDur = anchor.endSeconds - anchor.startSeconds;
    const timelineEnd = totalDurationSeconds(beatRows);
    const newStart = body.startInBeat ?? shot.startInBeat ?? 0;
    const newEnd = body.endInBeat ?? shot.endInBeat ?? anchorDur;
    if (
      !Number.isFinite(newStart) ||
      !Number.isFinite(newEnd) ||
      newStart < 0 ||
      newStart >= anchorDur || // the shot must START inside its anchor
      newEnd - newStart < MIN_SHOT_SECONDS ||
      anchor.startSeconds + newEnd > timelineEnd + 0.05
    ) {
      return badRequestResponse("Invalid bounds for this beat");
    }

    // Overlap check against every other shot on the timeline (absolute
    // ranges) — shots can span beats.
    const offsetById = new Map(offsets.map((o) => [o.id, o]));
    const absStart = anchor.startSeconds + newStart;
    const absEnd = anchor.startSeconds + newEnd;
    const others = await db
      .select()
      .from(shots)
      .where(eq(shots.projectId, id));
    const overlap = others.find((s) => {
      if (s.id === shotId) return false;
      const r = shotAbsoluteRange(s, offsetById);
      return r !== null && r.start < absEnd && r.end > absStart;
    });
    if (overlap) return badRequestResponse("Bounds overlap another shot");

    updates.beatId = anchorId;
    updates.startInBeat = newStart;
    updates.endInBeat = newEnd;
  }

  if (body.imagePrompt !== undefined) {
    if (typeof body.imagePrompt !== "string") {
      return badRequestResponse("imagePrompt must be a string");
    }
    const p = body.imagePrompt.trim();
    if (p.length === 0) return badRequestResponse("imagePrompt cannot be empty");
    if (p.length > 2000) {
      return badRequestResponse("imagePrompt too long (max 2000 characters)");
    }
    updates.imagePrompt = p;
  }
  if (body.motionPrompt !== undefined) {
    if (typeof body.motionPrompt !== "string") {
      return badRequestResponse("motionPrompt must be a string");
    }
    const p = body.motionPrompt.trim();
    if (p.length === 0) return badRequestResponse("motionPrompt cannot be empty");
    if (p.length > 2000) {
      return badRequestResponse("motionPrompt too long (max 2000 characters)");
    }
    updates.motionPrompt = p;
  }

  if (body.referencedEntityIds !== undefined) {
    const ids = body.referencedEntityIds;
    if (!Array.isArray(ids) || ids.length > 8 || !ids.every((v) => typeof v === "string" && isValidUUID(v))) {
      return badRequestResponse("referencedEntityIds must be an array of at most 8 UUIDs");
    }
    if (ids.length > 0) {
      const owned = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.projectId, id), inArray(entities.id, ids)));
      const ownedIds = new Set(owned.map((e) => e.id));
      if (!ids.every((eid) => ownedIds.has(eid))) {
        return badRequestResponse("entity does not belong to this project");
      }
    }
    updates.referencedEntityIds = ids;
  }

  if (body.clipModel !== undefined) {
    // null clears the selection back to the registry default
    if (body.clipModel !== null && !isClipModelId(body.clipModel)) {
      return badRequestResponse("Unknown clip model");
    }
    updates.clipModel = body.clipModel;
  }

  if (body.cameraMove !== undefined) {
    if (body.cameraMove !== null && !isCameraMove(body.cameraMove)) {
      return badRequestResponse("Unknown camera move");
    }
    updates.cameraMove = body.cameraMove;
  }

  if (body.cameraStrength !== undefined) {
    if (body.cameraStrength !== null && !isCameraStrength(body.cameraStrength)) {
      return badRequestResponse("Unknown camera strength");
    }
    updates.cameraStrength = body.cameraStrength;
  }

  if (body.endsOn !== undefined) {
    if (!VALID_ENDS_ON.includes(body.endsOn as typeof VALID_ENDS_ON[number])) {
      return badRequestResponse(`endsOn must be one of: ${VALID_ENDS_ON.join(", ")}`);
    }
    updates.endsOn = body.endsOn;
  }

  if (body.clipDurationChoice !== undefined) {
    if (
      body.clipDurationChoice !== null &&
      !(Number.isInteger(body.clipDurationChoice) && body.clipDurationChoice >= 1 && body.clipDurationChoice <= 15)
    ) {
      return badRequestResponse("clipDurationChoice must be an integer between 1 and 15, or null");
    }
    updates.clipDurationChoice = body.clipDurationChoice;
  }

  if (body.negativePrompt !== undefined) {
    if (
      body.negativePrompt !== null &&
      !(typeof body.negativePrompt === "string" && body.negativePrompt.length <= 500)
    ) {
      return badRequestResponse("negativePrompt must be a string of at most 500 characters, or null");
    }
    // Normalize an empty/whitespace-only string to null, matching the
    // topic/brief idiom, so the UI can persist "cleared" consistently.
    updates.negativePrompt = body.negativePrompt?.trim() || null;
  }

  if (body.useEntityRefs !== undefined) {
    if (typeof body.useEntityRefs !== "boolean") {
      return badRequestResponse("useEntityRefs must be a boolean");
    }
    updates.useEntityRefs = body.useEntityRefs;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(shots)
    .set(updates)
    .where(eq(shots.id, shotId))
    .returning();

  // sortOrder is not maintained after bounds changes — the UI and API GET
  // order by startInBeat, so a stale sortOrder is harmless.

  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const { project, shot } = await loadOwnedProjectAndShot(id, shotId, session.user.id);
  if (!project || !shot) return notFoundResponse();

  await db.delete(shots).where(eq(shots.id, shotId));
  return NextResponse.json({ ok: true });
}
