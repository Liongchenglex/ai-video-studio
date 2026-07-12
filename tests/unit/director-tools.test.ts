/**
 * Tests for director-tools.ts (AI Assistant Director Task 4, extended by
 * Task 11 for the entity tools): the declarative tool registry every
 * other AI-director module derives from (Anthropic tool list, prompt
 * capability inventory, budget metering). Uses an in-memory
 * DirectorRunCtx (makeCtx) — no DB, no fal, no Claude. The entity tools
 * (create_entity, generate_entity_sheet, tag_entity, untag_entity,
 * propose_entity_update) do real `@/lib/db` and
 * `@/lib/entity-sheet-generation` calls in production, so those two
 * modules are mocked here with a minimal chainable query-builder stub —
 * the first DB-mocking precedent in this test suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DIRECTOR_TOOLS,
  getDirectorTool,
  toAnthropicTools,
  capabilityInventory,
  type DirectorRunCtx,
} from "@/lib/director/director-tools";
import type { DirectingSettings } from "@/lib/shot-clip-generation";
import type { Project, Shot } from "@/lib/db/schema";

/**
 * Hoisted so the vi.mock factories below (which are hoisted above all
 * imports by vitest) can reference them. `chain(result)` builds a fake
 * drizzle query-builder: every chainable method (.from/.where/.limit/
 * .values/.set/.orderBy) returns the same object, and the object is
 * itself thenable so `await db.select()...` resolves to `result` no
 * matter where the caller stops chaining — mirroring how drizzle's
 * query builders are thenables in production.
 */
const { mockSelect, mockInsert, mockUpdate, mockGenerateEntitySheet, chain } = vi.hoisted(() => {
  function chain(result: unknown) {
    const obj: Record<string, unknown> = {};
    const self = () => obj;
    obj.from = self;
    obj.where = self;
    obj.limit = self;
    obj.values = self;
    obj.set = self;
    obj.orderBy = self;
    obj.returning = () => Promise.resolve(result);
    obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return obj;
  }
  return {
    mockSelect: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockGenerateEntitySheet: vi.fn(),
    chain,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/lib/entity-sheet-generation", () => ({
  generateEntitySheet: (...args: unknown[]) => mockGenerateEntitySheet(...args),
}));

const THROW_ON_WRITE = () => {
  throw new Error("unexpected write query builder call");
};

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

  it("has 16 tools registered", () => {
    expect(DIRECTOR_TOOLS).toHaveLength(16);
  });

  it("only propose_entity_update is marked sharedStateEdit: true", () => {
    const sharedStateEditTools = DIRECTOR_TOOLS.filter((t) => t.sharedStateEdit).map((t) => t.name);
    expect(sharedStateEditTools).toEqual(["propose_entity_update"]);
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

const VALID_ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ENTITY_ID = "22222222-2222-2222-2222-222222222222";

describe("Entity tools", () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockGenerateEntitySheet.mockReset();
  });

  describe("create_entity", () => {
    it("is free and requires name/type", () => {
      const t = getDirectorTool("create_entity")!;
      expect(t.estCostUsd({})).toBe(0);
      expect(t.inputSchema).toMatchObject({ required: expect.arrayContaining(["name", "type"]) });
    });

    it("derives the type enum from entityTypeEnum", () => {
      const t = getDirectorTool("create_entity")!;
      expect(JSON.stringify(t.inputSchema)).toContain('"character"');
      expect(JSON.stringify(t.inputSchema)).toContain('"location"');
      expect(JSON.stringify(t.inputSchema)).toContain('"object"');
    });

    it("rejects a name over 80 chars before any DB call", async () => {
      const ctx = makeCtx();
      const r = await getDirectorTool("create_entity")!.execute(ctx, {
        name: "x".repeat(81),
        type: "character",
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/80/);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("rejects an invalid type before any DB call", async () => {
      const ctx = makeCtx();
      const r = await getDirectorTool("create_entity")!.execute(ctx, {
        name: "Hero",
        type: "vehicle",
      });
      expect(r.ok).toBe(false);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("rejects a description over 500 chars before any DB call", async () => {
      const ctx = makeCtx();
      const r = await getDirectorTool("create_entity")!.execute(ctx, {
        name: "Hero",
        type: "character",
        description: "y".repeat(501),
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/500/);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("rejects a duplicate name within the project (mirrors the entities POST route)", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([{ name: "Hero" }]));
      const r = await getDirectorTool("create_entity")!.execute(ctx, {
        name: "hero",
        type: "character",
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/already exists/i);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("creates the entity and returns its new id", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([]));
      mockInsert.mockReturnValueOnce(
        chain([{ id: VALID_ENTITY_ID, name: "Hero", type: "character", description: "A hero" }]),
      );
      const r = await getDirectorTool("create_entity")!.execute(ctx, {
        name: "Hero",
        type: "character",
        description: "A hero",
      });
      expect(r.ok).toBe(true);
      expect(r.data?.entityId).toBe(VALID_ENTITY_ID);
      expect(ctx.appendEvent).toHaveBeenCalledWith("action", expect.objectContaining({ tool: "create_entity" }));
    });
  });

  describe("generate_entity_sheet", () => {
    it("estimates $0.04", () => {
      expect(getDirectorTool("generate_entity_sheet")!.estCostUsd({})).toBe(0.04);
    });

    it("rejects when the entity does not belong to ctx.project", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([]));
      const r = await getDirectorTool("generate_entity_sheet")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not found/i);
      expect(mockGenerateEntitySheet).not.toHaveBeenCalled();
    });

    it("calls the existing generateEntitySheet(project, entity) with no wrapping/duplication", async () => {
      const ctx = makeCtx();
      const entityRow = { id: VALID_ENTITY_ID, projectId: "project-1", name: "Hero" };
      mockSelect.mockReturnValueOnce(chain([entityRow]));
      mockGenerateEntitySheet.mockResolvedValueOnce({ ...entityRow, referenceSheetPath: "sheet.png" });
      const r = await getDirectorTool("generate_entity_sheet")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(true);
      expect(mockGenerateEntitySheet).toHaveBeenCalledWith(ctx.project, entityRow);
    });

    it("returns ok:false when generateEntitySheet throws", async () => {
      const ctx = makeCtx();
      const entityRow = { id: VALID_ENTITY_ID, projectId: "project-1", name: "Hero" };
      mockSelect.mockReturnValueOnce(chain([entityRow]));
      mockGenerateEntitySheet.mockRejectedValueOnce(new Error("fal down"));
      const r = await getDirectorTool("generate_entity_sheet")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/fal down/);
    });
  });

  describe("tag_entity / untag_entity", () => {
    it("both are free", () => {
      expect(getDirectorTool("tag_entity")!.estCostUsd({})).toBe(0);
      expect(getDirectorTool("untag_entity")!.estCostUsd({})).toBe(0);
    });

    it("tag_entity rejects an entity that does not belong to the project", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([]));
      const r = await getDirectorTool("tag_entity")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("tag_entity does a REAL update of shots.referencedEntityIds and syncs scratch", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([{ id: VALID_ENTITY_ID, name: "Hero" }]));
      mockUpdate.mockReturnValueOnce(chain([]));
      const r = await getDirectorTool("tag_entity")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(ctx.scratch.referencedEntityIds).toEqual([VALID_ENTITY_ID]);
    });

    it("tag_entity enforces the 8-tag cap (mirroring the PATCH route)", async () => {
      const ctx = makeCtx();
      ctx.scratch.referencedEntityIds = Array.from({ length: 8 }, (_, i) => `e${i}-${VALID_ENTITY_ID}`);
      mockSelect.mockReturnValueOnce(chain([{ id: OTHER_ENTITY_ID, name: "Ninth" }]));
      const r = await getDirectorTool("tag_entity")!.execute(ctx, { entityId: OTHER_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/8/);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(ctx.scratch.referencedEntityIds).toHaveLength(8);
    });

    it("tag_entity rejects a duplicate tag without hitting the cap message", async () => {
      const ctx = makeCtx();
      ctx.scratch.referencedEntityIds = [VALID_ENTITY_ID];
      mockSelect.mockReturnValueOnce(chain([{ id: VALID_ENTITY_ID, name: "Hero" }]));
      const r = await getDirectorTool("tag_entity")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("untag_entity does a REAL update of shots.referencedEntityIds and syncs scratch", async () => {
      const ctx = makeCtx();
      ctx.scratch.referencedEntityIds = [VALID_ENTITY_ID, OTHER_ENTITY_ID];
      mockUpdate.mockReturnValueOnce(chain([]));
      const r = await getDirectorTool("untag_entity")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(ctx.scratch.referencedEntityIds).toEqual([OTHER_ENTITY_ID]);
    });

    it("untag_entity rejects an entity that is not currently tagged", async () => {
      const ctx = makeCtx();
      ctx.scratch.referencedEntityIds = [];
      const r = await getDirectorTool("untag_entity")!.execute(ctx, { entityId: VALID_ENTITY_ID });
      expect(r.ok).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("propose_entity_update", () => {
    it("is marked sharedStateEdit: true", () => {
      expect(getDirectorTool("propose_entity_update")!.sharedStateEdit).toBe(true);
    });

    it("routes to ctx.addProposal and performs ZERO DB writes", async () => {
      const ctx = makeCtx();
      const entityRow = { id: VALID_ENTITY_ID, name: "Hero", description: "Old description" };
      mockSelect.mockReturnValueOnce(chain([entityRow]));
      mockInsert.mockImplementation(THROW_ON_WRITE);
      mockUpdate.mockImplementation(THROW_ON_WRITE);

      const r = await getDirectorTool("propose_entity_update")!.execute(ctx, {
        entityId: VALID_ENTITY_ID,
        field: "description",
        newValue: "New description",
        rationale: "Matches the reference sheet better.",
      });

      expect(r.ok).toBe(true);
      expect(ctx.addProposal).toHaveBeenCalledWith({
        entityId: VALID_ENTITY_ID,
        entityName: "Hero",
        field: "description",
        from: "Old description",
        to: "New description",
        rationale: "Matches the reference sheet better.",
      });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      // Per brief: execute ONLY calls ctx.addProposal — no action-feed event.
      expect(ctx.appendEvent).not.toHaveBeenCalled();
    });

    it("rejects when the entity does not belong to the project, without proposing", async () => {
      const ctx = makeCtx();
      mockSelect.mockReturnValueOnce(chain([]));
      const r = await getDirectorTool("propose_entity_update")!.execute(ctx, {
        entityId: VALID_ENTITY_ID,
        field: "description",
        newValue: "New description",
        rationale: "Because.",
      });
      expect(r.ok).toBe(false);
      expect(ctx.addProposal).not.toHaveBeenCalled();
    });

    it("rejects newValue over 500 chars before any DB call", async () => {
      const ctx = makeCtx();
      const r = await getDirectorTool("propose_entity_update")!.execute(ctx, {
        entityId: VALID_ENTITY_ID,
        field: "description",
        newValue: "z".repeat(501),
        rationale: "Because.",
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/500/);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("rejects rationale over 300 chars before any DB call", async () => {
      const ctx = makeCtx();
      const r = await getDirectorTool("propose_entity_update")!.execute(ctx, {
        entityId: VALID_ENTITY_ID,
        field: "description",
        newValue: "New description",
        rationale: "r".repeat(301),
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/300/);
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });
});
