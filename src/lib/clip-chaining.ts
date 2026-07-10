/**
 * End-frame decision logic (Clip Engine v2). Pure functions deciding whether
 * to apply an end frame (tail image) to a clip based on the end-frame mode
 * (free/next/custom), model capabilities, and asset readiness. Reasons are
 * surfaced to the UI so skipped chains degrade loudly, never failing the clip.
 *
 * resolveChainDecision delegates to resolveEndFrame for backward compatibility.
 */
import type { ClipModelSpec } from "@/lib/clip-models";

export type ChainSkipReason =
  | "not-requested"
  | "model-no-end-frame"
  | "no-next-shot"
  | "next-image-not-ready";

export type ChainDecision =
  | { useTail: true; tailImagePath: string }
  | { useTail: false; reason: ChainSkipReason };

export type EndFrameSkipReason =
  | "model-no-end-frame"
  | "no-next-shot"
  | "next-image-not-ready"
  | "custom-frame-not-ready";

export type EndFrameDecision =
  | { tailImagePath: string; skipReason?: never }
  | { tailImagePath?: never; skipReason?: EndFrameSkipReason }
  | Record<string, never>;

export function resolveEndFrame(args: {
  endsOn: "free" | "next" | "custom";
  endFramePath: string | null;
  endFrameStatus: string | null;
  spec: Pick<ClipModelSpec, "supportsEndFrame">;
  nextShot: { imagePath: string | null; imageStatus: string | null } | null;
}): EndFrameDecision {
  // Free: no tail, no reason
  if (args.endsOn === "free") {
    return {};
  }

  // Check model supports end frame for both next and custom modes
  if (!args.spec.supportsEndFrame) {
    return { skipReason: "model-no-end-frame" };
  }

  // Custom: use authored frame when done
  if (args.endsOn === "custom") {
    if (args.endFramePath && args.endFrameStatus === "done") {
      return { tailImagePath: args.endFramePath };
    }
    return { skipReason: "custom-frame-not-ready" };
  }

  // Next: use next shot's image when available
  if (args.endsOn === "next") {
    if (!args.nextShot) {
      return { skipReason: "no-next-shot" };
    }
    if (!args.nextShot.imagePath || args.nextShot.imageStatus !== "done") {
      return { skipReason: "next-image-not-ready" };
    }
    return { tailImagePath: args.nextShot.imagePath };
  }

  return {};
}

export function resolveChainDecision(args: {
  chainToNext: boolean;
  spec: Pick<ClipModelSpec, "supportsEndFrame">;
  nextShot: { imagePath: string | null; imageStatus: string | null } | null;
}): ChainDecision {
  // Delegate to resolveEndFrame for consistency
  const result = resolveEndFrame({
    endsOn: args.chainToNext ? "next" : "free",
    endFramePath: null,
    endFrameStatus: null,
    spec: args.spec,
    nextShot: args.nextShot,
  });

  // Map back to ChainDecision shape
  if ("tailImagePath" in result && result.tailImagePath) {
    return { useTail: true, tailImagePath: result.tailImagePath };
  }

  if ("skipReason" in result && result.skipReason) {
    return { useTail: false, reason: result.skipReason as ChainSkipReason };
  }

  // For "free" mode, map to "not-requested"
  return { useTail: false, reason: "not-requested" };
}
