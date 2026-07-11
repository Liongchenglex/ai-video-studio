/**
 * Tests for settingsFromShot (Task 3: DirectingSettings + clip-render
 * refactor). Validates the pure mapping from a shot row to the
 * model-agnostic DirectingSettings the render pathway consumes — in
 * particular slotSeconds, which is derived from startInBeat/endInBeat and
 * must degrade to null when either bound is missing.
 */
import { describe, it, expect } from "vitest";
import { settingsFromShot } from "@/lib/shot-clip-generation";
import type { Shot } from "@/lib/db/schema";

const baseShot: Shot = {
  id: "shot-1",
  projectId: "project-1",
  sortOrder: 0,
  imagePrompt: "a still frame",
  motionPrompt: "the camera pans slowly",
  imagePath: "projects/project-1/shots/shot-1/image.png",
  imageStatus: "done",
  clipPath: null,
  clipStatus: "pending",
  clipDurationSeconds: null,
  clipModel: null,
  sfxPath: null,
  sfxStatus: "pending",
  cameraMove: null,
  cameraStrength: null,
  endsOn: "free",
  endFramePath: null,
  endFrameStatus: null,
  endFrameInstruction: null,
  clipDurationChoice: null,
  negativePrompt: null,
  useEntityRefs: true,
  beatId: "beat-1",
  startInBeat: null,
  endInBeat: null,
  referencedEntityIds: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("settingsFromShot", () => {
  it("maps the row and computes slotSeconds", () => {
    const s = settingsFromShot({ ...baseShot, startInBeat: 1, endInBeat: 4.3, endsOn: "next" } as Shot);
    expect(s.slotSeconds).toBeCloseTo(3.3);
    expect(s.endsOn).toBe("next");
  });

  it("yields null slotSeconds when bounds missing", () => {
    expect(settingsFromShot({ ...baseShot, startInBeat: null } as Shot).slotSeconds).toBeNull();
  });
});
