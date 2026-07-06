/**
 * Curated fallback voices (used when GET /api/voices is unavailable) and
 * the project default. IDs refreshed 2026-07-06 against the live
 * ElevenLabs premade library — the original v1.0 preset IDs had gone
 * stale (several legacy IDs now redirect to a single voice, one had
 * changed gender). The full, always-current list with previews comes
 * from /api/voices; this file only guarantees the selector never renders
 * empty.
 */

export interface VoicePreset {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
}

export const VOICE_PRESETS: VoicePreset[] = [
  // Female voices
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    gender: "female",
    description: "Mature, reassuring, American",
  },
  {
    id: "Xb7hH8MSUJpSbSDYk0k2",
    name: "Alice",
    gender: "female",
    description: "Clear, engaging educator, British",
  },
  {
    id: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda",
    gender: "female",
    description: "Knowledgeable, professional, American",
  },
  // Male voices
  {
    id: "JBFqnCBsd6RMkjVDRZzb",
    name: "George",
    gender: "male",
    description: "Warm, captivating storyteller, British",
  },
  {
    id: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    gender: "male",
    description: "Deep, resonant, comforting, American",
  },
  {
    id: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel",
    gender: "male",
    description: "Steady broadcaster, British",
  },
];

// Kept as the historical default: existing projects (and the schema
// column default) reference this id, and ElevenLabs still voices it
// (it resolves to a professional narration voice). New projects can pick
// from the live library in the selector.
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export function getVoicePreset(id: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((v) => v.id === id);
}
