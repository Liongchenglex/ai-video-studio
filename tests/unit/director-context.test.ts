/**
 * Tests for director-context.ts (AI Assistant Director Task 5):
 * buildBriefingText, the pure text builder that assembles the Claude
 * briefing prompt from plain data (no DB/network — that's
 * gatherBriefingImages, exercised only by tsc/lint per the task brief).
 */
import { describe, it, expect } from "vitest";
import { buildBriefingText, type DirectorBriefingData } from "@/lib/director/director-context";
import type { DirectingSettings } from "@/lib/shot-clip-generation";

function baseScratch(overrides: Partial<DirectingSettings> = {}): DirectingSettings {
  return {
    imagePath: "projects/p1/shots/s1/image.png",
    motionPrompt: "the camera pans slowly across the meadow",
    clipModel: null,
    cameraMove: null,
    cameraStrength: null,
    endsOn: "free",
    endFramePath: null,
    endFrameStatus: null,
    clipDurationChoice: null,
    negativePrompt: null,
    useEntityRefs: true,
    referencedEntityIds: [],
    slotSeconds: null,
    ...overrides,
  };
}

function baseData(overrides: Partial<DirectorBriefingData> = {}): DirectorBriefingData {
  return {
    projectBrief: "A cozy nature documentary about a fox.",
    styleString: "flat vector, warm palette",
    script: "Once upon a time, a fox lived in the woods.",
    beatText: "A fox lived in the woods.",
    shot: {
      imagePrompt: "a red fox sitting in tall grass",
      motionPrompt: "the camera pans slowly across the meadow",
    },
    scratch: baseScratch(),
    neighbors: {},
    entities: [],
    budgetUsd: 1.5,
    spentUsd: 0.3,
    guidance: null,
    ...overrides,
  };
}

describe("buildBriefingText", () => {
  it("includes every section header in fixed order (Guidance omitted when null)", () => {
    const text = buildBriefingText(baseData());
    const headers = ["## Script", "## This beat", "## This shot", "## Neighbors", "## Cast & locations", "## Budget"];
    let lastIndex = -1;
    for (const header of headers) {
      const idx = text.indexOf(header);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(text).not.toContain("## Guidance");
  });

  it("includes the Guidance section, after Budget, when guidance is set", () => {
    const text = buildBriefingText(baseData({ guidance: "Make the fox react to the lantern." }));
    expect(text).toContain("## Guidance");
    expect(text.indexOf("## Budget")).toBeLessThan(text.indexOf("## Guidance"));
    expect(text).toContain("Make the fox react to the lantern.");
  });

  it("renders sheet-ready entities with (sheet ready)", () => {
    const text = buildBriefingText(
      baseData({
        entities: [
          { id: "e1", name: "Foxy", type: "character", sheetReady: true, taggedHere: true },
        ],
      }),
    );
    expect(text).toContain("Foxy");
    expect(text).toContain("(sheet ready)");
  });

  it("renders entities without a ready sheet as (no sheet)", () => {
    const text = buildBriefingText(
      baseData({
        entities: [
          { id: "e2", name: "The Lantern", type: "object", sheetReady: false, taggedHere: false },
        ],
      }),
    );
    expect(text).toContain("The Lantern");
    expect(text).toContain("(no sheet)");
  });

  it("shows spent vs budget as spent $X of $Y", () => {
    const text = buildBriefingText(baseData({ budgetUsd: 1.5, spentUsd: 0.3 }));
    expect(text).toContain("spent $0.30 of $1.50");
  });

  it("includes the scratch settings line (camera/ends-on/model/duration)", () => {
    const text = buildBriefingText(
      baseData({
        scratch: baseScratch({
          cameraMove: "push-in",
          cameraStrength: "medium",
          endsOn: "next",
          clipModel: "kling-v3-pro",
          clipDurationChoice: 5,
        }),
      }),
    );
    expect(text).toContain("push-in");
    expect(text).toContain("medium");
    expect(text).toContain("next");
    expect(text).toContain("kling-v3-pro");
    expect(text).toContain("5s");
  });

  it("describes unset camera/model/duration scratch settings without throwing", () => {
    const text = buildBriefingText(baseData({ scratch: baseScratch() }));
    expect(text).toContain("none");
    expect(text).toContain("free");
    expect(text).toContain("default");
    expect(text).toContain("auto");
  });

  it("renders neighbor prompts and ends-on when present, and a placeholder when absent", () => {
    const withNeighbors = buildBriefingText(
      baseData({
        neighbors: {
          prev: { imagePrompt: "a wide shot of the forest", endsOn: "free" },
          next: { imagePrompt: "the fox runs off screen", endsOn: "custom" },
        },
      }),
    );
    expect(withNeighbors).toContain("a wide shot of the forest");
    expect(withNeighbors).toContain("the fox runs off screen");

    const withoutNeighbors = buildBriefingText(baseData({ neighbors: {} }));
    expect(withoutNeighbors).toContain("## Neighbors");
  });

  it("includes the project brief, style string, script and beat text verbatim", () => {
    const text = buildBriefingText(baseData());
    expect(text).toContain("A cozy nature documentary about a fox.");
    expect(text).toContain("flat vector, warm palette");
    expect(text).toContain("Once upon a time, a fox lived in the woods.");
    expect(text).toContain("A fox lived in the woods.");
  });

  it("handles null projectBrief/styleString/script gracefully", () => {
    const text = buildBriefingText(baseData({ projectBrief: null, styleString: null, script: null }));
    expect(text).toContain("## Script");
  });
});
