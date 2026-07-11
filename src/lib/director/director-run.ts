/**
 * AI Assistant Director run persistence (spec §Run lifecycle, Task 6). Thin
 * DB layer over director_runs / director_events — no business logic, no
 * network calls. Route handlers own the preconditions (409 double-start,
 * done-image gate, budget allow-list); the Task 7 Inngest loop owns the
 * actual direction work and calls appendRunEvent/addRunSpend as it goes.
 *
 * Concurrency notes (both matter under concurrent Inngest steps + polling):
 * - appendRunEvent computes `seq` via a single insert…select statement (max
 *   seq under the run, +1) so concurrent appends can never race a
 *   read-modify-write and collide on seq.
 * - addRunSpend increments spentUsd with a SQL expression for the same
 *   reason — never read-then-add-then-write.
 */
import { db } from "@/lib/db";
import {
  directorRuns,
  directorEvents,
  type DirectorRun,
  type DirectorEvent,
} from "@/lib/db/schema";
import { eq, and, or, gt, asc, desc, sql } from "drizzle-orm";

/** Statuses that make a run "in flight" for the shot — blocks a second start and is what stop targets. */
const ACTIVE_STATUSES = ["running", "awaiting_approval"] as const;

/**
 * Inserts a new director_runs row in the default `running` status. Does NOT
 * check for an existing active run — the 409 double-start guard is the
 * route's job (it needs to return a specific status code, not throw).
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
 * after the run's current max in the same insert statement (no read step,
 * so no race between two concurrent appends).
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

/** Fetches a single run by id, or null. Used by the start route to validate `retryOfRunId`. */
export async function getRunById(runId: string): Promise<DirectorRun | null> {
  const [run] = await db.select().from(directorRuns).where(eq(directorRuns.id, runId)).limit(1);
  return run ?? null;
}

/** Flags the run for cooperative cancellation — the loop checks this between steps and exits. */
export async function requestStop(runId: string): Promise<void> {
  await db.update(directorRuns).set({ stopRequested: true }).where(eq(directorRuns.id, runId));
}

/** The shot's currently in-flight run (running or awaiting_approval), if any — gates both the 409 double-start check and stop. */
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
    .limit(1);
  return run ?? null;
}
