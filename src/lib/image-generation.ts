/**
 * Image generation service using FLUX.1 Kontext via fal.ai.
 * Generates a scene image from a scene description and optional style references.
 * Downloads the result and stores it in R2.
 */
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

interface GenerateImageInput {
  projectId: string;
  sceneId: string;
  sceneDescription: string;
  styleString?: string | null;
  styleRefPaths?: string[] | null;
}

interface GenerateImageResult {
  r2Key: string;
  downloadUrl: string;
}

/**
 * Generates a scene image and stores it in R2.
 * Uses FLUX.1 Kontext with style references when available.
 * The sceneDescription is used directly as the image prompt.
 */
export async function generateSceneImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const prompt = input.styleString
    ? `${input.styleString}. ${input.sceneDescription}`
    : input.sceneDescription;

  let imageUrl: string;

  if (input.styleRefPaths && input.styleRefPaths.length > 0) {
    const refUrls = await Promise.all(input.styleRefPaths.map(getDownloadUrl));

    const result = await fal.subscribe("fal-ai/flux-pro/kontext/max/multi", {
      input: {
        prompt,
        image_urls: refUrls,
        num_images: 1,
        output_format: "png",
        safety_tolerance: "2",
      },
    });

    const output = result.data as { images?: Array<{ url: string }> };
    if (!output.images || output.images.length === 0) {
      throw new Error("FLUX.1 Kontext returned no images");
    }
    imageUrl = output.images[0].url;
  } else {
    // image_urls is required by the type but can be omitted at runtime
    // when no style references are provided; cast to satisfy the type checker.
    const result = await fal.subscribe("fal-ai/flux-pro/kontext/max/multi", {
      input: {
        prompt,
        image_urls: [] as string[],
        num_images: 1,
        output_format: "png",
        safety_tolerance: "2",
      },
    });

    const output = result.data as { images?: Array<{ url: string }> };
    if (!output.images || output.images.length === 0) {
      throw new Error("Image generation returned no images");
    }
    imageUrl = output.images[0].url;
  }

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
