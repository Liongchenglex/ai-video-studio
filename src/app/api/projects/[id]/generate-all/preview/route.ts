/**
 * GET /api/projects/[id]/generate-all/preview
 * Itemized cost preview for the batch "Generate all" confirm dialog (v4 P3;
 * clip model + SFX aware since Clip Engine v2; duration-aware since
 * directing-controls task 10). Counts missing-only work (sheets for tagged
 * entities, shot images, shot clips) server-side and multiplies by the
 * per-unit USD estimates for the requested clip model and SFX inclusion.
 * Clip cost sums each target shot's resolved duration (its beat slot vs. any
 * explicit clipDurationChoice, per resolveClipDuration) rather than assuming
 * every clip is the model's default length. sfx.count is ALWAYS the
 * potential SFX work (clips this run + done clips missing SFX) so the
 * dialog can offer an SFX-only batch; sfx.estUsd follows the includeSfx flag
 * (0 unless requested). Display only — the dispatch endpoint recomputes
 * targeting itself and never trusts these numbers. Query params: clipModel,
 * includeSfx.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
} from "@/lib/api-utils";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { estimateBatchCost } from "@/lib/generation-costs";
import { isClipModelId, getClipModel, DEFAULT_CLIP_MODEL_ID, resolveClipDuration } from "@/lib/clip-models";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project || project.deletedAt) return notFoundResponse();

  const url = new URL(request.url);
  const clipModelParam = url.searchParams.get("clipModel");
  if (clipModelParam !== null && !isClipModelId(clipModelParam)) {
    return badRequestResponse("Unknown clip model");
  }
  const includeSfx = url.searchParams.get("includeSfx") === "true";

  const targets = await computeBatchTargets(id);
  // Potential SFX work: clips generated this run need SFX too, plus
  // already-done clips missing it. Reported regardless of includeSfx so the
  // dialog can offer the SFX-only path; the cost stays gated on the flag.
  const sfxCount = targets.clipShotIds.length + targets.sfxShotIds.length;

  // Duration-aware clip cost: sum each target shot's resolved duration
  // (beat slot vs. any explicit choice) under the selected model, rather
  // than assuming every clip runs the model's default length.
  const clipModelSpec = getClipModel(clipModelParam) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
  const clipShotRows =
    targets.clipShotIds.length > 0
      ? await db
          .select({
            startInBeat: shots.startInBeat,
            endInBeat: shots.endInBeat,
            clipDurationChoice: shots.clipDurationChoice,
          })
          .from(shots)
          .where(inArray(shots.id, targets.clipShotIds))
      : [];
  const clipSecondsTotal = clipShotRows.reduce((sum, s) => {
    const slotSeconds =
      s.startInBeat !== null && s.endInBeat !== null ? s.endInBeat - s.startInBeat : null;
    return sum + resolveClipDuration(clipModelSpec, slotSeconds, s.clipDurationChoice ?? null);
  }, 0);

  const cost = estimateBatchCost(
    {
      sheets: targets.sheetEntityIds.length,
      images: targets.imageShotIds.length,
      clips: targets.clipShotIds.length,
      sfx: sfxCount,
    },
    { clipModelId: clipModelParam ?? undefined, includeSfx, clipSecondsTotal },
  );

  return NextResponse.json({
    sheets: { count: targets.sheetEntityIds.length, estUsd: cost.sheetsUsd },
    images: { count: targets.imageShotIds.length, estUsd: cost.imagesUsd },
    clips: { count: targets.clipShotIds.length, estUsd: cost.clipsUsd },
    sfx: { count: sfxCount, estUsd: cost.sfxUsd },
    totalUsd: cost.totalUsd,
    totalWithClipsUsd: cost.totalWithClipsUsd,
    batchRunning: targets.anyGenerating,
  });
}
