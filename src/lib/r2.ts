/**
 * Cloudflare R2 storage client.
 * Provides S3-compatible access to R2 for uploading and retrieving
 * project assets (reference images, generated previews, etc.).
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Generates a presigned URL for uploading a file to R2.
 * The client uploads directly to R2 using this URL — the file never
 * passes through our server.
 */
export async function getUploadUrl(
  key: string,
  contentType: string,
  maxSizeBytes: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
    ContentLength: maxSizeBytes,
  });
  return getSignedUrl(r2Client, command, { expiresIn: 600 });
}

/**
 * Generates a presigned URL for reading a file from R2.
 * Used to serve images to the client without exposing R2 credentials.
 */
export async function getDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(r2Client, command, { expiresIn: 3600 });
}

/**
 * Deletes a file from R2. Used during project cleanup.
 */
export async function deleteObject(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  await r2Client.send(command);
}

/**
 * Builds the R2 key path for a project's style reference images.
 * Convention: projects/{projectId}/style-refs/{filename}
 */
export function styleRefKey(projectId: string, filename: string): string {
  return `projects/${projectId}/style-refs/${filename}`;
}

/**
 * Builds the R2 key path for a style preview image.
 */
export function stylePreviewKey(projectId: string): string {
  return `projects/${projectId}/style-preview.png`;
}
