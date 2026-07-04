/**
 * PATCH  /api/projects/[id]/entities/[entityId] — update name/description
 * DELETE /api/projects/[id]/entities/[entityId] — remove an entity
 *
 * PATCH accepts a subset of { name, description }; type is immutable in
 * v1. Editing description does NOT auto-regenerate the reference sheet
 * (redraw is explicit, Task 2).
 *
 * DELETE strips the entity's id from every shot's referencedEntityIds
 * (project-scoped), deletes the reference-sheet object from R2 if one
 * exists, then deletes the entity row.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, entities, shots } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl, deleteObject } from "@/lib/r2";

type Params = { params: Promise<{ id: string; entityId: string }> };

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;

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

export async function PATCH(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, entityId } = await params;
  if (!isValidUUID(id) || !isValidUUID(entityId)) return badRequestResponse("Invalid IDs");

  const { project, entity } = await loadOwnedProjectAndEntity(id, entityId, session.user.id);
  if (!project || !entity) return notFoundResponse();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return badRequestResponse("Invalid request body");
  }
  const body = rawBody as Partial<{ name: string; description: string }>;

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return badRequestResponse("name must be a string");
    }
    const name = body.name.trim();
    if (name.length === 0) {
      return badRequestResponse("name cannot be empty");
    }
    if (name.length > MAX_NAME_LENGTH) {
      return badRequestResponse(`name must be under ${MAX_NAME_LENGTH} characters`);
    }

    const existing = await db
      .select({ id: entities.id, name: entities.name })
      .from(entities)
      .where(eq(entities.projectId, id));
    const nameTaken = existing.some(
      (e) => e.id !== entityId && e.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (nameTaken) {
      return badRequestResponse("An entity with this name already exists");
    }

    updates.name = name;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return badRequestResponse("description must be a string");
    }
    const trimmed = body.description.trim();
    if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
      return badRequestResponse(
        `description must be under ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    updates.description = trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(entities)
    .set(updates)
    .where(eq(entities.id, entityId))
    .returning();

  return NextResponse.json({
    ...updated,
    referenceSheetUrl: updated.referenceSheetPath
      ? await getDownloadUrl(updated.referenceSheetPath)
      : null,
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, entityId } = await params;
  if (!isValidUUID(id) || !isValidUUID(entityId)) return badRequestResponse("Invalid IDs");

  const { project, entity } = await loadOwnedProjectAndEntity(id, entityId, session.user.id);
  if (!project || !entity) return notFoundResponse();

  // Strip the entity's id from every shot's referencedEntityIds
  // (project-scoped) before the row disappears.
  const projectShots = await db
    .select({ id: shots.id, referencedEntityIds: shots.referencedEntityIds })
    .from(shots)
    .where(eq(shots.projectId, id));

  for (const s of projectShots) {
    const tagged = s.referencedEntityIds ?? [];
    if (!tagged.includes(entityId)) continue;
    await db
      .update(shots)
      .set({ referencedEntityIds: tagged.filter((eId) => eId !== entityId) })
      .where(eq(shots.id, s.id));
  }

  if (entity.referenceSheetPath) {
    try {
      await deleteObject(entity.referenceSheetPath);
    } catch {
      // Object may already be gone — deletion of the row proceeds regardless.
    }
  }

  await db.delete(entities).where(eq(entities.id, entityId));
  return NextResponse.json({ ok: true });
}
