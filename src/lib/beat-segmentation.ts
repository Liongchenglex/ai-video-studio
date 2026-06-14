/**
 * Beat segmentation (v4.0).
 * Splits a prose script into ordered "beat" texts — one sentence or major
 * clause each — at natural prosodic boundaries. Each beat becomes its own
 * voiceover clip, so cuts must land on punctuation (never mid-sentence) to
 * keep concatenation seams inaudible. Deterministic; no AI involved.
 */

/** Minimum characters for a standalone beat; shorter tails merge backwards. */
const MIN_BEAT_CHARS = 25;

/**
 * Splits `script` into beat texts in document order.
 * Boundaries: sentence terminators (. ! ?) and major clause marks (; : —),
 * each followed by whitespace or end-of-text. Whitespace is normalised and
 * surrounding spaces trimmed; the original wording is otherwise preserved.
 */
export function segmentIntoBeats(script: string): string[] {
  const normalised = script.replace(/\s+/g, " ").trim();
  if (normalised.length === 0) return [];

  // Split *after* a boundary mark + trailing space, keeping the mark with its
  // sentence. The capturing group keeps delimiters; we re-join mark+clause.
  const pieces = normalised.split(/([.!?;:—]+\s+)/);

  const raw: string[] = [];
  let current = "";
  for (const piece of pieces) {
    current += piece;
    // A piece that *is* a boundary delimiter closes the current beat.
    if (/[.!?;:—]+\s+$/.test(piece)) {
      raw.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length > 0) raw.push(current.trim());

  // Merge slivers (e.g. "Yes." or "But—") into the previous beat.
  const beats: string[] = [];
  for (const beat of raw) {
    if (
      beats.length > 0 &&
      beat.replace(/[.!?;:—\s]/g, "").length < MIN_BEAT_CHARS
    ) {
      beats[beats.length - 1] = `${beats[beats.length - 1]} ${beat}`.trim();
    } else {
      beats.push(beat);
    }
  }

  return beats;
}
