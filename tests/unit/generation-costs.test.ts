/**
 * Cost estimation tests for batch generation. Verifies that clip pricing
 * is correctly derived from the clip model registry and SFX is optionally
 * included per estimate request.
 */
import { describe, it, expect } from "vitest";
import { estimateBatchCost } from "@/lib/generation-costs";

describe("estimateBatchCost", () => {
  const counts = { sheets: 2, images: 10, clips: 10 };

  it("prices clips by the default model when no model given", () => {
    const c = estimateBatchCost(counts);
    expect(c.clipsUsd).toBe(4.2); // 10 × $0.42 Kling default
    expect(c.sheetsUsd).toBe(0.08);
    expect(c.imagesUsd).toBe(0.4);
    expect(c.totalUsd).toBe(0.48); // sheets + images only (unchanged behavior)
    expect(c.totalWithClipsUsd).toBe(4.68);
    expect(c.sfxUsd).toBe(0);
  });

  it("prices clips by the selected model", () => {
    expect(estimateBatchCost(counts, { clipModelId: "ltx-2.3" }).clipsUsd).toBe(3.6);
    expect(estimateBatchCost(counts, { clipModelId: "veo-3.1-fast" }).clipsUsd).toBe(12);
  });

  it("falls back to the default model for unknown ids", () => {
    expect(estimateBatchCost(counts, { clipModelId: "nope" }).clipsUsd).toBe(4.2);
  });

  it("adds SFX per clip when included", () => {
    const c = estimateBatchCost(counts, { includeSfx: true });
    expect(c.sfxUsd).toBe(0.1); // 10 × $0.01 (sfx omitted falls back to clips)
    expect(c.totalWithClipsUsd).toBe(4.78);
  });

  it("prices SFX by the explicit sfx count when given", () => {
    const c = estimateBatchCost({ ...counts, sfx: 14 }, { includeSfx: true });
    expect(c.sfxUsd).toBe(0.14); // 14 × $0.01 — clips this run + done clips missing SFX
  });
});
