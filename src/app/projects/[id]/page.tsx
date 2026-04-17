/**
 * Project workspace page (server component). Fetches session and project
 * data server-side, renders the project workspace.
 */
import { headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Navbar } from "@/components/navbar";
import { ProjectWorkspace } from "@/components/project-workspace";
import { isValidUUID } from "@/lib/api-utils";

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

  return (
    <div className="min-h-screen bg-background">
      <Navbar user={{ name: session.user.name, email: session.user.email }} />
      <ProjectWorkspace
        project={{
          id: project.id,
          name: project.name,
          topic: project.topic,
          status: project.status,
        }}
      />
    </div>
  );
}
