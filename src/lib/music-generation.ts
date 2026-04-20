/**
 * Background music generation service using ElevenLabs Music API.
 * Generates a commercially cleared music track matching the video mood.
 * Stores MP3 in R2.
 */
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

interface GenerateMusicInput {
  projectId: string;
  mood: string;
  durationSeconds: number;
}

interface GenerateMusicResult {
  r2Key: string;
}

const MOOD_PROMPTS: Record<string, string> = {
  epic: "Epic cinematic orchestral music, dramatic and powerful, suitable for documentary narration",
  ambient: "Calm ambient background music, soft and atmospheric, suitable for educational narration",
  playful: "Playful upbeat background music, light and fun, suitable for entertaining narration",
};

/**
 * Generates background music and stores in R2.
 * Uses ElevenLabs Music API for commercially cleared tracks.
 */
export async function generateMusic(
  input: GenerateMusicInput,
): Promise<GenerateMusicResult> {
  const prompt = MOOD_PROMPTS[input.mood] || MOOD_PROMPTS.ambient;

  const response = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      duration_seconds: input.durationSeconds,
      output_format: "mp3_44100_128",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs Music API failed: ${response.status} ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  const r2Key = `projects/${input.projectId}/music.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  return { r2Key };
}
