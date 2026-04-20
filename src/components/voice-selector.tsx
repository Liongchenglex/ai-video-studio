/**
 * Voice preset selector panel for Step 3 (Visuals + Voice).
 * Shows 6 preset voices (3F/3M) with selection state.
 */
"use client";

import { VOICE_PRESETS, VoicePreset } from "@/lib/voice-presets";
import { Card, CardContent } from "@/components/ui/card";

interface VoiceSelectorProps {
  selectedVoiceId: string;
  onSelect: (voiceId: string) => void;
  disabled?: boolean;
}

function VoiceCard({
  voice,
  isSelected,
  disabled,
  onSelect,
}: {
  voice: VoicePreset;
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      className={`cursor-pointer transition-all ${
        isSelected
          ? "border-primary ring-1 ring-primary"
          : "hover:border-primary/50"
      } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      onClick={onSelect}
    >
      <CardContent className="p-3">
        <p className="text-sm font-medium">{voice.name}</p>
        <p className="text-xs text-muted-foreground">{voice.description}</p>
      </CardContent>
    </Card>
  );
}

export function VoiceSelector({
  selectedVoiceId,
  onSelect,
  disabled = false,
}: VoiceSelectorProps) {
  const femaleVoices = VOICE_PRESETS.filter((v) => v.gender === "female");
  const maleVoices = VOICE_PRESETS.filter((v) => v.gender === "male");

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <h3 className="text-sm font-medium">Voice</h3>

      <div>
        <p className="text-xs text-muted-foreground mb-2">Female</p>
        <div className="grid gap-2">
          {femaleVoices.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              isSelected={v.id === selectedVoiceId}
              disabled={disabled}
              onSelect={() => onSelect(v.id)}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2">Male</p>
        <div className="grid gap-2">
          {maleVoices.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              isSelected={v.id === selectedVoiceId}
              disabled={disabled}
              onSelect={() => onSelect(v.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
