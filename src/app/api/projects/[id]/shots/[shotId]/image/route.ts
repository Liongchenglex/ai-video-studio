/**
 * POST /api/projects/[id]/shots/[shotId]/image
 * Generates (or regenerates) the image for a single shot using FLUX.1 Kontext
 * with the project's style string as conditioning. Stores in R2 and persists
 * the path on the shot row. Returns the new presigned download URL so the
 * client can update without a refresh.
 *
 * Reference Bible conditioning (F-16): if the shot is tagged with entities
 * (`referencedEntityIds`), resolves the primary tagged entity — the first
 * tagged entity of type `character` with a `done` reference sheet, else the
 * first tagged entity with a `done` sheet — and conditions generation on its
 * presigned reference-sheet URL via Kontext's image+prompt mode. Untagged or
 * not-yet-ready entities fall back to unconditioned generation, unchanged.
 *
 * Synchronous: awaits fal.ai. Typical latency 20-30s per image.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, entities, type Entity } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { generateImage } from "@/lib/image-generation";
import { getDownloadUrl } from "@/lib/r2";

type Params = { params: Promise<{ id: string; shotId: string }> };

/**
 * Resolves the shot's single primary conditioning entity, project-scoped:
 * the first tagged entity (in tag order) of type "character" with a "done"
 * reference sheet, else the first tagged entity (in tag order) with a "done"
 * sheet. Returns null if the shot has no tagged, ready entity.
 */
async function resolvePrimaryEntity(
  projectId: string,
  referencedEntityIds: string[] | null | undefined,
): Promise<Entity | null> {
  const taggedIds = referencedEntityIds ?? [];
  if (taggedIds.length === 0) return null;

  const readyRows = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.projectId, projectId),
        inArray(entities.id, taggedIds),
        eq(entities.referenceStatus, "done"),
      ),
    );
  const readyById = new Map(readyRows.map((e) => [e.id, e]));
  // Preserve tag order (DB row order is unspecified).
  const ordered = taggedIds
    .map((tid) => readyById.get(tid))
    .filter((e): e is Entity => e !== undefined);

  return ordered.find((e) => e.type === "character") ?? ordered[0] ?? null;
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

  const [row] = await db
    .select({ shot: shots, project: projects })
    .from(shots)
    .innerJoin(projects, eq(shots.projectId, projects.id))
    .where(and(eq(shots.id, shotId), eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!row) return notFoundResponse();
  const { shot, project } = row;

  if (!shot.imagePrompt?.trim()) {
    return badRequestResponse("Shot has no image prompt");
  }

  await db.update(shots).set({ imageStatus: "generating" }).where(eq(shots.id, shotId));

  try {
    const primaryEntity = await resolvePrimaryEntity(id, shot.referencedEntityIds);
    const referenceImageUrl = primaryEntity?.referenceSheetPath
      ? await getDownloadUrl(primaryEntity.referenceSheetPath)
      : null;

    console.log(
      `[shot/image] project=${id} shot=${shotId} | prompt: ${shot.imagePrompt.substring(0, 120)}... | ` +
        (primaryEntity
          ? `conditioned on entity=${primaryEntity.id} (${primaryEntity.name})`
          : "unconditioned"),
    );

    const r2Key = `projects/${project.id}/shots/${shot.id}/image.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: shot.imagePrompt,
      styleString: project.styleString,
      referenceImageUrl,
    });

    await db
      .update(shots)
      .set({ imagePath: result.r2Key, imageStatus: "done" })
      .where(eq(shots.id, shotId));

    console.log(`[shot/image] done: ${result.r2Key}`);
    return NextResponse.json({
      imagePath: result.r2Key,
      imageUrl: result.downloadUrl,
      imageStatus: "done",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/image] failed:`, msg);
    await db.update(shots).set({ imageStatus: "failed" }).where(eq(shots.id, shotId)).catch(() => {});
    return NextResponse.json({ error: msg, imageStatus: "failed" }, { status: 500 });
  }
}
