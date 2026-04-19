/**
 * GET  /api/projects/[id]/style — get current style profile
 * PUT  /api/projects/[id]/style — save style string and ref paths
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
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";

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

  // Generate download URLs for reference images so the client can display them
  const refUrls = project.styleRefPaths
    ? await Promise.all(project.styleRefPaths.map(getDownloadUrl))
    : [];

  const previewUrl = project.stylePreviewPath
    ? await getDownloadUrl(project.stylePreviewPath)
    : null;

  return NextResponse.json({
    styleString: project.styleString,
    styleRefPaths: project.styleRefPaths,
    styleRefUrls: refUrls,
    stylePreviewUrl: previewUrl,
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
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

  let body: { styleString?: string; styleRefPaths?: string[] };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const updates: Record<string, unknown> = {};

  if (body.styleString !== undefined) {
    const trimmed = body.styleString.trim();
    if (trimmed.length === 0) {
      return badRequestResponse("Style string cannot be empty");
    }
    // 120 tokens ~= 480 characters as a rough ceiling
    if (trimmed.length > 600) {
      return badRequestResponse("Style string is too long (keep under ~120 tokens)");
    }
    updates.styleString = trimmed;
  }

  if (body.styleRefPaths !== undefined) {
    if (!Array.isArray(body.styleRefPaths)) {
      return badRequestResponse("styleRefPaths must be an array");
    }
    if (body.styleRefPaths.length > 3) {
      return badRequestResponse("Maximum 3 reference images allowed");
    }
    updates.styleRefPaths = body.styleRefPaths;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .returning();

  return NextResponse.json({
    styleString: updated.styleString,
    styleRefPaths: updated.styleRefPaths,
  });
}
