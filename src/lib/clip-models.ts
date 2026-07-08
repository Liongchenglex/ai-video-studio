/**
 * Clip model registry — the single source of truth for which fal.ai
 * image-to-video models the app can use (Clip Engine v2). Drives the
 * inspector dropdown, the clip route's allow-list validation, the
 * generation service's input mapping, and batch cost estimates.
 * Adding a model = adding one entry here. Client-supplied model ids MUST
 * be resolved through getClipModel/isClipModelId — never passed to fal raw.
 */

export type ClipModelId = "ltx-2.3" | "kling-2.5-turbo-pro" | "veo-3.1-fast";

export interface ClipModelSpec {
  id: ClipModelId;
  label: string;
  falEndpoint: string;
  /** Fixed output length used for estimates; actual output duration wins when fal returns one. */
  durationSeconds: number;
  /** Model accepts an end-frame image (enables "chain to next shot"). */
  supportsEndFrame: boolean;
  /** Model generates its own audio track. */
  nativeAudio: boolean;
  /** Display-only ballpark, same convention as generation-costs.ts. */
  estUsdPerClip: number;
  whenToUse: string;
  buildInput(args: {
    imageUrl: string;
    prompt: string;
    tailImageUrl?: string;
  }): Record<string, unknown>;
}

export const DEFAULT_CLIP_MODEL_ID: ClipModelId = "kling-2.5-turbo-pro";

/** Display-only ballpark for one MMAudio v2 SFX pass (priced ~$0.001/s). */
export const SFX_EST_USD = 0.01;

export const CLIP_MODELS: ClipModelSpec[] = [
  {
    id: "kling-2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    durationSeconds: 5,
    supportsEndFrame: true,
    nativeAudio: false,
    estUsdPerClip: 0.42,
    whenToUse: "Default — best motion quality for the price; supports chaining to the next shot.",
    buildInput: ({ imageUrl, prompt, tailImageUrl }) => ({
      image_url: imageUrl,
      prompt,
      duration: "5",
      ...(tailImageUrl ? { tail_image_url: tailImageUrl } : {}),
    }),
  },
  {
    id: "ltx-2.3",
    label: "LTX 2.3",
    falEndpoint: "fal-ai/ltx-2.3/image-to-video",
    durationSeconds: 6,
    supportsEndFrame: false,
    nativeAudio: false,
    estUsdPerClip: 0.25,
    whenToUse: "Cheap drafts — fast and low-cost, but weak at directed motion; no chaining.",
    buildInput: ({ imageUrl, prompt }) => ({ image_url: imageUrl, prompt }),
  },
  {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast",
    falEndpoint: "fal-ai/veo3.1/fast/image-to-video",
    durationSeconds: 8,
    supportsEndFrame: false,
    nativeAudio: true,
    estUsdPerClip: 1.2,
    whenToUse: "Hero shots — strongest complex motion and native audio; ~3× the default's cost.",
    buildInput: ({ imageUrl, prompt }) => ({ image_url: imageUrl, prompt }),
  },
];

export function getClipModel(id: string | null | undefined): ClipModelSpec | null {
  if (!id) return null;
  return CLIP_MODELS.find((m) => m.id === id) ?? null;
}

export function isClipModelId(id: unknown): id is ClipModelId {
  return typeof id === "string" && CLIP_MODELS.some((m) => m.id === id);
}
