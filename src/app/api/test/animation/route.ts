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
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

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
    // Get the presigned URL for the scene's generated image
    const imageUrl = await getDownloadUrl(scene.imagePath);

    // Use sceneDescription as the motion prompt — this is where camera/transition words are useful
    const motionPrompt = project.styleString
      ? `${scene.sceneDescription}. Style: ${project.styleString}`
      : scene.sceneDescription;

    console.log(`[test/animation] Scene ${scene.sortOrder} | Duration: ${scene.durationSeconds}s`);
    console.log(`[test/animation] Motion prompt: ${motionPrompt.substring(0, 120)}...`);
    console.log(`[test/animation] Image URL: ${imageUrl.substring(0, 80)}...`);

    // LTX-2.3 only supports 6, 8, or 10 second clips
    // Pick the closest supported duration
    const supportedDurations = [6, 8, 10];
    const clipDuration = supportedDurations.reduce((prev, curr) =>
      Math.abs(curr - scene.durationSeconds) < Math.abs(prev - scene.durationSeconds) ? curr : prev
    );

    const result = await fal.subscribe("fal-ai/ltx-2.3/image-to-video", {
      input: {
        image_url: imageUrl,
        prompt: motionPrompt,
        duration: String(clipDuration),
        resolution: "720p",
        aspect_ratio: "auto",
        fps: "25",
        generate_audio: false,
      },
    });

    const output = result.data as { video?: { url: string } };
    if (!output.video?.url) {
      throw new Error("LTX-2.3 returned no video");
    }

    console.log(`[test/animation] Video generated, downloading...`);

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

    const downloadUrl = await getDownloadUrl(r2Key);

    console.log(`[test/animation] Done: ${r2Key}`);
    return NextResponse.json({
      success: true,
      r2Key,
      downloadUrl,
      clipDuration,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[test/animation] Failed:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
