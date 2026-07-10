/**
 * Unit tests for shot-beat-mapping's pure helpers, focused on
 * orderShotsByTimeline (final-review finding #1): "next shot" must be
 * resolved by true timeline position, not the unreliable sortOrder column.
 */
import { describe, it, expect } from "vitest";
import { orderShotsByTimeline } from "@/lib/shot-beat-mapping";

interface TestShot {
  id: string;
  beatId: string | null;
  startInBeat: number | null;
  sortOrder: number;
}

const shot = (
  id: string,
  beatId: string | null,
  startInBeat: number | null,
  sortOrder: number,
): TestShot => ({ id, beatId, startInBeat, sortOrder });

const beats = [
  { id: "b1", sortOrder: 0 },
  { id: "b2", sortOrder: 1 },
  { id: "b3", sortOrder: 2 },
];

describe("orderShotsByTimeline", () => {
  it("orders shots across beats by the beat's timeline position, ignoring sortOrder", () => {
    // sortOrder here is deliberately reversed vs. the true beat order.
    const shots = [
      shot("in-b3", "b3", 0, 0),
      shot("in-b2", "b2", 0, 1),
      shot("in-b1", "b1", 0, 2),
    ];
    const ordered = orderShotsByTimeline(shots, beats);
    expect(ordered.map((s) => s.id)).toEqual(["in-b1", "in-b2", "in-b3"]);
  });

  it("orders shots within the same beat by startInBeat", () => {
    const shots = [
      shot("late", "b1", 5, 0),
      shot("early", "b1", 1, 1),
    ];
    const ordered = orderShotsByTimeline(shots, beats);
    expect(ordered.map((s) => s.id)).toEqual(["early", "late"]);
  });

  it("split scenario: duplicate sortOrder in the same beat, startInBeat decides", () => {
    // The split route gives the right half sortOrder+1 without shifting
    // later rows, so both halves can carry the SAME sortOrder as another
    // shot. startInBeat (which always differs after a split) must decide.
    const shots = [
      shot("right-half", "b1", 3, 5),
      shot("left-half", "b1", 0, 5),
    ];
    const ordered = orderShotsByTimeline(shots, beats);
    expect(ordered.map((s) => s.id)).toEqual(["left-half", "right-half"]);
  });

  it("duplicate (beat, startInBeat) tie: sortOrder decides, then id", () => {
    const shots = [
      shot("z", "b1", 2, 9),
      shot("a", "b1", 2, 3),
    ];
    expect(orderShotsByTimeline(shots, beats).map((s) => s.id)).toEqual(["a", "z"]);

    // Same beat, same startInBeat, same sortOrder — id is the final
    // deterministic tie-breaker.
    const tied = [shot("zz", "b1", 2, 3), shot("aa", "b1", 2, 3)];
    expect(orderShotsByTimeline(tied, beats).map((s) => s.id)).toEqual(["aa", "zz"]);
  });

  it("null or unknown beatId shots sort after all anchored shots, by (sortOrder, id)", () => {
    const shots = [
      shot("orphan-b", null, null, 2),
      shot("anchored", "b3", 0, 0),
      shot("orphan-a", null, null, 2),
      shot("dangling", "does-not-exist", 0, 1),
    ];
    const ordered = orderShotsByTimeline(shots, beats);
    expect(ordered.map((s) => s.id)).toEqual(["anchored", "dangling", "orphan-a", "orphan-b"]);
  });

  it("is a pure function — does not mutate the input array", () => {
    const shots = [shot("b", "b2", 0, 1), shot("a", "b1", 0, 0)];
    const copy = [...shots];
    orderShotsByTimeline(shots, beats);
    expect(shots).toEqual(copy);
  });
});
