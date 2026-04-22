/**
 * Step 3: Editor. PRD v3.0 Iter 1 scaffold.
 * If the project has no VO yet, show a "Generate voiceover" button that
 * fires the continuous VO generation. Once VO exists, render the timeline
 * editor (currently the prototype — Iter 2 will add shot CRUD).
 */
"use client";

import { ArrowLeft, Loader2, Mic, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { VoiceSelector } from "@/components/voice-selector";
import { EditorPrototype } from "@/components/editor-prototype";
import type { ShotData } from "@/components/project-workspace";

interface StepEditorProps {
  projectId: string;
  script: string;
  voiceoverUrl: string | null;
  voiceoverStatus: string;
  durationSeconds: number | null;
  voiceId: string;
  shots: ShotData[];
  recommendingShots: boolean;
  onGenerateVoiceover: () => void;
  onRecommendShots: () => void;
  onVoiceChange: (voiceId: string) => void;
  onBack: () => void;
}

export function StepEditor({
  projectId,
  script,
  voiceoverUrl,
  voiceoverStatus,
  durationSeconds,
  voiceId,
  shots,
  recommendingShots,
  onGenerateVoiceover,
  onRecommendShots,
  onVoiceChange,
  onBack,
}: StepEditorProps) {
  const hasScript = script.trim().length > 0;
  const voGenerating = voiceoverStatus === "generating";
  const voReady = voiceoverStatus === "done" && !!voiceoverUrl;

  if (!hasScript) {
    return (
      <section className="space-y-4">
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <h2 className="text-lg font-semibold">Generate a script first</h2>
            <p className="text-sm text-muted-foreground">
              Go back to the Script step and generate or write a script before opening the editor.
            </p>
            <Button variant="outline" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Script
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (!voReady) {
    return (
      <section className="space-y-4">
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Generate voiceover</h2>
              <p className="text-sm text-muted-foreground mt-1">
                The editor opens once we&rsquo;ve produced a continuous voiceover for your
                script. This takes ~30-60 seconds.
              </p>
            </div>

            <VoiceSelector
              selectedVoiceId={voiceId}
              onSelect={onVoiceChange}
              disabled={voGenerating}
            />

            <div className="flex items-center gap-3">
              <Button onClick={onGenerateVoiceover} disabled={voGenerating}>
                {voGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating voiceover...
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-4 w-4" />
                    Generate voiceover
                  </>
                )}
              </Button>
              {voiceoverStatus === "failed" && (
                <span className="text-sm text-destructive">VO generation failed. Try again.</span>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </div>
      </section>
    );
  }

  // VO is ready — render the editor prototype wired to the new model.
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Shots</h2>
          <p className="text-sm text-muted-foreground">
            {shots.length === 0
              ? "No shots yet. Let AI recommend a starting list, or click an empty spot on the timeline to create one manually."
              : `${shots.length} shots. Drag to reposition, trim edges, split at playhead (S), delete (Del), or click a gap to insert.`}
          </p>
        </div>
        <Button onClick={onRecommendShots} disabled={recommendingShots} variant={shots.length === 0 ? "default" : "outline"}>
          {recommendingShots ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Recommending…
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {shots.length === 0 ? "Recommend shots" : "Re-recommend shots"}
            </>
          )}
        </Button>
      </div>

      <EditorPrototype
        projectId={projectId}
        script={script}
        voiceoverUrl={voiceoverUrl}
        durationSeconds={durationSeconds ?? 0}
        shots={shots}
      />

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </section>
  );
}
