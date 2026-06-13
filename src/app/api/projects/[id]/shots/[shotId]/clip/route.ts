/**
 * POST /api/projects/[id]/shots/[shotId]/clip
 * Generates (or regenerates) the animation clip for a shot using LTX-2.3
 * image-to-video via fal.ai. The shot's image is uploaded to fal storage
 * first (fal can't always fetch from R2 presigned URLs), then LTX produces
 * a ~6s 1080p clip that we download and store in R2.
 *
 * Synchronous: awaits fal.ai. Typical latency 60-120s per clip.
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
      `[shot/clip] project=${id} shot=${shotId} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const falImageUrl = await uploadImageToFal(shot.imagePath);
    console.log(`[shot/clip] uploaded to fal: ${falImageUrl}`);

    const result = await fal.subscribe("fal-ai/ltx-2.3/image-to-video", {
      input: {
        image_url: falImageUrl,
        prompt: shot.motionPrompt,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot/clip] ${msg}`));
        }
      },
    });

    const output = result.data as {
      video?: { url: string; duration?: number; fps?: number };
    };
    if (!output.video?.url) throw new Error("LTX-2.3 returned no video");

    const clipDuration = output.video.duration ?? 6;

    // Download the clip from fal and push to R2
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
      .set({
        clipPath: r2Key,
        clipStatus: "done",
        clipDurationSeconds: Math.round(clipDuration),
      })
      .where(eq(shots.id, shotId));

    const downloadUrl = await getDownloadUrl(r2Key);
    console.log(`[shot/clip] done: ${r2Key} (${clipDuration}s)`);
    return NextResponse.json({
      clipPath: r2Key,
      clipUrl: downloadUrl,
      clipStatus: "done",
      clipDurationSeconds: Math.round(clipDuration),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[shot/clip] failed:`, msg);
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shotId)).catch(() => {});
    return NextResponse.json({ error: msg, clipStatus: "failed" }, { status: 500 });
  }
}
