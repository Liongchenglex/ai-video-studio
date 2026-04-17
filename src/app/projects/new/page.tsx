/**
 * Create new project page (server component). Fetches session
 * and renders the new project form with navbar.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Navbar } from "@/components/navbar";
import { NewProjectForm } from "@/components/new-project-form";

export default async function NewProjectPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar user={{ name: session.user.name, email: session.user.email }} />
      <NewProjectForm />
    </div>
  );
}
