/**
 * Project workspace page (server component, PRD v3.0 shape).
 * Loads the project row (including script + VO), shots attached directly
 * to the project, and generates presigned URLs for any existing assets.
 */
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, shots } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { Navbar } from "@/components/navbar";
import { ProjectWorkspace } from "@/components/project-workspace";
import { isValidUUID } from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";

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

  const shotsWithUrls = await Promise.all(
    projectShots.map(async (shot) => ({
      ...shot,
      imageStatus: shot.imageStatus ?? "pending",
      clipStatus: shot.clipStatus ?? "pending",
      imageUrl: shot.imagePath ? await getDownloadUrl(shot.imagePath) : null,
      clipUrl: shot.clipPath ? await getDownloadUrl(shot.clipPath) : null,
    })),
  );

  const styleRefUrls = project.styleRefPaths
    ? await Promise.all(project.styleRefPaths.map(getDownloadUrl))
    : [];

  const stylePreviewUrl = project.stylePreviewPath
    ? await getDownloadUrl(project.stylePreviewPath)
    : null;

  const voiceoverUrl = project.voiceoverPath
    ? await getDownloadUrl(project.voiceoverPath)
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
          voiceoverPath: project.voiceoverPath,
          voiceoverStatus: project.voiceoverStatus ?? "pending",
          voiceoverUrl,
          durationSeconds: project.durationSeconds,
          musicPath: project.musicPath,
          musicStatus: project.musicStatus,
          musicMood: project.musicMood || "ambient",
        }}
        initialShots={shotsWithUrls}
      />
    </div>
  );
}
