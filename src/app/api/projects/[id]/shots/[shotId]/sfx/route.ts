/**
 * POST   /api/projects/[id]/shots/[shotId]/sfx — generate synced SFX for
 *        the shot's clip via MMAudio v2. Body: { prompt?: string } (≤500
 *        chars, optional steering text forwarded only to fal).
 * DELETE /api/projects/[id]/shots/[shotId]/sfx — remove the SFX variant:
 *        deletes the R2 object, nulls sfxPath, resets sfxStatus.
 * The clip itself is never modified by either verb.
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
import { generateShotSfx, SFX_PROMPT_MAX_CHARS } from "@/lib/sfx-generation";

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

  if (!shot.clipPath || shot.clipStatus !== "done") {
    return badRequestResponse("Generate the shot's clip before adding SFX");
  }
  if (shot.sfxStatus === "generating") {
    return badRequestResponse("SFX is already generating for this shot");
  }

  let prompt: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { prompt?: unknown };
      if (body.prompt !== undefined) {
        if (typeof body.prompt !== "string" || body.prompt.length > SFX_PROMPT_MAX_CHARS) {
          return badRequestResponse(`prompt must be a string of at most ${SFX_PROMPT_MAX_CHARS} characters`);
        }
        prompt = body.prompt;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }

  try {
    const result = await generateShotSfx(project, shot, { prompt });
    return NextResponse.json({ ...result, sfxStatus: "done" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/sfx] failed:`, msg);
    return NextResponse.json({ error: msg, sfxStatus: "failed" }, { status: 500 });
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

  if (shot.sfxPath) {
    try {
      await deleteObject(shot.sfxPath);
    } catch (error) {
      // Losing the orphan object is acceptable; losing the DB reset is not.
      console.warn(`[shot/sfx] R2 delete failed for ${shot.sfxPath}:`, error);
    }
  }

  await db
    .update(shots)
    .set({ sfxPath: null, sfxStatus: "pending" })
    .where(eq(shots.id, shotId));

  return NextResponse.json({ sfxPath: null, sfxStatus: "pending" });
}
