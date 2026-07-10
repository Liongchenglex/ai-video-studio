/**
 * Unit tests for the pure chain-suggestion helpers: buildChainPairs
 * (adjacent-pair construction with beat/entity context) and
 * sanitizeChainSuggestions (model-output allow-listing). The network-bound
 * suggestChains is not unit-tested; its error path returns [].
 *
 * buildChainPairs no longer sorts (final-review finding #1) — it requires
 * timeline-ordered input from the caller (orderShotsByTimeline). These
 * tests pass shots pre-ordered, matching that contract.
 */
import { describe, it, expect } from "vitest";
import { buildChainPairs, sanitizeChainSuggestions } from "@/lib/chain-suggestion";

const shot = (id: string, sortOrder: number, beatId: string, entities: string[] = []) => ({
  id,
  sortOrder,
  beatId,
  imagePrompt: `prompt ${id}`,
  referencedEntityIds: entities,
});

describe("buildChainPairs", () => {
  it("pairs adjacent shots in input order with shared context", () => {
    const pairs = buildChainPairs([
      shot("a", 1, "b1", ["e1", "e2"]),
      shot("b", 2, "b1", ["e2"]),
      shot("c", 3, "b2", ["e1"]),
    ]);
    expect(pairs).toEqual([
      { shotId: "a", nextShotId: "b", sameBeat: true, sharedEntityIds: ["e2"] },
      { shotId: "b", nextShotId: "c", sameBeat: false, sharedEntityIds: [] },
    ]);
  });

  it("returns [] for fewer than two shots", () => {
    expect(buildChainPairs([shot("a", 1, "b1")])).toEqual([]);
    expect(buildChainPairs([])).toEqual([]);
  });

  it("tolerates null referencedEntityIds", () => {
    const pairs = buildChainPairs([
      { ...shot("a", 1, "b1"), referencedEntityIds: null },
      shot("b", 2, "b1"),
    ]);
    expect(pairs[0].sharedEntityIds).toEqual([]);
  });

  it("does NOT sort — unordered input is the caller's bug, pairs follow input order as-is", () => {
    // sortOrder here is deliberately reversed vs. the passed-in order; if
    // this function still sorted internally, the pairing would differ.
    const pairs = buildChainPairs([
      shot("c", 1, "b1"),
      shot("a", 3, "b1"),
      shot("b", 2, "b1"),
    ]);
    expect(pairs.map((p) => [p.shotId, p.nextShotId])).toEqual([
      ["c", "a"],
      ["a", "b"],
    ]);
  });
});

describe("sanitizeChainSuggestions", () => {
  const pairs = buildChainPairs([shot("a", 1, "b1"), shot("b", 2, "b1"), shot("c", 3, "b1")]);

  it("keeps only ids that are a pair's first shot", () => {
    expect(sanitizeChainSuggestions(["a", "c", "zzz", 42, null], pairs)).toEqual(["a"]);
    // "c" is only ever a nextShotId (last shot) — chaining it is invalid
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeChainSuggestions("a", pairs)).toEqual([]);
    expect(sanitizeChainSuggestions(undefined, pairs)).toEqual([]);
  });
});
