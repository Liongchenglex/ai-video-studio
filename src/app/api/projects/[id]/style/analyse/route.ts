/**
 * POST /api/projects/[id]/style/analyse
 * Triggers Claude Vision analysis of the project's uploaded reference images.
 * Returns the generated style descriptor string.
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
import { analyseStyleImages } from "@/lib/style-analysis";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
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

  const refPaths = project.styleRefPaths;
  if (!refPaths || refPaths.length === 0) {
    return badRequestResponse("Upload reference images first");
  }

  try {
    const styleString = await analyseStyleImages(refPaths);

    await db
      .update(projects)
      .set({ styleString })
      .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)));

    return NextResponse.json({ styleString });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    console.error("Style analysis failed:", rawMessage);

    if (rawMessage.includes("content policy")) {
      return NextResponse.json(
        { error: "Images were flagged by content policy. Please use different reference images." },
        { status: 422 },
      );
    }

    return NextResponse.json(
      { error: "Style analysis failed. Please try again." },
      { status: 500 },
    );
  }
}
