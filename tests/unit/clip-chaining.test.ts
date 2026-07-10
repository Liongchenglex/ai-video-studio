/**
 * Tests for chain-to-next decision logic (Clip Engine v2). Validates
 * that resolveChainDecision correctly decides whether to chain clips
 * based on model capabilities, next shot readiness, and user intent.
 * Also tests resolveEndFrame for generalized end-frame resolution.
 */
import { describe, it, expect } from "vitest";
import { resolveChainDecision, resolveEndFrame } from "@/lib/clip-chaining";

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

describe("resolveEndFrame", () => {
  const spec = { supportsEndFrame: true };
  const noEnd = { supportsEndFrame: false };
  const next = { imagePath: "p/next.png", imageStatus: "done" };

  it("free → no tail, no reason", () => {
    expect(resolveEndFrame({ endsOn: "free", endFramePath: null, endFrameStatus: null, spec, nextShot: next })).toEqual({});
  });
  it("next → next shot's done image; degrades with reasons", () => {
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: next }))
      .toEqual({ tailImagePath: "p/next.png" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec: noEnd, nextShot: next }))
      .toEqual({ skipReason: "model-no-end-frame" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: null }))
      .toEqual({ skipReason: "no-next-shot" });
    expect(resolveEndFrame({ endsOn: "next", endFramePath: null, endFrameStatus: null, spec, nextShot: { imagePath: null, imageStatus: "pending" } }))
      .toEqual({ skipReason: "next-image-not-ready" });
  });
  it("custom → the authored frame when done; degrades when not", () => {
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: "p/end.png", endFrameStatus: "done", spec, nextShot: null }))
      .toEqual({ tailImagePath: "p/end.png" });
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: null, endFrameStatus: "pending", spec, nextShot: null }))
      .toEqual({ skipReason: "custom-frame-not-ready" });
    expect(resolveEndFrame({ endsOn: "custom", endFramePath: "p/end.png", endFrameStatus: "done", spec: noEnd, nextShot: null }))
      .toEqual({ skipReason: "model-no-end-frame" });
  });
});
