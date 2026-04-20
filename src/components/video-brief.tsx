/**
 * Video brief input section. Captures the creative brief, target duration,
 * and tone — the three inputs that feed script generation (F-03).
 * Used on Step 1 of the project stepper.
 */
"use client";

import { useState, useCallback } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VideoBriefProps {
  projectId: string;
  initialBrief: string;
  initialDuration: number;
  initialTone: string;
  onNext: () => void;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
}

const DURATIONS = [
  { value: "3", label: "3 minutes" },
  { value: "5", label: "5 minutes" },
  { value: "8", label: "8 minutes" },
  { value: "10", label: "10 minutes" },
];

const TONES = [
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "documentary", label: "Documentary" },
  { value: "satirical", label: "Satirical" },
];

export function VideoBrief({
  projectId,
  initialBrief,
  initialDuration,
  initialTone,
  onNext,
  onBriefChange,
  onDurationChange,
  onToneChange,
}: VideoBriefProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [duration, setDuration] = useState(String(initialDuration));
  const [tone, setTone] = useState(initialTone);

  const saveField = useCallback(
    async (field: string, value: string | number) => {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
    },
    [projectId],
  );

  const handleBriefBlur = useCallback(() => {
    if (brief.trim()) {
      onBriefChange(brief.trim());
      saveField("brief", brief.trim());
    }
  }, [brief, saveField, onBriefChange]);

  const handleDurationChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setDuration(value);
      onDurationChange(Number(value));
      saveField("targetDuration", Number(value));
    },
    [saveField, onDurationChange],
  );

  const handleToneChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setTone(value);
      onToneChange(value);
      saveField("tone", value);
    },
    [saveField, onToneChange],
  );

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Video concept</h2>
        <p className="text-sm text-muted-foreground">
          Describe what your video is about. Be specific — include topics, structure, and emphasis.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="brief">Brief</Label>
        <Textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={handleBriefBlur}
          placeholder="Describe your video concept in detail. Include the topic, key points to cover, structure preferences, and any specific instructions..."
          rows={6}
          className="resize-none"
        />
      </div>

      <div className="flex gap-4">
        <div className="space-y-2">
          <Label>Target duration</Label>
          <Select value={duration} onValueChange={handleDurationChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Tone</Label>
          <Select value={tone} onValueChange={handleToneChange}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={onNext} disabled={!brief.trim()}>
          Next: Style
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}
