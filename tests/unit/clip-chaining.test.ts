/**
 * Tests for end-frame resolution logic (Clip Engine v2). Validates that
 * resolveEndFrame correctly decides whether to apply a tail image based on
 * end-frame mode (free/next/custom), model capabilities, and asset
 * readiness.
 */
import { describe, it, expect } from "vitest";
import { resolveEndFrame } from "@/lib/clip-chaining";

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
