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
import { generateEntitySheet } from "@/lib/entity-sheet-generation";

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

  try {
    const updated = await generateEntitySheet(project, entity);
    return NextResponse.json({
      ...updated,
      referenceSheetUrl: updated.referenceSheetPath
        ? await getDownloadUrl(updated.referenceSheetPath)
        : null,
    });
  } catch (err) {
    console.error(`Reference sheet generation failed for entity ${entityId}:`, err);
    return NextResponse.json(
      { error: "Reference sheet generation failed" },
      { status: 502 },
    );
  }
}
