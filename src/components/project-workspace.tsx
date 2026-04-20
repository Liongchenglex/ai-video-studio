/**
 * Project workspace orchestrator (client component).
 * Manages the 3-step stepper flow: Concept → Style → Script.
 * All state lives here; step components are pure renderers.
 */
"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ProjectStepper } from "@/components/project-stepper";
import { VideoBrief } from "@/components/video-brief";
import { StepStyle } from "@/components/step-style";
import { StepScript } from "@/components/step-script";

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
    brief: string | null;
    targetDuration: number;
    tone: string;
  };
  initialScenes: Array<{
    id: string;
    sortOrder: number;
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    isHook: boolean;
  }>;
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectWorkspace({ project, initialScenes }: ProjectWorkspaceProps) {
  const router = useRouter();

  // ── Step navigation ──
  const [currentStep, setCurrentStep] = useState(() => {
    if (initialScenes.length > 0) return 2;
    if (project.styleString || (project.styleRefPaths && project.styleRefPaths.length > 0)) return 1;
    return 0;
  });

  // ── Brief state ──
  const [brief, setBrief] = useState(project.brief || "");
  const [targetDuration, setTargetDuration] = useState(project.targetDuration);
  const [tone, setTone] = useState(project.tone);

  // ── Style state ──
  const [styleString, setStyleString] = useState(project.styleString || "");
  const [refKeys, setRefKeys] = useState<string[]>(project.styleRefPaths || []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(project.stylePreviewUrl);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [showTemplateSave, setShowTemplateSave] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateRefreshKey, setTemplateRefreshKey] = useState(0);

  // ── Script state ──
  const [scenes, setScenes] = useState(initialScenes);
  const [scriptKey, setScriptKey] = useState(0);
  const [generatingScript, setGeneratingScript] = useState(false);

  const hasRefImages = refKeys.length > 0;

  // ── Step completion ──
  const steps = [
    {
      label: "Concept",
      description: "Video brief",
      completed: brief.trim().length > 0,
    },
    {
      label: "Style",
      description: "Visual identity",
      completed: styleString.length > 0 || hasRefImages,
    },
    {
      label: "Script",
      description: "Scene breakdown",
      completed: scenes.length > 0,
    },
  ];

  // ── Style handlers ──
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
      const res = await fetch("/api/style-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          name: templateName.trim(),
        }),
      });
      if (res.ok) {
        setShowTemplateSave(false);
        setTemplateName("");
        setTemplateSaved(true);
        setTemplateRefreshKey((k) => k + 1);
      }
    } finally {
      setSavingTemplate(false);
    }
  }, [project.id, templateName]);

  // ── Script handlers ──
  const handleGenerateScript = useCallback(async () => {
    setGeneratingScript(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/script/generate`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setScenes(data.scenes);
        setScriptKey((k) => k + 1);
      }
    } finally {
      setGeneratingScript(false);
    }
  }, [project.id]);

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

      <ProjectStepper
        currentStep={currentStep}
        steps={steps}
        onStepClick={setCurrentStep}
      />

      <Separator className="mb-8" />

      {currentStep === 0 && (
        <VideoBrief
          projectId={project.id}
          initialBrief={brief}
          initialDuration={targetDuration}
          initialTone={tone}
          onNext={() => setCurrentStep(1)}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
        />
      )}

      {currentStep === 1 && (
        <StepStyle
          projectId={project.id}
          styleString={styleString}
          styleRefUrls={project.styleRefUrls}
          styleRefPaths={refKeys}
          previewUrl={previewUrl}
          hasRefImages={hasRefImages}
          generatingPreview={generatingPreview}
          templateRefreshKey={templateRefreshKey}
          templateSaved={templateSaved}
          showTemplateSave={showTemplateSave}
          savingTemplate={savingTemplate}
          templateName={templateName}
          onUploadComplete={handleUploadComplete}
          onStyleSave={handleStyleSave}
          onPreviewRequest={handlePreviewRequest}
          onApplyTemplate={handleApplyTemplate}
          onSaveTemplate={handleSaveTemplate}
          onSetTemplateName={setTemplateName}
          onShowTemplateSave={setShowTemplateSave}
          onCreateNewStyle={() => {
            setStyleString("");
            setRefKeys([]);
            setPreviewUrl(null);
          }}
          onNext={() => setCurrentStep(2)}
          onBack={() => setCurrentStep(0)}
        />
      )}

      {currentStep === 2 && (
        <StepScript
          projectId={project.id}
          brief={brief}
          duration={targetDuration}
          tone={tone}
          scenes={scenes}
          scriptKey={scriptKey}
          generatingScript={generatingScript}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
          onGenerateScript={handleGenerateScript}
          onBack={() => setCurrentStep(1)}
        />
      )}
    </main>
  );
}
