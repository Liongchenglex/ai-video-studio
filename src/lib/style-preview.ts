/**
 * Style preview generation using FLUX.1 Kontext via fal.ai.
 * Generates a sample image conditioned on the project's style string
 * and reference images to let the user validate before committing.
 */
import { fal } from "@fal-ai/client";
import { getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

interface PreviewResult {
  imageUrl: string;
}

/**
 * Generates a style preview image using FLUX.1 Kontext.
 * Passes reference images + style string as input.
 */
export async function generateStylePreview(
  styleString: string,
  refR2Keys: string[],
): Promise<PreviewResult> {
  const refUrls = await Promise.all(refR2Keys.map(getDownloadUrl));

  const prompt = `A simple outdoor scene that showcases the visual style — ${styleString}`;

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

  return { imageUrl: output.images[0].url };
}
