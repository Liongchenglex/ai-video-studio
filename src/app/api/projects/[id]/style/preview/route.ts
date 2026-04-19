/**
 * POST /api/projects/[id]/style/preview
 * Generates a style preview image using FLUX.1 Kontext.
 * Requires style string and reference images to be set on the project.
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
import { generateStylePreview } from "@/lib/style-preview";

type Params = { params: Promise<{ id: string }> };

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

  if (!project.styleRefPaths || project.styleRefPaths.length === 0) {
    return badRequestResponse("Upload reference images first");
  }

  if (!project.styleString) {
    return badRequestResponse("Analyse style first");
  }

  try {
    const { imageUrl } = await generateStylePreview(
      project.styleString,
      project.styleRefPaths,
    );

    await db
      .update(projects)
      .set({ stylePreviewPath: imageUrl })
      .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)));

    return NextResponse.json({ previewUrl: imageUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preview generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
