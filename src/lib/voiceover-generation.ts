/**
 * Voiceover generation (F-05, PRD v3.0).
 * One continuous voiceover per project. Char-level timestamps drive
 * the editor's waveform scrubbing and shot time-range selection.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

interface GenerateVoiceoverInput {
  projectId: string;
  text: string;
  voiceId: string;
}

export interface VoiceoverTimestamps {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface GenerateVoiceoverResult {
  r2Key: string;
  timestamps: VoiceoverTimestamps;
  durationSeconds: number;
}

/**
 * Generates a single continuous voiceover for the whole project script.
 * Stored at `projects/{projectId}/voiceover.mp3`. Caller persists r2Key +
 * timestamps + durationSeconds to the projects row.
 */
export async function generateProjectVoiceover(
  input: GenerateVoiceoverInput,
): Promise<GenerateVoiceoverResult> {
  const result = await elevenlabs.textToSpeech.convertWithTimestamps(
    input.voiceId,
    {
      text: input.text,
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
    },
  );

  if (!result.audioBase64) {
    throw new Error("ElevenLabs returned no audio");
  }

  const audioBuffer = Buffer.from(result.audioBase64, "base64");

  const r2Key = `projects/${input.projectId}/voiceover.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  const timestamps: VoiceoverTimestamps = {
    characters: result.alignment?.characters || [],
    character_start_times_seconds: result.alignment?.characterStartTimesSeconds || [],
    character_end_times_seconds: result.alignment?.characterEndTimesSeconds || [],
  };

  const endTimes = timestamps.character_end_times_seconds;
  const durationSeconds = endTimes.length > 0
    ? Math.ceil(endTimes[endTimes.length - 1])
    : 0;

  return { r2Key, timestamps, durationSeconds };
}
