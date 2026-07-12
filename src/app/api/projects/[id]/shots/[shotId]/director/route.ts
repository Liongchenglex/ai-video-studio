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
 *      generate-all preview route's auth). Critique events carry candidate
 *      frame R2 KEYS (`payload.frameKeys`), never presigned URLs (Task 7's
 *      direct-shot loop writes keys because a presigned URL embedded in a
 *      DB row would go stale) — this route presigns them into
 *      `payload.frameUrls` on every read, on a copy of the event, so the
 *      stored row is never mutated. Defense in depth (final-review C1):
 *      only keys under THIS run's own R2 prefix are ever presigned — a
 *      stray/foreign key in a malformed event payload is dropped, never
 *      turned into a downloadable URL for an object the requester may not
 *      own. record_critique's execute() (director-tools.ts) is the primary
 *      defense — it strips any model-supplied frameKeys before persisting
 *      — this is the second layer.
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
import {
  createRun,
  getRunById,
  getRunWithEvents,
  activeRunForShot,
  filterRunFrameKeys,
} from "@/lib/director/director-run";
import type { DirectorEvent } from "@/lib/db/schema";

type Params = { params: Promise<{ id: string; shotId: string }> };

/**
 * Presigns a critique event's `frameKeys` (R2 keys) into `frameUrls`
 * (presigned download URLs) for this one response — returns a new event
 * object, never mutates the DB row passed in. Events of any other type, or
 * critique events with no frameKeys array, pass through unchanged.
 *
 * Security (final-review C1): `runFramePrefix` scopes which keys are
 * eligible — anything in `frameKeys` that isn't a string under this run's
 * own R2 prefix (`projects/{projectId}/shots/{shotId}/director/{run.id}/`)
 * is silently dropped rather than presigned. record_critique's execute()
 * already refuses to persist model-supplied frameKeys at all, so this
 * should never trigger in practice — it's the belt to that suspenders.
 */
async function presignEventFrames(event: DirectorEvent, runFramePrefix: string): Promise<DirectorEvent> {
  if (event.type !== "critique") return event;
  const { frameKeys, ...rest } = event.payload;
  if (!Array.isArray(frameKeys)) return event;
  const validKeys = filterRunFrameKeys(frameKeys, runFramePrefix);
  if (validKeys.length === 0) return event;
  const frameUrls = await Promise.all(validKeys.map((key) => getDownloadUrl(key)));
  return { ...event, payload: { ...rest, frameUrls } };
}

const MIN_BUDGET_USD = 0.25;
const MAX_BUDGET_USD = 5.0;
const GUIDANCE_MAX_CHARS = 500;

/**
 * True when the error is Postgres unique violation 23505 on the
 * director_runs_one_active_per_shot partial index. Drizzle wraps driver
 * errors in DrizzleQueryError with the postgres-js PostgresError on
 * `cause`, so we walk the cause chain rather than assuming a shape.
 */
function isActiveRunUniqueViolation(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; e = e.cause as unknown, depth++) {
    const pg = e as Error & { code?: unknown; constraint_name?: unknown };
    if (pg.code === "23505" && pg.constraint_name === "director_runs_one_active_per_shot") {
      return true;
    }
  }
  return false;
}

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

  // Double-start guard, layer 1 (friendly path): app-level pre-check.
  // Layer 2 is the director_runs_one_active_per_shot partial unique index —
  // two starts racing past this pre-check cannot both insert, and the
  // loser's 23505 is mapped to the same 409 below. Without the index a
  // double-start would be a real double-spend (2x budget).
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

  let run;
  try {
    run = await createRun(id, shotId, budgetUsd!, guidance);
  } catch (err) {
    if (isActiveRunUniqueViolation(err)) {
      return NextResponse.json({ error: "A director run is already active for this shot" }, { status: 409 });
    }
    throw err;
  }

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
  const runFramePrefix = `projects/${id}/shots/${shotId}/director/${run.id}/`;
  const presignedEvents = await Promise.all(events.map((event) => presignEventFrames(event, runFramePrefix)));

  return NextResponse.json({ run: { ...run, candidateUrl }, events: presignedEvents });
}
