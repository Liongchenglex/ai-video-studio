/**
 * Tests for director-resolve.ts (AI Assistant Director Task 13):
 * `promotionPlan` is a PURE function — no DB, no R2, no network — that
 * turns an `awaiting_approval`/`stopped` DirectorRun's `settingsSnapshot` +
 * candidate fields into the shot row patch and R2 copy operations the
 * resolve route executes on approve. These tests exercise only the pure
 * mapping; the route's DB/R2 orchestration is exercised live (per the
 * project's paid-smoke policy for this feature), not unit-tested here.
 */
import { describe, it, expect } from "vitest";
import { promotionPlan } from "@/lib/director/director-resolve";
import type { DirectorRun } from "@/lib/db/schema";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const SHOT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";

const CLIP_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/clip.mp4`;
const IMAGE_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/image.png`;
const END_FRAME_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/end-frame.png`;

const CANDIDATE_CLIP_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/director/${RUN_ID}/candidate.mp4`;
const CANDIDATE_IMAGE_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/director/${RUN_ID}/scratch-image.png`;
const CANDIDATE_END_FRAME_KEY = `projects/${PROJECT_ID}/shots/${SHOT_ID}/director/${RUN_ID}/end-frame.png`;

/** Builds a full, valid `awaiting_approval` run row; overrides layer on top. */
function makeRun(overrides: Partial<DirectorRun> = {}): DirectorRun {
  const base: DirectorRun = {
    id: RUN_ID,
    shotId: SHOT_ID,
    projectId: PROJECT_ID,
    status: "awaiting_approval",
    budgetUsd: 1.5,
    spentUsd: 0.32,
    guidance: null,
    verdict: "Looks good.",
    stopRequested: false,
    clipCandidatePath: CANDIDATE_CLIP_KEY,
    candidateDurationSeconds: 4,
    candidateModel: "kling-v2",
    settingsSnapshot: {
      imagePath: `projects/${PROJECT_ID}/shots/${SHOT_ID}/image.png`,
      motionPrompt: "the camera pushes in slowly",
      clipModel: "kling-v2",
      cameraMove: "push_in",
      cameraStrength: "medium",
      endsOn: "free",
      endFramePath: null,
      endFrameStatus: null,
      clipDurationChoice: 4,
      negativePrompt: "blurry, distorted",
      useEntityRefs: true,
      referencedEntityIds: ["entity-1"],
      slotSeconds: 4.2,
      scratchImagePath: `projects/${PROJECT_ID}/shots/${SHOT_ID}/image.png`,
      scratchImageEdited: false,
    },
    proposals: [],
    createdAt: new Date("2026-07-10T00:00:00Z"),
    updatedAt: new Date("2026-07-10T00:00:00Z"),
  };
  return { ...base, ...overrides };
}

describe("promotionPlan", () => {
  it("maps every directing field from a full snapshot", () => {
    const run = makeRun();
    const { shotPatch } = promotionPlan(run);

    expect(shotPatch).toMatchObject({
      motionPrompt: "the camera pushes in slowly",
      cameraMove: "push_in",
      cameraStrength: "medium",
      endsOn: "free",
      endFramePath: null,
      endFrameStatus: null,
      clipDurationChoice: 4,
      negativePrompt: "blurry, distorted",
      useEntityRefs: true,
      referencedEntityIds: ["entity-1"],
      clipModel: "kling-v2",
      clipPath: CLIP_KEY,
      clipDurationSeconds: 4,
      clipStatus: "done",
      sfxPath: null,
      sfxStatus: "pending",
    });
    // scratchImageEdited is false in this fixture — imagePath must not be patched.
    expect(shotPatch.imagePath).toBeUndefined();
  });

  it("uses candidateModel for clipModel, not the snapshot's own clipModel", () => {
    const run = makeRun({
      candidateModel: "veo-3",
      settingsSnapshot: { ...makeRun().settingsSnapshot, clipModel: "kling-v2" },
    });
    const { shotPatch } = promotionPlan(run);
    expect(shotPatch.clipModel).toBe("veo-3");
  });

  it("includes the clip copy op always, from the run's clipCandidatePath to the shot's standard clip.mp4 key", () => {
    const run = makeRun();
    const { copyOps } = promotionPlan(run);
    expect(copyOps).toContainEqual({ from: CANDIDATE_CLIP_KEY, to: CLIP_KEY });
  });

  it("includes an image copy op only when scratchImageEdited is true", () => {
    const editedRun = makeRun({
      settingsSnapshot: {
        ...makeRun().settingsSnapshot,
        imagePath: CANDIDATE_IMAGE_KEY,
        scratchImagePath: CANDIDATE_IMAGE_KEY,
        scratchImageEdited: true,
      },
    });
    const { copyOps, shotPatch } = promotionPlan(editedRun);
    expect(copyOps).toContainEqual({ from: CANDIDATE_IMAGE_KEY, to: IMAGE_KEY });
    expect(shotPatch.imagePath).toBe(IMAGE_KEY);

    const uneditedRun = makeRun();
    const { copyOps: uneditedCopyOps } = promotionPlan(uneditedRun);
    expect(uneditedCopyOps.some((op) => op.to === IMAGE_KEY)).toBe(false);
  });

  it("always includes the SFX reset (sfxPath: null, sfxStatus: pending)", () => {
    for (const run of [
      makeRun(),
      makeRun({
        settingsSnapshot: { ...makeRun().settingsSnapshot, endsOn: "custom", endFramePath: CANDIDATE_END_FRAME_KEY },
      }),
    ]) {
      const { shotPatch } = promotionPlan(run);
      expect(shotPatch.sfxPath).toBeNull();
      expect(shotPatch.sfxStatus).toBe("pending");
    }
  });

  it("endsOn custom keeps custom and copies the run-prefixed end frame to the shot's standard end-frame.png key", () => {
    const run = makeRun({
      settingsSnapshot: {
        ...makeRun().settingsSnapshot,
        endsOn: "custom",
        endFramePath: CANDIDATE_END_FRAME_KEY,
        endFrameStatus: "done",
      },
    });
    const { shotPatch, copyOps } = promotionPlan(run);
    expect(shotPatch.endsOn).toBe("custom");
    expect(shotPatch.endFramePath).toBe(END_FRAME_KEY);
    expect(shotPatch.endFrameStatus).toBe("done");
    expect(copyOps).toContainEqual({ from: CANDIDATE_END_FRAME_KEY, to: END_FRAME_KEY });
  });

  it("does not emit an end-frame copy op when endFramePath is absent", () => {
    const run = makeRun();
    const { copyOps } = promotionPlan(run);
    expect(copyOps.some((op) => op.to === END_FRAME_KEY)).toBe(false);
  });

  it("does not re-copy an end frame that is already at the shot's standard key (no-op self-copy guard)", () => {
    const run = makeRun({
      settingsSnapshot: {
        ...makeRun().settingsSnapshot,
        endsOn: "custom",
        endFramePath: END_FRAME_KEY, // already the standard destination — untouched by this run
        endFrameStatus: "done",
      },
    });
    const { shotPatch, copyOps } = promotionPlan(run);
    expect(shotPatch.endFramePath).toBe(END_FRAME_KEY);
    expect(copyOps.some((op) => op.to === END_FRAME_KEY)).toBe(false);
  });

  it("throws when the run has no settingsSnapshot", () => {
    const run = makeRun({ settingsSnapshot: null });
    expect(() => promotionPlan(run)).toThrow();
  });

  it("throws when the run has no clip candidate to promote", () => {
    const run = makeRun({ clipCandidatePath: null });
    expect(() => promotionPlan(run)).toThrow();
  });
});
