/**
 * Shot SFX generation service (Clip Engine v2). Runs the finished clip
 * through MMAudio v2 (video→audio foley, ~$0.001/s) and stores the merged
 * output as a SEPARATE variant at .../clip-sfx.mp4 — clip.mp4 is never
 * touched, so SFX can be re-rolled or removed for cents without re-billing
 * the clip. Owns the sfxStatus generating → done/failed lifecycle; throws
 * after marking failed. Caller must ensure shot.clipPath is set.
 *
 * MMAudio v2's `prompt` input is REQUIRED by the fal schema (confirmed via
 * the endpoint's OpenAPI spec — https://fal.ai/api/openapi/queue/openapi.json
 * ?endpoint_id=fal-ai/mmaudio-v2), unlike the caller-facing `opts.prompt`
 * here, which stays optional: an empty/blank prompt falls back to
 * DEFAULT_SFX_PROMPT so MMAudio always receives non-empty steering text.
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import { uploadR2ObjectToFal } from "@/lib/fal-upload";

fal.config({ credentials: process.env.FAL_KEY! });

export const SFX_PROMPT_MAX_CHARS = 500;

// Placeholder only — used whenever the caller doesn't supply steering text.
// MMAudio requires a non-empty prompt; this stays neutral (no genre/mood
// bias) and lets the model infer foley from the video itself.
const DEFAULT_SFX_PROMPT = "realistic synchronized sound effects for this video";

export async function generateShotSfx(
  project: Project,
  shot: Shot,
  opts?: { prompt?: string },
): Promise<{ sfxPath: string; sfxUrl: string }> {
  await db.update(shots).set({ sfxStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(`[shot-sfx] project=${project.id} shot=${shot.id}`);

    const videoUrl = await uploadR2ObjectToFal(shot.clipPath!, {
      fileName: "shot-clip.mp4",
      contentType: "video/mp4",
    });

    const prompt = opts?.prompt?.trim() || DEFAULT_SFX_PROMPT;

    const result = await fal.subscribe("fal-ai/mmaudio-v2", {
      input: { video_url: videoUrl, prompt },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-sfx] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string } };
    if (!output.video?.url) throw new Error("MMAudio returned no video");

    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) throw new Error("Failed to download SFX variant");
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const r2Key = `projects/${project.id}/shots/${shot.id}/clip-sfx.mp4`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: videoBuffer,
        ContentType: "video/mp4",
      }),
    );

    await db
      .update(shots)
      .set({ sfxPath: r2Key, sfxStatus: "done" })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-sfx] done: ${r2Key}`);
    return { sfxPath: r2Key, sfxUrl: await getDownloadUrl(r2Key) };
  } catch (error) {
    await db.update(shots).set({ sfxStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
