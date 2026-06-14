/**
 * Beat timing (v4.0).
 * The timeline stacks beats sequentially: a beat's absolute start is the sum
 * of all prior beats' durations. These pure helpers convert per-beat
 * durations into absolute offsets used by the editor and exporter.
 */

export interface BeatLike {
  id: string;
  sortOrder: number;
  voDurationSeconds: number | null;
}

export interface BeatOffset {
  id: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Returns each beat's absolute [startSeconds, endSeconds] in sortOrder.
 * Beats with no measured duration yet contribute 0 length.
 */
export function computeBeatOffsets(beats: BeatLike[]): BeatOffset[] {
  const ordered = [...beats].sort((a, b) => a.sortOrder - b.sortOrder);
  const offsets: BeatOffset[] = [];
  let cursor = 0;
  for (const beat of ordered) {
    const dur = beat.voDurationSeconds ?? 0;
    offsets.push({ id: beat.id, startSeconds: cursor, endSeconds: cursor + dur });
    cursor += dur;
  }
  return offsets;
}

/** Total timeline duration = sum of beat durations. */
export function totalDurationSeconds(beats: BeatLike[]): number {
  return beats.reduce((sum, b) => sum + (b.voDurationSeconds ?? 0), 0);
}

/**
 * Absolute time of a shot given its parent beat's absolute start and the
 * shot's offset within the beat.
 */
export function absoluteShotTime(
  beatStartSeconds: number,
  offsetInBeat: number,
): number {
  return beatStartSeconds + offsetInBeat;
}
