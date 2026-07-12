/**
 * Tests for the pure helpers in director-run.ts. The rest of that module is
 * a thin DB layer (no branching logic worth unit testing without a real
 * database — see docs/feature20's manual test cases for the resolve-route
 * flows), but `filterRunFrameKeys` is pure and security-critical enough
 * (final-review finding C1) to cover directly.
 */
import { describe, it, expect } from "vitest";
import { filterRunFrameKeys } from "@/lib/director/director-run";

const RUN_PREFIX = "projects/proj-1/shots/shot-1/director/run-1/";

describe("filterRunFrameKeys", () => {
  it("keeps only string keys under the run's own prefix", () => {
    const keys = [
      `${RUN_PREFIX}frame-0.png`,
      `${RUN_PREFIX}frame-3.png`,
      "projects/other-project/shots/other-shot/director/other-run/frame-0.png",
    ];
    expect(filterRunFrameKeys(keys, RUN_PREFIX)).toEqual([
      `${RUN_PREFIX}frame-0.png`,
      `${RUN_PREFIX}frame-3.png`,
    ]);
  });

  it("drops non-string entries", () => {
    const keys = [`${RUN_PREFIX}frame-0.png`, 123, null, { key: "x" }];
    expect(filterRunFrameKeys(keys, RUN_PREFIX)).toEqual([`${RUN_PREFIX}frame-0.png`]);
  });

  it("returns an empty array when the input isn't an array", () => {
    expect(filterRunFrameKeys(undefined, RUN_PREFIX)).toEqual([]);
    expect(filterRunFrameKeys("not-an-array", RUN_PREFIX)).toEqual([]);
    expect(filterRunFrameKeys(null, RUN_PREFIX)).toEqual([]);
  });

  it("rejects a key that merely contains the prefix, not starting with it", () => {
    const keys = [`decoy/${RUN_PREFIX}frame-0.png`];
    expect(filterRunFrameKeys(keys, RUN_PREFIX)).toEqual([]);
  });

  it("rejects a sibling run's key under the same shot", () => {
    const siblingRunKey = "projects/proj-1/shots/shot-1/director/run-2/frame-0.png";
    expect(filterRunFrameKeys([siblingRunKey], RUN_PREFIX)).toEqual([]);
  });
});
