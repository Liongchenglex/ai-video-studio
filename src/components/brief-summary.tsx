/**
 * Collapsible video concept summary for the Script step.
 * Shows brief, duration, and tone in a compact read-only view.
 * Expands to an editable form when the user clicks Edit.
 */
"use client";

import { useState, useCallback } from "react";
import { ChevronUp, Pencil } from "lucide-react";
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

interface BriefSummaryProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
}

const DURATIONS = [
  { value: "3", label: "3 min" },
  { value: "5", label: "5 min" },
  { value: "8", label: "8 min" },
  { value: "10", label: "10 min" },
];

const TONES = [
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "documentary", label: "Documentary" },
  { value: "satirical", label: "Satirical" },
];

function toneLabel(value: string): string {
  return TONES.find((t) => t.value === value)?.label || value;
}

export function BriefSummary({
  projectId,
  brief,
  duration,
  tone,
  onBriefChange,
  onDurationChange,
  onToneChange,
}: BriefSummaryProps) {
  const [editing, setEditing] = useState(false);
  const [localBrief, setLocalBrief] = useState(brief);

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

  const handleSaveBrief = useCallback(() => {
    const trimmed = localBrief.trim();
    if (trimmed && trimmed !== brief) {
      onBriefChange(trimmed);
      saveField("brief", trimmed);
    }
    setEditing(false);
  }, [localBrief, brief, onBriefChange, saveField]);

  const handleDurationChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      const num = Number(value);
      onDurationChange(num);
      saveField("targetDuration", num);
    },
    [onDurationChange, saveField],
  );

  const handleToneChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      onToneChange(value);
      saveField("tone", value);
    },
    [onToneChange, saveField],
  );

  if (editing) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Video concept</h3>
          <Button variant="ghost" size="sm" onClick={handleSaveBrief}>
            <ChevronUp className="mr-1 h-3 w-3" />
            Done
          </Button>
        </div>
        <Textarea
          value={localBrief}
          onChange={(e) => setLocalBrief(e.target.value)}
          rows={4}
          className="resize-none"
        />
        <div className="flex gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Duration</Label>
            <Select value={String(duration)} onValueChange={handleDurationChange}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
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
          <div className="space-y-1">
            <Label className="text-xs">Tone</Label>
            <Select value={tone} onValueChange={handleToneChange}>
              <SelectTrigger className="h-8 w-[140px] text-xs">
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
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium mb-1">Video concept</h3>
          <p className="text-sm text-muted-foreground line-clamp-2">{brief}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {duration} min · {toneLabel(tone)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setLocalBrief(brief); setEditing(true); }}>
          <Pencil className="mr-1 h-3 w-3" />
          Edit
        </Button>
      </div>
    </div>
  );
}
