/**
 * Shot clip generation service (v4 P3 extraction; multi-model since Clip
 * Engine v2). Resolves the clip model from the registry (explicit param →
 * shot.clipModel → default), optionally passes the NEXT shot's still as the
 * end frame when shot.chainToNext is set and the model supports it (a
 * skipped chain degrades to unchained generation and reports why), calls
 * fal, and stores at projects/{projectId}/shots/{shotId}/clip.mp4. Owns the
 * clipStatus generating → done/failed lifecycle; throws after marking
 * failed. Regenerating a clip resets any SFX variant — the old audio no
 * longer matches. Caller must ensure shot.imagePath is set. Called by
 * POST /shots/[shotId]/clip AND the batch orchestrator.
 *
 * "Next shot" is resolved by TRUE TIMELINE ORDER (orderShotsByTimeline),
 * not the shots.sortOrder column — sortOrder goes stale after a split (the
 * right half gets sortOrder+1 without shifting later rows) and after create
 * (appends by count), so a naive `gt(sortOrder)` query can pick the wrong
 * shot or miss the real next one entirely.
 */
import { db } from "@/lib/db";
import { shots, beats, type Project, type Shot } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import { uploadR2ObjectToFal } from "@/lib/fal-upload";
import {
  getClipModel,
  DEFAULT_CLIP_MODEL_ID,
  type ClipModelId,
} from "@/lib/clip-models";
import { resolveChainDecision, type ChainSkipReason } from "@/lib/clip-chaining";
import { orderShotsByTimeline } from "@/lib/shot-beat-mapping";

fal.config({ credentials: process.env.FAL_KEY! });

export async function generateShotClip(
  project: Project,
  shot: Shot,
  opts?: { model?: string },
): Promise<{
  clipPath: string;
  clipUrl: string;
  clipDurationSeconds: number;
  clipModel: ClipModelId;
  chainSkippedReason?: ChainSkipReason;
}> {
  const spec =
    getClipModel(opts?.model) ??
    getClipModel(shot.clipModel) ??
    getClipModel(DEFAULT_CLIP_MODEL_ID)!;

  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    console.log(
      `[shot-clip] project=${project.id} shot=${shot.id} model=${spec.id} | motion: ${shot.motionPrompt.substring(0, 120)}...`,
    );

    const projectBeats = await db
      .select({ id: beats.id, sortOrder: beats.sortOrder })
      .from(beats)
      .where(eq(beats.projectId, project.id))
      .orderBy(asc(beats.sortOrder));
    const projectShots = await db
      .select({
        id: shots.id,
        beatId: shots.beatId,
        startInBeat: shots.startInBeat,
        sortOrder: shots.sortOrder,
        imagePath: shots.imagePath,
        imageStatus: shots.imageStatus,
      })
      .from(shots)
      .where(eq(shots.projectId, project.id));
    const ordered = orderShotsByTimeline(projectShots, projectBeats);
    const currentIndex = ordered.findIndex((s) => s.id === shot.id);
    const nextShot = currentIndex >= 0 ? (ordered[currentIndex + 1] ?? null) : null;

    const chain = resolveChainDecision({
      chainToNext: shot.chainToNext,
      spec,
      nextShot: nextShot ?? null,
    });

    const imageUrl = await uploadR2ObjectToFal(shot.imagePath!, {
      fileName: "shot-image.png",
      contentType: "image/png",
    });
    const tailImageUrl = chain.useTail
      ? await uploadR2ObjectToFal(chain.tailImagePath, {
          fileName: "shot-tail-image.png",
          contentType: "image/png",
        })
      : undefined;

    const result = await fal.subscribe(spec.falEndpoint, {
      input: spec.buildInput({ imageUrl, prompt: shot.motionPrompt, tailImageUrl }),
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-clip] ${msg}`));
        }
      },
    });

    const output = result.data as { video?: { url: string; duration?: number } };
    if (!output.video?.url) throw new Error(`${spec.label} returned no video`);
    const clipDuration = output.video.duration ?? spec.durationSeconds;

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

    // SFX is invalidated by a new clip: the old audio no longer matches.
    await db
      .update(shots)
      .set({
        clipPath: r2Key,
        clipStatus: "done",
        clipDurationSeconds: Math.round(clipDuration),
        clipModel: spec.id,
        sfxPath: null,
        sfxStatus: "pending",
      })
      .where(eq(shots.id, shot.id));

    const chainSkippedReason =
      shot.chainToNext && !chain.useTail ? chain.reason : undefined;
    console.log(
      `[shot-clip] done: ${r2Key} (${clipDuration}s, ${spec.id}${chainSkippedReason ? `, chain skipped: ${chainSkippedReason}` : chain.useTail ? ", chained" : ""})`,
    );
    return {
      clipPath: r2Key,
      clipUrl: await getDownloadUrl(r2Key),
      clipDurationSeconds: Math.round(clipDuration),
      clipModel: spec.id,
      ...(chainSkippedReason ? { chainSkippedReason } : {}),
    };
  } catch (error) {
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
