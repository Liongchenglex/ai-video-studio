/**
 * Scene utility helpers for script generation and display.
 * Provides word counting, duration estimation, and reading pace calculations.
 */

/** Average narration pace: 150 words per minute */
const WORDS_PER_MINUTE = 150;

/**
 * Counts words in a text string.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimates speaking duration in seconds from a word count.
 */
export function wordsToDuration(wordCount: number): number {
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60);
}

/**
 * Estimates the target word count for a given duration in minutes.
 */
export function durationToWords(durationMinutes: number): number {
  return durationMinutes * WORDS_PER_MINUTE;
}

/**
 * Calculates total duration in seconds from an array of scene durations.
 */
export function totalDuration(scenes: Array<{ durationSeconds: number }>): number {
  return scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
}

/**
 * Checks if the total duration drifts more than 15% from the target.
 * Returns the drift percentage (positive = over, negative = under).
 */
export function durationDrift(
  actualSeconds: number,
  targetMinutes: number,
): { drift: number; overTarget: boolean; warning: boolean } {
  const targetSeconds = targetMinutes * 60;
  if (targetSeconds === 0) return { drift: 0, overTarget: false, warning: false };
  const drift = ((actualSeconds - targetSeconds) / targetSeconds) * 100;
  return {
    drift: Math.round(drift),
    overTarget: drift > 0,
    warning: Math.abs(drift) > 15,
  };
}

/**
 * Formats seconds into a human-readable duration string (e.g. "5:30").
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
