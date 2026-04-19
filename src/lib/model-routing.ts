/**
 * Model routing logic for image and video generation.
 * Determines which API to call based on whether the project has a
 * style profile (reference images + style string).
 *
 * Used by F-04 (Image Generation) and F-07 (Animation).
 */

export type ImageModel = "flux-kontext" | "imagen-4-fast";
export type VideoModel = "ltx-2.3";

interface ProjectStyleState {
  styleString: string | null;
  styleRefPaths: string[] | null;
}

/**
 * Resolves which image generation model to use.
 * - Style profile exists → FLUX.1 Kontext (accepts reference images + text)
 * - No style profile → Imagen 4 Fast (text-only)
 */
export function resolveImageModel(project: ProjectStyleState): ImageModel {
  const hasStyle =
    project.styleString &&
    project.styleRefPaths &&
    project.styleRefPaths.length > 0;

  return hasStyle ? "flux-kontext" : "imagen-4-fast";
}

/**
 * Resolves which video generation model to use.
 * Currently always LTX-2.3.
 */
export function resolveVideoModel(_project: ProjectStyleState): VideoModel {
  return "ltx-2.3";
}

/**
 * Returns a human-readable label for display as a badge on generated assets.
 */
export function imageModelLabel(model: ImageModel): string {
  switch (model) {
    case "flux-kontext":
      return "FLUX.1 Kontext";
    case "imagen-4-fast":
      return "Imagen 4";
  }
}

export function videoModelLabel(model: VideoModel): string {
  switch (model) {
    case "ltx-2.3":
      return "LTX-2.3";
  }
}
