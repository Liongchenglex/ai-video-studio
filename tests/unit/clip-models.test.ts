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
  it("defaults to Kling v3 Pro", () => {
    expect(DEFAULT_CLIP_MODEL_ID).toBe("kling-v3-pro");
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

  it("Kling v3 Pro is the default and maps the full directing surface", () => {
    expect(DEFAULT_CLIP_MODEL_ID).toBe("kling-v3-pro");
    const v3 = getClipModel("kling-v3-pro")!;
    expect(v3.falEndpoint).toBe("fal-ai/kling-video/v3/pro/image-to-video");
    expect(v3.supportsEndFrame).toBe(true);
    expect(v3.supportsReferences).toBe(true);
    expect(v3.supportsNegativePrompt).toBe(true);
    expect(v3.supportsCameraControl).toBe(false);
    expect(v3.nativeAudio).toBe(false);
    expect(v3.durations).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const input = v3.buildInput({
      imageUrl: "a",
      prompt: "p",
      tailImageUrl: "b",
      negativePrompt: "blur",
      durationSeconds: 4,
      referenceImageUrls: ["r1", "r2"],
    });
    // duration is fal's string-encoded enum ("3".."15"); elements is a list of
    // KlingV3ComboElementInput objects keyed by frontal_image_url (verified
    // via fal's v3 pro i2v schema — see task-2-report.md).
    expect(input).toEqual({
      start_image_url: "a",
      end_image_url: "b",
      prompt: "p",
      negative_prompt: "blur",
      duration: "4",
      generate_audio: false,
      elements: [{ frontal_image_url: "r1" }, { frontal_image_url: "r2" }],
    });
  });

  it("Kling v3 Pro buildInput omits optional fields and forces audio off by default", () => {
    const v3 = getClipModel("kling-v3-pro")!;
    expect(v3.buildInput({ imageUrl: "a", prompt: "p" })).toEqual({
      start_image_url: "a",
      prompt: "p",
      duration: "5",
      generate_audio: false,
    });
  });
});
