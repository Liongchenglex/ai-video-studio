/**
 * POST /api/style-templates/[templateId]/apply
 * Applies a saved style template to a target project.
 * Copies style string and reference image paths — no re-analysis needed.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { styleTemplates, projects } from "@/lib/db/schema";
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

type Params = { params: Promise<{ templateId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { templateId } = await params;
  if (!isValidUUID(templateId)) return badRequestResponse("Invalid template ID");

  let body: { projectId: string };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!body.projectId || !isValidUUID(body.projectId)) {
    return badRequestResponse("Valid project ID is required");
  }

  const [template] = await db
    .select()
    .from(styleTemplates)
    .where(
      and(
        eq(styleTemplates.id, templateId),
        eq(styleTemplates.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!template) return notFoundResponse();

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

  const [updated] = await db
    .update(projects)
    .set({
      styleString: template.styleString,
      styleRefPaths: template.refPaths,
      stylePreviewPath: template.previewPath,
    })
    .where(and(eq(projects.id, body.projectId), eq(projects.userId, session.user.id)))
    .returning();

  return NextResponse.json({
    styleString: updated.styleString,
    styleRefPaths: updated.styleRefPaths,
  });
}
