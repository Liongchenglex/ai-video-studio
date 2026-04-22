/**
 * Project workspace orchestrator (PRD v3.0 stepper).
 * Four steps: Concept → Style → Script → Editor.
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
import { StepEditor } from "@/components/step-editor";

export interface ShotData {
  id: string;
  projectId: string;
  sortOrder: number;
  startSeconds: number;
  endSeconds: number;
  text: string | null;
  imagePrompt: string;
  motionPrompt: string;
  imagePath: string | null;
  imageStatus: string;
  clipPath: string | null;
  clipStatus: string;
  clipDurationSeconds: number | null;
  imageUrl?: string | null;
  clipUrl?: string | null;
}

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
    voiceoverPath: string | null;
    voiceoverStatus: string;
    voiceoverUrl: string | null;
    durationSeconds: number | null;
    musicPath: string | null;
    musicStatus: string | null;
    musicMood: string;
  };
  initialShots: ShotData[];
}

const statusLabel: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  ready: "Ready",
  published: "Published",
};

export function ProjectWorkspace({ project, initialShots }: ProjectWorkspaceProps) {
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

  // ── Script state ──
  const [script, setScript] = useState(project.script || "");
  const [generatingScript, setGeneratingScript] = useState(false);

  // ── Voice state ──
  const [voiceId, setVoiceId] = useState(project.voiceId);
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(project.voiceoverUrl);
  const [voiceoverStatus, setVoiceoverStatus] = useState(project.voiceoverStatus);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(project.durationSeconds);

  // ── Shots state ──
  const [shots, setShots] = useState<ShotData[]>(initialShots);
  const [recommendingShots, setRecommendingShots] = useState(false);

  const hasRefImages = refKeys.length > 0;
  const hasScript = script.trim().length > 0;
  const hasVO = voiceoverStatus === "done" && !!voiceoverUrl;

  const handleStepChange = useCallback((step: number) => {
    setCurrentStep(step);
    if (step === 3) {
      // Coming into the editor — pull fresh server data (covers the case where
      // VO was generated in a prior visit and the parent state is stale).
      router.refresh();
    }
  }, [router]);

  const [currentStep, setCurrentStep] = useState(() => {
    if (hasScript) return 2;
    if (styleString.length > 0 || hasRefImages) return 1;
    return 0;
  });

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
      description: "Draft & edit",
      completed: hasScript,
    },
    {
      label: "Editor",
      description: "Voice & shots",
      completed: hasVO && shots.length > 0,
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
        setScript(data.script);
        // Regenerating script invalidates any VO.
        setVoiceoverUrl(null);
        setVoiceoverStatus("pending");
        setDurationSeconds(null);
      }
    } finally {
      setGeneratingScript(false);
    }
  }, [project.id]);

  // ── Voice handlers ──
  const handleGenerateVoiceover = useCallback(async () => {
    setVoiceoverStatus("generating");
    try {
      const res = await fetch(`/api/projects/${project.id}/voiceover/generate`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          r2Key: string;
          durationSeconds: number;
          voiceoverUrl: string;
        };
        setVoiceoverUrl(data.voiceoverUrl);
        setDurationSeconds(data.durationSeconds);
        setVoiceoverStatus("done");
      } else {
        setVoiceoverStatus("failed");
      }
    } catch {
      setVoiceoverStatus("failed");
    }
  }, [project.id]);

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

  // ── Shot handlers ──
  const handleRecommendShots = useCallback(async () => {
    setRecommendingShots(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/shots/recommend`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.text();
        console.error("[recommend-shots] server error:", err);
        return;
      }
      const data = (await res.json()) as { shots: ShotData[] };
      console.log(`[recommend-shots] received ${data.shots.length} shots`);
      // Clear first to force a remount of downstream memo-based state,
      // then set — React 18 batches these so UI only sees the new list.
      setShots([]);
      setShots(data.shots);
    } catch (err) {
      console.error("[recommend-shots] fetch failed:", err);
    } finally {
      setRecommendingShots(false);
    }
  }, [project.id]);

  // The editor step needs more horizontal room than the other steps.
  const containerMax = currentStep === 3 ? "max-w-[96rem]" : "max-w-5xl";

  return (
    <main className={`mx-auto ${containerMax} px-4 py-8`}>
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
        onStepClick={handleStepChange}
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
          script={script}
          generatingScript={generatingScript}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
          onScriptChange={setScript}
          onGenerateScript={handleGenerateScript}
          onBack={() => setCurrentStep(1)}
          onNext={() => handleStepChange(3)}
        />
      )}

      {currentStep === 3 && (
        <StepEditor
          projectId={project.id}
          script={script}
          voiceoverUrl={voiceoverUrl}
          voiceoverStatus={voiceoverStatus}
          durationSeconds={durationSeconds}
          voiceId={voiceId}
          shots={shots}
          recommendingShots={recommendingShots}
          onGenerateVoiceover={handleGenerateVoiceover}
          onRecommendShots={handleRecommendShots}
          onVoiceChange={handleVoiceChange}
          onBack={() => setCurrentStep(2)}
        />
      )}
    </main>
  );
}
