/**
 * Shared camera-directing vocabulary for the clip model registry
 * (Clip Engine v2 / Directing Controls). No fal.ai endpoint the app
 * currently calls accepts these as hard input params — they are mapped
 * into the text prompt as a fallback (see clip-models.ts buildInput
 * implementations). Kept in their own module so the vocabulary can be
 * imported without pulling in the full model registry.
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
