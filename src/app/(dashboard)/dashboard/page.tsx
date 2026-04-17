/**
 * Dashboard page (server component). Fetches session server-side
 * and renders the project list with navbar.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Navbar } from "@/components/navbar";
import { DashboardContent } from "@/components/dashboard-content";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar user={{ name: session.user.name, email: session.user.email }} />
      <DashboardContent />
    </div>
  );
}
