/**
 * POST /api/projects/[id]/style/preview
 * Generates a style preview image using FLUX.1 Kontext.
 * Downloads the generated image and stores it in R2 so it persists
 * beyond fal.ai's temporary URL expiry.
 */
import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
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
import { r2Client, stylePreviewKey, getDownloadUrl } from "@/lib/r2";

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

    // Download from fal.ai and upload to R2 for permanent storage
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error("Failed to download preview image from fal.ai");
    }
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    const contentType = imageRes.headers.get("content-type") || "image/png";

    const key = stylePreviewKey(id);
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: imageBuffer,
        ContentType: contentType,
      }),
    );

    // Store the R2 key (not the fal.ai URL) on the project
    await db
      .update(projects)
      .set({ stylePreviewPath: key })
      .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)));

    // Return a presigned download URL for the client
    const previewUrl = await getDownloadUrl(key);
    return NextResponse.json({ previewUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preview generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
