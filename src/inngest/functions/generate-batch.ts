/**
 * Inngest function: batch "Generate all" orchestrator (v4 P3; extended for
 * Clip Engine v2). Four sequential waves over missing-only targets —
 * 1) reference sheets for tagged entities, 2) shot images (entity-conditioned
 * via the shared service), 2.5) optional AI chain suggestions (flags shots
 * whose clip should end on the next shot's still), 3) clips (only when
 * includeClips, only for shots whose image is done, threading the selected
 * clip model), 4) optional SFX for shots whose clip just finished. Each item
 * is one step that flips the row's own status column; a failed item marks
 * its row `failed` and NEVER halts the batch (re-running Generate all is the
 * retry). Paid work runs in chunks of 3 to bound concurrent fal.ai calls.
 * Per-project concurrency 1 makes double-dispatch harmless.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { projects, entities, shots } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { generateEntitySheet } from "@/lib/entity-sheet-generation";
import { generateShotImage } from "@/lib/shot-image-generation";
import { generateShotClip } from "@/lib/shot-clip-generation";
import { suggestChains } from "@/lib/chain-suggestion";
import { generateShotSfx } from "@/lib/sfx-generation";

const CHUNK_SIZE = 3;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const generateBatchFn = inngest.createFunction(
  {
    id: "generate-batch",
    retries: 1,
    concurrency: [{ scope: "fn", key: "event.data.projectId", limit: 1 }],
  },
  { event: "project/batch.generate" },
  async ({ event, step }) => {
    const {
      projectId,
      includeClips,
      clipModel,
      suggestChains: suggestChainsFlag,
      includeSfx,
    } = event.data as {
      projectId: string;
      includeClips: boolean;
      clipModel?: string;
      suggestChains?: boolean;
      includeSfx?: boolean;
    };

    // Re-verify the project exists before spending money.
    const projectExists = await step.run("verify-project", async () => {
      const [p] = await db
        .select({ id: projects.id, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return !!p && !p.deletedAt;
    });
    if (!projectExists) return { skipped: "project-missing" };

    const targets = await step.run("compute-targets", () => computeBatchTargets(projectId));

    // ── Wave 1: reference sheets ──
    let sheetsFailed = 0;
    for (const chunk of chunked(targets.sheetEntityIds, CHUNK_SIZE)) {
      const results = await Promise.all(
        chunk.map((entityId) =>
          step.run(`sheet-${entityId}`, async () => {
            try {
              const [row] = await db
                .select({ entity: entities, project: projects })
                .from(entities)
                .innerJoin(projects, eq(entities.projectId, projects.id))
                .where(and(eq(entities.id, entityId), eq(projects.id, projectId)))
                .limit(1);
              if (!row) return { ok: false };
              // Targets were frozen at compute-targets; if the user manually
              // retried this item after that and it's already done, or its
              // retry is in flight right now, skip instead of re-billing it.
              if (row.entity.referenceStatus === "done" || row.entity.referenceStatus === "generating") {
                return { ok: true, skipped: true };
              }
              await generateEntitySheet(row.project, row.entity);
              return { ok: true };
            } catch (err) {
              console.error(`[batch] sheet failed entity=${entityId}:`, err);
              return { ok: false }; // row already marked failed by the service
            }
          }),
        ),
      );
      sheetsFailed += results.filter((r) => !r.ok).length;
    }

    // ── Wave 2: shot images (sheets from wave 1 now condition them) ──
    let imagesFailed = 0;
    for (const chunk of chunked(targets.imageShotIds, CHUNK_SIZE)) {
      const results = await Promise.all(
        chunk.map((shotId) =>
          step.run(`image-${shotId}`, async () => {
            try {
              const [row] = await db
                .select({ shot: shots, project: projects })
                .from(shots)
                .innerJoin(projects, eq(shots.projectId, projects.id))
                .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
                .limit(1);
              if (!row) return { ok: false };
              if (row.shot.imageStatus === "done" || row.shot.imageStatus === "generating") {
                return { ok: true, skipped: true };
              }
              await generateShotImage(row.project, row.shot);
              return { ok: true };
            } catch (err) {
              console.error(`[batch] image failed shot=${shotId}:`, err);
              return { ok: false };
            }
          }),
        ),
      );
      imagesFailed += results.filter((r) => !r.ok).length;
    }

    // ── Chain suggestions (optional, before clips) ──
    let chainsApplied = 0;
    if (includeClips && suggestChainsFlag) {
      chainsApplied = await step.run("suggest-chains", async () => {
        const [project] = await db
          .select({ brief: projects.brief })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const shotRows = await db
          .select({
            id: shots.id,
            sortOrder: shots.sortOrder,
            beatId: shots.beatId,
            imagePrompt: shots.imagePrompt,
            referencedEntityIds: shots.referencedEntityIds,
          })
          .from(shots)
          .where(eq(shots.projectId, projectId));
        const ids = await suggestChains(shotRows, project?.brief ?? null);
        if (ids.length > 0) {
          await db.update(shots).set({ chainToNext: true }).where(inArray(shots.id, ids));
        }
        return ids.length;
      });
    }

    // ── Wave 3: clips — re-check image readiness AFTER wave 2 ──
    let clipsFailed = 0;
    let clipsRun = 0;
    let sfxFailed = 0;
    if (includeClips) {
      const readyClipShotIds = await step.run("compute-clip-targets", async () => {
        const rows = await db
          .select({ id: shots.id, imageStatus: shots.imageStatus, imagePath: shots.imagePath })
          .from(shots)
          .where(eq(shots.projectId, projectId));
        const wanted = new Set(targets.clipShotIds);
        return rows
          .filter((s) => wanted.has(s.id) && s.imageStatus === "done" && s.imagePath)
          .map((s) => s.id);
      });
      clipsRun = readyClipShotIds.length;

      for (const chunk of chunked(readyClipShotIds, CHUNK_SIZE)) {
        const results = await Promise.all(
          chunk.map((shotId) =>
            step.run(`clip-${shotId}`, async () => {
              try {
                const [row] = await db
                  .select({ shot: shots, project: projects })
                  .from(shots)
                  .innerJoin(projects, eq(shots.projectId, projects.id))
                  .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
                  .limit(1);
                if (!row) return { ok: false };
                if (row.shot.clipStatus === "done" || row.shot.clipStatus === "generating") {
                  return { ok: true, skipped: true };
                }
                await generateShotClip(row.project, row.shot, { model: clipModel });
                return { ok: true };
              } catch (err) {
                console.error(`[batch] clip failed shot=${shotId}:`, err);
                return { ok: false };
              }
            }),
          ),
        );
        clipsFailed += results.filter((r) => !r.ok).length;
      }

      // ── Wave 4: SFX (optional) — only shots whose clip is now done ──
      if (includeSfx) {
        const sfxShotIds = await step.run("compute-sfx-targets", async () => {
          const rows = await db
            .select({ id: shots.id, clipStatus: shots.clipStatus, sfxStatus: shots.sfxStatus })
            .from(shots)
            .where(eq(shots.projectId, projectId));
          return rows
            .filter((s) => s.clipStatus === "done" && s.sfxStatus !== "done")
            .map((s) => s.id);
        });

        for (const chunk of chunked(sfxShotIds, CHUNK_SIZE)) {
          const results = await Promise.all(
            chunk.map((shotId) =>
              step.run(`sfx-${shotId}`, async () => {
                try {
                  const [row] = await db
                    .select({ shot: shots, project: projects })
                    .from(shots)
                    .innerJoin(projects, eq(shots.projectId, projects.id))
                    .where(and(eq(shots.id, shotId), eq(projects.id, projectId)))
                    .limit(1);
                  if (!row) return { ok: false };
                  if (row.shot.sfxStatus === "done" || row.shot.sfxStatus === "generating") {
                    return { ok: true, skipped: true };
                  }
                  if (!row.shot.clipPath || row.shot.clipStatus !== "done") {
                    return { ok: true, skipped: true };
                  }
                  await generateShotSfx(row.project, row.shot);
                  return { ok: true };
                } catch (err) {
                  console.error(`[batch] sfx failed shot=${shotId}:`, err);
                  return { ok: false };
                }
              }),
            ),
          );
          sfxFailed += results.filter((r) => !r.ok).length;
        }
      }
    }

    return {
      projectId,
      sheets: { total: targets.sheetEntityIds.length, failed: sheetsFailed },
      images: { total: targets.imageShotIds.length, failed: imagesFailed },
      clips: { total: clipsRun, failed: clipsFailed },
      chains: { applied: chainsApplied },
      sfx: { failed: sfxFailed },
    };
  },
);
