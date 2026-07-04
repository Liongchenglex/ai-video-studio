/**
 * Reference-sheet prompt templates for entity image generation.
 * Pure functions — given an entity's name/type/description, produce the
 * exact still-image prompt passed to generateImage(). Project styleString
 * is appended separately by generateImage(), as with all other prompts.
 */

export interface SheetEntityInput {
  name: string;
  type: "character" | "location" | "object";
  description?: string | null;
}

/**
 * Builds the type-specific multi-view reference-sheet prompt for an entity.
 */
export function sheetPrompt(entity: SheetEntityInput): string {
  const description = entity.description ?? "";

  switch (entity.type) {
    case "character":
      return `Character reference sheet of ${entity.name}: ${description}. One single coherent sheet showing the same character from multiple views — full-body front view, side profile view, three-quarter view, and a close-up portrait — identical face, hair, build and clothing in every view, arranged side by side on a plain neutral background. No scene, no text labels.`;
    case "location":
      return `Location reference sheet of ${entity.name}: ${description}. One single coherent sheet showing the same place from multiple angles — wide establishing view, mid-distance view, and a characteristic detail view — consistent architecture, landscape and lighting, arranged side by side. No people, no text labels.`;
    case "object":
      return `Object reference sheet of ${entity.name}: ${description}. One single coherent sheet showing the same object from multiple angles — front, three-quarter and detail close-up — identical materials and proportions, arranged side by side on a plain neutral background. No text labels.`;
  }
}
