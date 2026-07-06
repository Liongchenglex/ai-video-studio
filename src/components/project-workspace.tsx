/**
 * Project workspace orchestrator (v4.0 stepper).
 * Three steps: Concept → Style → Editor. Brief and style state live here;
 * the script/voice/shots state moved into the unified editor's store and
 * gates. Step 2 mounts <UnifiedEditor/>, which is one screen for writing,
 * voicing, and storyboarding.
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
import { UnifiedEditor } from "@/components/editor/unified-editor";
import type { EditorBeat, EditorEntity, EditorShot } from "@/components/editor/editor-store";

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
    script: string | null;
    voiceId: string;
  };
  initialBeats: EditorBeat[];
  initialShots: EditorShot[];
  initialEntities: EditorEntity[];
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectWorkspace({
  project,
  initialBeats,
  initialShots,
  initialEntities,
}: ProjectWorkspaceProps) {
  const router = useRouter();

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

  // ── Voice (the editor's store owns beats/shots; workspace keeps only the
  // project-level voice selection so the voiceId patch stays in one place) ──
  const [voiceId, setVoiceId] = useState(project.voiceId);

  const hasRefImages = refKeys.length > 0;
  const hasScript = (project.script?.trim().length ?? 0) > 0;

  const [currentStep, setCurrentStep] = useState(() => {
    if (hasScript || initialBeats.length > 0) return 2;
    if (styleString.length > 0 || hasRefImages) return 1;
    return 0;
  });

  const handleStepChange = useCallback(
    (step: number) => {
      setCurrentStep(step);
      if (step === 2) {
        // Entering the editor — pull fresh server data so beats/shots created
        // on a prior visit show up.
        router.refresh();
      }
    },
    [router],
  );

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
      label: "Editor",
      description: "Write · voice · direct",
      completed: initialBeats.length > 0 && initialShots.length > 0,
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

  // ── Voice handler (project-level; editor gates call it too) ──
  const handleVoiceChange = useCallback(
    async (newVoiceId: string) => {
      setVoiceId(newVoiceId);
      await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId: newVoiceId }),
      });
    },
    [project.id],
  );

  // The editor step needs more horizontal room than the other steps.
  const containerMax = currentStep === 2 ? "max-w-[96rem]" : "max-w-5xl";

  return (
    <main className={`mx-auto ${containerMax} px-4 py-8`}>
      <Button variant="ghost" className="mb-6" onClick={() => router.push("/dashboard")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to dashboard
      </Button>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">{project.name}</h1>
          {project.topic && <p className="mt-1 text-muted-foreground">{project.topic}</p>}
        </div>
        <Badge variant="secondary">{statusLabel[project.status]}</Badge>
      </div>

      <ProjectStepper currentStep={currentStep} steps={steps} onStepClick={handleStepChange} />

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
          onNext={() => handleStepChange(2)}
          onBack={() => setCurrentStep(0)}
        />
      )}

      {currentStep === 2 && (
        <UnifiedEditor
          projectId={project.id}
          script={project.script}
          hasBrief={brief.trim().length > 0}
          voiceId={voiceId}
          initialBeats={initialBeats}
          initialShots={initialShots}
          initialEntities={initialEntities}
          onVoiceChange={handleVoiceChange}
        />
      )}
    </main>
  );
}
