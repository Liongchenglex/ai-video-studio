/**
 * Clip model registry — the single source of truth for which fal.ai
 * image-to-video models the app can use (Clip Engine v2). Drives the
 * inspector dropdown, the clip route's allow-list validation, the
 * generation service's input mapping, and batch cost estimates.
 * Adding a model = adding one entry here. Client-supplied model ids MUST
 * be resolved through getClipModel/isClipModelId — never passed to fal raw.
 */

export type ClipModelId = "ltx-2.3" | "kling-2.5-turbo-pro" | "veo-3.1-fast";

// TODO(directing-controls task 2): clip-camera.ts will own these two types;
// this task defines them locally to stay self-contained, then Task 2 switches
// this file to `import type { CameraMove, CameraStrength } from "@/lib/clip-camera"`.
export type CameraMove =
  | "static"
  | "push-in"
  | "pull-back"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "orbit";
export type CameraStrength = "subtle" | "medium" | "strong";

export interface ClipModelSpec {
  id: ClipModelId;
  label: string;
  falEndpoint: string;
  /** Fixed output length used for estimates; actual output duration wins when fal returns one. */
  durationSeconds: number;
  /** All durations this model accepts, seconds. durationSeconds stays the default. */
  durations: number[];
  /** Model accepts an end-frame image (enables "chain to next shot"). */
  supportsEndFrame: boolean;
  /** Model generates its own audio track. */
  nativeAudio: boolean;
  /** Display-only ballpark per output second. */
  estUsdPerSecond: number;
  supportsCameraControl: boolean;
  supportsReferences: boolean;
  supportsNegativePrompt: boolean;
  whenToUse: string;
  buildInput(args: {
    imageUrl: string;
    prompt: string;
    tailImageUrl?: string;
    camera?: { move: CameraMove; strength: CameraStrength };
    negativePrompt?: string;
    durationSeconds?: number;
    referenceImageUrls?: string[];
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
    durations: [5, 10],
    supportsEndFrame: true,
    nativeAudio: false,
    estUsdPerSecond: 0.084,
    // Only the 2.6+ endpoints take camera params; this is the 2.5 endpoint,
    // verified false here — Task 2 flips this on the 2.6+ entries it adds.
    supportsCameraControl: false,
    supportsReferences: false,
    supportsNegativePrompt: true,
    whenToUse:
      "Default. Balanced cost vs. quality: strong, stable motion and the best chaining. Tradeoff: 5s max per clip, no sound of its own (use Add SFX).",
    buildInput: ({ imageUrl, prompt, tailImageUrl, negativePrompt, durationSeconds }) => ({
      image_url: imageUrl,
      prompt,
      duration: String(durationSeconds ?? 5),
      ...(tailImageUrl ? { tail_image_url: tailImageUrl } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    }),
  },
  {
    id: "ltx-2.3",
    label: "LTX 2.3",
    falEndpoint: "fal-ai/ltx-2.3/image-to-video",
    durationSeconds: 6,
    durations: [6],
    supportsEndFrame: true,
    nativeAudio: false,
    estUsdPerSecond: 0.06,
    supportsCameraControl: false,
    supportsReferences: false,
    // LTX takes no negative prompt on this endpoint — verify in Task 2; if
    // fal's schema exposes one, flip this flag and map it in buildInput.
    supportsNegativePrompt: false,
    whenToUse:
      "Cheapest & fastest — good for drafts and simple ambient motion. Tradeoff: weakest at directed, multi-step motion; visuals can drift on complex scenes.",
    // generate_audio defaults to true on fal's LTX endpoint; force it off —
    // the MMAudio SFX flow owns audio, we don't want an embedded soundtrack.
    buildInput: ({ imageUrl, prompt, tailImageUrl }) => ({
      image_url: imageUrl,
      prompt,
      generate_audio: false,
      ...(tailImageUrl ? { end_image_url: tailImageUrl } : {}),
    }),
  },
  {
    id: "veo-3.1-fast",
    label: "Veo 3.1 Fast",
    falEndpoint: "fal-ai/veo3.1/fast/image-to-video",
    durationSeconds: 8,
    durations: [8],
    supportsEndFrame: false,
    nativeAudio: true,
    estUsdPerSecond: 0.15,
    supportsCameraControl: false,
    supportsReferences: false,
    supportsNegativePrompt: false,
    whenToUse:
      "Best quality — strongest complex/directed motion, 8s clips, generates its own audio. Tradeoff: ~3× the default's cost and no chaining to the next shot.",
    buildInput: ({ imageUrl, prompt }) => ({ image_url: imageUrl, prompt }),
  },
];

/** Display-only cost estimate: per-second rate × duration (defaults to the model's durationSeconds). */
export function estClipUsd(
  spec: Pick<ClipModelSpec, "estUsdPerSecond" | "durationSeconds">,
  seconds?: number,
): number {
  return Math.round(spec.estUsdPerSecond * (seconds ?? spec.durationSeconds) * 100) / 100;
}

export function getClipModel(id: string | null | undefined): ClipModelSpec | null {
  if (!id) return null;
  return CLIP_MODELS.find((m) => m.id === id) ?? null;
}

export function isClipModelId(id: unknown): id is ClipModelId {
  return typeof id === "string" && CLIP_MODELS.some((m) => m.id === id);
}
