/**
 * POST   /api/projects/[id]/shots/[shotId]/end-frame — authors a custom
 *        end frame from the shot's current image via FLUX Kontext. Body:
 *        { instruction: string } (required, non-empty, ≤500 chars,
 *        forwarded only to fal). Requires a "done" primary image.
 * DELETE /api/projects/[id]/shots/[shotId]/end-frame — removes the custom
 *        end frame: deletes the R2 object (non-fatal), nulls
 *        endFramePath/endFrameInstruction, resets endFrameStatus to
 *        "pending", and sets endsOn back to "free" when it was "custom".
 * The shot's primary image is never modified by either verb.
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
import { deleteObject } from "@/lib/r2";
import { createShotEndFrame, FRAME_EDIT_INSTRUCTION_MAX_CHARS } from "@/lib/shot-frame-edit";

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
    return badRequestResponse("Generate the shot's image before authoring an end frame");
  }
  // Paid-call double-click protection (SFX route idiom).
  if (shot.endFrameStatus === "generating") {
    return badRequestResponse("End frame is already generating for this shot");
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
    const result = await createShotEndFrame(project, shot, instruction);
    return NextResponse.json({ ...result, endFrameStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/end-frame] failed:`, msg);
    return NextResponse.json({ error: msg, endFrameStatus: "failed" }, { status: 500 });
  }
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

  const row = await loadOwnedRow(id, shotId, session.user.id);
  if (!row) return notFoundResponse();
  const { shot } = row;

  // In-flight guard (mirrors the POST guard above): deleting out from under
  // a generating end frame would race the write that lands when it finishes.
  if (shot.endFrameStatus === "generating") {
    return badRequestResponse("End frame is generating — wait for it to finish before deleting");
  }

  if (shot.endFramePath) {
    try {
      await deleteObject(shot.endFramePath);
    } catch (error) {
      // Losing the orphan object is acceptable; losing the DB reset is not.
      console.warn(`[shot/end-frame] R2 delete failed for ${shot.endFramePath}:`, error);
    }
  }

  await db
    .update(shots)
    .set({
      endFramePath: null,
      endFrameInstruction: null,
      endFrameStatus: "pending",
      ...(shot.endsOn === "custom" ? { endsOn: "free" } : {}),
    })
    .where(eq(shots.id, shotId));

  return NextResponse.json({
    endFramePath: null,
    endFrameInstruction: null,
    endFrameStatus: "pending",
    endsOn: shot.endsOn === "custom" ? "free" : shot.endsOn,
  });
}
