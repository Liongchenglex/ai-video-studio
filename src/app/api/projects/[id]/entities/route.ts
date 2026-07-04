/**
 * API routes for a project's Reference Bible entities (F-16, v4.0).
 * GET  /api/projects/[id]/entities — list entities with presigned sheet
 *      URLs and a shot-tag count computed over the project's shots.
 * POST /api/projects/[id]/entities — create a new entity (character,
 *      location, or object). Reference sheets are generated separately
 *      (Task 2) — a newly created entity always starts with no sheet.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, entities, shots, entityTypeEnum } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";

type Params = { params: Promise<{ id: string }> };

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const ENTITY_TYPES = entityTypeEnum.enumValues;

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

  const rows = await db
    .select()
    .from(entities)
    .where(eq(entities.projectId, id))
    .orderBy(asc(entities.createdAt));

  // shotCount = number of shots whose referencedEntityIds contains the
  // entity's id — computed in JS over one project-scoped query.
  const shotRows = await db
    .select({ referencedEntityIds: shots.referencedEntityIds })
    .from(shots)
    .where(eq(shots.projectId, id));

  const shotCountById = new Map<string, number>();
  for (const s of shotRows) {
    for (const entityId of s.referencedEntityIds ?? []) {
      shotCountById.set(entityId, (shotCountById.get(entityId) ?? 0) + 1);
    }
  }

  const withUrls = await Promise.all(
    rows.map(async (e) => ({
      ...e,
      referenceSheetUrl: e.referenceSheetPath
        ? await getDownloadUrl(e.referenceSheetPath)
        : null,
      shotCount: shotCountById.get(e.id) ?? 0,
    })),
  );

  return NextResponse.json({ entities: withUrls });
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

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

  let body: { name?: string; type?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (typeof body.name !== "string") {
    return badRequestResponse("name is required");
  }
  const name = body.name.trim();
  if (name.length === 0) {
    return badRequestResponse("name is required");
  }
  if (name.length > MAX_NAME_LENGTH) {
    return badRequestResponse(`name must be under ${MAX_NAME_LENGTH} characters`);
  }

  if (
    typeof body.type !== "string" ||
    !(ENTITY_TYPES as readonly string[]).includes(body.type)
  ) {
    return badRequestResponse("type must be one of character, location, object");
  }
  const type = body.type as (typeof ENTITY_TYPES)[number];

  let description: string | null = null;
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
    description = trimmed.length > 0 ? trimmed : null;
  }

  const existing = await db
    .select({ name: entities.name })
    .from(entities)
    .where(eq(entities.projectId, id));
  const nameTaken = existing.some(
    (e) => e.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (nameTaken) {
    return badRequestResponse("An entity with this name already exists");
  }

  const [created] = await db
    .insert(entities)
    .values({
      projectId: id,
      name,
      type,
      description,
    })
    .returning();

  return NextResponse.json({ ...created, referenceSheetUrl: null }, { status: 201 });
}
