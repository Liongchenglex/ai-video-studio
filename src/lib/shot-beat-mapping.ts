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
