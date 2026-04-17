/**
 * Project workspace content (client component). Displays project
 * details and placeholder for future feature modules.
 */
"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface ProjectWorkspaceProps {
  project: {
    id: string;
    name: string;
    topic: string | null;
    status: string;
  };
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectWorkspace({ project }: ProjectWorkspaceProps) {
  const router = useRouter();

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => router.push("/dashboard")}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to dashboard
      </Button>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">{project.name}</h1>
          {project.topic && (
            <p className="mt-1 text-muted-foreground">{project.topic}</p>
          )}
        </div>
        <Badge variant="secondary">{statusLabel[project.status]}</Badge>
      </div>

      <Separator className="mb-8" />

      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-muted-foreground">
          Project workspace — style profiles, script generation, and asset
          management will appear here in future phases.
        </p>
      </div>
    </main>
  );
}
