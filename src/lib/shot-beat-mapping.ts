/**
 * Shot ↔ beat mapping (v4.0 Phase 2 + cross-beat shots).
 * Pure helpers for the anchor-beat spillover model: a shot's beatId is the
 * beat containing its START (the anchor); startInBeat lies within the
 * anchor, but endInBeat may exceed the anchor's duration so the shot spans
 * into following beats. Absolute time = anchor start + offset. Consumed by
 * the shot create/update/split routes and the editor components.
 */
import type { BeatOffset } from "@/lib/beat-timing";

/** Shots shorter than this (after clamping) are stretched to it. */
export const MIN_SHOT_SECONDS = 0.25;

/**
 * The beat whose [startSeconds, endSeconds) contains the given time — the
 * anchor for anything starting there. Times at (or within epsilon past) the
 * timeline end resolve to the last beat so boundary math never dead-ends.
 */
export function anchorForTime(
  seconds: number,
  offsets: BeatOffset[],
): BeatOffset | null {
  if (offsets.length === 0) return null;
  const hit = offsets.find(
    (o) => seconds >= o.startSeconds && seconds < o.endSeconds,
  );
  if (hit) return hit;
  const last = offsets[offsets.length - 1];
  return seconds >= last.endSeconds - 1e-6 ? last : null;
}

/**
 * A shot's absolute [start, end) on the timeline, derived from its anchor's
 * offset. Null when the shot has no anchor or offsets (unmigrated data).
 */
export function shotAbsoluteRange(
  shot: { beatId: string | null; startInBeat: number | null; endInBeat: number | null },
  offsetById: Map<string, BeatOffset>,
): { start: number; end: number } | null {
  if (!shot.beatId || shot.startInBeat == null || shot.endInBeat == null) return null;
  const anchor = offsetById.get(shot.beatId);
  if (!anchor) return null;
  return {
    start: anchor.startSeconds + shot.startInBeat,
    end: anchor.startSeconds + shot.endInBeat,
  };
}

/**
 * Deterministic timeline order for shots — the truthful "next shot" used by
 * clip chaining (final-review finding #1). `sortOrder` alone is unreliable:
 * the split route gives the right half `sortOrder + 1` without shifting
 * later rows (so two shots can share a sortOrder), and create appends by
 * count. The true order is: the anchor beat's position on the timeline
 * (beat sortOrder — beats are renormalized so it's unique and reliable, no
 * need to compute second-level offsets), then position within that beat
 * (startInBeat). `sortOrder` and finally `id` only break exact ties (e.g.
 * two shots at the identical beat + startInBeat).
 *
 * Shots whose beatId is null OR doesn't match any given beat (dangling
 * reference) have no timeline position and sort AFTER every anchored shot,
 * ordered among themselves by (sortOrder, id).
 *
 * Pure — does not mutate `shots`.
 */
export function orderShotsByTimeline<
  T extends { id: string; beatId: string | null; startInBeat: number | null; sortOrder: number },
>(shots: T[], beats: Array<{ id: string; sortOrder: number }>): T[] {
  const beatSortOrderById = new Map(beats.map((b) => [b.id, b.sortOrder]));

  const sortKey = (s: T): [number, number, number, string] => {
    const beatSortOrder = s.beatId ? beatSortOrderById.get(s.beatId) : undefined;
    if (beatSortOrder === undefined) {
      // Unanchored/dangling — sorts after every anchored shot (Infinity),
      // then by (sortOrder, id) among themselves.
      return [Infinity, 0, s.sortOrder, s.id];
    }
    return [beatSortOrder, s.startInBeat ?? 0, s.sortOrder, s.id];
  };

  return [...shots].sort((a, b) => {
    const [aBeat, aStart, aSort, aId] = sortKey(a);
    const [bBeat, bStart, bSort, bId] = sortKey(b);
    if (aBeat !== bBeat) return aBeat - bBeat;
    if (aStart !== bStart) return aStart - bStart;
    if (aSort !== bSort) return aSort - bSort;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}
