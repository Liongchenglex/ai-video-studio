/**
 * Reference image upload component for the style profile system.
 * Provides 3 drag-and-drop slots with thumbnail previews.
 * Uploads files directly to R2 via presigned URLs.
 */
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Upload, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface StyleUploadProps {
  projectId: string;
  existingUrls?: string[];
  existingKeys?: string[];
  onUploadComplete: (keys: string[]) => void;
  disabled?: boolean;
}

interface SlotState {
  key: string | null;
  previewUrl: string | null;
  uploading: boolean;
  error: string | null;
}

const MAX_SLOTS = 3;
const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function StyleUpload({
  projectId,
  existingUrls = [],
  existingKeys = [],
  onUploadComplete,
  disabled = false,
}: StyleUploadProps) {
  const [slots, setSlots] = useState<SlotState[]>(() =>
    Array.from({ length: MAX_SLOTS }, (_, i) => ({
      key: existingKeys[i] || null,
      previewUrl: existingUrls[i] || null,
      uploading: false,
      error: null,
    })),
  );

  // Notify parent whenever the set of keys changes (not during render)
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const allKeys = slots.map((s) => s.key).filter(Boolean) as string[];
    onUploadComplete(allKeys);
  }, [slots.map((s) => s.key).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadFile = useCallback(
    async (file: File, slotIndex: number) => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setSlots((prev) =>
          prev.map((s, i) =>
            i === slotIndex ? { ...s, error: "Must be JPEG, PNG, or WebP" } : s,
          ),
        );
        return;
      }

      if (file.size > MAX_SIZE) {
        setSlots((prev) =>
          prev.map((s, i) =>
            i === slotIndex ? { ...s, error: "File exceeds 10MB limit" } : s,
          ),
        );
        return;
      }

      setSlots((prev) =>
        prev.map((s, i) =>
          i === slotIndex ? { ...s, uploading: true, error: null } : s,
        ),
      );

      try {
        const res = await fetch(`/api/projects/${projectId}/style/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [
              {
                filename: file.name,
                contentType: file.type,
                size: file.size,
              },
            ],
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Upload failed");
        }

        const { uploads } = await res.json();
        const { key, uploadUrl } = uploads[0];

        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });

        if (!uploadRes.ok) {
          throw new Error("Failed to upload to storage");
        }

        const previewUrl = URL.createObjectURL(file);

        setSlots((prev) =>
          prev.map((s, i) =>
            i === slotIndex
              ? { key, previewUrl, uploading: false, error: null }
              : s,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setSlots((prev) =>
          prev.map((s, i) =>
            i === slotIndex ? { ...s, uploading: false, error: message } : s,
          ),
        );
      }
    },
    [projectId],
  );

  const removeSlot = useCallback((slotIndex: number) => {
    setSlots((prev) =>
      prev.map((s, i) =>
        i === slotIndex
          ? { key: null, previewUrl: null, uploading: false, error: null }
          : s,
      ),
    );
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, slotIndex: number) => {
      e.preventDefault();
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file, slotIndex);
    },
    [disabled, uploadFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, slotIndex: number) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file, slotIndex);
      e.target.value = "";
    },
    [uploadFile],
  );

  const hasAnyImage = slots.some((s) => s.key !== null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {slots.map((slot, i) => (
          <div
            key={i}
            className="relative aspect-square rounded-lg border-2 border-dashed transition-colors hover:border-primary/50"
            onDrop={(e) => handleDrop(e, i)}
            onDragOver={(e) => e.preventDefault()}
          >
            {slot.uploading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : slot.previewUrl ? (
              <>
                <img
                  src={slot.previewUrl}
                  alt={`Reference ${i + 1}`}
                  className="h-full w-full rounded-lg object-cover"
                />
                {!disabled && (
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -right-2 -top-2 h-6 w-6"
                    onClick={() => removeSlot(i)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </>
            ) : (
              <label className="flex h-full cursor-pointer flex-col items-center justify-center gap-1 text-muted-foreground">
                <Upload className="h-5 w-5" />
                <span className="text-xs">Image {i + 1}</span>
                <input
                  type="file"
                  className="hidden"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(e) => handleFileSelect(e, i)}
                  disabled={disabled}
                />
              </label>
            )}
            {slot.error && (
              <p className="absolute -bottom-5 left-0 text-xs text-destructive">
                {slot.error}
              </p>
            )}
          </div>
        ))}
      </div>
      {!hasAnyImage && (
        <p className="text-xs text-muted-foreground">
          Upload 1–3 reference images to define your visual style (JPEG, PNG, or WebP, max 10MB each)
        </p>
      )}
    </div>
  );
}
