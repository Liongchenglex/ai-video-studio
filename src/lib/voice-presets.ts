/**
 * Curated voice presets for v1.0 (6 voices: 3 female, 3 male).
 * Selected from ElevenLabs' default library for narration warmth and clarity.
 * Voice IDs are from ElevenLabs' pre-made voices.
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
    id: "21m00Tcm4TlvDq8ikWAM",
    name: "Rachel",
    gender: "female",
    description: "Calm, clear, American",
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Bella",
    gender: "female",
    description: "Warm, engaging, American",
  },
  {
    id: "MF3mGyEYCl7XYWbV9V6O",
    name: "Elli",
    gender: "female",
    description: "Young, energetic, American",
  },
  // Male voices
  {
    id: "ErXwobaYiN019PkySvjV",
    name: "Antoni",
    gender: "male",
    description: "Warm, conversational, American",
  },
  {
    id: "VR6AewLTigWG4xSOukaG",
    name: "Arnold",
    gender: "male",
    description: "Deep, authoritative, American",
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    name: "Adam",
    gender: "male",
    description: "Deep, narration, American",
  },
];

export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel

export function getVoicePreset(id: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((v) => v.id === id);
}
