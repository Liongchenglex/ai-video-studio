/**
 * Dashboard content (client component). Contains the project list
 * header and new project button.
 */
"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectList } from "@/components/project-list";

export function DashboardContent() {
  const router = useRouter();

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Projects</h1>
          <p className="text-muted-foreground">Manage your video projects</p>
        </div>
        <Button onClick={() => router.push("/projects/new")}>
          <Plus className="mr-2 h-4 w-4" />
          New project
        </Button>
      </div>
      <ProjectList />
    </main>
  );
}
