/**
 * Shot image generation service (v4 P3 extraction).
 * Owns the full lifecycle for (re)generating one shot's still image: flips
 * imageStatus generating → done/failed, resolves the shot's primary tagged
 * entity (first character with a done sheet, else first done sheet) and
 * conditions FLUX Kontext on its reference sheet, else falls back to
 * unconditioned. Stores at projects/{projectId}/shots/{shotId}/image.png.
 * Called by POST /shots/[shotId]/image AND the batch orchestrator.
 * Throws after marking failed. Caller must ensure imagePrompt is non-empty.
 */
import { db } from "@/lib/db";
import { shots, entities, type Entity, type Project, type Shot } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateImage } from "@/lib/image-generation";
import { getDownloadUrl } from "@/lib/r2";

export async function resolvePrimaryEntity(
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

export async function generateShotImage(
  project: Project,
  shot: Shot,
): Promise<{ imagePath: string; imageUrl: string }> {
  await db.update(shots).set({ imageStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    const primaryEntity = await resolvePrimaryEntity(project.id, shot.referencedEntityIds);
    const referenceImageUrl = primaryEntity?.referenceSheetPath
      ? await getDownloadUrl(primaryEntity.referenceSheetPath)
      : null;

    console.log(
      `[shot-image] project=${project.id} shot=${shot.id} | prompt: ${shot.imagePrompt.substring(0, 120)}... | ` +
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
      referenceSubjectName: primaryEntity?.name ?? null,
    });

    await db
      .update(shots)
      .set({ imagePath: result.r2Key, imageStatus: "done" })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-image] done: ${result.r2Key}`);
    return { imagePath: result.r2Key, imageUrl: result.downloadUrl };
  } catch (error) {
    await db.update(shots).set({ imageStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
