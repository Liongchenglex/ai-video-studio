/**
 * Shot frame-edit service (Directing Controls, Stage 3: frame staging).
 * Edits a shot's still image in place via FLUX Kontext (same
 * fal-ai/flux-pro/kontext endpoint and { prompt, image_url } input/output
 * shape as src/lib/image-generation.ts's reference-conditioned path — see
 * that file's KONTEXT_IMAGE_PROMPT_ENDPOINT for the source of truth) and,
 * separately, authors a custom end frame from the shot's current image.
 * Both own their own generating → done/failed status lifecycle and throw
 * after marking failed.
 *
 * editShotImage overwrites projects/{p}/shots/{s}/image.png in place and,
 * because the shot's image just changed underneath any previously
 * authored end frame, resets endFrameStatus to "pending" (stale-flag) when
 * an end frame exists — it does not delete or otherwise touch the end
 * frame object itself, and never touches clip/sfx.
 *
 * createShotEndFrame stores a SEPARATE object at
 * projects/{p}/shots/{s}/end-frame.png, always sourced from the shot's
 * current imagePath, and records the instruction used (kept for re-rolls).
 */
import { db } from "@/lib/db";
import { shots, type Project, type Shot } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

// Verified 2026-07-04 with a live call ($0.04): fal-ai/flux-pro/kontext
// accepts { prompt, image_url } and returns an image — see
// src/lib/image-generation.ts's KONTEXT_IMAGE_PROMPT_ENDPOINT (same
// endpoint id, same input shape, reused here rather than re-verified).
const KONTEXT_IMAGE_PROMPT_ENDPOINT = "fal-ai/flux-pro/kontext";

export const FRAME_EDIT_INSTRUCTION_MAX_CHARS = 500;

/** Runs the shot's current image through Kontext with an edit instruction
 *  and returns the fal-hosted URL of the resulting image (not yet stored
 *  in R2 — callers persist it at their own key). */
async function runKontextEdit(sourceImagePath: string, instruction: string): Promise<string> {
  const imageUrl = await getDownloadUrl(sourceImagePath);

  const result = await fal.subscribe(KONTEXT_IMAGE_PROMPT_ENDPOINT, {
    input: {
      prompt: instruction,
      image_url: imageUrl,
    },
  });

  const output = result.data as { images?: Array<{ url: string }> };
  if (!output.images || output.images.length === 0) {
    throw new Error("Frame edit returned no images");
  }
  return output.images[0].url;
}

/** Downloads a fal-hosted image and stores it at the given R2 key. */
async function downloadAndStore(sourceUrl: string, r2Key: string): Promise<void> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error("Failed to download edited frame");
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/png";

  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

/**
 * Edits the shot's primary image in place (overwrites image.png). Caller
 * must ensure shot.imagePath is set and shot.imageStatus is "done".
 */
export async function editShotImage(
  project: Project,
  shot: Shot,
  instruction: string,
): Promise<{ imagePath: string; imageUrl: string }> {
  await db.update(shots).set({ imageStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(`[shot-frame-edit] editing image project=${project.id} shot=${shot.id}`);

    const editedUrl = await runKontextEdit(shot.imagePath!, instruction);
    const r2Key = `projects/${project.id}/shots/${shot.id}/image.png`;
    await downloadAndStore(editedUrl, r2Key);

    // The image just changed underneath any previously authored end
    // frame, so its "done" status is now stale — flag it for re-roll
    // without touching the end frame object itself.
    const hasEndFrame = !!shot.endFramePath;
    await db
      .update(shots)
      .set({
        imagePath: r2Key,
        imageStatus: "done",
        ...(hasEndFrame ? { endFrameStatus: "pending" as const } : {}),
      })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-frame-edit] image edit done: ${r2Key}`);
    return { imagePath: r2Key, imageUrl: await getDownloadUrl(r2Key) };
  } catch (error) {
    await db.update(shots).set({ imageStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}

/**
 * Authors a custom end frame for the shot, sourced from its current
 * imagePath. Caller must ensure shot.imagePath is set and shot.imageStatus
 * is "done".
 */
export async function createShotEndFrame(
  project: Project,
  shot: Shot,
  instruction: string,
): Promise<{ endFramePath: string; endFrameUrl: string }> {
  await db.update(shots).set({ endFrameStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(`[shot-frame-edit] creating end frame project=${project.id} shot=${shot.id}`);

    const editedUrl = await runKontextEdit(shot.imagePath!, instruction);
    const r2Key = `projects/${project.id}/shots/${shot.id}/end-frame.png`;
    await downloadAndStore(editedUrl, r2Key);

    await db
      .update(shots)
      .set({ endFramePath: r2Key, endFrameStatus: "done", endFrameInstruction: instruction })
      .where(eq(shots.id, shot.id));

    console.log(`[shot-frame-edit] end frame done: ${r2Key}`);
    return { endFramePath: r2Key, endFrameUrl: await getDownloadUrl(r2Key) };
  } catch (error) {
    await db.update(shots).set({ endFrameStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
