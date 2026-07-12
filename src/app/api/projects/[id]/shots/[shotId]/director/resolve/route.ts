/**
 * POST /api/projects/[id]/shots/[shotId]/director/resolve — closes out the
 * shot's resolvable AI Assistant Director run (`awaiting_approval` or
 * `stopped`, per `resolvableRunForShot`) with one of three actions:
 *
 *   - `approve` — requires a clip candidate on the run. The run's status is
 *     claimed FIRST, via a conditional UPDATE (`claimRunApproval`) whose
 *     affected-rows check is the race guard — only the claim's winner may
 *     touch the shot, closing the window where a losing approve could
 *     mutate the shot right before a concurrent reject/dismiss won the
 *     race. Only after the claim succeeds does the route execute
 *     `promotionPlan` (Task 13's pure mapper in director-resolve.ts): R2
 *     `CopyObjectCommand`s promote the candidate clip (and, when the
 *     director edited them, the scratch still / custom end frame) onto the
 *     shot's standard keys, then the shot row is patched with the
 *     directing settings that produced the candidate. If either step
 *     throws after the claim, the route best-effort compensates — appends
 *     a run `error` event describing the partial promotion, restores the
 *     run's status to `awaiting_approval` (safe as a plain UPDATE, since
 *     the claim already excluded other racers), and returns a 500; a retry
 *     re-runs the (idempotent, overwrite-safe) copies and patch. Checked
 *     proposals (`approvedProposalIds`, indexes into the run's `proposals`
 *     jsonb array) are applied last, each as an independent entities-row
 *     description update scoped to this project; a proposal failure is
 *     reported per-item and never un-promotes the already-approved clip.
 *   - `reject` — appends `note` (if given) onto the run's `guidance` via
 *     `buildRejectionGuidance` and flips status to `rejected`. The client's
 *     "reject & retry" flow is a fresh `POST .../director` with
 *     `retryOfRunId` set to this run, which seeds the new run's guidance
 *     from the (now feedback-carrying) old run.
 *   - `dismiss` — flips status to `rejected` without touching `guidance`
 *     or applying anything; `note` is accepted but ignored.
 *
 * Both `reject` and `dismiss` use the same conditional-UPDATE race guard
 * (`claimRunRejection`) as `approve` does.
 *
 * Full house security stack (rate limit → CSRF → session → UUID params →
 * ownership join), matching every other route under this shot's director
 * namespace (see start/stop route.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, entities, directorRuns } from "@/lib/db/schema";
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
import { copyObject } from "@/lib/r2";
import {
  resolvableRunForShot,
  claimRunApproval,
  claimRunRejection,
  appendRunEvent,
} from "@/lib/director/director-run";
import { promotionPlan, buildRejectionGuidance } from "@/lib/director/director-resolve";

type Params = { params: Promise<{ id: string; shotId: string }> };

const NOTE_MAX_CHARS = 500;
const RESOLVE_ACTIONS = ["approve", "reject", "dismiss"] as const;
type ResolveAction = (typeof RESOLVE_ACTIONS)[number];

interface ResolveBody {
  action: ResolveAction;
  note: string | null;
  approvedProposalIds: number[];
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

/**
 * Parses and validates the request body. Returns either the parsed body or
 * a ready-to-return error response — never throws (JSON parse failure is
 * itself mapped to a 400).
 */
async function parseResolveBody(
  request: NextRequest,
  proposalCount: number,
): Promise<{ body: ResolveBody } | { error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: badRequestResponse("Invalid request body") };
  }
  if (typeof raw !== "object" || raw === null) {
    return { error: badRequestResponse("Invalid request body") };
  }
  const input = raw as Record<string, unknown>;

  if (typeof input.action !== "string" || !RESOLVE_ACTIONS.includes(input.action as ResolveAction)) {
    return { error: badRequestResponse(`action must be one of: ${RESOLVE_ACTIONS.join(", ")}`) };
  }
  const action = input.action as ResolveAction;

  let note: string | null = null;
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.length > NOTE_MAX_CHARS) {
      return { error: badRequestResponse(`note must be a string of at most ${NOTE_MAX_CHARS} characters`) };
    }
    const trimmed = input.note.trim();
    note = trimmed === "" ? null : trimmed;
  }

  let approvedProposalIds: number[] = [];
  if (input.approvedProposalIds !== undefined) {
    if (!Array.isArray(input.approvedProposalIds)) {
      return { error: badRequestResponse("approvedProposalIds must be an array of integers") };
    }
    for (const id of input.approvedProposalIds) {
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= proposalCount) {
        return { error: badRequestResponse("approvedProposalIds must be integer indexes into the run's proposals") };
      }
    }
    // De-dup: applying the same checked proposal twice is a harmless
    // no-op (idempotent description overwrite), but there's no reason to.
    approvedProposalIds = [...new Set(input.approvedProposalIds as number[])];
  }

  return { body: { action, note, approvedProposalIds } };
}

interface ProposalResult {
  index: number;
  entityId: unknown;
  applied: boolean;
  error?: string;
}

/**
 * Applies each checked proposal as an independent entities-row description
 * update, scoped to this project (re-checks ownership per proposal — an
 * entity referenced by an old proposal could since have been deleted, or
 * belong to a different project in a pathological jsonb-tamper scenario).
 * Never throws: each failure is captured in its own result so one bad
 * proposal can't take down the rest, and none of them can undo the
 * already-committed clip promotion.
 */
async function applyApprovedProposals(
  projectId: string,
  proposals: Array<Record<string, unknown>>,
  approvedIndexes: number[],
): Promise<ProposalResult[]> {
  const results: ProposalResult[] = [];
  for (const index of approvedIndexes) {
    const proposal = proposals[index];
    const entityId = proposal?.entityId;
    const to = proposal?.to;
    try {
      if (proposal?.field !== "description") {
        throw new Error("Unsupported proposal field.");
      }
      if (typeof entityId !== "string" || !isValidUUID(entityId) || typeof to !== "string") {
        throw new Error("Malformed proposal entry.");
      }
      const updated = await db
        .update(entities)
        .set({ description: to })
        .where(and(eq(entities.id, entityId), eq(entities.projectId, projectId)))
        .returning({ id: entities.id });
      if (updated.length === 0) {
        throw new Error("Entity not found in this project.");
      }
      results.push({ index, entityId, applied: true });
    } catch (err) {
      results.push({
        index,
        entityId,
        applied: false,
        error: err instanceof Error ? err.message : "Unknown error applying proposal.",
      });
    }
  }
  return results;
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

  const run = await resolvableRunForShot(shotId);
  if (!run) {
    return badRequestResponse("No director run awaiting resolution for this shot");
  }

  const parsed = await parseResolveBody(request, run.proposals?.length ?? 0);
  if ("error" in parsed) return parsed.error;
  const { action, note, approvedProposalIds } = parsed.body;

  if (action === "approve") {
    if (!run.clipCandidatePath) {
      return badRequestResponse("This run has no candidate clip to approve");
    }

    // Order matters (fixed per review — claim FIRST): claim → R2 copies →
    // shot patch → proposals. The conditional-UPDATE claim is the race
    // guard, so its winner is the only request allowed to touch the shot;
    // running the copies/patch before the claim let a losing request mutate
    // the shot and still lose the race to a concurrent reject/dismiss,
    // leaving the shot promoted while the run ended up rejected.
    const won = await claimRunApproval(run.id);
    if (!won) {
      return NextResponse.json({ error: "This run was already resolved" }, { status: 409 });
    }

    const { shotPatch, copyOps } = promotionPlan(run);

    try {
      for (const op of copyOps) {
        await copyObject(op.from, op.to);
      }
      await db.update(shots).set(shotPatch).where(eq(shots.id, shotId));
    } catch (err) {
      // The claim already won, so a failure here leaves the promotion
      // partial (some copies may have landed; the shot patch may or may
      // not have run). Best-effort compensate: record what happened and
      // restore the run to awaiting_approval — a plain UPDATE is safe
      // because the claim already excluded every other racer, so nothing
      // else can be resolving this run concurrently — then report failure.
      // A retried approve re-runs promotionPlan's copies (plain overwrites)
      // and re-patches the shot, so this is safe to retry.
      const message = err instanceof Error ? err.message : "Unknown error promoting candidate.";
      await appendRunEvent(run.id, "error", {
        step: "approve",
        message: `Partial promotion while applying candidate: ${message}`,
      });
      await db.update(directorRuns).set({ status: "awaiting_approval" }).where(eq(directorRuns.id, run.id));
      return NextResponse.json({ error: "Failed to promote approved candidate" }, { status: 500 });
    }

    const proposalResults = await applyApprovedProposals(id, run.proposals ?? [], approvedProposalIds);

    return NextResponse.json({ runId: run.id, status: "approved", proposals: proposalResults });
  }

  if (action === "reject") {
    const guidance = note ? buildRejectionGuidance(run.guidance, note) : undefined;
    const won = await claimRunRejection(run.id, guidance);
    if (!won) {
      return NextResponse.json({ error: "This run was already resolved" }, { status: 409 });
    }
    return NextResponse.json({ runId: run.id, status: "rejected" });
  }

  // dismiss: rejected, guidance untouched, nothing applied.
  const won = await claimRunRejection(run.id);
  if (!won) {
    return NextResponse.json({ error: "This run was already resolved" }, { status: 409 });
  }
  return NextResponse.json({ runId: run.id, status: "rejected" });
}
