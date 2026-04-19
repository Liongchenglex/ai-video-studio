/**
 * Style preview panel. Displays the FLUX.1 Kontext-generated preview
 * image so the user can validate their style before committing.
 */
"use client";

import { useState } from "react";
import { Loader2, ImageIcon } from "lucide-react";

interface StylePreviewPanelProps {
  projectId: string;
  previewUrl: string | null;
  generating: boolean;
}

export function StylePreviewPanel({
  projectId: _projectId,
  previewUrl,
  generating,
}: StylePreviewPanelProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-medium">Style preview</h3>

      {generating ? (
        <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-xs">Generating preview...</span>
          </div>
        </div>
      ) : previewUrl && !imageError ? (
        <img
          src={previewUrl}
          alt="Style preview"
          className="w-full rounded-md"
          onError={() => setImageError(true)}
        />
      ) : (
        <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <ImageIcon className="h-6 w-6" />
            <span className="text-xs">
              {imageError
                ? "Failed to load preview"
                : "Click Preview to generate a sample image"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
