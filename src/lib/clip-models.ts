/**
 * Clip model registry — the single source of truth for which fal.ai
 * image-to-video models the app can use (Clip Engine v2). Drives the
 * inspector dropdown, the clip route's allow-list validation, the
 * generation service's input mapping, and batch cost estimates.
 * Adding a model = adding one entry here. Client-supplied model ids MUST
 * be resolved through getClipModel/isClipModelId — never passed to fal raw.
 */

export type ClipModelId =
  | "ltx-2.3"
  | "kling-2.5-turbo-pro"
  | "kling-v3-pro"
  | "veo-3.1-fast";

// Camera vocabulary lives in clip-camera.ts; re-exported here so existing
// importers of clip-models.ts keep working unchanged.
import type { CameraMove, CameraStrength } from "@/lib/clip-camera";
export type { CameraMove, CameraStrength };

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

export const DEFAULT_CLIP_MODEL_ID: ClipModelId = "kling-v3-pro";

/** Display-only ballpark for one MMAudio v2 SFX pass (priced ~$0.001/s). */
export const SFX_EST_USD = 0.01;

export const CLIP_MODELS: ClipModelSpec[] = [
  {
    id: "kling-v3-pro",
    label: "Kling v3 Pro",
    falEndpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    durationSeconds: 5,
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportsEndFrame: true,
    nativeAudio: false,
    // Verified fal pricing (audio off, since generate_audio is forced false
    // below): $0.112/s. (Audio-on tier is $0.168/s but unused here.)
    estUsdPerSecond: 0.112,
    // Verified against fal's v3/pro and v2.6/pro image-to-video schemas
    // (directing-controls task 2): no camera_control param on either i2v
    // endpoint, so camera direction stays prompt-fallback for all Kling tiers.
    supportsCameraControl: false,
    supportsReferences: true,
    supportsNegativePrompt: true,
    whenToUse:
      "New default. Full directing surface: chaining, cast references, negative prompt, 3–15s. Tradeoff: pricier per second than Kling 2.5; no native audio (use Add SFX).",
    buildInput: ({
      imageUrl,
      prompt,
      tailImageUrl,
      negativePrompt,
      durationSeconds,
      referenceImageUrls,
    }) => ({
      start_image_url: imageUrl,
      prompt,
      duration: String(durationSeconds ?? 5),
      // fal's v3 endpoint defaults generate_audio to true; force it off — the
      // MMAudio SFX flow owns audio, we don't want an embedded soundtrack.
      generate_audio: false,
      ...(tailImageUrl ? { end_image_url: tailImageUrl } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      // Cast references map 1:1 to fal's `elements` list. fal's RUNTIME
      // validator (stricter than the docs page) requires BOTH
      // frontal_image_url AND reference_image_urls per element — we pass the
      // same sheet for both since our reference sheets are multi-view.
      // Verified against a live 422 during the paid smoke run (2026-07-11).
      ...(referenceImageUrls?.length
        ? {
            elements: referenceImageUrls.map((url) => ({
              frontal_image_url: url,
              reference_image_urls: [url],
            })),
          }
        : {}),
    }),
  },
  {
    id: "kling-2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    falEndpoint: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    durationSeconds: 5,
    durations: [5, 10],
    supportsEndFrame: true,
    nativeAudio: false,
    estUsdPerSecond: 0.084,
    // Verified against fal's v2.5-turbo/pro and v2.6/pro image-to-video
    // schemas (directing-controls task 2): neither exposes a hard
    // camera_control param on the i2v endpoint, so this stays prompt-fallback.
    supportsCameraControl: false,
    supportsReferences: false,
    supportsNegativePrompt: true,
    whenToUse:
      "Cheaper alternative to the default: strong, stable motion and the best chaining. Tradeoff: 5s default, 10s optional, no sound of its own (use Add SFX).",
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

/**
 * Resolves clip duration following a precedence order:
 * 1. Explicit wins if listed in durations (else nearest listed, ties up)
 * 2. Nearest to slotSeconds (ties up)
 * 3. If slotSeconds is null, use durationSeconds
 */
export function resolveClipDuration(
  spec: Pick<ClipModelSpec, "durations" | "durationSeconds">,
  slotSeconds: number | null,
  explicit: number | null,
): number {
  // Check if explicit is in durations
  if (explicit !== null && spec.durations.includes(explicit)) {
    return explicit;
  }

  // If explicit is provided but not in durations, find nearest
  if (explicit !== null) {
    return spec.durations.reduce((best, d) =>
      Math.abs(d - explicit) < Math.abs(best - explicit) ||
      (Math.abs(d - explicit) === Math.abs(best - explicit) && d > best)
        ? d
        : best,
    );
  }

  // If slotSeconds is provided, find nearest
  if (slotSeconds !== null) {
    return spec.durations.reduce((best, d) =>
      Math.abs(d - slotSeconds) < Math.abs(best - slotSeconds) ||
      (Math.abs(d - slotSeconds) === Math.abs(best - slotSeconds) && d > best)
        ? d
        : best,
    );
  }

  // Default to durationSeconds
  return spec.durationSeconds;
}
