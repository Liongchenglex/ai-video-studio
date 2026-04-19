/**
 * GET  /api/style-templates — list all templates for the authenticated user
 * POST /api/style-templates — save current project's style as a reusable template
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { styleTemplates, projects } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  badRequestResponse,
  notFoundResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const templates = await db
    .select()
    .from(styleTemplates)
    .where(eq(styleTemplates.userId, session.user.id))
    .orderBy(desc(styleTemplates.updatedAt));

  const templatesWithUrls = await Promise.all(
    templates.map(async (t) => ({
      ...t,
      refUrls: await Promise.all(t.refPaths.map(getDownloadUrl)),
      previewUrl: t.previewPath ? await getDownloadUrl(t.previewPath) : null,
    })),
  );

  return NextResponse.json(templatesWithUrls);
}

export async function POST(request: NextRequest) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  let body: { projectId: string; name: string };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!body.name?.trim()) {
    return badRequestResponse("Template name is required");
  }
  if (body.name.trim().length > 100) {
    return badRequestResponse("Template name must be under 100 characters");
  }

  if (!body.projectId || !isValidUUID(body.projectId)) {
    return badRequestResponse("Valid project ID is required");
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, body.projectId),
        eq(projects.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();

  if (!project.styleString || !project.styleRefPaths || project.styleRefPaths.length === 0) {
    return badRequestResponse("Project has no style profile to save as template");
  }

  const [template] = await db
    .insert(styleTemplates)
    .values({
      userId: session.user.id,
      name: body.name.trim(),
      styleString: project.styleString,
      refPaths: project.styleRefPaths,
      previewPath: project.stylePreviewPath,
    })
    .returning();

  return NextResponse.json(template, { status: 201 });
}
