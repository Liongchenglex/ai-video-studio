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
  projectId: string;
  sceneId: string;
  stillImagePrompt: string;
  styleString?: string | null;
}

interface GenerateImageResult {
  r2Key: string;
  downloadUrl: string;
}

/**
 * Generates a scene image and stores it in R2.
 * Uses text-to-image with the scene description as the primary prompt.
 * Style string is appended as a style modifier, not prepended.
 */
export async function generateSceneImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  // Still image prompt first (what to draw), style second (how it should look)
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

  // Download from fal.ai and upload to R2
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error("Failed to download generated image");
  }
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const contentType = imageRes.headers.get("content-type") || "image/png";

  const r2Key = `projects/${input.projectId}/scenes/${input.sceneId}/image.png`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );

  const downloadUrl = await getDownloadUrl(r2Key);
  return { r2Key, downloadUrl };
}
