/**
 * Video brief input section. Captures the creative brief, target duration,
 * and tone — the three inputs that feed script generation (F-03).
 */
"use client";

import { useState, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
  onGenerateScript: () => void;
  generating: boolean;
  hasScenes: boolean;
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
  onGenerateScript,
  generating,
  hasScenes,
}: VideoBriefProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [duration, setDuration] = useState(String(initialDuration));
  const [tone, setTone] = useState(initialTone);
  const [saving, setSaving] = useState(false);

  const saveField = useCallback(
    async (field: string, value: string | number) => {
      setSaving(true);
      try {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: value }),
        });
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  const handleBriefBlur = useCallback(() => {
    if (brief.trim()) {
      saveField("brief", brief.trim());
    }
  }, [brief, saveField]);

  const handleDurationChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setDuration(value);
      saveField("targetDuration", Number(value));
    },
    [saveField],
  );

  const handleToneChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setTone(value);
      saveField("tone", value);
    },
    [saveField],
  );

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Video concept</h2>

      <div className="space-y-2">
        <Label htmlFor="brief">Brief</Label>
        <Textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={handleBriefBlur}
          placeholder="Describe your video concept in detail. Include the topic, key points to cover, structure preferences, and any specific instructions..."
          rows={5}
          disabled={generating}
          className="resize-none"
        />
      </div>

      <div className="flex gap-4">
        <div className="space-y-2">
          <Label>Target duration</Label>
          <Select value={duration} onValueChange={handleDurationChange} disabled={generating}>
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
          <Select value={tone} onValueChange={handleToneChange} disabled={generating}>
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

      <Button
        onClick={onGenerateScript}
        disabled={generating || !brief.trim()}
      >
        {generating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Generating script...
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" />
            {hasScenes ? "Regenerate script" : "Generate script"}
          </>
        )}
      </Button>
    </section>
  );
}
