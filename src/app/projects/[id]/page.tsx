/**
 * Project workspace page (server component). Fetches session and project
 * data server-side, renders the project workspace with style profile.
 */
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
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

  const projectScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  // Generate download URLs for existing reference images
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
        }}
        initialScenes={projectScenes}
      />
    </div>
  );
}
