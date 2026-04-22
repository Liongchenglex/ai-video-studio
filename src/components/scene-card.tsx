/**
 * Scene card for the Visuals + Voice step.
 * Shows generated image, voiceover audio player, scene description,
 * and regeneration controls per scene.
 */
"use client";

import { useState, useRef, useEffect } from "react";
import { RefreshCw, Loader2, ImageIcon, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SceneCardProps {
  scene: {
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
  };
  projectId: string;
  onRegenerateImage: (sceneId: string) => void;
  onRegenerateVoice: (sceneId: string) => void;
}

export function SceneCard({
  scene,
  projectId: _projectId,
  onRegenerateImage,
  onRegenerateVoice,
}: SceneCardProps) {
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Update audio element when voiceover URL changes (e.g. after polling)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (scene.voiceoverUrl) {
      audioRef.current = new Audio(scene.voiceoverUrl);
      audioRef.current.onended = () => setAudioPlaying(false);
    } else {
      audioRef.current = null;
    }
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [scene.voiceoverUrl]);

  const toggleAudio = () => {
    if (!audioRef.current) return;
    if (audioPlaying) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setAudioPlaying(false);
    } else {
      audioRef.current.play();
      setAudioPlaying(true);
    }
  };

  const imageGenerating = scene.imageStatus === "generating" || scene.imageStatus === "pending";
  const voiceGenerating = scene.voiceoverStatus === "generating" || scene.voiceoverStatus === "pending";

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video bg-muted">
        {scene.imageUrl && scene.imageStatus === "done" ? (
          <img
            src={scene.imageUrl}
            alt={`Scene ${scene.sortOrder + 1}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {imageGenerating ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : scene.imageStatus === "failed" ? (
              <div className="text-center">
                <ImageIcon className="mx-auto h-8 w-8 text-destructive" />
                <p className="mt-1 text-xs text-destructive">Failed</p>
              </div>
            ) : (
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1">
          <Badge variant="secondary" className="text-xs">
            #{scene.sortOrder + 1}
          </Badge>
          {scene.isHook && (
            <Badge variant="default" className="text-xs">
              Hook
            </Badge>
          )}
        </div>
        <div className="absolute right-2 top-2">
          <Badge variant="secondary" className="text-xs">
            {scene.durationSeconds}s
          </Badge>
        </div>
      </div>

      <CardContent className="p-3 space-y-2">
        <p className="text-sm line-clamp-2">{scene.sceneDescription}</p>

        <div className="flex items-center gap-2">
          {scene.voiceoverUrl && scene.voiceoverStatus === "done" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={toggleAudio}
            >
              <Volume2 className="mr-1 h-3 w-3" />
              {audioPlaying ? "Stop" : "Play VO"}
            </Button>
          ) : voiceGenerating ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating VO...
            </span>
          ) : scene.voiceoverStatus === "failed" ? (
            <span className="text-xs text-destructive">VO failed</span>
          ) : null}

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerateImage(scene.id)}
            disabled={imageGenerating}
            title="Regenerate image"
          >
            {imageGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerateVoice(scene.id)}
            disabled={voiceGenerating}
            title="Regenerate voiceover"
          >
            {voiceGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Volume2 className="h-3 w-3" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
