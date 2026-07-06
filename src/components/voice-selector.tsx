/**
 * Voice selector with live ElevenLabs library + previews.
 * Fetches the full premade voice list (with preview URLs) from
 * GET /api/voices on mount; falls back to the curated presets in
 * voice-presets.ts when the API is unavailable. Each voice row has a
 * ▶ preview button that plays ElevenLabs' hosted sample — one shared
 * Audio element, so starting a preview stops the previous one. The
 * currently-persisted voice is always rendered even when it isn't in
 * the fetched list (legacy voice ids remain voiceable).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Square, Loader2 } from "lucide-react";
import { VOICE_PRESETS } from "@/lib/voice-presets";
import type { VoiceOption } from "@/app/api/voices/route";

interface VoiceSelectorProps {
  selectedVoiceId: string;
  onSelect: (voiceId: string) => void;
  disabled?: boolean;
}

const FALLBACK_VOICES: VoiceOption[] = VOICE_PRESETS.map((p) => ({
  id: p.id,
  name: p.name,
  gender: p.gender,
  accent: null,
  descriptive: p.description,
  previewUrl: null,
}));

function VoiceRow({
  voice,
  isSelected,
  disabled,
  previewing,
  onSelect,
  onPreviewToggle,
}: {
  voice: VoiceOption;
  isSelected: boolean;
  disabled: boolean;
  previewing: boolean;
  onSelect: () => void;
  onPreviewToggle: () => void;
}) {
  return (
    <div
      onClick={disabled ? undefined : onSelect}
      className={`flex cursor-pointer items-center gap-2 rounded border p-2 transition ${
        isSelected ? "border-primary ring-1 ring-primary" : "hover:border-primary/50"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      {voice.previewUrl && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation(); // preview without changing the selection
            onPreviewToggle();
          }}
          title={previewing ? "Stop preview" : "Play preview"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted transition hover:bg-primary hover:text-primary-foreground"
        >
          {previewing ? <Square className="size-3" /> : <Play className="size-3" />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{voice.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[voice.gender, voice.accent, voice.descriptive].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
}

export function VoiceSelector({
  selectedVoiceId,
  onSelect,
  disabled = false,
}: VoiceSelectorProps) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/voices")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { voices: VoiceOption[] }) => {
        if (!cancelled && data.voices.length > 0) setVoices(data.voices);
        else if (!cancelled) setVoices(FALLBACK_VOICES);
      })
      .catch(() => {
        if (!cancelled) setVoices(FALLBACK_VOICES);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One shared audio element — starting a preview stops the previous one.
  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPreviewingId(null);
  };
  const togglePreview = (voice: VoiceOption) => {
    if (previewingId === voice.id) {
      stopPreview();
      return;
    }
    stopPreview();
    if (!voice.previewUrl) return;
    const a = new Audio(voice.previewUrl);
    a.onended = () => setPreviewingId(null);
    a.onerror = () => setPreviewingId(null);
    audioRef.current = a;
    setPreviewingId(voice.id);
    a.play().catch(() => setPreviewingId(null));
  };
  useEffect(() => () => audioRef.current?.pause(), []);

  const list = voices ?? [];
  // Keep whatever voice the project already uses visible and selectable,
  // even when it's a legacy id absent from the current library.
  const withCurrent = list.some((v) => v.id === selectedVoiceId)
    ? list
    : [
        {
          id: selectedVoiceId,
          name: "Current voice",
          gender: null,
          accent: null,
          descriptive: "in use on this project",
          previewUrl: null,
        },
        ...list,
      ];

  const females = withCurrent.filter((v) => v.gender === "female");
  const males = withCurrent.filter((v) => v.gender === "male");
  const other = withCurrent.filter((v) => v.gender !== "female" && v.gender !== "male");

  const group = (label: string, items: VoiceOption[]) =>
    items.length > 0 && (
      <div key={label}>
        <p className="mb-1.5 text-xs text-muted-foreground">{label}</p>
        <div className="grid gap-1.5">
          {items.map((v) => (
            <VoiceRow
              key={v.id}
              voice={v}
              isSelected={v.id === selectedVoiceId}
              disabled={disabled}
              previewing={previewingId === v.id}
              onSelect={() => onSelect(v.id)}
              onPreviewToggle={() => togglePreview(v)}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Voice</h3>
        {voices === null && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {group("Female", females)}
        {group("Male", males)}
        {group("Other", other)}
      </div>
    </div>
  );
}
