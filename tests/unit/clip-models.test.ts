// Tests for the clip model registry (src/lib/clip-models.ts): default model
// selection, id lookup/type-guarding, and per-model buildInput() mapping
// (LTX maps end_image_url + disables audio, Kling maps tail_image_url + fixed duration).
import { describe, it, expect } from "vitest";
import {
  CLIP_MODELS,
  DEFAULT_CLIP_MODEL_ID,
  estClipUsd,
  getClipModel,
  isClipModelId,
} from "@/lib/clip-models";

describe("clip model registry", () => {
  it("defaults to Kling 2.5 Turbo Pro", () => {
    expect(DEFAULT_CLIP_MODEL_ID).toBe("kling-2.5-turbo-pro");
    expect(getClipModel(DEFAULT_CLIP_MODEL_ID)?.supportsEndFrame).toBe(true);
  });

  it("returns null for unknown / missing ids", () => {
    expect(getClipModel("fal-ai/evil/endpoint")).toBeNull();
    expect(getClipModel(null)).toBeNull();
    expect(getClipModel(undefined)).toBeNull();
  });

  it("type-guards ids", () => {
    expect(isClipModelId("ltx-2.3")).toBe(true);
    expect(isClipModelId("gpt-video")).toBe(false);
    expect(isClipModelId(42)).toBe(false);
  });

  it("every entry has cost, duration, and guidance", () => {
    for (const m of CLIP_MODELS) {
      expect(estClipUsd(m)).toBeGreaterThan(0);
      expect(m.durationSeconds).toBeGreaterThan(0);
      expect(m.whenToUse.length).toBeGreaterThan(10);
    }
  });

  it("exposes per-second pricing, duration lists, and capability flags", () => {
    for (const m of CLIP_MODELS) {
      expect(m.estUsdPerSecond).toBeGreaterThan(0);
      expect(m.durations.length).toBeGreaterThan(0);
      expect(m.durations).toContain(m.durationSeconds);
      expect(typeof m.supportsCameraControl).toBe("boolean");
      expect(typeof m.supportsReferences).toBe("boolean");
      expect(typeof m.supportsNegativePrompt).toBe("boolean");
    }
  });

  it("estClipUsd prices by duration with the default as fallback", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(estClipUsd(kling)).toBe(0.42); // 5s × $0.084
    expect(estClipUsd(kling, 10)).toBe(0.84);
    const ltx = getClipModel("ltx-2.3")!;
    expect(estClipUsd(ltx)).toBe(0.36); // 6s × $0.06
  });

  it("Kling buildInput maps negative prompt and duration", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(
      kling.buildInput({ imageUrl: "a", prompt: "p", negativePrompt: "blur", durationSeconds: 10 }),
    ).toEqual({ image_url: "a", prompt: "p", duration: "10", negative_prompt: "blur" });
  });

  it("LTX buildInput maps end_image_url and disables audio", () => {
    const ltx = getClipModel("ltx-2.3")!;
    expect(ltx.supportsEndFrame).toBe(true);
    expect(estClipUsd(ltx)).toBe(0.36);
    expect(
      ltx.buildInput({
        imageUrl: "https://fal/img.png",
        prompt: "clock swings",
        tailImageUrl: "https://fal/tail.png",
      }),
    ).toEqual({
      image_url: "https://fal/img.png",
      prompt: "clock swings",
      generate_audio: false,
      end_image_url: "https://fal/tail.png",
    });
    expect(
      ltx.buildInput({ imageUrl: "https://fal/img.png", prompt: "clock swings" }),
    ).toEqual({
      image_url: "https://fal/img.png",
      prompt: "clock swings",
      generate_audio: false,
    });
  });

  it("Kling buildInput maps tail_image_url and fixed duration", () => {
    const kling = getClipModel("kling-2.5-turbo-pro")!;
    expect(
      kling.buildInput({ imageUrl: "a", prompt: "p", tailImageUrl: "b" }),
    ).toEqual({ image_url: "a", prompt: "p", duration: "5", tail_image_url: "b" });
    expect(kling.buildInput({ imageUrl: "a", prompt: "p" })).toEqual({
      image_url: "a",
      prompt: "p",
      duration: "5",
    });
  });
});
