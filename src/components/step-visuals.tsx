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

  // TODO: Re-enable polling when Inngest integration is working
  // Disabled for now to allow granular testing of individual services
  // useEffect(() => { ... polling logic ... }, [pollingActive, projectId]);

  // ── Direct test handlers (no Inngest) ──
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const handleTestImage = useCallback(
    async (sceneId: string) => {
      setTestStatus(`Generating image for scene...`);
      setScenes((prev) =>
        prev.map((s) => (s.id === sceneId ? { ...s, imageStatus: "generating" } : s)),
      );
      try {
        const res = await fetch("/api/test/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, sceneId }),
        });
        const data = await res.json();
        if (res.ok) {
          setTestStatus(`Image done: ${data.r2Key}`);
          // Refresh scenes to get the new URL
          const scenesRes = await fetch(`/api/projects/${projectId}/scenes`);
          if (scenesRes.ok) setScenes(await scenesRes.json());
        } else {
          setTestStatus(`Image failed: ${data.error}`);
          setScenes((prev) =>
            prev.map((s) => (s.id === sceneId ? { ...s, imageStatus: "failed" } : s)),
          );
        }
      } catch (err) {
        setTestStatus(`Image error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    },
    [projectId],
  );

  const handleTestVoiceover = useCallback(
    async (sceneId: string) => {
      setTestStatus(`Generating voiceover for scene...`);
      setScenes((prev) =>
        prev.map((s) => (s.id === sceneId ? { ...s, voiceoverStatus: "generating" } : s)),
      );
      try {
        const res = await fetch("/api/test/voiceover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, sceneId }),
        });
        const data = await res.json();
        if (res.ok) {
          setTestStatus(`Voiceover done: ${data.durationSeconds}s`);
          const scenesRes = await fetch(`/api/projects/${projectId}/scenes`);
          if (scenesRes.ok) setScenes(await scenesRes.json());
        } else {
          setTestStatus(`Voiceover failed: ${data.error}`);
          setScenes((prev) =>
            prev.map((s) => (s.id === sceneId ? { ...s, voiceoverStatus: "failed" } : s)),
          );
        }
      } catch (err) {
        setTestStatus(`Voiceover error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    },
    [projectId],
  );

  const handleTestMusic = useCallback(async () => {
    setTestStatus("Generating music...");
    try {
      const res = await fetch("/api/test/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestStatus(`Music done: ${data.r2Key}`);
      } else {
        setTestStatus(`Music failed: ${data.error}`);
      }
    } catch (err) {
      setTestStatus(`Music error: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, [projectId]);

  const handleTestAnimation = useCallback(
    async (sceneId: string) => {
      setTestStatus("Generating animation clip...");
      try {
        const res = await fetch("/api/test/animation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, sceneId }),
        });
        const data = await res.json();
        if (res.ok) {
          setTestStatus(`Animation done: ${data.clipDuration}s clip — ${data.r2Key}`);
        } else {
          setTestStatus(`Animation failed: ${data.error}`);
        }
      } catch (err) {
        setTestStatus(`Animation error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    },
    [projectId],
  );

  const handleRegenerateImage = useCallback(
    async (sceneId: string) => {
      handleTestImage(sceneId);
    },
    [handleTestImage],
  );

  const handleRegenerateVoice = useCallback(
    async (sceneId: string) => {
      handleTestVoiceover(sceneId);
    },
    [handleTestVoiceover],
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

      {/* Test Panel — direct API calls, no Inngest */}
      <div className="rounded-lg border border-dashed p-4 space-y-3">
        <h3 className="text-sm font-medium">Test Panel (direct calls)</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => handleTestImage(scenes[0]?.id)} disabled={!scenes[0]}>
            Test Image (Scene 1)
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleTestVoiceover(scenes[0]?.id)} disabled={!scenes[0]}>
            Test Voiceover (Scene 1)
          </Button>
          <Button size="sm" variant="outline" onClick={handleTestMusic}>
            Test Music
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleTestAnimation(scenes[0]?.id)} disabled={!scenes[0]?.imagePath}>
            Test Animation (Scene 1)
          </Button>
        </div>
        {testStatus && (
          <p className="text-xs text-muted-foreground font-mono">{testStatus}</p>
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
