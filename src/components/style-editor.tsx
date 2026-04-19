/**
 * Style string editor with live token counter.
 * Shows the Claude-generated style description, allows inline editing,
 * and provides actions for re-analysis, preview, and save.
 */
"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface StyleEditorProps {
  projectId: string;
  initialStyleString: string;
  hasRefImages: boolean;
  onSave: (styleString: string) => void;
  onPreviewRequest: () => void;
  disabled?: boolean;
}

/**
 * Rough token count estimate: ~4 characters per token for English text.
 * Not exact, but sufficient for a UI indicator.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

export function StyleEditor({
  projectId,
  initialStyleString,
  hasRefImages,
  onSave,
  onPreviewRequest,
  disabled = false,
}: StyleEditorProps) {
  const [styleString, setStyleString] = useState(initialStyleString);
  const [analysing, setAnalysing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenCount = estimateTokens(styleString);
  const tokenColor =
    tokenCount > 120 ? "text-destructive" : tokenCount > 100 ? "text-amber-500" : "text-muted-foreground";

  async function handleAnalyse() {
    setAnalysing(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/style/analyse`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Analysis failed");
      }
      const data = await res.json();
      setStyleString(data.styleString);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalysing(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/style`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleString }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Save failed");
      }
      onSave(styleString);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Style description</label>
        <span className={`text-xs ${tokenColor}`}>~{tokenCount} / 120 tokens</span>
      </div>

      <Textarea
        value={styleString}
        onChange={(e) => setStyleString(e.target.value)}
        placeholder="Upload reference images and click Analyse to generate a style description..."
        rows={4}
        disabled={disabled || analysing}
        className="resize-none"
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleAnalyse}
          disabled={disabled || analysing || !hasRefImages}
        >
          {analysing ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Analysing...
            </>
          ) : (
            "Analyse style"
          )}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onPreviewRequest}
          disabled={disabled || !styleString.trim() || !hasRefImages}
        >
          Preview
        </Button>

        <Button
          size="sm"
          onClick={handleSave}
          disabled={disabled || saving || !styleString.trim()}
        >
          {saving ? (
            <>
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              Saving...
            </>
          ) : (
            "Save profile"
          )}
        </Button>
      </div>
    </div>
  );
}
