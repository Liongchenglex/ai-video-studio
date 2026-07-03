/**
 * Storyboard card view (v4.0 Pillar B, mockup 02).
 *
 * Renders one card per shot in a responsive grid, ordered by
 * (beat.sortOrder, startInBeat). Each card surfaces the shot's thumbnail
 * (clip loop > image > placeholder), a rolled-up generation status, the
 * visual prompt, the parent beat's narration line, and the same
 * generate/retry actions as the timeline inspector — this is a second
 * renderer over the identical `useEditor()` state, not a parallel data
 * model (spec §5).
 */
"use client";

import { RefreshCw, Clapperboard, AlertTriangle, Check, Loader2, Pencil } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useEditor,
  absoluteShotRange,
  type EditorBeat,
  type EditorShot,
} from "@/components/editor/editor-store";

// m:ss formatting for the absolute shot range shown on each card.
function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type RollupStatus = "pending" | "generating" | "failed" | "ready";

function rollupStatus(shot: EditorShot): RollupStatus {
  if (shot.imageStatus === "generating" || shot.clipStatus === "generating") return "generating";
  if (shot.imageStatus === "failed" || shot.clipStatus === "failed") return "failed";
  if (shot.imageStatus === "done") return "ready";
  return "pending";
}

function StatusBadge({ status }: { status: RollupStatus }) {
  switch (status) {
    case "generating":
      return (
        <Badge variant="secondary" className="absolute right-2 top-2 gap-1 bg-amber-500/90 text-white">
          <Loader2 className="size-3 animate-spin" />
          generating
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="absolute right-2 top-2 gap-1">
          <AlertTriangle className="size-3" />
          failed
        </Badge>
      );
    case "ready":
      return (
        <Badge className="absolute right-2 top-2 gap-1 bg-emerald-600 text-white">
          <Check className="size-3" />
          ready
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="absolute right-2 top-2">
          pending
        </Badge>
      );
  }
}

function ShotCard({ shot, beat, index }: { shot: EditorShot; beat: EditorBeat; index: number }) {
  const { beats, selection, select, generateImage, generateClip } = useEditor();
  const status = rollupStatus(shot);
  const range = absoluteShotRange(shot, beats);
  const imageFailed = shot.imageStatus === "failed";
  const clipFailed = shot.clipStatus === "failed";
  const isSelected = selection?.type === "shot" && selection.shotId === shot.id;
  const isGenerating = shot.imageStatus === "generating" || shot.clipStatus === "generating";

  const retry = () => {
    if (imageFailed) generateImage(shot.id);
    else if (clipFailed) generateClip(shot.id);
  };

  return (
    <Card
      className={`cursor-pointer gap-0 p-0 ${isSelected ? "ring-2 ring-primary" : ""}`}
      onClick={() => select({ type: "shot", shotId: shot.id })}
    >
      {/* Thumbnail band */}
      <div className="relative aspect-video bg-muted">
        {shot.clipUrl ? (
          <video
            src={shot.clipUrl}
            className="absolute inset-0 h-full w-full object-cover"
            autoPlay
            loop
            muted
            playsInline
          />
        ) : shot.imageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={shot.imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Clapperboard className="size-8" />
          </div>
        )}
        <StatusBadge status={status} />
      </div>

      <div className="flex flex-col gap-2 p-3">
        {/* Meta line */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Shot {index + 1} · Beat {beat.sortOrder + 1}
          </span>
          {range && (
            <span className="font-mono">
              {formatTimestamp(range.start)}–{formatTimestamp(range.end)}
            </span>
          )}
        </div>

        {/* Description (visual) */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-primary">
            Description (visual)
          </div>
          <p className="text-sm">{shot.imagePrompt}</p>
        </div>

        {/* Script (narration) */}
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-blue-500">
            Script (narration)
          </div>
          <p className="line-clamp-3 text-sm text-muted-foreground">&ldquo;{beat.text}&rdquo;</p>
        </div>

        {/* Actions */}
        <div className="mt-1 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {status === "failed" ? (
            <>
              <Button variant="outline" size="sm" className="flex-1" onClick={retry}>
                <RefreshCw className="size-3.5" />
                Retry
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => select({ type: "shot", shotId: shot.id })}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={isGenerating}
                onClick={() => generateImage(shot.id)}
              >
                <RefreshCw className="size-3.5" />
                Re-image
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={!shot.imagePath || isGenerating}
                onClick={() => generateClip(shot.id)}
              >
                <Clapperboard className="size-3.5" />
                Clip
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

export function StoryboardView() {
  const { beats, shots } = useEditor();

  const beatById = new Map(beats.map((b) => [b.id, b]));
  const ordered = [...shots]
    .filter((s) => s.beatId && beatById.has(s.beatId))
    .sort((a, b) => {
      const beatA = beatById.get(a.beatId!)!;
      const beatB = beatById.get(b.beatId!)!;
      if (beatA.sortOrder !== beatB.sortOrder) return beatA.sortOrder - beatB.sortOrder;
      return (a.startInBeat ?? 0) - (b.startInBeat ?? 0);
    });

  const doneCount = shots.filter((s) => s.imageStatus === "done").length;
  const failedCount = shots.filter(
    (s) => s.imageStatus === "failed" || s.clipStatus === "failed",
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Header strip */}
      <div className="text-sm text-muted-foreground">
        {shots.length} shots · {doneCount}/{shots.length} imaged · {failedCount} failed
      </div>

      {/* Card grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {ordered.map((shot, index) => (
          <ShotCard key={shot.id} shot={shot} beat={beatById.get(shot.beatId!)!} index={index} />
        ))}
      </div>
    </div>
  );
}
