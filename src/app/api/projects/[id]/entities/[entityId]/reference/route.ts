/**
 * POST /api/projects/[id]/entities/[entityId]/reference
 * (Re)generates an entity's multi-view reference sheet via text-to-image
 * (FLUX Kontext), using the type-specific prompt template from
 * reference-sheet.ts plus the project's style string. Stores the result at
 * projects/{projectId}/entities/{entityId}/sheet.png and returns the
 * updated entity row with a fresh presigned referenceSheetUrl.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, entities } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  isValidUUID,
  badRequestResponse,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { generateImage } from "@/lib/image-generation";
import { sheetPrompt } from "@/lib/reference-sheet";

type Params = { params: Promise<{ id: string; entityId: string }> };

async function loadOwnedProjectAndEntity(projectId: string, entityId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project || project.deletedAt) return { project: null, entity: null };

  const [entity] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.projectId, projectId)))
    .limit(1);
  return { project, entity: entity ?? null };
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, entityId } = await params;
  if (!isValidUUID(id) || !isValidUUID(entityId)) return badRequestResponse("Invalid IDs");

  const { project, entity } = await loadOwnedProjectAndEntity(id, entityId, session.user.id);
  if (!project || !entity) return notFoundResponse();

  await db
    .update(entities)
    .set({ referenceStatus: "generating" })
    .where(eq(entities.id, entityId));

  try {
    const r2Key = `projects/${id}/entities/${entityId}/sheet.png`;
    const result = await generateImage({
      r2Key,
      stillImagePrompt: sheetPrompt(entity),
      styleString: project.styleString,
    });

    const [updated] = await db
      .update(entities)
      .set({
        referenceSheetPath: result.r2Key,
        referenceStatus: "done",
      })
      .where(eq(entities.id, entityId))
      .returning();

    return NextResponse.json({
      ...updated,
      referenceSheetUrl: updated.referenceSheetPath
        ? await getDownloadUrl(updated.referenceSheetPath)
        : null,
    });
  } catch (err) {
    console.error(`Reference sheet generation failed for entity ${entityId}:`, err);
    await db
      .update(entities)
      .set({ referenceStatus: "failed" })
      .where(eq(entities.id, entityId));
    return NextResponse.json(
      { error: "Reference sheet generation failed" },
      { status: 502 },
    );
  }
}
