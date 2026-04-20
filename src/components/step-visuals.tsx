/**
 * Step 3 (now Step 4 in stepper): Visuals + Voice.
 * Shows scene cards with images and voiceover, voice selector panel,
 * and generate assets button with polling progress.
 */
"use client";

import { useState, useCallback, useEffect } from "react";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SceneCard } from "@/components/scene-card";
import { VoiceSelector } from "@/components/voice-selector";
import { BriefSummary } from "@/components/brief-summary";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  durationSeconds: number;
  isHook: boolean;
  imagePath: string | null;
  imageStatus: string;
  voiceoverPath: string | null;
  voiceoverStatus: string;
  imageUrl?: string | null;
  voiceoverUrl?: string | null;
}

interface StepVisualsProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  scenes: SceneData[];
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
  onBack: () => void;
}

export function StepVisuals({
  projectId,
  brief,
  duration,
  tone,
  scenes: initialScenes,
  voiceId,
  onVoiceChange,
  onBriefChange,
  onDurationChange,
  onToneChange,
  onBack,
}: StepVisualsProps) {
  const [scenes, setScenes] = useState(initialScenes);
  const [generating, setGenerating] = useState(false);
  const [pollingActive, setPollingActive] = useState(false);

  const hasAnyPending = scenes.some(
    (s) =>
      s.imageStatus === "pending" ||
      s.imageStatus === "generating" ||
      s.voiceoverStatus === "pending" ||
      s.voiceoverStatus === "generating",
  );

  // Poll for scene status updates while generation is in progress
  useEffect(() => {
    if (!pollingActive && !hasAnyPending) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/projects/${projectId}/scenes`);
      if (res.ok) {
        const data = await res.json();
        setScenes(data);
        const stillPending = data.some(
          (s: SceneData) =>
            s.imageStatus === "pending" ||
            s.imageStatus === "generating" ||
            s.voiceoverStatus === "pending" ||
            s.voiceoverStatus === "generating",
        );
        if (!stillPending) {
          setPollingActive(false);
          setGenerating(false);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [pollingActive, hasAnyPending, projectId]);

  const handleGenerateAssets = useCallback(async () => {
    setGenerating(true);
    setPollingActive(true);
    const res = await fetch(`/api/projects/${projectId}/generate-assets`, {
      method: "POST",
    });
    if (!res.ok) {
      setGenerating(false);
      setPollingActive(false);
    }
  }, [projectId]);

  const handleRegenerateImage = useCallback(
    async (sceneId: string) => {
      setScenes((prev) =>
        prev.map((s) =>
          s.id === sceneId ? { ...s, imageStatus: "pending" } : s,
        ),
      );
      setPollingActive(true);
      await fetch(
        `/api/projects/${projectId}/scenes/${sceneId}/regenerate-image`,
        { method: "POST" },
      );
    },
    [projectId],
  );

  const handleRegenerateVoice = useCallback(
    async (sceneId: string) => {
      setScenes((prev) =>
        prev.map((s) =>
          s.id === sceneId ? { ...s, voiceoverStatus: "pending" } : s,
        ),
      );
      setPollingActive(true);
      await fetch(
        `/api/projects/${projectId}/scenes/${sceneId}/regenerate-voice`,
        { method: "POST" },
      );
    },
    [projectId],
  );

  const handleVoiceChange = useCallback(
    async (newVoiceId: string) => {
      onVoiceChange(newVoiceId);
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId: newVoiceId }),
      });
    },
    [projectId, onVoiceChange],
  );

  const noneStarted = scenes.every(
    (s) => s.imageStatus === "pending" && !s.imagePath,
  );

  return (
    <section className="space-y-6">
      <BriefSummary
        projectId={projectId}
        brief={brief}
        duration={duration}
        tone={tone}
        onBriefChange={onBriefChange}
        onDurationChange={onDurationChange}
        onToneChange={onToneChange}
      />

      <div className="flex items-center gap-3">
        <Button
          onClick={handleGenerateAssets}
          disabled={generating || hasAnyPending}
        >
          {generating || hasAnyPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating assets...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {noneStarted ? "Generate visuals + voice" : "Regenerate all"}
            </>
          )}
        </Button>
        {hasAnyPending && (
          <span className="text-sm text-muted-foreground">
            {scenes.filter((s) => s.imageStatus === "done").length}/{scenes.length} images,{" "}
            {scenes.filter((s) => s.voiceoverStatus === "done").length}/{scenes.length} voiceovers
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            {scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                projectId={projectId}
                onRegenerateImage={handleRegenerateImage}
                onRegenerateVoice={handleRegenerateVoice}
              />
            ))}
          </div>
        </div>

        <div>
          <VoiceSelector
            selectedVoiceId={voiceId}
            onSelect={handleVoiceChange}
            disabled={hasAnyPending}
          />
        </div>
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </section>
  );
}
