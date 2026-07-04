/**
 * Unified-editor inspector (v4.0 Pillar B, mockup 01 right rail).
 *
 * A single right-hand panel that renders by the shared `selection` in
 * `useEditor()`:
 *   - shot → editable image/motion prompts, AI-suggest, generate image/clip,
 *            split & delete (ported from editor-prototype's ShotEditPanel).
 *   - beat → read-only narration, voice status, re-voice, play-this-beat.
 *   - gap  → create-a-shot form (ported from editor-prototype's GapCreateForm).
 *   - null → the shot under the playhead (ported ActiveShotPreview).
 *
 * All persistence goes through the store; AI-suggest calls the existing
 * suggest-image / suggest-motion endpoints with voText = the narration
 * under the shot's time range — the joined text of every beat it overlaps,
 * since shots may span beat boundaries (anchor-beat spillover).
 */
"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import {
  Trash2,
  Scissors,
  Sparkles,
  Loader2,
  Plus,
  ImageIcon,
  Film,
  Play,
  Mic,
  User,
  Mountain,
  Box,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useEditor,
  absoluteShotRange,
  beatsSpanned,
  entitiesOfShot,
  type EditorBeat,
  type EditorEntity,
  type EditorShot,
} from "@/components/editor/editor-store";

const ENTITY_TYPE_ICON: Record<EditorEntity["type"], LucideIcon> = {
  character: User,
  location: Mountain,
  object: Box,
};

const MIN_HALF = 0.25; // seconds — mirror the server split guard

interface InspectorProps {
  playheadSeconds: number;
  onSeek: (s: number) => void;
  onPlayBeat: (startSeconds: number) => void;
}

export function Inspector({ playheadSeconds, onSeek, onPlayBeat }: InspectorProps) {
  const { beats, shots, selection } = useEditor();

  // Shot under the playhead — used for the null-selection preview.
  const playheadShot = useMemo(
    () =>
      shots.find((s) => {
        const r = absoluteShotRange(s, beats);
        return r && playheadSeconds >= r.start && playheadSeconds < r.end;
      }) ?? null,
    [shots, beats, playheadSeconds],
  );

  const title =
    selection?.type === "gap"
      ? "New shot"
      : selection?.type === "shot"
        ? "Shot — selected"
        : selection?.type === "beat"
          ? "Beat — selected"
          : "Preview";

  const selectedShot =
    selection?.type === "shot" ? shots.find((s) => s.id === selection.shotId) ?? null : null;
  const selectedBeat =
    selection?.type === "beat" ? beats.find((b) => b.id === selection.beatId) ?? null : null;

  return (
    <div className="space-y-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>

      {selection?.type === "gap" ? (
        <GapCreateForm
          key={`${selection.beatId}-${selection.startInBeat}`}
          selection={selection}
        />
      ) : selectedShot ? (
        <ShotEditPanel
          key={selectedShot.id}
          shot={selectedShot}
          beat={beats.find((b) => b.id === selectedShot.beatId) ?? null}
          playheadSeconds={playheadSeconds}
        />
      ) : selectedBeat ? (
        <BeatPanel beat={selectedBeat} onPlayBeat={onPlayBeat} onSeek={onSeek} />
      ) : playheadShot ? (
        <ActiveShotPreview shot={playheadShot} />
      ) : (
        <p className="text-xs text-muted-foreground">
          No shot at the playhead. Click a shot, beat, or an empty spot in the timeline.
        </p>
      )}
    </div>
  );
}

// ─── Beat panel ───────────────────────────────────────────────────────

function voStatusBadge(status: string) {
  switch (status) {
    case "done":
      return <Badge className="bg-emerald-600 text-white">voiced</Badge>;
    case "generating":
      return (
        <Badge variant="secondary" className="gap-1 bg-amber-500/90 text-white">
          <Loader2 className="size-3 animate-spin" /> voicing
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">voice failed</Badge>;
    default:
      return <Badge variant="outline">pending</Badge>;
  }
}

function BeatPanel({
  beat,
  onPlayBeat,
  onSeek,
}: {
  beat: EditorBeat;
  onPlayBeat: (startSeconds: number) => void;
  onSeek: (s: number) => void;
}) {
  const { revoiceBeat } = useEditor();
  const needsRevoice = beat.voStatus === "failed" || !beat.voUrl;

  return (
    <>
      <div className="flex items-center justify-between">
        <Badge variant="outline">Beat {beat.sortOrder + 1}</Badge>
        {voStatusBadge(beat.voStatus)}
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Narration
        </p>
        <p className="text-sm leading-6">{beat.text}</p>
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => {
            onSeek(beat.startSeconds);
            onPlayBeat(beat.startSeconds);
          }}
          disabled={!beat.voUrl}
          title={beat.voUrl ? "Play this beat" : "No audio for this beat yet"}
        >
          <Play className="mr-1 size-3" /> Play this beat
        </Button>
        <Button
          size="sm"
          variant={needsRevoice ? "default" : "outline"}
          onClick={() => revoiceBeat(beat.id)}
          disabled={beat.voStatus === "generating"}
          title="Re-voice this beat's current text"
        >
          {beat.voStatus === "generating" ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Mic className="mr-1 size-3" />
          )}
          Re-voice
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Double-click the script text above to edit the words.
      </p>
    </>
  );
}

// ─── Active-shot preview (null selection) ─────────────────────────────

function ActiveShotPreview({ shot }: { shot: EditorShot }) {
  return (
    <>
      {shot.clipUrl ? (
        <video key={shot.id} src={shot.clipUrl} autoPlay muted loop className="w-full rounded" />
      ) : shot.imageUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={shot.imageUrl} alt="" className="w-full rounded" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded bg-muted">
          <span className="text-xs text-muted-foreground">No image yet</span>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Image prompt
        </p>
        <p className="text-xs">{shot.imagePrompt}</p>
      </div>
      {shot.motionPrompt && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Motion prompt
          </p>
          <p className="text-xs">{shot.motionPrompt}</p>
        </div>
      )}
    </>
  );
}

// ─── Shot edit panel (shot selection) ─────────────────────────────────

// "beat 3" or "beats 3–5" — shots may span beat boundaries.
function spanLabel(spanned: EditorBeat[]): string {
  if (spanned.length === 0) return "beat ?";
  const first = spanned[0].sortOrder + 1;
  const last = spanned[spanned.length - 1].sortOrder + 1;
  return first === last ? `beat ${first}` : `beats ${first}–${last}`;
}

function ShotEditPanel({
  shot,
  beat,
  playheadSeconds,
}: {
  shot: EditorShot;
  beat: EditorBeat | null;
  playheadSeconds: number;
}) {
  const {
    projectId,
    beats,
    entities,
    updateShot,
    deleteShot,
    splitShot,
    generateImage,
    generateClip,
    tagShot,
  } = useEditor();
  // Narration under the shot's time range — the concatenated text of every
  // beat it overlaps (shots may spill past their anchor beat).
  const spanned = beatsSpanned(shot, beats);
  const voText = spanned.length > 0 ? spanned.map((b) => b.text).join(" ") : beat?.text ?? "";

  const [imagePrompt, setImagePrompt] = useState(shot.imagePrompt);
  const [motionPrompt, setMotionPrompt] = useState(shot.motionPrompt);
  const [suggestingImage, setSuggestingImage] = useState(false);
  const [suggestingMotion, setSuggestingMotion] = useState(false);

  // Which asset the preview shows. Auto-switches to whichever the user just
  // regenerated so regen results are always visible.
  const [previewMode, setPreviewMode] = useState<"image" | "clip">(
    shot.clipUrl ? "clip" : "image",
  );

  useEffect(() => {
    setImagePrompt(shot.imagePrompt);
    setMotionPrompt(shot.motionPrompt);
  }, [shot.id, shot.imagePrompt, shot.motionPrompt]);

  const prevImageUrl = useRef(shot.imageUrl);
  const prevClipUrl = useRef(shot.clipUrl);
  useEffect(() => {
    if (shot.imageUrl && shot.imageUrl !== prevImageUrl.current) setPreviewMode("image");
    prevImageUrl.current = shot.imageUrl;
  }, [shot.imageUrl]);
  useEffect(() => {
    if (shot.clipUrl && shot.clipUrl !== prevClipUrl.current) setPreviewMode("clip");
    prevClipUrl.current = shot.clipUrl;
  }, [shot.clipUrl]);

  const persistIfChanged = () => {
    if (imagePrompt !== shot.imagePrompt || motionPrompt !== shot.motionPrompt) {
      updateShot(shot.id, { imagePrompt, motionPrompt });
    }
  };

  const range = absoluteShotRange(shot, beats);
  const canSplit =
    !!beat &&
    !!range &&
    playheadSeconds > range.start + MIN_HALF &&
    playheadSeconds < range.end - MIN_HALF;

  const aiSuggestImage = async () => {
    if (!voText) return;
    setSuggestingImage(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText }),
      });
      if (res.ok) {
        const data = (await res.json()) as { imagePrompt: string };
        setImagePrompt(data.imagePrompt);
        await updateShot(shot.id, { imagePrompt: data.imagePrompt, motionPrompt });
      }
    } finally {
      setSuggestingImage(false);
    }
  };

  const aiSuggestMotion = async () => {
    if (!voText || !imagePrompt.trim()) return;
    setSuggestingMotion(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-motion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText, imagePrompt }),
      });
      if (res.ok) {
        const data = (await res.json()) as { motionPrompt: string };
        setMotionPrompt(data.motionPrompt);
        await updateShot(shot.id, { imagePrompt, motionPrompt: data.motionPrompt });
      }
    } finally {
      setSuggestingMotion(false);
    }
  };

  const hasImage = !!shot.imageUrl;
  const hasClip = !!shot.clipUrl;
  const effectiveMode = previewMode === "clip" && !hasClip ? "image" : previewMode;

  // Reference Bible tagging (v4.0 Phase 4) — the tagged entities and
  // whether any of them has a usable ("done") reference sheet yet.
  const taggedEntities = entitiesOfShot(shot, entities);
  const hasReadyReference = taggedEntities.some((e) => e.referenceStatus === "done");
  const toggleEntity = (entityId: string) => {
    const current = shot.referencedEntityIds;
    const updated = current.includes(entityId)
      ? current.filter((id) => id !== entityId)
      : [...current, entityId];
    tagShot(shot.id, updated);
  };

  return (
    <>
      {(hasImage || hasClip) && (
        <div className="flex gap-1 text-[10px]">
          <button
            type="button"
            onClick={() => setPreviewMode("image")}
            disabled={!hasImage}
            className={`flex-1 rounded px-2 py-1 transition ${
              effectiveMode === "image"
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/80 disabled:opacity-40 disabled:hover:bg-muted"
            }`}
          >
            Image{hasImage ? "" : " (none)"}
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode("clip")}
            disabled={!hasClip}
            className={`flex-1 rounded px-2 py-1 transition ${
              effectiveMode === "clip"
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/80 disabled:opacity-40 disabled:hover:bg-muted"
            }`}
          >
            Clip{hasClip ? "" : " (none)"}
          </button>
        </div>
      )}

      {effectiveMode === "clip" && shot.clipUrl ? (
        <video key={shot.clipUrl} src={shot.clipUrl} autoPlay muted loop className="w-full rounded" />
      ) : effectiveMode === "image" && shot.imageUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img key={shot.imageUrl} src={shot.imageUrl} alt="" className="w-full rounded" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded bg-muted">
          <span className="text-xs text-muted-foreground">No image yet</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <Badge variant="outline">
          {(() => {
            const range = absoluteShotRange(shot, beats);
            return range
              ? `${range.start.toFixed(1)}–${range.end.toFixed(1)}s · ${spanLabel(spanned)}`
              : `beat ${beat ? beat.sortOrder + 1 : "?"}`;
          })()}
        </Badge>
      </div>

      {voText && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            VO (narration)
          </p>
          <p className="text-xs font-mono">{voText}</p>
        </div>
      )}

      {entities.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            In this shot
          </p>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((entity) => {
              const Icon = ENTITY_TYPE_ICON[entity.type];
              const selected = shot.referencedEntityIds.includes(entity.id);
              return (
                <button
                  key={entity.id}
                  type="button"
                  onClick={() => toggleEntity(entity.id)}
                  className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition ${
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                >
                  <Icon className="size-3" />
                  {entity.name}
                </button>
              );
            })}
          </div>
          {taggedEntities.length > 0 && !hasReadyReference && (
            <p className="text-[10px] text-muted-foreground">
              no reference sheet yet — Redraw in the rail
            </p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Image prompt
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestImage}
            disabled={suggestingImage || !voText}
          >
            {suggestingImage ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            <span className="ml-1">AI suggest</span>
          </Button>
        </div>
        <textarea
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
          onBlur={persistIfChanged}
          rows={4}
          className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Motion prompt
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestMotion}
            disabled={suggestingMotion || !voText || !imagePrompt.trim()}
            title={
              !imagePrompt.trim()
                ? "Write an image prompt first — motion suggestions need it"
                : "AI suggest motion"
            }
          >
            {suggestingMotion ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            <span className="ml-1">AI suggest</span>
          </Button>
        </div>
        <textarea
          value={motionPrompt}
          onChange={(e) => setMotionPrompt(e.target.value)}
          onBlur={persistIfChanged}
          rows={2}
          className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Asset generation */}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => generateImage(shot.id)}
          disabled={shot.imageStatus === "generating"}
          title={shot.imagePath ? "Regenerate image" : "Generate image"}
        >
          {shot.imageStatus === "generating" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <ImageIcon className="mr-1 h-3 w-3" />
          )}
          {shot.imagePath ? "Re-image" : "Image"}
        </Button>
        <Button
          size="sm"
          variant="default"
          className="flex-1"
          onClick={() => generateClip(shot.id, "ltx")}
          disabled={!shot.imagePath || shot.clipStatus === "generating"}
          title={
            !shot.imagePath
              ? "Generate image first"
              : shot.clipPath
                ? "Regenerate clip (LTX)"
                : "Generate clip (LTX)"
          }
        >
          {shot.clipStatus === "generating" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Film className="mr-1 h-3 w-3" />
          )}
          {shot.clipPath ? "Re-clip" : "Clip"} (LTX)
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => generateClip(shot.id, "hailuo")}
          disabled={!shot.imagePath || shot.clipStatus === "generating"}
          title={
            !shot.imagePath
              ? "Generate image first"
              : "A/B test: generate with Hailuo 02 instead of LTX (overwrites current clip)"
          }
        >
          {shot.clipStatus === "generating" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Film className="mr-1 h-3 w-3" />
          )}
          Clip (Hailuo)
        </Button>
      </div>

      {shot.imageStatus === "failed" && (
        <p className="text-[10px] text-destructive">Image generation failed. Retry above.</p>
      )}
      {shot.clipStatus === "failed" && (
        <p className="text-[10px] text-destructive">Clip generation failed. Retry above.</p>
      )}

      {/* Timeline ops */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={() => {
            if (beat) splitShot(shot.id, playheadSeconds - beat.startSeconds);
          }}
          disabled={!canSplit}
          title={canSplit ? "Split shot at playhead" : "Move the playhead inside the shot to split"}
        >
          <Scissors className="mr-1 h-3 w-3" />
          Split
        </Button>
        <Button size="sm" variant="destructive" onClick={() => deleteShot(shot.id)}>
          <Trash2 className="mr-1 h-3 w-3" />
          Delete
        </Button>
      </div>
    </>
  );
}

// ─── Gap create form (gap selection) ──────────────────────────────────

function GapCreateForm({
  selection,
}: {
  selection: { type: "gap"; beatId: string; startInBeat: number; endInBeat: number };
}) {
  const { projectId, beats, createShot, select } = useEditor();
  const beat = beats.find((b) => b.id === selection.beatId) ?? null;
  // The gap may span beat boundaries (offsets are relative to its anchor
  // beat) — narration is every beat the absolute range overlaps.
  const gapStart = (beat?.startSeconds ?? 0) + selection.startInBeat;
  const gapEnd = (beat?.startSeconds ?? 0) + selection.endInBeat;
  const spanned = beat
    ? beats.filter(
        (b) => b.endSeconds > b.startSeconds && b.startSeconds < gapEnd && b.endSeconds > gapStart,
      )
    : [];
  const voText = spanned.length > 0 ? spanned.map((b) => b.text).join(" ") : beat?.text ?? "";

  const [imagePrompt, setImagePrompt] = useState("");
  const [motionPrompt, setMotionPrompt] = useState("");
  const [suggestingImage, setSuggestingImage] = useState(false);
  const [suggestingMotion, setSuggestingMotion] = useState(false);
  const [creating, setCreating] = useState(false);

  const aiSuggestImage = async () => {
    if (!voText.trim()) return;
    setSuggestingImage(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText: voText.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { imagePrompt: string };
        setImagePrompt(data.imagePrompt);
      }
    } finally {
      setSuggestingImage(false);
    }
  };

  const aiSuggestMotion = async () => {
    if (!voText.trim() || !imagePrompt.trim()) return;
    setSuggestingMotion(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-motion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText: voText.trim(), imagePrompt }),
      });
      if (res.ok) {
        const data = (await res.json()) as { motionPrompt: string };
        setMotionPrompt(data.motionPrompt);
      }
    } finally {
      setSuggestingMotion(false);
    }
  };

  const handleCreate = async () => {
    if (!imagePrompt.trim()) return;
    setCreating(true);
    try {
      await createShot(
        selection.beatId,
        selection.startInBeat,
        selection.endInBeat,
        imagePrompt.trim(),
        motionPrompt.trim() || undefined,
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <Badge variant="outline">
          {gapStart.toFixed(1)}–{gapEnd.toFixed(1)}s · {spanLabel(spanned)}
        </Badge>
      </div>

      {voText && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            VO here
          </p>
          <p className="text-xs font-mono">{voText}</p>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Image prompt
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestImage}
            disabled={suggestingImage || !voText.trim()}
          >
            {suggestingImage ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            <span className="ml-1">AI suggest</span>
          </Button>
        </div>
        <textarea
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
          rows={4}
          placeholder="Describe what the viewer sees: subject + composition. No motion verbs, no colors (style layer handles those)."
          className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Motion prompt (optional)
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestMotion}
            disabled={suggestingMotion || !voText.trim() || !imagePrompt.trim()}
            title={!imagePrompt.trim() ? "Write or suggest an image prompt first" : "AI suggest motion"}
          >
            {suggestingMotion ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            <span className="ml-1">AI suggest</span>
          </Button>
        </div>
        <textarea
          value={motionPrompt}
          onChange={(e) => setMotionPrompt(e.target.value)}
          rows={2}
          placeholder="Leave blank for default placeholder — you can also regenerate after the image exists."
          className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={!imagePrompt.trim() || creating}
          className="flex-1"
        >
          {creating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />}
          Create shot
        </Button>
        <Button size="sm" variant="outline" onClick={() => select(null)} disabled={creating}>
          Cancel
        </Button>
      </div>
    </>
  );
}
