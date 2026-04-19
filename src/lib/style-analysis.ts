/**
 * Style analysis service using Claude Vision.
 * Analyses reference images and returns a concise style descriptor
 * string (max 120 tokens) used to condition all downstream generation calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getDownloadUrl } from "@/lib/r2";

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a visual style analyst. Examine the provided reference images and return a single concise style descriptor string (maximum 120 tokens) that captures:
- Visual style (e.g. flat vector, photorealistic, watercolour, cel animation)
- Colour palette (e.g. warm muted tones, high contrast neon, desaturated earth tones)
- Line treatment (e.g. thick black outlines, no outlines, soft edges)
- Lighting (e.g. cinematic ambient, flat lighting, dramatic shadows)
- Mood (e.g. epic, playful, clinical, melancholic)
- Perspective (e.g. isometric, first-person, bird's eye)

Return ONLY the descriptor string. No explanation. No preamble.`;

/**
 * Fetches images from R2 as base64 for Claude Vision input.
 */
async function fetchImageAsBase64(
  r2Key: string,
): Promise<{ base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" }> {
  const url = await getDownloadUrl(r2Key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from R2: ${r2Key}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const contentType = response.headers.get("content-type") || "image/png";
  const mediaType = contentType as "image/jpeg" | "image/png" | "image/webp";

  return { base64, mediaType };
}

/**
 * Analyses reference images using Claude Vision and returns a style string.
 * All images are sent in a single API call for holistic analysis.
 */
export async function analyseStyleImages(
  r2Keys: string[],
): Promise<string> {
  if (r2Keys.length === 0) {
    throw new Error("At least one reference image is required");
  }

  const imageContents = await Promise.all(
    r2Keys.map(async (key) => {
      const { base64, mediaType } = await fetchImageAsBase64(key);
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType,
          data: base64,
        },
      };
    }),
  );

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          ...imageContents,
          {
            type: "text",
            text: "Analyse these reference images and return the style descriptor string.",
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  return textBlock.text.trim();
}
