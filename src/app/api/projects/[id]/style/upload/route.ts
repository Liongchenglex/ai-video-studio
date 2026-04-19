/**
 * POST /api/projects/[id]/style/upload
 * Generates presigned R2 upload URLs for style reference images.
 * Client uploads directly to R2 using the returned URLs.
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
import { getUploadUrl, styleRefKey } from "@/lib/r2";

const MAX_IMAGES = 3;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

type Params = { params: Promise<{ id: string }> };

interface UploadRequest {
  files: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
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

  let body: UploadRequest;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return badRequestResponse("At least one file is required");
  }
  if (body.files.length > MAX_IMAGES) {
    return badRequestResponse(`Maximum ${MAX_IMAGES} reference images allowed`);
  }

  const errors: string[] = [];
  for (const file of body.files) {
    if (!file.filename || !file.contentType || !file.size) {
      errors.push("Each file must have filename, contentType, and size");
      continue;
    }
    if (file.filename.length > 255) {
      errors.push(`${file.filename.slice(0, 20)}...: filename too long`);
      continue;
    }
    if (!ALLOWED_TYPES.includes(file.contentType)) {
      errors.push(`${file.filename}: must be JPEG, PNG, or WebP`);
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`${file.filename}: exceeds 10MB limit`);
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
  }

  const uploads = await Promise.all(
    body.files.map(async (file) => {
      const sanitized = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = styleRefKey(id, `${Date.now()}-${sanitized}`);
      const uploadUrl = await getUploadUrl(key, file.contentType, file.size);
      return { key, uploadUrl, filename: file.filename };
    }),
  );

  return NextResponse.json({ uploads });
}
