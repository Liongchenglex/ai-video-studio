/**
 * GET /api/projects/[id]/generate-all/preview
 * Itemized cost preview for the batch "Generate all" confirm dialog (v4 P3;
 * clip model + SFX aware since Clip Engine v2). Counts missing-only work
 * (sheets for tagged entities, shot images, shot clips) server-side and
 * multiplies by the per-unit USD estimates for the requested clip model and
 * SFX inclusion. Display only — the dispatch endpoint recomputes targeting
 * itself and never trusts these numbers. Query params: clipModel, includeSfx.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
} from "@/lib/api-utils";
import { computeBatchTargets } from "@/lib/batch-targeting";
import { estimateBatchCost } from "@/lib/generation-costs";
import { isClipModelId } from "@/lib/clip-models";

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
  const cost = estimateBatchCost(
    {
      sheets: targets.sheetEntityIds.length,
      images: targets.imageShotIds.length,
      clips: targets.clipShotIds.length,
    },
    { clipModelId: clipModelParam ?? undefined, includeSfx },
  );

  return NextResponse.json({
    sheets: { count: targets.sheetEntityIds.length, estUsd: cost.sheetsUsd },
    images: { count: targets.imageShotIds.length, estUsd: cost.imagesUsd },
    clips: { count: targets.clipShotIds.length, estUsd: cost.clipsUsd },
    sfx: { count: includeSfx ? targets.clipShotIds.length : 0, estUsd: cost.sfxUsd },
    totalUsd: cost.totalUsd,
    totalWithClipsUsd: cost.totalWithClipsUsd,
    batchRunning: targets.anyGenerating,
  });
}
