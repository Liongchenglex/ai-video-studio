/**
 * Per-unit USD cost ESTIMATES for batch generation ("Generate all", v4 P3).
 * These are display-only ballparks for the cost-preview dialog — the UI must
 * label them as estimates. Derived from observed fal.ai pricing for FLUX
 * Kontext (sheets/images) and LTX-2.3 image-to-video (clips).
 */
export const SHEET_EST_USD = 0.04;
export const IMAGE_EST_USD = 0.04;
export const CLIP_EST_USD = 0.25;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateBatchCost(counts: {
  sheets: number;
  images: number;
  clips: number;
}) {
  const sheetsUsd = round2(counts.sheets * SHEET_EST_USD);
  const imagesUsd = round2(counts.images * IMAGE_EST_USD);
  const clipsUsd = round2(counts.clips * CLIP_EST_USD);
  return {
    sheetsUsd,
    imagesUsd,
    clipsUsd,
    totalUsd: round2(sheetsUsd + imagesUsd),
    totalWithClipsUsd: round2(sheetsUsd + imagesUsd + clipsUsd),
  };
}
