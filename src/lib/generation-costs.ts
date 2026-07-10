/**
 * Per-unit USD cost ESTIMATES for batch generation ("Generate all", v4 P3;
 * clip pricing registry-driven since Clip Engine v2). Display-only
 * ballparks for the cost-preview dialog — the UI must label them as
 * estimates. Clip cost comes from the selected model's registry entry.
 */
import { getClipModel, DEFAULT_CLIP_MODEL_ID, SFX_EST_USD } from "@/lib/clip-models";

export const SHEET_EST_USD = 0.04;
export const IMAGE_EST_USD = 0.04;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimateBatchCost(
  counts: { sheets: number; images: number; clips: number; sfx?: number },
  opts?: { clipModelId?: string; includeSfx?: boolean },
) {
  const clipModel = getClipModel(opts?.clipModelId) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
  const sheetsUsd = round2(counts.sheets * SHEET_EST_USD);
  const imagesUsd = round2(counts.images * IMAGE_EST_USD);
  const clipsUsd = round2(counts.clips * clipModel.estUsdPerClip);
  // sfx count may exceed clips: already-done clips missing SFX are targeted too.
  const sfxUsd = opts?.includeSfx ? round2((counts.sfx ?? counts.clips) * SFX_EST_USD) : 0;
  return {
    sheetsUsd,
    imagesUsd,
    clipsUsd,
    sfxUsd,
    totalUsd: round2(sheetsUsd + imagesUsd),
    totalWithClipsUsd: round2(sheetsUsd + imagesUsd + clipsUsd + sfxUsd),
  };
}
