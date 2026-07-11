/**
 * Shared camera-directing vocabulary for the clip model registry
 * (Clip Engine v2 / Directing Controls). No fal.ai endpoint the app
 * currently calls accepts these as hard input params — they are mapped
 * into the text prompt as a fallback (see clip-models.ts buildInput
 * implementations). Kept in their own module so the vocabulary can be
 * imported without pulling in the full model registry.
 *
 * Exports:
 * - Type guards: isCameraMove, isCameraStrength (runtime type validation)
 * - Constants: CAMERA_MOVES (labeled moves), CAMERA_MAGNITUDE (strength→number)
 * - Prompt builder: cameraPromptSuffix (deterministic fallback prompt text)
 */

export type CameraMove =
  | "static"
  | "push-in"
  | "pull-back"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "orbit";

export type CameraStrength = "subtle" | "medium" | "strong";

/** Ordered array of camera moves with descriptive labels for UI. */
export const CAMERA_MOVES: Array<{ id: CameraMove; label: string }> = [
  { id: "static", label: "Static" },
  { id: "push-in", label: "Push in" },
  { id: "pull-back", label: "Pull back" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "tilt-up", label: "Tilt up" },
  { id: "tilt-down", label: "Tilt down" },
  { id: "orbit", label: "Orbit" },
];

/** Strength-to-magnitude mapping for camera direction prompts. */
export const CAMERA_MAGNITUDE: Record<CameraStrength, number> = {
  subtle: 3,
  medium: 6,
  strong: 9,
};

/** Type guard: check if value is a valid CameraMove. */
export function isCameraMove(v: unknown): v is CameraMove {
  return typeof v === "string" && CAMERA_MOVES.map((m) => m.id).includes(v as CameraMove);
}

/** Type guard: check if value is a valid CameraStrength. */
export function isCameraStrength(v: unknown): v is CameraStrength {
  return typeof v === "string" && Object.keys(CAMERA_MAGNITUDE).includes(v as CameraStrength);
}

/**
 * Builds a deterministic camera-direction prompt suffix.
 * Maps (move, strength) to natural-language phrasing for prompt fallback.
 * Example: cameraPromptSuffix("push-in", "subtle") → "Camera: slow push-in."
 */
export function cameraPromptSuffix(move: CameraMove, strength: CameraStrength): string {
  // Static is special: ignore strength, return no-movement phrase
  if (move === "static") {
    return "Camera: locked off, no camera movement.";
  }

  // Map strength to speed word
  const speedWord = {
    subtle: "slow",
    medium: "steady",
    strong: "fast",
  }[strength];

  // Map move to phrase
  const movePhrase = {
    "push-in": "push-in",
    "pull-back": "pull-back",
    "pan-left": "pan to the left",
    "pan-right": "pan to the right",
    "tilt-up": "tilt upward",
    "tilt-down": "tilt downward",
    orbit: "orbit around the subject",
  }[move];

  return `Camera: ${speedWord} ${movePhrase}.`;
}
