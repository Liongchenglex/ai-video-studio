/**
 * Step 2: Script. F-03 PRD v3.0 — plain-text prose editor.
 * Auto-saves on blur. Live word count + estimated duration (at 150 wpm).
 * Generate / Regenerate button calls the script/generate endpoint.
 */
"use client";

import { useState, useCallback, useEffect } from "react";
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BriefSummary } from "@/components/brief-summary";

const WORDS_PER_MINUTE = 150;

interface StepScriptProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  script: string;
  generatingScript: boolean;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
  onScriptChange: (script: string) => void;
  onGenerateScript: () => void;
  onBack: () => void;
  onNext?: () => void;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function StepScript({
  projectId,
  brief,
  duration,
  tone,
  script,
  generatingScript,
  onBriefChange,
  onDurationChange,
  onToneChange,
  onScriptChange,
  onGenerateScript,
  onBack,
  onNext,
}: StepScriptProps) {
  const [local, setLocal] = useState(script);
  const [saving, setSaving] = useState(false);

  // Keep local state in sync if parent reloads a fresh script (e.g. after regenerate)
  useEffect(() => {
    setLocal(script);
  }, [script]);

  const words = wordCount(local);
  const estSeconds = Math.round((words / WORDS_PER_MINUTE) * 60);
  const targetSeconds = duration * 60;
  const drift = targetSeconds > 0 ? Math.round(((estSeconds - targetSeconds) / targetSeconds) * 100) : 0;
  const driftWarning = Math.abs(drift) > 15;

  const handleBlur = useCallback(async () => {
    if (local === script) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: local }),
      });
      onScriptChange(local);
    } finally {
      setSaving(false);
    }
  }, [local, script, projectId, onScriptChange]);

  const hasScript = local.trim().length > 0;

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
        <Button onClick={onGenerateScript} disabled={generatingScript || !brief.trim()}>
          {generatingScript ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating script...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {hasScript ? "Regenerate script" : "Generate script"}
            </>
          )}
        </Button>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>

      {hasScript && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Script</h2>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{words} words</Badge>
              <Badge variant={driftWarning ? "destructive" : "outline"}>
                ~{Math.floor(estSeconds / 60)}:{String(estSeconds % 60).padStart(2, "0")} / {duration}:00
                {driftWarning ? ` (${drift > 0 ? "+" : ""}${drift}%)` : ""}
              </Badge>
            </div>
          </div>

          <textarea
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={handleBlur}
            className="w-full min-h-[360px] rounded-md border bg-background p-4 font-serif text-base leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Your script will appear here. Edit freely — paragraph breaks divide natural beats."
          />

          <p className="text-xs text-muted-foreground">
            Editing the script invalidates any existing voiceover. You&rsquo;ll be prompted to regenerate VO when you enter the Editor.
          </p>
        </section>
      )}

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        {hasScript && onNext && (
          <Button onClick={onNext}>
            Next: Editor
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
    </section>
  );
}
