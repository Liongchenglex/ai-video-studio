/**
 * Image generation service using FLUX Kontext via fal.ai.
 * Generates a scene image from a scene description with optional style conditioning.
 * Downloads the result and stores it in R2.
 */
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

interface GenerateImageInput {
  /** Full R2 key the caller wants the image stored at. */
  r2Key: string;
  /** Concrete visual description (no motion words). */
  stillImagePrompt: string;
  /** Optional style conditioning appended to the prompt. */
  styleString?: string | null;
}

interface GenerateImageResult {
  r2Key: string;
  downloadUrl: string;
}

/**
 * Generates an image via FLUX Kontext and stores it at the caller-provided R2 key.
 * Still image prompt is the subject; style string is appended as a style modifier.
 */
export async function generateImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const prompt = input.styleString
    ? `${input.stillImagePrompt}. Style: ${input.styleString}`
    : input.stillImagePrompt;

  const result = await fal.subscribe("fal-ai/flux-pro/kontext/text-to-image", {
    input: {
      prompt,
    },
  });

  const output = result.data as { images?: Array<{ url: string }> };
  if (!output.images || output.images.length === 0) {
    throw new Error("Image generation returned no images");
  }

  const imageUrl = output.images[0].url;

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error("Failed to download generated image");
  }
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const contentType = imageRes.headers.get("content-type") || "image/png";

  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: input.r2Key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );

  const downloadUrl = await getDownloadUrl(input.r2Key);
  return { r2Key: input.r2Key, downloadUrl };
}
