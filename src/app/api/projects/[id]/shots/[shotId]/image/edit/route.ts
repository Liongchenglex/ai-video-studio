/**
 * POST /api/projects/[id]/shots/[shotId]/image/edit — edits the shot's
 * existing image in place via FLUX Kontext. Body: { instruction: string }
 * (required, non-empty, ≤500 chars, forwarded only to fal). Requires a
 * "done" image to edit; overwrites image.png and, if a custom end frame
 * exists, resets endFrameStatus to "pending" (stale-flag — the end frame
 * was authored from the old image). Never touches clip/sfx.
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
import { editShotImage, FRAME_EDIT_INSTRUCTION_MAX_CHARS } from "@/lib/shot-frame-edit";

type Params = { params: Promise<{ id: string; shotId: string }> };

async function loadOwnedRow(projectId: string, shotId: string, userId: string) {
  const [row] = await db
    .select({ shot: shots, project: projects })
    .from(shots)
    .innerJoin(projects, eq(shots.projectId, projects.id))
    .where(and(eq(shots.id, shotId), eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const row = await loadOwnedRow(id, shotId, session.user.id);
  if (!row) return notFoundResponse();
  const { shot, project } = row;

  if (!shot.imagePath || shot.imageStatus !== "done") {
    return badRequestResponse("Generate the shot's image before editing it");
  }

  let instruction: string;
  const raw = await request.text();
  try {
    const body = JSON.parse(raw) as { instruction?: unknown };
    if (typeof body.instruction !== "string" || body.instruction.trim().length === 0) {
      return badRequestResponse("instruction is required");
    }
    if (body.instruction.length > FRAME_EDIT_INSTRUCTION_MAX_CHARS) {
      return badRequestResponse(
        `instruction must be at most ${FRAME_EDIT_INSTRUCTION_MAX_CHARS} characters`,
      );
    }
    instruction = body.instruction;
  } catch {
    return badRequestResponse("Invalid request body");
  }

  try {
    const result = await editShotImage(project, shot, instruction);
    return NextResponse.json({ ...result, imageStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/image/edit] failed:`, msg);
    return NextResponse.json({ error: msg, imageStatus: "failed" }, { status: 500 });
  }
}
