/**
 * Editable script table displaying all scenes for a project.
 * Supports inline editing, regeneration, deletion, and shows
 * a running duration counter with drift warning.
 */
"use client";

import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SceneRow } from "@/components/scene-row";
import { totalDuration, durationDrift, formatDuration } from "@/lib/scene-utils";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface ScriptTableProps {
  projectId: string;
  initialScenes: SceneData[];
  targetDuration: number;
}

export function ScriptTable({
  projectId,
  initialScenes,
  targetDuration,
}: ScriptTableProps) {
  const [scenes, setScenes] = useState<SceneData[]>(initialScenes);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const total = totalDuration(scenes);
  const drift = durationDrift(total, targetDuration);

  const handleUpdate = useCallback((sceneId: string, updated: SceneData) => {
    setScenes((prev) => prev.map((s) => (s.id === sceneId ? updated : s)));
  }, []);

  const handleDelete = useCallback(
    async (sceneId: string) => {
      const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setScenes((prev) => {
          const filtered = prev.filter((s) => s.id !== sceneId);
          return filtered.map((s, i) => ({ ...s, sortOrder: i }));
        });
      }
    },
    [projectId],
  );

  const handleRegenerate = useCallback(
    async (sceneId: string) => {
      setRegeneratingId(sceneId);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/scenes/${sceneId}/regenerate`,
          { method: "POST" },
        );
        if (res.ok) {
          const updated = await res.json();
          setScenes((prev) => prev.map((s) => (s.id === sceneId ? updated : s)));
        }
      } finally {
        setRegeneratingId(null);
      }
    },
    [projectId],
  );

  const handleAddScene = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceover: "New scene voiceover...",
        sceneDescription: "Describe what happens on screen...",
        imagePrompt: "Describe the key visual for this scene...",
        durationSeconds: 10,
        insertAfter: scenes.length - 1,
      }),
    });
    if (res.ok) {
      const newScene = await res.json();
      setScenes((prev) => [...prev, newScene]);
    }
  }, [projectId, scenes.length]);

  if (scenes.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Script</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {scenes.length} scenes
          </span>
          <span
            className={`text-sm font-medium ${drift.warning ? "text-destructive" : "text-muted-foreground"}`}
          >
            {formatDuration(total)} / {targetDuration}:00 target
            {drift.warning && ` (${drift.drift > 0 ? "+" : ""}${drift.drift}%)`}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="w-8 px-2 py-2 text-xs font-medium text-muted-foreground">#</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Voiceover</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Scene description</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Image prompt</th>
              <th className="w-16 px-2 py-2 text-xs font-medium text-muted-foreground">Duration</th>
              <th className="w-20 px-2 py-2 text-xs font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {scenes.map((scene) => (
              <SceneRow
                key={scene.id}
                scene={scene}
                projectId={projectId}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                onRegenerate={handleRegenerate}
                regenerating={regeneratingId === scene.id}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Button variant="outline" size="sm" onClick={handleAddScene}>
        <Plus className="mr-1 h-3 w-3" />
        Add scene
      </Button>
    </section>
  );
}
