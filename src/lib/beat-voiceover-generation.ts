/**
 * Per-beat voiceover generation (v4.0).
 * One short ElevenLabs clip per beat. previousText/nextText are passed as
 * CONTEXT ONLY (not re-voiced, not billed) so intonation and pacing carry
 * across beat boundaries — the key to seamless concatenation. Duration is
 * kept fractional for accurate sequential stacking on the timeline.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

export interface BeatVoiceoverTimestamps {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface GenerateBeatVoiceoverInput {
  projectId: string;
  beatId: string;
  text: string;
  voiceId: string;
  /** Preceding beat text, for prosody continuity (context only). */
  previousText?: string;
  /** Following beat text, for prosody continuity (context only). */
  nextText?: string;
}

interface GenerateBeatVoiceoverResult {
  r2Key: string;
  timestamps: BeatVoiceoverTimestamps;
  durationSeconds: number;
}

/**
 * Generates one beat's voiceover and stores it in R2.
 * Caller persists r2Key + timestamps + durationSeconds onto the beat row.
 */
export async function generateBeatVoiceover(
  input: GenerateBeatVoiceoverInput,
): Promise<GenerateBeatVoiceoverResult> {
  const result = await elevenlabs.textToSpeech.convertWithTimestamps(
    input.voiceId,
    {
      text: input.text,
      modelId: "eleven_multilingual_v2",
      outputFormat: "mp3_44100_128",
      previousText: input.previousText,
      nextText: input.nextText,
    },
  );

  if (!result.audioBase64) {
    throw new Error("ElevenLabs returned no audio");
  }

  const audioBuffer = Buffer.from(result.audioBase64, "base64");

  const r2Key = `projects/${input.projectId}/beats/${input.beatId}.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  const timestamps: BeatVoiceoverTimestamps = {
    characters: result.alignment?.characters || [],
    character_start_times_seconds:
      result.alignment?.characterStartTimesSeconds || [],
    character_end_times_seconds:
      result.alignment?.characterEndTimesSeconds || [],
  };

  const endTimes = timestamps.character_end_times_seconds;
  const durationSeconds =
    endTimes.length > 0 ? endTimes[endTimes.length - 1] : 0;

  return { r2Key, timestamps, durationSeconds };
}
