/**
 * POST /api/test/animation
 * Direct test endpoint for animation generation — no Inngest.
 * Takes the scene's generated image as first frame, uses sceneDescription as motion prompt.
 * Body: { projectId, sceneId }
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSession, unauthorizedResponse, badRequestResponse } from "@/lib/api-utils";
import { fal } from "@fal-ai/client";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { projectId, sceneId } = await request.json();
  if (!projectId || !sceneId) return badRequestResponse("projectId and sceneId required");

  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, session.user.id)))
    .limit(1);
  if (!project) return badRequestResponse("Project not found");

  const [scene] = await db.select().from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, projectId)))
    .limit(1);
  if (!scene) return badRequestResponse("Scene not found");

  if (!scene.imagePath) {
    return badRequestResponse("Generate an image for this scene first");
  }

  try {
    // Download image from R2 and upload to fal.ai storage
    // (fal.ai can't always fetch from R2 presigned URLs)
    console.log(`[test/animation] Scene ${scene.sortOrder} | Uploading image to fal.ai...`);

    const r2Object = await r2Client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: scene.imagePath,
      }),
    );
    const imageBytes = await r2Object.Body!.transformToByteArray();
    const imageBuffer = Buffer.from(imageBytes);
    const imageBlob = new Blob([imageBuffer], { type: "image/png" });
    const imageFile = new File([imageBlob], "scene-image.png", { type: "image/png" });

    const falUpload = await fal.storage.upload(imageFile);
    console.log(`[test/animation] Uploaded to fal: ${falUpload}`);

    // Use sceneDescription as the motion prompt
    const motionPrompt = scene.sceneDescription;

    console.log(`[test/animation] Motion prompt: ${motionPrompt.substring(0, 120)}...`);

    const result = await fal.subscribe("fal-ai/ltx-2.3/image-to-video", {
      input: {
        image_url: falUpload,
        prompt: motionPrompt,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[test/animation] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string } };
    if (!output.video?.url) {
      throw new Error("LTX-2.3 returned no video");
    }

    console.log(`[test/animation] Video generated, downloading to R2...`);

    // Download from fal.ai and upload to R2
    const videoRes = await fetch(output.video.url);
    if (!videoRes.ok) {
      throw new Error("Failed to download generated video");
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

    const r2Key = `projects/${projectId}/scenes/${sceneId}/clip.mp4`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: r2Key,
        Body: videoBuffer,
        ContentType: "video/mp4",
      }),
    );

    console.log(`[test/animation] Done: ${r2Key}`);
    return NextResponse.json({
      success: true,
      r2Key,
      videoUrl: output.video.url,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[test/animation] Failed:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
