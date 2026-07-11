/**
 * Project workspace page (server component, PRD v3.0 shape).
 * Loads the project row (including script + VO), shots attached directly
 * to the project, and generates presigned URLs for any existing assets.
 */
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, shots, beats, entities } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { Navbar } from "@/components/navbar";
import { ProjectWorkspace } from "@/components/project-workspace";
import type { EditorBeat, EditorEntity, EditorShot } from "@/components/editor/editor-store";
import { isValidUUID } from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { computeBeatOffsets } from "@/lib/beat-timing";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  if (!isValidUUID(id)) {
    notFound();
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project || project.userId !== session.user.id) {
    notFound();
  }

  // Shots attach directly to the project now (no scenes).
  const projectShots = await db
    .select()
    .from(shots)
    .where(eq(shots.projectId, id))
    .orderBy(asc(shots.sortOrder));

  // Map shot rows straight to the store's EditorShot shape (beat-relative
  // offsets; the deprecated absolute start/endSeconds are not carried).
  const initialShots: EditorShot[] = await Promise.all(
    projectShots.map(async (shot) => ({
      id: shot.id,
      beatId: shot.beatId,
      sortOrder: shot.sortOrder,
      startInBeat: shot.startInBeat,
      endInBeat: shot.endInBeat,
      imagePrompt: shot.imagePrompt,
      motionPrompt: shot.motionPrompt,
      imagePath: shot.imagePath,
      imageStatus: shot.imageStatus ?? "pending",
      imageUrl: shot.imagePath ? await getDownloadUrl(shot.imagePath) : null,
      clipPath: shot.clipPath,
      clipStatus: shot.clipStatus ?? "pending",
      clipUrl: shot.clipPath ? await getDownloadUrl(shot.clipPath) : null,
      clipDurationSeconds: shot.clipDurationSeconds,
      clipModel: shot.clipModel,
      cameraMove: shot.cameraMove,
      cameraStrength: shot.cameraStrength,
      endsOn: (shot.endsOn ?? "free") as EditorShot["endsOn"],
      clipDurationChoice: shot.clipDurationChoice,
      negativePrompt: shot.negativePrompt,
      useEntityRefs: shot.useEntityRefs,
      endFramePath: shot.endFramePath,
      endFrameStatus: shot.endFrameStatus ?? "pending",
      endFrameInstruction: shot.endFrameInstruction,
      endFrameUrl: shot.endFramePath ? await getDownloadUrl(shot.endFramePath) : null,
      sfxPath: shot.sfxPath,
      sfxStatus: shot.sfxStatus ?? "pending",
      sfxUrl: shot.sfxPath ? await getDownloadUrl(shot.sfxPath) : null,
      referencedEntityIds: shot.referencedEntityIds ?? [],
    })),
  );

  // Beats (mirrors GET /beats): ordered, presigned audio, absolute offsets.
  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const beatOffsets = computeBeatOffsets(beatRows);
  const beatOffsetById = new Map(beatOffsets.map((o) => [o.id, o]));

  const initialBeats: EditorBeat[] = await Promise.all(
    beatRows.map(async (b) => ({
      id: b.id,
      sortOrder: b.sortOrder,
      text: b.text,
      voStatus: b.voStatus ?? "pending",
      voDurationSeconds: b.voDurationSeconds,
      voUrl: b.voPath ? await getDownloadUrl(b.voPath) : null,
      startSeconds: beatOffsetById.get(b.id)?.startSeconds ?? 0,
      endSeconds: beatOffsetById.get(b.id)?.endSeconds ?? 0,
    })),
  );

  // Reference Bible entities (v4.0 Phase 4, F-16) — project-scoped, ordered
  // by createdAt (mirrors GET /entities). shotCount is computed from the
  // shots already loaded above rather than a second DB pass, since
  // initialShots' referencedEntityIds is the same source the count needs.
  const entityRows = await db
    .select()
    .from(entities)
    .where(eq(entities.projectId, id))
    .orderBy(asc(entities.createdAt));

  const entityShotCountById = new Map<string, number>();
  for (const s of initialShots) {
    for (const entityId of s.referencedEntityIds) {
      entityShotCountById.set(entityId, (entityShotCountById.get(entityId) ?? 0) + 1);
    }
  }

  const initialEntities: EditorEntity[] = await Promise.all(
    entityRows.map(async (e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      description: e.description ?? "",
      referenceStatus: e.referenceStatus ?? "pending",
      referenceSheetUrl: e.referenceSheetPath ? await getDownloadUrl(e.referenceSheetPath) : null,
      shotCount: entityShotCountById.get(e.id) ?? 0,
    })),
  );

  const styleRefUrls = project.styleRefPaths
    ? await Promise.all(project.styleRefPaths.map(getDownloadUrl))
    : [];

  const stylePreviewUrl = project.stylePreviewPath
    ? await getDownloadUrl(project.stylePreviewPath)
    : null;

  return (
    <div className="min-h-screen bg-background">
      <Navbar user={{ name: session.user.name, email: session.user.email }} />
      <ProjectWorkspace
        project={{
          id: project.id,
          name: project.name,
          topic: project.topic,
          status: project.status,
          styleString: project.styleString,
          styleRefPaths: project.styleRefPaths,
          styleRefUrls,
          stylePreviewUrl,
          brief: project.brief,
          targetDuration: project.targetDuration ?? 5,
          tone: project.tone ?? "educational",
          script: project.script,
          voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
          negativePrompt: project.negativePrompt,
        }}
        initialBeats={initialBeats}
        initialShots={initialShots}
        initialEntities={initialEntities}
      />
    </div>
  );
}
