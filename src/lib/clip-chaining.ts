/**
 * Chain-to-next decision logic (Clip Engine v2). Pure function deciding
 * whether a clip generation should pass the next shot's still image as the
 * model's end frame ("chaining"), and if not, why — the reason is surfaced
 * to the UI so a skipped chain degrades loudly, never fails the clip.
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

export function resolveChainDecision(args: {
  chainToNext: boolean;
  spec: Pick<ClipModelSpec, "supportsEndFrame">;
  nextShot: { imagePath: string | null; imageStatus: string | null } | null;
}): ChainDecision {
  if (!args.chainToNext) return { useTail: false, reason: "not-requested" };
  if (!args.spec.supportsEndFrame) return { useTail: false, reason: "model-no-end-frame" };
  if (!args.nextShot) return { useTail: false, reason: "no-next-shot" };
  if (!args.nextShot.imagePath || args.nextShot.imageStatus !== "done") {
    return { useTail: false, reason: "next-image-not-ready" };
  }
  return { useTail: true, tailImagePath: args.nextShot.imagePath };
}
