/**
 * Single editable row in the script table.
 * Supports inline editing of voiceover, scene description, and image prompt.
 * Changes persist to the server on blur.
 */
"use client";

import { useState, useCallback } from "react";
import { GripVertical, RefreshCw, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface SceneRowProps {
  scene: SceneData;
  projectId: string;
  onUpdate: (sceneId: string, updated: SceneData) => void;
  onDelete: (sceneId: string) => void;
  onRegenerate: (sceneId: string) => void;
  regenerating: boolean;
}

export function SceneRow({
  scene,
  projectId,
  onUpdate,
  onDelete,
  onRegenerate,
  regenerating,
}: SceneRowProps) {
  const [voiceover, setVoiceover] = useState(scene.voiceover);
  const [sceneDescription, setSceneDescription] = useState(scene.sceneDescription);
  const [imagePrompt, setImagePrompt] = useState(scene.imagePrompt);

  const saveField = useCallback(
    async (field: string, value: string) => {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        const updated = await res.json();
        onUpdate(scene.id, updated);
      }
    },
    [projectId, scene.id, onUpdate],
  );

  return (
    <tr className="group border-b transition-colors hover:bg-muted/50">
      <td className="w-8 px-2 py-3 text-center align-top">
        <div className="flex items-center gap-1">
          <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" />
          <span className="text-sm text-muted-foreground">{scene.sortOrder + 1}</span>
        </div>
        {scene.isHook && (
          <Badge variant="secondary" className="mt-1 text-[10px]">
            Hook
          </Badge>
        )}
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={voiceover}
          onChange={(e) => setVoiceover(e.target.value)}
          onBlur={() => {
            if (voiceover.trim() !== scene.voiceover) {
              saveField("voiceover", voiceover.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={sceneDescription}
          onChange={(e) => setSceneDescription(e.target.value)}
          onBlur={() => {
            if (sceneDescription.trim() !== scene.sceneDescription) {
              saveField("sceneDescription", sceneDescription.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
          onBlur={() => {
            if (imagePrompt.trim() !== scene.imagePrompt) {
              saveField("imagePrompt", imagePrompt.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="w-16 px-2 py-3 text-center align-top">
        <span className="text-sm">{scene.durationSeconds}s</span>
      </td>
      <td className="w-20 px-2 py-3 align-top">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerate(scene.id)}
            disabled={regenerating}
            title="Regenerate scene"
          >
            {regenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => onDelete(scene.id)}
            disabled={regenerating}
            title="Delete scene"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
