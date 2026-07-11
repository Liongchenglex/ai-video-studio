/**
 * POST /api/projects/[id]/shots/[shotId]/director — starts an AI Assistant
 *      Director run for this shot: validates the budget/guidance body,
 *      refuses a second concurrent run (409) and a shot with no done still
 *      to work from (400), persists the run row, then hands off to the
 *      `direct-shot` Inngest function (Task 7) via `shot/director.run`.
 *      Optional `retryOfRunId` seeds the new run's guidance verbatim from a
 *      prior run on the same shot when the caller doesn't supply its own
 *      guidance — the "Reject & retry" flow (Task 13/14) reuses this so the
 *      rejection note accumulated on the old run's guidance carries
 *      forward without the client having to resend it.
 * GET  /api/projects/[id]/shots/[shotId]/director — polls the shot's most
 *      recent run plus any events after `?since=` (seq, default 0).
 *      Read-only: session + ownership only, no CSRF/rate-limit (mirrors the
 *      generate-all preview route's auth).
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
import { getDownloadUrl } from "@/lib/r2";
import { inngest } from "@/inngest";
import { createRun, getRunById, getRunWithEvents, activeRunForShot } from "@/lib/director/director-run";

type Params = { params: Promise<{ id: string; shotId: string }> };

const MIN_BUDGET_USD = 0.25;
const MAX_BUDGET_USD = 5.0;
const GUIDANCE_MAX_CHARS = 500;

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
  const { shot } = row;

  if (!shot.imagePath || shot.imageStatus !== "done") {
    return badRequestResponse("Generate the shot's still before starting the director");
  }

  let budgetUsd: number | undefined;
  let guidance: string | null = null;
  let retryOfRunId: string | undefined;
  let guidanceProvided = false;
  try {
    const body = (await request.json()) as {
      budgetUsd?: unknown;
      guidance?: unknown;
      retryOfRunId?: unknown;
    };
    if (typeof body.budgetUsd !== "number" || !Number.isFinite(body.budgetUsd)) {
      return badRequestResponse("budgetUsd must be a number");
    }
    if (body.budgetUsd < MIN_BUDGET_USD || body.budgetUsd > MAX_BUDGET_USD) {
      return badRequestResponse(`budgetUsd must be between ${MIN_BUDGET_USD} and ${MAX_BUDGET_USD}`);
    }
    budgetUsd = body.budgetUsd;

    if (body.guidance !== undefined) {
      if (typeof body.guidance !== "string" || body.guidance.length > GUIDANCE_MAX_CHARS) {
        return badRequestResponse(`guidance must be a string of at most ${GUIDANCE_MAX_CHARS} characters`);
      }
      guidanceProvided = true;
      const trimmed = body.guidance.trim();
      guidance = trimmed === "" ? null : trimmed;
    }

    if (body.retryOfRunId !== undefined) {
      if (typeof body.retryOfRunId !== "string" || !isValidUUID(body.retryOfRunId)) {
        return badRequestResponse("retryOfRunId must be a valid UUID");
      }
      retryOfRunId = body.retryOfRunId;
    }
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (await activeRunForShot(shotId)) {
    return NextResponse.json({ error: "A director run is already active for this shot" }, { status: 409 });
  }

  // Retry flow: seed guidance verbatim from the prior run when the caller
  // didn't supply its own — only when that run belongs to this shot.
  if (retryOfRunId && !guidanceProvided) {
    const priorRun = await getRunById(retryOfRunId);
    if (priorRun && priorRun.shotId === shotId) {
      guidance = priorRun.guidance;
    }
  }

  const run = await createRun(id, shotId, budgetUsd!, guidance);

  await inngest.send({
    name: "shot/director.run",
    data: { runId: run.id, projectId: id, shotId },
  });

  return NextResponse.json({ runId: run.id }, { status: 202 });
}

export async function GET(request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const row = await loadOwnedRow(id, shotId, session.user.id);
  if (!row) return notFoundResponse();

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  let sinceSeq = 0;
  if (sinceParam !== null) {
    sinceSeq = Number(sinceParam);
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) {
      return badRequestResponse("since must be a non-negative integer");
    }
  }

  const result = await getRunWithEvents(shotId, sinceSeq);
  if (!result) return notFoundResponse();
  const { run, events } = result;

  const candidateUrl = run.clipCandidatePath ? await getDownloadUrl(run.clipCandidatePath) : null;

  return NextResponse.json({ run: { ...run, candidateUrl }, events });
}
