/**
 * Shot clip generation service (v4 P3 extraction; multi-model since Clip
 * Engine v2; camera/negative-prompt/duration/ends_on wiring added in
 * Directing Controls task 7). Resolves the clip model from the registry
 * (explicit param → shot.clipModel → default), resolves the end frame via
 * resolveEndFrame based on shot.endsOn ("free" | "next" | "custom") — "next"
 * uses the timeline-next shot's done image, "custom" uses the shot's
 * authored end-frame asset, and any resolution that can't produce a tail
 * image degrades to an unchained clip and reports why via
 * endFrameSkippedReason rather than failing the clip. When a camera move is
 * selected and the model has no hard camera-control param, a deterministic
 * camera phrase is appended to the motion prompt as a best-effort fallback
 * (cameraBestEffort); models that DO support hard camera params (none yet)
 * get the move passed as structured input instead. Duration is resolved via
 * resolveClipDuration (explicit choice → nearest to the shot's timeline slot
 * → model default) and always passed to buildInput. A negative prompt (shot
 * override, else project default, trimmed) is passed only when the model
 * supports one. Calls fal, and stores at
 * projects/{projectId}/shots/{shotId}/clip.mp4. Owns the clipStatus
 * generating → done/failed lifecycle; throws after marking failed.
 * Regenerating a clip resets any SFX variant — the old audio no longer
 * matches. Caller must ensure shot.imagePath is set. Called by
 * POST /shots/[shotId]/clip AND the batch orchestrator.
 *
 * "Next shot" is resolved by TRUE TIMELINE ORDER (orderShotsByTimeline),
 * not the shots.sortOrder column — sortOrder goes stale after a split (the
 * right half gets sortOrder+1 without shifting later rows) and after create
 * (appends by count), so a naive `gt(sortOrder)` query can pick the wrong
 * shot or miss the real next one entirely.
 *
 * Entity references (Directing Controls task 12): when the shot's
 * useEntityRefs toggle is on and the resolved model supports it, every
 * tagged entity with a done reference sheet (up to 4, tag order) is
 * uploaded to fal storage and passed as referenceImageUrls; models map
 * these to their cast/element-reference param (see kling-v3-pro's
 * buildInput). Never fails the clip — resolveClipReferences reports why
 * refs were skipped via refsSkippedReason instead.
 *
 * AI Assistant Director task 3: the resolution/upload/fal/R2 body lives in
 * renderDirectedClip(project, shotId, settings: DirectingSettings,
 * outputR2Key) — it never touches the shots row. generateShotClip is a
 * thin orchestrator: flip clipStatus → settingsFromShot(shot) (pure
 * mapper) → renderDirectedClip to the standard clip.mp4 key → shot-row
 * success update / catch-mark-failed-rethrow. This lets AI-director
 * candidate rendering share the exact same pathway real shots use.
 */
import { db } from "@/lib/db";
import { shots, beats, entities, type Project, type Shot } from "@/lib/db/schema";
import { eq, asc, and, inArray } from "drizzle-orm";
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";
import { uploadR2ObjectToFal } from "@/lib/fal-upload";
import {
  getClipModel,
  DEFAULT_CLIP_MODEL_ID,
  resolveClipDuration,
  type ClipModelId,
  type ClipModelSpec,
} from "@/lib/clip-models";
import { resolveEndFrame, type EndFrameSkipReason } from "@/lib/clip-chaining";
import { resolveClipReferences, type RefsSkipReason } from "@/lib/clip-references";
import {
  isCameraMove,
  isCameraStrength,
  cameraPromptSuffix,
  type CameraMove,
  type CameraStrength,
} from "@/lib/clip-camera";
import { orderShotsByTimeline } from "@/lib/shot-beat-mapping";

fal.config({ credentials: process.env.FAL_KEY! });

/**
 * Loads the shot's tagged entities (referencedEntityIds), scoped to the
 * project, reordered to match the tag array order (DB row order is
 * unspecified). Mirrors the query idiom in resolvePrimaryEntity
 * (shot-image-generation.ts) but returns ALL tagged entities, not just one.
 */
async function loadTaggedEntities(projectId: string, referencedEntityIds: string[] | null | undefined) {
  const taggedIds = referencedEntityIds ?? [];
  if (taggedIds.length === 0) return [];

  const rows = await db
    .select({
      id: entities.id,
      name: entities.name,
      referenceStatus: entities.referenceStatus,
      referenceSheetPath: entities.referenceSheetPath,
    })
    .from(entities)
    .where(and(eq(entities.projectId, projectId), inArray(entities.id, taggedIds)));
  const byId = new Map(rows.map((e) => [e.id, e]));
  return taggedIds.map((tid) => byId.get(tid)).filter((e): e is (typeof rows)[number] => e !== undefined);
}

/**
 * Resolves the entity references named in settings and uploads each ready
 * sheet to fal storage. The pure keep/skip decision lives in
 * resolveClipReferences; this owns only the DB load (loadTaggedEntities,
 * project-scoped) and the uploads. Returns the fal URLs for buildInput
 * plus the applied count / skip reason for the response and done-log.
 */
async function resolveAndUploadReferences(
  project: Project,
  settings: Pick<DirectingSettings, "referencedEntityIds" | "useEntityRefs">,
  spec: Pick<ClipModelSpec, "supportsReferences">,
): Promise<{ referenceImageUrls?: string[]; refsApplied: number; refsSkippedReason?: RefsSkipReason }> {
  const taggedEntities = await loadTaggedEntities(project.id, settings.referencedEntityIds);
  const refs = resolveClipReferences({ useEntityRefs: settings.useEntityRefs, spec, taggedEntities });
  if (refs.sheetPaths.length === 0) {
    return { refsApplied: 0, ...(refs.skipReason ? { refsSkippedReason: refs.skipReason } : {}) };
  }

  const referenceImageUrls = await Promise.all(
    refs.sheetPaths.map((sheetPath, i) =>
      uploadR2ObjectToFal(sheetPath, {
        fileName: `entity-ref-${i}.png`,
        contentType: "image/png",
      }),
    ),
  );
  return { referenceImageUrls, refsApplied: referenceImageUrls.length };
}

export interface GenerateShotClipResult {
  clipPath: string;
  clipUrl: string;
  clipDurationSeconds: number;
  clipModel: ClipModelId;
  endFrameSkippedReason?: EndFrameSkipReason;
  cameraBestEffort?: boolean;
  refsApplied?: number;
  refsSkippedReason?: RefsSkipReason;
}

/**
 * Everything clip resolution needs, decoupled from the shots row. Lets
 * renderDirectedClip serve both the real shot pathway (via
 * settingsFromShot) and future AI-director candidate pathways that never
 * touch the shots table, while sharing one resolution/upload/fal/R2 body.
 */
export interface DirectingSettings {
  imagePath: string; // start still (real or scratch)
  motionPrompt: string;
  clipModel: string | null;
  cameraMove: string | null;
  cameraStrength: string | null;
  endsOn: "free" | "next" | "custom";
  endFramePath: string | null;
  endFrameStatus: string | null;
  clipDurationChoice: number | null;
  negativePrompt: string | null; // shot-level override
  useEntityRefs: boolean;
  referencedEntityIds: string[];
  slotSeconds: number | null;
}

/**
 * Pure mapper from a shot row to DirectingSettings. slotSeconds is derived
 * from the shot's timeline bounds (endInBeat - startInBeat), degrading to
 * null when either bound is missing.
 */
export function settingsFromShot(shot: Shot): DirectingSettings {
  return {
    imagePath: shot.imagePath!,
    motionPrompt: shot.motionPrompt,
    clipModel: shot.clipModel,
    cameraMove: shot.cameraMove,
    cameraStrength: shot.cameraStrength,
    endsOn: (shot.endsOn ?? "free") as "free" | "next" | "custom",
    endFramePath: shot.endFramePath,
    endFrameStatus: shot.endFrameStatus,
    clipDurationChoice: shot.clipDurationChoice ?? null,
    negativePrompt: shot.negativePrompt,
    useEntityRefs: shot.useEntityRefs,
    referencedEntityIds: shot.referencedEntityIds ?? [],
    slotSeconds:
      shot.startInBeat != null && shot.endInBeat != null ? shot.endInBeat - shot.startInBeat : null,
  };
}

/**
 * Resolves and renders a clip from DirectingSettings: uploads the start
 * (and resolved end) frame, resolves entity references, camera, negative
 * prompt and duration, calls fal, and writes the result to outputR2Key.
 * Reads the shot row ONLY for the timeline-order next-shot lookup (needed
 * for endsOn: "next") and to scope entity reference loading — it never
 * mutates the shots table. Shared by the real shot pathway
 * (generateShotClip) and AI-director candidate rendering, so both take
 * the exact same resolution logic.
 */
export async function renderDirectedClip(
  project: Project,
  shotId: string,
  settings: DirectingSettings,
  outputR2Key: string,
): Promise<GenerateShotClipResult> {
  const spec =
    getClipModel(settings.clipModel) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;

  console.log(
    `[shot-clip] project=${project.id} shot=${shotId} model=${spec.id} | motion: ${settings.motionPrompt.substring(0, 120)}...`,
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
  const currentIndex = ordered.findIndex((s) => s.id === shotId);
  const nextShot = currentIndex >= 0 ? (ordered[currentIndex + 1] ?? null) : null;

  const endFrame = resolveEndFrame({
    endsOn: settings.endsOn,
    endFramePath: settings.endFramePath,
    endFrameStatus: settings.endFrameStatus,
    spec,
    nextShot: nextShot ?? null,
  });

  const imageUrl = await uploadR2ObjectToFal(settings.imagePath, {
    fileName: "shot-image.png",
    contentType: "image/png",
  });
  const tailImageUrl = endFrame.tailImagePath
    ? await uploadR2ObjectToFal(endFrame.tailImagePath, {
        fileName: "shot-tail-image.png",
        contentType: "image/png",
      })
    : undefined;

  const refs = await resolveAndUploadReferences(project, settings, spec);

  const cameraSelected = settings.cameraMove && isCameraMove(settings.cameraMove);
  const strength: CameraStrength =
    settings.cameraStrength && isCameraStrength(settings.cameraStrength) ? settings.cameraStrength : "medium";
  const cameraBestEffort = Boolean(cameraSelected && !spec.supportsCameraControl);
  const prompt = cameraBestEffort
    ? `${settings.motionPrompt} ${cameraPromptSuffix(settings.cameraMove as CameraMove, strength)}`
    : settings.motionPrompt;

  const negativePrompt = spec.supportsNegativePrompt
    ? (settings.negativePrompt?.trim() || project.negativePrompt?.trim() || undefined)
    : undefined;

  const durationSeconds = resolveClipDuration(spec, settings.slotSeconds, settings.clipDurationChoice ?? null);

  const result = await fal.subscribe(spec.falEndpoint, {
    input: spec.buildInput({
      imageUrl,
      prompt,
      tailImageUrl,
      ...(cameraSelected && spec.supportsCameraControl
        ? { camera: { move: settings.cameraMove as CameraMove, strength } }
        : {}),
      ...(negativePrompt ? { negativePrompt } : {}),
      durationSeconds,
      ...(refs.referenceImageUrls ? { referenceImageUrls: refs.referenceImageUrls } : {}),
    }),
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS" && "logs" in update) {
        update.logs?.map((log) => log.message).forEach((msg) => console.log(`[shot-clip] ${msg}`));
      }
    },
  });

  const output = result.data as { video?: { url: string; duration?: number } };
  if (!output.video?.url) throw new Error(`${spec.label} returned no video`);
  // Fall back to the duration we REQUESTED, not the model default —
  // Kling v3 honors the request but omits duration in its response
  // (observed live: requested 4s, real file 4.04s, response had none).
  const clipDuration = output.video.duration ?? durationSeconds;

  const videoRes = await fetch(output.video.url);
  if (!videoRes.ok) throw new Error("Failed to download generated clip");
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: outputR2Key,
      Body: videoBuffer,
      ContentType: "video/mp4",
    }),
  );

  const endFrameSkippedReason = settings.endsOn !== "free" ? endFrame.skipReason : undefined;
  console.log(
    `[shot-clip] done: ${outputR2Key} (${clipDuration}s, ${spec.id}` +
      `${endFrameSkippedReason ? `, end frame skipped: ${endFrameSkippedReason}` : endFrame.tailImagePath ? ", end frame applied" : ""}` +
      `${cameraBestEffort ? ", camera best-effort" : ""}, refs=${refs.refsApplied})`,
  );
  return {
    clipPath: outputR2Key,
    clipUrl: await getDownloadUrl(outputR2Key),
    clipDurationSeconds: Math.round(clipDuration),
    clipModel: spec.id,
    ...(endFrameSkippedReason ? { endFrameSkippedReason } : {}),
    ...(cameraBestEffort ? { cameraBestEffort } : {}),
    ...(refs.refsApplied ? { refsApplied: refs.refsApplied } : {}),
    ...(refs.refsSkippedReason ? { refsSkippedReason: refs.refsSkippedReason } : {}),
  };
}

export async function generateShotClip(
  project: Project,
  shot: Shot,
  opts?: { model?: string },
): Promise<GenerateShotClipResult> {
  await db.update(shots).set({ clipStatus: "generating" }).where(eq(shots.id, shot.id));

  try {
    const settings = settingsFromShot(shot);
    // opts.model is trusted PRE-VALIDATED (both callers gate on isClipModelId).
    // An invalid string here would overwrite the shot's model and silently fall
    // back to the registry default inside renderDirectedClip — validate at the
    // boundary, never pass raw client input.
    if (opts?.model) settings.clipModel = opts.model;

    const r2Key = `projects/${project.id}/shots/${shot.id}/clip.mp4`;
    const result = await renderDirectedClip(project, shot.id, settings, r2Key);

    // SFX is invalidated by a new clip: the old audio no longer matches.
    await db
      .update(shots)
      .set({
        clipPath: result.clipPath,
        clipStatus: "done",
        clipDurationSeconds: result.clipDurationSeconds,
        clipModel: result.clipModel,
        sfxPath: null,
        sfxStatus: "pending",
      })
      .where(eq(shots.id, shot.id));

    return result;
  } catch (error) {
    await db.update(shots).set({ clipStatus: "failed" }).where(eq(shots.id, shot.id)).catch(() => {});
    throw error;
  }
}
