/**
 * Project workspace content (client component). Displays project
 * details and the style profile section (F-02).
 */
"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { StyleUpload } from "@/components/style-upload";
import { StyleEditor } from "@/components/style-editor";
import { StylePreviewPanel } from "@/components/style-preview-panel";
import { StyleTemplateGrid } from "@/components/style-template-grid";

interface ProjectWorkspaceProps {
  project: {
    id: string;
    name: string;
    topic: string | null;
    status: string;
    styleString: string | null;
    styleRefPaths: string[] | null;
    styleRefUrls: string[];
    stylePreviewUrl: string | null;
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
  const [styleString, setStyleString] = useState(project.styleString || "");
  const [refKeys, setRefKeys] = useState<string[]>(project.styleRefPaths || []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(project.stylePreviewUrl);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [showTemplateSave, setShowTemplateSave] = useState(false);

  const hasRefImages = refKeys.length > 0;

  const handleUploadComplete = useCallback(
    async (keys: string[]) => {
      setRefKeys(keys);
      await fetch(`/api/projects/${project.id}/style`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleRefPaths: keys }),
      });
    },
    [project.id],
  );

  const handleStyleSave = useCallback((newStyleString: string) => {
    setStyleString(newStyleString);
  }, []);

  const handlePreviewRequest = useCallback(async () => {
    setGeneratingPreview(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/style/preview`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setPreviewUrl(data.previewUrl);
      }
    } finally {
      setGeneratingPreview(false);
    }
  }, [project.id]);

  const handleApplyTemplate = useCallback(
    async (templateId: string) => {
      const res = await fetch(`/api/style-templates/${templateId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      if (res.ok) {
        router.refresh();
      }
    },
    [project.id, router],
  );

  const handleSaveTemplate = useCallback(async () => {
    if (!templateName.trim()) return;
    setSavingTemplate(true);
    try {
      await fetch("/api/style-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          name: templateName.trim(),
        }),
      });
      setShowTemplateSave(false);
      setTemplateName("");
    } finally {
      setSavingTemplate(false);
    }
  }, [project.id, templateName]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
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

      {/* Style Profile Section */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section>
            <h2 className="mb-4 text-lg font-semibold">Style profile</h2>

            {/* Reference image upload */}
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-medium">Reference images</h3>
              <StyleUpload
                projectId={project.id}
                existingUrls={project.styleRefUrls}
                existingKeys={project.styleRefPaths || []}
                onUploadComplete={handleUploadComplete}
              />
            </div>

            {/* Style editor */}
            <StyleEditor
              projectId={project.id}
              initialStyleString={styleString}
              hasRefImages={hasRefImages}
              onSave={handleStyleSave}
              onPreviewRequest={handlePreviewRequest}
            />

            {/* Save as template */}
            {styleString && hasRefImages && (
              <div className="mt-4">
                {showTemplateSave ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="Template name"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      maxLength={100}
                      className="max-w-xs"
                    />
                    <Button
                      size="sm"
                      onClick={handleSaveTemplate}
                      disabled={savingTemplate || !templateName.trim()}
                    >
                      <Save className="mr-1 h-3 w-3" />
                      {savingTemplate ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowTemplateSave(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowTemplateSave(true)}
                  >
                    Save as template
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right column: preview + templates */}
        <div className="space-y-6">
          <StylePreviewPanel
            projectId={project.id}
            previewUrl={previewUrl}
            generating={generatingPreview}
          />

          <Separator />

          <StyleTemplateGrid
            projectId={project.id}
            onApply={handleApplyTemplate}
            onCreateNew={() => {
              setStyleString("");
              setRefKeys([]);
              setPreviewUrl(null);
            }}
          />
        </div>
      </div>
    </main>
  );
}
