/**
 * Unit tests for the pure camera module: enum guards, prompt-suffix
 * fallback phrasing, and strength magnitudes.
 */
import { describe, it, expect } from "vitest";
import {
  CAMERA_MOVES, CAMERA_MAGNITUDE, cameraPromptSuffix, isCameraMove, isCameraStrength,
} from "@/lib/clip-camera";

describe("clip-camera", () => {
  it("guards enums", () => {
    expect(isCameraMove("push-in")).toBe(true);
    expect(isCameraMove("dolly-zoom")).toBe(false);
    expect(isCameraMove(3)).toBe(false);
    expect(isCameraStrength("subtle")).toBe(true);
    expect(isCameraStrength("extreme")).toBe(false);
  });

  it("has eight moves and three magnitudes", () => {
    expect(CAMERA_MOVES.map((m) => m.id)).toEqual([
      "static", "push-in", "pull-back", "pan-left", "pan-right", "tilt-up", "tilt-down", "orbit",
    ]);
    expect(CAMERA_MAGNITUDE).toEqual({ subtle: 3, medium: 6, strong: 9 });
  });

  it("builds deterministic prompt suffixes", () => {
    expect(cameraPromptSuffix("push-in", "subtle")).toBe("Camera: slow push-in.");
    expect(cameraPromptSuffix("push-in", "strong")).toBe("Camera: fast push-in.");
    expect(cameraPromptSuffix("pan-left", "medium")).toBe("Camera: steady pan to the left.");
    expect(cameraPromptSuffix("static", "strong")).toBe("Camera: locked off, no camera movement.");
  });
});
