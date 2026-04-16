/**
 * Project workspace page. Shows project details and status.
 * This is the hub where future features (style, script, assets) will plug in.
 */
"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Navbar } from "@/components/navbar";

interface Project {
  id: string;
  name: string;
  topic: string | null;
  status: "draft" | "generating" | "ready" | "published";
  createdAt: string;
  updatedAt: string;
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProject() {
      const res = await fetch(`/api/projects/${id}`);
      if (res.ok) {
        setProject(await res.json());
      } else {
        router.push("/dashboard");
      }
      setLoading(false);
    }
    fetchProject();
  }, [id, router]);

  if (loading || !project) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="mx-auto max-w-4xl px-4 py-8">
          <p className="text-muted-foreground">Loading project...</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
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
    </div>
  );
}
