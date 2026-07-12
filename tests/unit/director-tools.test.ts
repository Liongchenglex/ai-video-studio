/**
 * Tests for director-tools.ts (AI Assistant Director Task 4): the
 * declarative tool registry every other AI-director module derives from
 * (Anthropic tool list, prompt capability inventory, budget metering).
 * Uses an in-memory DirectorRunCtx (makeCtx) — no DB, no fal, no Claude.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DIRECTOR_TOOLS,
  getDirectorTool,
  toAnthropicTools,
  capabilityInventory,
  type DirectorRunCtx,
} from "@/lib/director/director-tools";
import type { DirectingSettings } from "@/lib/shot-clip-generation";
import type { Project, Shot } from "@/lib/db/schema";

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

const baseProject = {
  id: "project-1",
} as Project;

function baseScratch(): DirectingSettings {
  return {
    imagePath: "projects/project-1/shots/shot-1/image.png",
    motionPrompt: "the camera pans slowly",
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
  };
}

function makeCtx(): DirectorRunCtx {
  return {
    project: baseProject,
    shot: baseShot,
    runId: "run-1",
    scratch: baseScratch(),
    scratchImageEdited: false,
    appendEvent: vi.fn().mockResolvedValue(undefined),
    addSpend: vi.fn().mockResolvedValue(undefined),
    addProposal: vi.fn().mockResolvedValue(undefined),
    setCandidate: vi.fn().mockResolvedValue(undefined),
    candidateKey: (f: string) => "test/" + f,
  };
}

describe("DIRECTOR_TOOLS registry invariants", () => {
  it("every tool satisfies the registry invariant", () => {
    for (const t of DIRECTOR_TOOLS) {
      expect(t.description.length).toBeGreaterThanOrEqual(20);
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.estCostUsd).toBe("function");
    }
  });

  it("enums derive from app sources", () => {
    const cam = getDirectorTool("set_camera_move")!;
    expect(JSON.stringify(cam.inputSchema)).toContain('"push-in"');
    const model = getDirectorTool("set_clip_model")!;
    expect(JSON.stringify(model.inputSchema)).toContain('"kling-v3-pro"');
  });

  it("setting tools mutate scratch and are free", async () => {
    const ctx = makeCtx();
    const t = getDirectorTool("set_camera_move")!;
    expect(t.estCostUsd({ move: "push-in", strength: "subtle" })).toBe(0);
    const r = await t.execute(ctx, { move: "push-in", strength: "subtle" });
    expect(r.ok).toBe(true);
    expect(ctx.scratch.cameraMove).toBe("push-in");
  });

  it("set_ends_on rejects custom without a scratch end frame", async () => {
    const ctx = makeCtx();
    const r = await getDirectorTool("set_ends_on")!.execute(ctx, { endsOn: "custom" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/end frame/i);
  });

  it("toAnthropicTools and capabilityInventory cover every tool", () => {
    expect(toAnthropicTools()).toHaveLength(DIRECTOR_TOOLS.length);
    for (const t of DIRECTOR_TOOLS) expect(capabilityInventory()).toContain(t.name);
  });

  it("has 11 tools registered", () => {
    expect(DIRECTOR_TOOLS).toHaveLength(11);
  });
});

describe("Kontext tools (edit_start_image, create_custom_end_frame)", () => {
  it("both estimate $0.04", () => {
    expect(getDirectorTool("edit_start_image")!.estCostUsd({})).toBe(0.04);
    expect(getDirectorTool("create_custom_end_frame")!.estCostUsd({})).toBe(0.04);
  });

  it("edit_start_image rejects an instruction over 500 chars before any fal call", async () => {
    const ctx = makeCtx();
    const r = await getDirectorTool("edit_start_image")!.execute(ctx, {
      instruction: "x".repeat(501),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/500/);
    expect(ctx.scratchImageEdited).toBe(false);
    expect(ctx.appendEvent).not.toHaveBeenCalled();
  });

  it("edit_start_image rejects an empty instruction before any fal call", async () => {
    const ctx = makeCtx();
    const r = await getDirectorTool("edit_start_image")!.execute(ctx, { instruction: "   " });
    expect(r.ok).toBe(false);
    expect(ctx.appendEvent).not.toHaveBeenCalled();
  });

  it("create_custom_end_frame rejects an instruction over 500 chars before any fal call", async () => {
    const ctx = makeCtx();
    const r = await getDirectorTool("create_custom_end_frame")!.execute(ctx, {
      instruction: "y".repeat(600),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/500/);
    expect(ctx.scratch.endFramePath).toBeNull();
    expect(ctx.appendEvent).not.toHaveBeenCalled();
  });
});
