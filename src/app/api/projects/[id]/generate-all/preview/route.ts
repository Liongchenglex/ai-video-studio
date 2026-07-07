/**
 * GET /api/projects/[id]/generate-all/preview
 * Itemized cost preview for the batch "Generate all" confirm dialog (v4 P3).
 * Counts missing-only work (sheets for tagged entities, shot images, shot
 * clips) server-side and multiplies by the per-unit USD estimates. Display
 * only — the dispatch endpoint recomputes targeting itself and never trusts
 * these numbers.
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

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
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

  const targets = await computeBatchTargets(id);
  const cost = estimateBatchCost({
    sheets: targets.sheetEntityIds.length,
    images: targets.imageShotIds.length,
    clips: targets.clipShotIds.length,
  });

  return NextResponse.json({
    sheets: { count: targets.sheetEntityIds.length, estUsd: cost.sheetsUsd },
    images: { count: targets.imageShotIds.length, estUsd: cost.imagesUsd },
    clips: { count: targets.clipShotIds.length, estUsd: cost.clipsUsd },
    totalUsd: cost.totalUsd,
    totalWithClipsUsd: cost.totalWithClipsUsd,
    batchRunning: targets.anyGenerating,
  });
}
