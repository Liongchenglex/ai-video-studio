/**
 * Missing-only targeting for batch "Generate all" (v4 P3). One computation
 * used by the preview endpoint, the dispatch endpoint, and the Inngest
 * orchestrator, so the three can never disagree about what a batch covers.
 * Missing = status pending|failed. done is never re-billed; generating is
 * skipped (in-flight).
 *
 * Also self-heals stale `generating` rows before reading them (see
 * STALE_GENERATING_MINUTES below) — this is why the function does a write
 * even though it's also called from the preview GET endpoint.
 */
import { db } from "@/lib/db";
import { entities, shots } from "@/lib/db/schema";
import { eq, and, lt } from "drizzle-orm";

export interface BatchTargets {
  sheetEntityIds: string[];
  imageShotIds: string[];
  clipShotIds: string[];
  anyGenerating: boolean;
}

// If an Inngest run dies without its per-item catch executing (e.g. the
// process is killed mid-step), the row it was working on stays `generating`
// forever: POST /generate-all then 409s forever, the Generate-all button
// stays disabled, and the per-item retry button is disabled too (it's also
// gated on not-generating) — only a manual psql UPDATE recovers. Heal here,
// before targets are read, because preview, dispatch, and the orchestrator
// all funnel through this one function, so all three self-heal identically.
// 15 minutes is safely stale: the longest legitimate item (an LTX clip) is
// ~2 minutes, and every legitimate status flip refreshes `updatedAt` via the
// columns' `$onUpdate`.
const STALE_GENERATING_MINUTES = 15;

async function healStaleGenerating(projectId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_GENERATING_MINUTES * 60 * 1000);
  await db
    .update(entities)
    .set({ referenceStatus: "failed" })
    .where(
      and(
        eq(entities.projectId, projectId),
        eq(entities.referenceStatus, "generating"),
        lt(entities.updatedAt, cutoff),
      ),
    );
  await db
    .update(shots)
    .set({ imageStatus: "failed" })
    .where(
      and(
        eq(shots.projectId, projectId),
        eq(shots.imageStatus, "generating"),
        lt(shots.updatedAt, cutoff),
      ),
    );
  await db
    .update(shots)
    .set({ clipStatus: "failed" })
    .where(
      and(
        eq(shots.projectId, projectId),
        eq(shots.clipStatus, "generating"),
        lt(shots.updatedAt, cutoff),
      ),
    );
}

export async function computeBatchTargets(projectId: string): Promise<BatchTargets> {
  await healStaleGenerating(projectId);

  const entityRows = await db
    .select({ id: entities.id, referenceStatus: entities.referenceStatus })
    .from(entities)
    .where(eq(entities.projectId, projectId));
  const shotRows = await db
    .select({
      id: shots.id,
      imageStatus: shots.imageStatus,
      clipStatus: shots.clipStatus,
      imagePrompt: shots.imagePrompt,
      motionPrompt: shots.motionPrompt,
      referencedEntityIds: shots.referencedEntityIds,
    })
    .from(shots)
    .where(eq(shots.projectId, projectId));

  const taggedEntityIds = new Set<string>();
  for (const s of shotRows) for (const eid of s.referencedEntityIds ?? []) taggedEntityIds.add(eid);

  const missing = (status: string | null) =>
    (status ?? "pending") === "pending" || status === "failed";

  return {
    sheetEntityIds: entityRows
      .filter((e) => taggedEntityIds.has(e.id) && missing(e.referenceStatus))
      .map((e) => e.id),
    imageShotIds: shotRows
      .filter((s) => missing(s.imageStatus) && s.imagePrompt.trim().length > 0)
      .map((s) => s.id),
    clipShotIds: shotRows
      .filter((s) => missing(s.clipStatus) && s.motionPrompt.trim().length > 0)
      .map((s) => s.id),
    anyGenerating:
      entityRows.some((e) => e.referenceStatus === "generating") ||
      shotRows.some((s) => s.imageStatus === "generating" || s.clipStatus === "generating"),
  };
}
