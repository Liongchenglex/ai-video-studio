/**
 * Shot ↔ beat mapping (v4.0 Phase 2).
 * Pure helpers that place an absolute [start, end] second range onto the
 * beat timeline: pick the beat with maximum overlap and clamp the range
 * into offsets within that beat. Used by the legacy-shot adoption
 * migration and by per-beat shot recommendation.
 */
import type { BeatOffset } from "@/lib/beat-timing";

/** Shots shorter than this (after clamping) are stretched to it. */
export const MIN_SHOT_SECONDS = 0.25;

export interface BeatRelativeRange {
  beatId: string;
  startInBeat: number;
  endInBeat: number;
}

/**
 * Maps an absolute range onto the beat with which it overlaps most.
 * Returns null when there are no beats or the range has no positive
 * overlap with any beat (e.g. it lies entirely past the timeline end —
 * callers should then clamp to the last beat themselves or skip).
 */
export function assignRangeToBeat(
  startSec: number,
  endSec: number,
  offsets: BeatOffset[],
): BeatRelativeRange | null {
  if (offsets.length === 0 || endSec <= startSec) return null;

  let best: BeatOffset | null = null;
  let bestOverlap = 0;
  for (const o of offsets) {
    const overlap =
      Math.min(endSec, o.endSeconds) - Math.max(startSec, o.startSeconds);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = o;
    }
  }
  if (!best) return null;

  const beatDur = best.endSeconds - best.startSeconds;
  let startInBeat = Math.max(0, startSec - best.startSeconds);
  let endInBeat = Math.min(beatDur, endSec - best.startSeconds);

  // Enforce a minimum length, clamped inside the beat.
  if (endInBeat - startInBeat < MIN_SHOT_SECONDS) {
    endInBeat = Math.min(beatDur, startInBeat + MIN_SHOT_SECONDS);
    startInBeat = Math.max(0, endInBeat - MIN_SHOT_SECONDS);
  }
  if (endInBeat <= startInBeat) return null; // beat shorter than the minimum

  return { beatId: best.id, startInBeat, endInBeat };
}
