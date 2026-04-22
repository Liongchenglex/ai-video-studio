/**
 * POST /api/projects/[id]/shots/[shotId]/split
 * Body: { atSeconds }
 * Splits a shot in two at the given time. Both halves inherit the prompts
 * and image/clip paths of the original; the user can regenerate assets
 * for either half afterwards.
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
import { deriveVOText } from "@/lib/vo-text";

type Params = { params: Promise<{ id: string; shotId: string }> };

const MIN_HALF_SECONDS = 1;

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const [shot] = await db
    .select()
    .from(shots)
    .where(and(eq(shots.id, shotId), eq(shots.projectId, id)))
    .limit(1);
  if (!shot) return notFoundResponse();

  let body: { atSeconds: number };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  const at = Math.round(body.atSeconds);
  if (
    typeof at !== "number" ||
    at < shot.startSeconds + MIN_HALF_SECONDS ||
    at > shot.endSeconds - MIN_HALF_SECONDS
  ) {
    return badRequestResponse(
      `atSeconds must be between ${shot.startSeconds + MIN_HALF_SECONDS} and ${shot.endSeconds - MIN_HALF_SECONDS}`,
    );
  }

  // Update original to end at the split point
  const leftText = project.script && project.durationSeconds
    ? deriveVOText(project.script, project.durationSeconds, shot.startSeconds, at)
    : null;
  const [left] = await db
    .update(shots)
    .set({ endSeconds: at, text: leftText })
    .where(eq(shots.id, shotId))
    .returning();

  // Insert the second half. Inherits prompts + existing image/clip paths —
  // if the user doesn't like the duplication they can regenerate.
  const rightText = project.script && project.durationSeconds
    ? deriveVOText(project.script, project.durationSeconds, at, shot.endSeconds)
    : null;
  const [right] = await db
    .insert(shots)
    .values({
      projectId: id,
      sortOrder: shot.sortOrder + 1,
      startSeconds: at,
      endSeconds: shot.endSeconds,
      text: rightText,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
    })
    .returning();

  return NextResponse.json({ left, right });
}
