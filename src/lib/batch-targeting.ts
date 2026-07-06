/**
 * Missing-only targeting for batch "Generate all" (v4 P3). One computation
 * used by the preview endpoint, the dispatch endpoint, and the Inngest
 * orchestrator, so the three can never disagree about what a batch covers.
 * Missing = status pending|failed. done is never re-billed; generating is
 * skipped (in-flight).
 */
import { db } from "@/lib/db";
import { entities, shots } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface BatchTargets {
  sheetEntityIds: string[];
  imageShotIds: string[];
  clipShotIds: string[];
  anyGenerating: boolean;
}

export async function computeBatchTargets(projectId: string): Promise<BatchTargets> {
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
