/**
 * Tests for entity reference resolution logic (Directing Controls task 12).
 * Validates that resolveClipReferences correctly decides which tagged
 * entities' reference sheets ride into the clip request, based on the
 * useEntityRefs toggle, the model's supportsReferences flag, and each
 * entity's reference-sheet readiness.
 */
import { describe, it, expect } from "vitest";
import { resolveClipReferences } from "@/lib/clip-references";

describe("resolveClipReferences", () => {
  const supports = { supportsReferences: true };
  const noSupport = { supportsReferences: false };
  const ready = (id: string, path: string) => ({
    id,
    name: `entity-${id}`,
    referenceStatus: "done",
    referenceSheetPath: path,
  });
  const notReady = (id: string) => ({
    id,
    name: `entity-${id}`,
    referenceStatus: "pending",
    referenceSheetPath: null,
  });

  it("disabled → skip 'disabled' with empty paths", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: false,
        spec: supports,
        taggedEntities: [ready("1", "p/1.png")],
      }),
    ).toEqual({ sheetPaths: [], skipReason: "disabled" });
  });

  it("unsupported model → skip 'model-no-references'", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: true,
        spec: noSupport,
        taggedEntities: [ready("1", "p/1.png")],
      }),
    ).toEqual({ sheetPaths: [], skipReason: "model-no-references" });
  });

  it("no done sheets → skip 'no-ready-sheets'", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: true,
        spec: supports,
        taggedEntities: [notReady("1"), notReady("2")],
      }),
    ).toEqual({ sheetPaths: [], skipReason: "no-ready-sheets" });
  });

  it("no tagged entities at all → skip 'no-ready-sheets'", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: true,
        spec: supports,
        taggedEntities: [],
      }),
    ).toEqual({ sheetPaths: [], skipReason: "no-ready-sheets" });
  });

  it("happy path → ready sheets returned in tag order, no skip reason", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: true,
        spec: supports,
        taggedEntities: [ready("1", "p/1.png"), notReady("2"), ready("3", "p/3.png")],
      }),
    ).toEqual({ sheetPaths: ["p/1.png", "p/3.png"] });
  });

  it("5 tagged ready entities → capped at 4, tag order preserved", () => {
    expect(
      resolveClipReferences({
        useEntityRefs: true,
        spec: supports,
        taggedEntities: [
          ready("1", "p/1.png"),
          ready("2", "p/2.png"),
          ready("3", "p/3.png"),
          ready("4", "p/4.png"),
          ready("5", "p/5.png"),
        ],
      }),
    ).toEqual({ sheetPaths: ["p/1.png", "p/2.png", "p/3.png", "p/4.png"] });
  });
});
