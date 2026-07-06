/**
 * Entity reference-sheet generation service (v4 P3 extraction).
 * Owns the full lifecycle for (re)generating one entity's multi-view
 * reference sheet: flips referenceStatus generating → done/failed, generates
 * via FLUX Kontext text-to-image with the type-specific sheet prompt + the
 * project's style string, stores at
 * projects/{projectId}/entities/{entityId}/sheet.png.
 * Called by POST /entities/[entityId]/reference AND the batch orchestrator —
 * one implementation, two callers. Throws after marking failed.
 */
import { db } from "@/lib/db";
import { entities, type Entity, type Project } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateImage } from "@/lib/image-generation";
import { sheetPrompt } from "@/lib/reference-sheet";

export async function generateEntitySheet(
  project: Project,
  entity: Entity,
): Promise<Entity> {
  await db
    .update(entities)
    .set({ referenceStatus: "generating" })
    .where(eq(entities.id, entity.id));

  try {
    const r2Key = `projects/${project.id}/entities/${entity.id}/sheet.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: sheetPrompt(entity),
      styleString: project.styleString,
    });

    const [updated] = await db
      .update(entities)
      .set({ referenceSheetPath: result.r2Key, referenceStatus: "done" })
      .where(eq(entities.id, entity.id))
      .returning();
    return updated;
  } catch (err) {
    await db
      .update(entities)
      .set({ referenceStatus: "failed" })
      .where(eq(entities.id, entity.id))
      .catch(() => {});
    throw err;
  }
}
