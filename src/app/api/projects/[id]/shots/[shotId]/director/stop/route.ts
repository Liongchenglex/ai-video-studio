/**
 * POST /api/projects/[id]/shots/[shotId]/director/stop — requests
 * cooperative cancellation of the shot's active director run (running or
 * awaiting_approval). Flags `stopRequested`; the direct-shot Inngest loop
 * (Task 7) checks it between steps and exits, it does not stop the run
 * synchronously. 400 when the shot has no active run to stop.
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
import { activeRunForShot, requestStop } from "@/lib/director/director-run";

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

  const run = await activeRunForShot(shotId);
  if (!run) return badRequestResponse("No active director run for this shot");

  await requestStop(run.id);

  return NextResponse.json({ runId: run.id, stopRequested: true });
}
