/**
 * Cost-preview + confirm dialog for batch "Generate all" (v4 P3, mockup:
 * spec §6). Fetches the itemized server-side preview on open, offers an
 * "Also generate clips" checkbox (itemized separately — clips are the
 * expensive line), and dispatches the batch on confirm. All numbers are
 * estimates and labeled as such; the server recomputes everything.
 */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditor, type GenerateAllPreview } from "@/components/editor/editor-store";
import { CLIP_MODELS, DEFAULT_CLIP_MODEL_ID, getClipModel } from "@/lib/clip-models";

export function GenerateAllDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { fetchGenerateAllPreview, generateAll } = useEditor();
  const [preview, setPreview] = useState<GenerateAllPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeClips, setIncludeClips] = useState(false);
  const [clipModel, setClipModel] = useState<string>(DEFAULT_CLIP_MODEL_ID);
  const [suggestChains, setSuggestChains] = useState(true);
  // Chaining needs an end-frame-capable model — mirrors the orchestrator's
  // gate (generate-batch.ts) so the dialog never promises chaining the
  // batch can't actually do (final-review finding #2).
  const chainsUnsupported = !(getClipModel(clipModel)?.supportsEndFrame ?? false);
  const effectiveSuggestChains = suggestChains && !chainsUnsupported;
  const [includeSfx, setIncludeSfx] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState(false);

  // Reset only on open — keep separate from the refetch effect below so
  // toggling model/SFX doesn't clobber the clips checkbox.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setIncludeClips(false);
    setIncludeSfx(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(false);
    setLoading(true);
    fetchGenerateAllPreview({ clipModel, includeSfx })
      .then((p) => {
        setPreview(p);
        if (!p) setError(true);
      })
      .finally(() => setLoading(false));
  }, [open, clipModel, includeSfx, fetchGenerateAllPreview]);

  // An SFX pass over already-done clips is real work even when nothing else is.
  const sfxWork = includeClips && includeSfx && preview !== null && preview.sfx.count > 0;
  const nothingToDo =
    preview !== null &&
    preview.sheets.count === 0 &&
    preview.images.count === 0 &&
    (!includeClips || preview.clips.count === 0) &&
    !sfxWork;

  const handleConfirm = async () => {
    setDispatching(true);
    setError(false);
    const ok = await generateAll({
      includeClips,
      ...(includeClips ? { clipModel, suggestChains: effectiveSuggestChains, includeSfx } : {}),
    });
    setDispatching(false);
    if (ok) onOpenChange(false);
    else setError(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate all missing assets</DialogTitle>
          <DialogDescription>
            Reference sheets generate first so every tagged shot comes out
            on-model. Shots that are already done are skipped — nothing is
            re-billed.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Counting what&rsquo;s missing…
          </div>
        )}

        {preview && (
          <div className="space-y-2 text-sm">
            {preview.batchRunning && (
              <p className="rounded bg-amber-500/10 p-2 text-amber-600">
                A batch is already running — wait for it to finish.
              </p>
            )}
            <div className="flex justify-between">
              <span>{preview.sheets.count} reference sheets</span>
              <span className="font-mono">~${preview.sheets.estUsd.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>{preview.images.count} shot images</span>
              <span className="font-mono">~${preview.images.estUsd.toFixed(2)}</span>
            </div>
            <label className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeClips}
                  onChange={(e) => setIncludeClips(e.target.checked)}
                  disabled={preview.clips.count === 0 && preview.sfx.count === 0}
                />
                Also generate {preview.clips.count} clips
              </span>
              <span className="font-mono">
                {includeClips ? `~$${preview.clips.estUsd.toFixed(2)}` : "—"}
              </span>
            </label>
            {includeClips && (
              <div className="space-y-2 pl-6">
                <select
                  value={clipModel}
                  onChange={(e) => setClipModel(e.target.value)}
                  className="w-full rounded border bg-background p-1.5 text-xs"
                >
                  {CLIP_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — ~${m.estUsdPerClip.toFixed(2)}/clip
                    </option>
                  ))}
                </select>
                <label
                  className="flex items-center gap-2 text-xs"
                  title={
                    chainsUnsupported
                      ? "The selected model can't take an end frame, so it can't chain"
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={suggestChains && !chainsUnsupported}
                    disabled={chainsUnsupported}
                    onChange={(e) => setSuggestChains(e.target.checked)}
                  />
                  Suggest chained shots (AI)
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeSfx}
                      onChange={(e) => setIncludeSfx(e.target.checked)}
                    />
                    Add SFX to all clips ({preview.sfx.count})
                  </span>
                  <span className="font-mono">
                    {includeSfx ? `~$${preview.sfx.estUsd.toFixed(2)}` : "—"}
                  </span>
                </label>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 font-medium">
              <span>Total (estimate)</span>
              <span className="font-mono">
                ~${(includeClips ? preview.totalWithClipsUsd : preview.totalUsd).toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Estimates only — actual provider billing may differ slightly.
            </p>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">
            Something went wrong. Close and try again.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={dispatching}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !preview || preview.batchRunning || nothingToDo || dispatching}
          >
            {dispatching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            {nothingToDo ? "Nothing to generate" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
