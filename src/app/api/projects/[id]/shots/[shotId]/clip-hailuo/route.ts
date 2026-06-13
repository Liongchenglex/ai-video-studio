/**
 * POST /api/projects/[id]/shots/[shotId]/clip-hailuo
 * A/B test endpoint — same flow as the LTX-2.3 clip endpoint but calls
 * MiniMax Hailuo 02 Standard (768p, 6s) instead. Used to compare motion
 * quality side-by-side against LTX on the same still image.
 *
 * Output is written to a SEPARATE R2 key (`clip-hailuo.mp4`) so the LTX
 * clip isn't overwritten — the side panel can show both.
 *
 * Persists to the same `clipPath`/`clipStatus`/`clipDurationSeconds` fields
 * for UI simplicity (this is a throwaway comparison test, not a permanent
 * second-model feature).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

type Params = { params: Promise<{ id: string; shotId: string }> };

async function uploadImageToFal(r2Key: string): Promise<string> {
  const r2Object = await r2Client.send(
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
  );
  const imageBytes = await r2Object.Body!.transformToByteArray();
  const imageBuffer = Buffer.from(imageBytes);

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
  return getDownloadUrl(r2Key);
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, shotId } = await params;
  if (!isValidUUID(id) || !isValidUUID(shotId)) return badRequestResponse("Invalid IDs");

  const [row] = await db
    .select({ shot: shots, project: projects })
    .from(shots)
    .innerJoin(projects, eq(shots.projectId, projects.id))
    .where(and(eq(shots.id, shotId), eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!row) return notFoundResponse();
  const { shot, project } = row;

  if (!shot.imagePath) {
    return badRequestResponse("Generate the shot's image before generating a clip");
  }

  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shotId));

  try {
    console.log(
      `[shot/clip-hailuo] project=${id} shot=${shotId} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const falImageUrl = await uploadImageToFal(shot.imagePath);
    console.log(`[shot/clip-hailuo] uploaded to fal: ${falImageUrl}`);

    const result = await fal.subscribe("fal-ai/minimax/hailuo-02/standard/image-to-video", {
      input: {
        image_url: falImageUrl,
        prompt: shot.motionPrompt,
        duration: "6",
        resolution: "768P",
        // Disabled: prompt_optimizer is the most likely cause of subject drift
        // (human → elephant). Our motion prompt is already Haiku-generated and
        // scene-aware; no need to re-rewrite it internally.
        prompt_optimizer: false,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs
            ?.map((log) => log.message)
            .forEach((msg) => console.log(`[shot/clip-hailuo] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string } };
    if (!output.video?.url) throw new Error("Hailuo returned no video");

    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) throw new Error("Failed to download generated clip");
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    // Store to a distinct key so the LTX clip (if any) isn't overwritten
    const r2Key = `projects/${project.id}/shots/${shot.id}/clip-hailuo.mp4`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: videoBuffer,
        ContentType: "video/mp4",
      }),
    );

    // We point the shot at the Hailuo clip so the timeline + preview show it.
    // User can regenerate with LTX to swap back. This is a throwaway A/B test.
    await db
      .update(shots)
      .set({
        clipPath: r2Key,
        clipStatus: "done",
        clipDurationSeconds: 6,
      })
      .where(eq(shots.id, shotId));

    const downloadUrl = await getDownloadUrl(r2Key);
    console.log(`[shot/clip-hailuo] done: ${r2Key}`);
    return NextResponse.json({
      clipPath: r2Key,
      clipUrl: downloadUrl,
      clipStatus: "done",
      clipDurationSeconds: 6,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/clip-hailuo] failed:`, msg);
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shotId)).catch(() => {});
    return NextResponse.json({ error: msg, clipStatus: "failed" }, { status: 500 });
  }
}
