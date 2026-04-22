/**
 * Maps time bounds on the project timeline back to the VO text that plays
 * during those bounds, via proportional char/second distribution.
 *
 * Uses the full script length and the project's measured VO duration.
 * Accuracy is ±1-2 words at boundaries — enough for display + prompting;
 * editor UI can still let the user edit the shot text manually if needed.
 */
export function deriveVOText(
  script: string,
  totalDurationSeconds: number,
  startSeconds: number,
  endSeconds: number,
): string {
  if (!script || totalDurationSeconds <= 0) return "";
  const totalChars = script.length;
  const charsPerSecond = totalChars / totalDurationSeconds;

  const startChar = Math.max(0, Math.floor(startSeconds * charsPerSecond));
  const endChar = Math.min(totalChars, Math.ceil(endSeconds * charsPerSecond));

  return script.slice(startChar, endChar).trim();
}
