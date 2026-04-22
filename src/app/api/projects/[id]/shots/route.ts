/**
 * POST /api/projects/[id]/shots
 * Creates a new shot on the project timeline. Fills a user-selected gap
 * with the given prompts. Rejects on overlap with an existing shot.
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

type Params = { params: Promise<{ id: string }> };

const DEFAULT_MOTION_PROMPT = "subtle cinematic camera motion — slow push-in";

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
    startSeconds: number;
    endSeconds: number;
    imagePrompt: string;
    motionPrompt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (
    typeof body.startSeconds !== "number" ||
    typeof body.endSeconds !== "number" ||
    body.endSeconds <= body.startSeconds ||
    body.startSeconds < 0
  ) {
    return badRequestResponse("Invalid startSeconds/endSeconds");
  }
  if (!body.imagePrompt || body.imagePrompt.trim().length === 0) {
    return badRequestResponse("imagePrompt is required");
  }

  // Overlap check — a new shot's [start, end) must be disjoint from every other.
  // Note: sortOrder is not load-bearing; the UI and APIs order by startSeconds.
  // We only need to supply a unique-ish value on insert for the NOT NULL constraint.
  const existing = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id));

  const overlap = existing.find(
    (s) => s.startSeconds < body.endSeconds && s.endSeconds > body.startSeconds,
  );
  if (overlap) {
    return badRequestResponse(
      `Shot overlaps an existing shot at ${overlap.startSeconds}s–${overlap.endSeconds}s`,
    );
  }

  const text = project.script && project.durationSeconds
    ? deriveVOText(project.script, project.durationSeconds, body.startSeconds, body.endSeconds)
    : null;

  const [created] = await db
    .insert(shots)
    .values({
      projectId: id,
      sortOrder: existing.length, // monotonically increasing; real order comes from startSeconds
      startSeconds: body.startSeconds,
      endSeconds: body.endSeconds,
      text,
      imagePrompt: body.imagePrompt.trim(),
      motionPrompt: body.motionPrompt?.trim() || DEFAULT_MOTION_PROMPT,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
