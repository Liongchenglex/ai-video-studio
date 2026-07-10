/**
 * Tests for chain-to-next decision logic (Clip Engine v2). Validates
 * that resolveChainDecision correctly decides whether to chain clips
 * based on model capabilities, next shot readiness, and user intent.
 */
import { describe, it, expect } from "vitest";
import { resolveChainDecision } from "@/lib/clip-chaining";

const endFrameSpec = { supportsEndFrame: true };
const noEndFrameSpec = { supportsEndFrame: false };
const readyNext = { imagePath: "projects/p/shots/n/image.png", imageStatus: "done" };

describe("resolveChainDecision", () => {
  it("chains when requested, supported, and next image is done", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: true, tailImagePath: readyNext.imagePath });
  });

  it("skips when not requested", () => {
    expect(
      resolveChainDecision({ chainToNext: false, spec: endFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: false, reason: "not-requested" });
  });

  it("skips when the model has no end-frame support", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: noEndFrameSpec, nextShot: readyNext }),
    ).toEqual({ useTail: false, reason: "model-no-end-frame" });
  });

  it("skips when the shot is last in sequence", () => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot: null }),
    ).toEqual({ useTail: false, reason: "no-next-shot" });
  });

  it.each([
    { imagePath: null, imageStatus: "pending" },
    { imagePath: "projects/p/shots/n/image.png", imageStatus: "failed" },
    { imagePath: "projects/p/shots/n/image.png", imageStatus: "generating" },
  ])("skips when the next image is not ready (%j)", (nextShot) => {
    expect(
      resolveChainDecision({ chainToNext: true, spec: endFrameSpec, nextShot }),
    ).toEqual({ useTail: false, reason: "next-image-not-ready" });
  });
});
