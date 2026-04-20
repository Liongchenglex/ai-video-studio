/**
 * Step 3: Script — shows brief summary + generate button + script table.
 */
"use client";

import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BriefSummary } from "@/components/brief-summary";
import { ScriptTable } from "@/components/script-table";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface StepScriptProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  scenes: SceneData[];
  scriptKey: number;
  generatingScript: boolean;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
  onGenerateScript: () => void;
  onBack: () => void;
}

export function StepScript({
  projectId,
  brief,
  duration,
  tone,
  scenes,
  scriptKey,
  generatingScript,
  onBriefChange,
  onDurationChange,
  onToneChange,
  onGenerateScript,
  onBack,
}: StepScriptProps) {
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
          onClick={onGenerateScript}
          disabled={generatingScript || !brief.trim()}
        >
          {generatingScript ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating script...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {scenes.length > 0 ? "Regenerate script" : "Generate script"}
            </>
          )}
        </Button>
      </div>

      {scenes.length > 0 && (
        <ScriptTable
          key={scriptKey}
          projectId={projectId}
          initialScenes={scenes}
          targetDuration={duration}
        />
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </section>
  );
}
