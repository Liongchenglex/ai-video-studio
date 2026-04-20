/**
 * Voiceover generation service using ElevenLabs TTS.
 * Generates narration audio with word-level timestamps for sync.
 * Stores MP3 in R2 and returns timing data for captions/assembly.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

interface GenerateVoiceoverInput {
  projectId: string;
  sceneId: string;
  text: string;
  voiceId: string;
}

interface VoiceoverTimestamps {
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
 * Generates voiceover audio with timestamps and stores in R2.
 */
export async function generateSceneVoiceover(
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

  const r2Key = `projects/${input.projectId}/scenes/${input.sceneId}/voiceover.mp3`;
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
