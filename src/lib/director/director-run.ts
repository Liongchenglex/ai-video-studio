/**
 * AI Assistant Director run persistence (spec §Run lifecycle, Task 6). Thin
 * DB layer over director_runs / director_events — no business logic, no
 * network calls. Route handlers own the preconditions (409 double-start,
 * done-image gate, budget allow-list); the Task 7 Inngest loop owns the
 * actual direction work and calls appendRunEvent/addRunSpend as it goes.
 *
 * Concurrency notes:
 * - appendRunEvent computes `seq` via a single insert…select statement (max
 *   seq under the run, +1). That minimizes — but does not fully eliminate —
 *   the collision window under true concurrency; it's safe here because the
 *   direct-shot loop is the run's only writer and its steps run
 *   sequentially.
 * - addRunSpend increments spentUsd with a SQL expression — never
 *   read-then-add-then-write.
 * - The director_runs_one_active_per_shot partial unique index (schema.ts)
 *   backs the start route's 409 pre-check at the DB level: two racing
 *   starts cannot both insert an active run.
 */
import { db } from "@/lib/db";
import {
  directorRuns,
  directorEvents,
  type DirectorRun,
  type DirectorEvent,
} from "@/lib/db/schema";
import { eq, and, or, gt, asc, desc, sql, isNotNull } from "drizzle-orm";

/** Statuses that make a run "in flight" for the shot — blocks a second start and is what stop targets. */
const ACTIVE_STATUSES = ["running", "awaiting_approval"] as const;

/** Statuses the resolve route (Task 13) may act on — a run that finished with, or without, a stop request. */
const RESOLVABLE_STATUSES = ["awaiting_approval", "stopped"] as const;

/**
 * Inserts a new director_runs row in the default `running` status. Does NOT
 * check for an existing active run — the 409 double-start guard is the
 * route's job (it needs to return a specific status code, not throw).
 * Throws Postgres 23505 (via the director_runs_one_active_per_shot partial
 * unique index) when an active run already exists — the route maps that to
 * the same 409.
 */
export async function createRun(
  projectId: string,
  shotId: string,
  budgetUsd: number,
  guidance: string | null,
): Promise<DirectorRun> {
  const [run] = await db
    .insert(directorRuns)
    .values({ projectId, shotId, budgetUsd, guidance })
    .returning();
  return run;
}

/**
 * Appends one append-only event row, assigning `seq` as the next integer
 * after the run's current max in the same insert statement. The
 * insert-select minimizes (not eliminates) the seq-collision window; the
 * sequential direct-shot loop being the run's only writer is what makes
 * this safe in practice.
 */
export async function appendRunEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(directorEvents).values({
    runId,
    seq: sql`(select coalesce(max(seq), 0) + 1 from director_events where run_id = ${runId})`,
    type,
    payload,
  });
}

/**
 * Increments the run's spentUsd by a SQL expression (never a
 * read-add-write round trip), so concurrent spend updates always land
 * correctly regardless of ordering.
 */
export async function addRunSpend(runId: string, usd: number): Promise<void> {
  await db
    .update(directorRuns)
    .set({ spentUsd: sql`${directorRuns.spentUsd} + ${usd}` })
    .where(eq(directorRuns.id, runId));
}

/**
 * Loads the shot's most recent run (by createdAt) plus its events with
 * seq > sinceSeq, ordered oldest-first. Returns null when the shot has no
 * runs yet.
 */
export async function getRunWithEvents(
  shotId: string,
  sinceSeq = 0,
): Promise<{ run: DirectorRun; events: DirectorEvent[] } | null> {
  const [run] = await db
    .select()
    .from(directorRuns)
    .where(eq(directorRuns.shotId, shotId))
    .orderBy(desc(directorRuns.createdAt))
    .limit(1);
  if (!run) return null;

  const events = await db
    .select()
    .from(directorEvents)
    .where(and(eq(directorEvents.runId, run.id), gt(directorEvents.seq, sinceSeq)))
    .orderBy(asc(directorEvents.seq));

  return { run, events };
}

/**
 * Persists a freshly generated candidate clip onto the run row. Unlike
 * spend, these are last-writer-wins fields (a new candidate replaces the
 * old one outright), so a plain update — not a SQL increment — is correct.
 * Called by the direct-shot loop's DirectorRunCtx.setCandidate, which
 * generate_candidate_clip's execute() invokes after a successful render.
 */
export async function setRunCandidate(
  runId: string,
  candidate: { clipPath: string; clipDurationSeconds: number; clipModel: string },
): Promise<void> {
  await db
    .update(directorRuns)
    .set({
      clipCandidatePath: candidate.clipPath,
      candidateDurationSeconds: candidate.clipDurationSeconds,
      candidateModel: candidate.clipModel,
    })
    .where(eq(directorRuns.id, runId));
}

/**
 * Appends one proposal to the run's `proposals` jsonb array via `||`
 * concatenation (same never-read-then-write reasoning as addRunSpend).
 * No Stage-1 tool calls this yet (Stage 2's entity tag/create tools will);
 * DirectorRunCtx.addProposal must exist regardless since it's part of the
 * fixed ctx shape every tool's execute() can rely on.
 */
export async function addRunProposal(runId: string, proposal: Record<string, unknown>): Promise<void> {
  await db
    .update(directorRuns)
    .set({
      proposals: sql`coalesce(${directorRuns.proposals}, '[]'::jsonb) || ${JSON.stringify([proposal])}::jsonb`,
    })
    .where(eq(directorRuns.id, runId));
}

/** Fetches a single run by id, or null. Used by the start route to validate `retryOfRunId`. */
export async function getRunById(runId: string): Promise<DirectorRun | null> {
  const [run] = await db.select().from(directorRuns).where(eq(directorRuns.id, runId)).limit(1);
  return run ?? null;
}

/** Flags the run for cooperative cancellation — the loop checks this between steps and exits. */
export async function requestStop(runId: string): Promise<void> {
  await db.update(directorRuns).set({ stopRequested: true }).where(eq(directorRuns.id, runId));
}

/**
 * The shot's currently in-flight run (running or awaiting_approval), if any
 * — gates both the 409 double-start check and stop. Latest-first ordering
 * matches getRunWithEvents' semantics (the partial unique index guarantees
 * at most one active run going forward; the orderBy is a belt for any
 * pre-index data).
 */
export async function activeRunForShot(shotId: string): Promise<DirectorRun | null> {
  const [run] = await db
    .select()
    .from(directorRuns)
    .where(
      and(
        eq(directorRuns.shotId, shotId),
        or(...ACTIVE_STATUSES.map((status) => eq(directorRuns.status, status))),
      ),
    )
    .orderBy(desc(directorRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * The shot's most recent run that the resolve route (Task 13) can act on
 * (`awaiting_approval` or `stopped`), if any. Unlike `activeRunForShot`,
 * "resolvable" includes `stopped` — a stopped run's candidate-so-far, if
 * it has one, is still approvable.
 */
export async function resolvableRunForShot(shotId: string): Promise<DirectorRun | null> {
  const [run] = await db
    .select()
    .from(directorRuns)
    .where(
      and(
        eq(directorRuns.shotId, shotId),
        or(...RESOLVABLE_STATUSES.map((status) => eq(directorRuns.status, status))),
      ),
    )
    .orderBy(desc(directorRuns.createdAt))
    .limit(1);
  return run ?? null;
}

/**
 * Atomically flips a run to `approved` iff it is still in a resolvable
 * status AND still has a clip candidate — the race guard that stops two
 * concurrent "approve" requests from both promoting. Returns true iff this
 * call won the race (the caller should treat `false` as a 409 conflict,
 * not retry the promotion). Deliberately does NOT check the run's status
 * before racing — the conditional UPDATE's WHERE clause is the single
 * source of truth so the check-and-act is one round trip.
 */
export async function claimRunApproval(runId: string): Promise<boolean> {
  const rows = await db
    .update(directorRuns)
    .set({ status: "approved" })
    .where(
      and(
        eq(directorRuns.id, runId),
        or(...RESOLVABLE_STATUSES.map((status) => eq(directorRuns.status, status))),
        isNotNull(directorRuns.clipCandidatePath),
      ),
    )
    .returning({ id: directorRuns.id });
  return rows.length > 0;
}

/**
 * Atomically flips a run to `rejected` iff it is still in a resolvable
 * status — used by both "reject" (which passes the new guidance text with
 * the user's note appended) and "dismiss" (which omits `guidance` so the
 * existing value, if any, is left untouched). Same race-guard shape as
 * `claimRunApproval`; returns true iff this call won the race.
 */
export async function claimRunRejection(runId: string, guidance?: string | null): Promise<boolean> {
  const patch: { status: "rejected"; guidance?: string | null } = { status: "rejected" };
  if (guidance !== undefined) patch.guidance = guidance;

  const rows = await db
    .update(directorRuns)
    .set(patch)
    .where(
      and(
        eq(directorRuns.id, runId),
        or(...RESOLVABLE_STATUSES.map((status) => eq(directorRuns.status, status))),
      ),
    )
    .returning({ id: directorRuns.id });
  return rows.length > 0;
}
