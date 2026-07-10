/**
 * Shared R2 → fal.ai storage upload (Clip Engine v2 extraction — was
 * duplicated in shot-clip-generation and the deleted clip-hailuo route).
 * fal can't always read R2 presigned URLs, so we copy the bytes into fal
 * storage and fall back to a presigned URL only if the initiate call fails.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

export async function uploadR2ObjectToFal(
  r2Key: string,
  opts: { fileName: string; contentType: string },
): Promise<string> {
  const r2Object = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
  );
  const bytes = await r2Object.Body!.transformToByteArray();
  const buffer = Buffer.from(bytes);

  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_name: opts.fileName, content_type: opts.contentType }),
  });

  if (initRes.ok) {
    const { upload_url, file_url } = (await initRes.json()) as {
      upload_url: string;
      file_url: string;
    };
    const putRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": opts.contentType },
      body: buffer,
    });
    if (!putRes.ok) {
      throw new Error(`fal storage upload failed (${putRes.status}) for ${opts.fileName}`);
    }
    return file_url;
  }

  // Fallback: some fal models accept R2 presigned URLs directly
  return getDownloadUrl(r2Key);
}
