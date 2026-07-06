/**
 * Shot clip generation service (v4 P3 extraction). LTX-2.3 image-to-video
 * via fal.ai: uploads the shot's still image to fal storage (fal can't
 * always read R2 presigned URLs), generates a ~6s clip from the motion
 * prompt, stores at projects/{projectId}/shots/{shotId}/clip.mp4. Owns the
 * clipStatus generating → done/failed lifecycle; throws after marking
 * failed. Caller must ensure shot.imagePath is set. Called by
 * POST /shots/[shotId]/clip AND the batch orchestrator (Hailuo A/B route
 * stays separate — batch always uses the default LTX provider).
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

async function uploadImageToFal(r2Key: string): Promise<string> {
  // Pull the image bytes out of R2
  const r2Object = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
  );
  const imageBytes = await r2Object.Body!.transformToByteArray();
  const imageBuffer = Buffer.from(imageBytes);

  // Ask fal for a one-shot upload URL
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_name: "shot-image.png", content_type: "image/png" }),
  });

  if (initRes.ok) {
    const { upload_url, file_url } = (await initRes.json()) as {
      upload_url: string;
      file_url: string;
    };
    await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: imageBuffer,
    });
    return file_url;
  }

  // Fallback: some fal models accept R2 presigned URLs directly
  return getDownloadUrl(r2Key);
}

export async function generateShotClip(
  project: Project,
  shot: Shot,
): Promise<{ clipPath: string; clipUrl: string; clipDurationSeconds: number }> {
  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(
      `[shot-clip] project=${project.id} shot=${shot.id} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const falImageUrl = await uploadImageToFal(shot.imagePath!);
    const result = await fal.subscribe("fal-ai/ltx-2.3/image-to-video", {
      input: { image_url: falImageUrl, prompt: shot.motionPrompt },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-clip] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string; duration?: number } };
    if (!output.video?.url) throw new Error("LTX-2.3 returned no video");
    const clipDuration = output.video.duration ?? 6;

    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) throw new Error("Failed to download generated clip");
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const r2Key = `projects/${project.id}/shots/${shot.id}/clip.mp4`;
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
      .set({ clipPath: r2Key, clipStatus: "done", clipDurationSeconds: Math.round(clipDuration) })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-clip] done: ${r2Key} (${clipDuration}s)`);
    return {
      clipPath: r2Key,
      clipUrl: await getDownloadUrl(r2Key),
      clipDurationSeconds: Math.round(clipDuration),
    };
  } catch (error) {
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
