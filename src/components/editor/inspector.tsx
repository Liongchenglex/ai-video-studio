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

import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
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
  Star,
  TextCursorInput,
  Music,
  X,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VoiceSelector } from "@/components/voice-selector";
import {
  CLIP_MODELS,
  DEFAULT_CLIP_MODEL_ID,
  estClipUsd,
  getClipModel,
  resolveClipDuration,
} from "@/lib/clip-models";
import { CAMERA_MOVES } from "@/lib/clip-camera";
import { orderShotsByTimeline } from "@/lib/shot-beat-mapping";
import { DirectorVerdictCard } from "@/components/editor/director-verdict-card";
import {
  useEditor,
  absoluteShotRange,
  beatsSpanned,
  entitiesOfShot,
  primaryEntityOfShot,
  type EditorBeat,
  type EditorEntity,
  type EditorShot,
  type DirectorRunView,
  type DirectorEventView,
} from "@/components/editor/editor-store";

const ENTITY_TYPE_ICON: Record<EditorEntity["type"], LucideIcon> = {
  character: User,
  location: Mountain,
  object: Box,
};

// Copy for a skipped end frame under the "Ends on" control (Directing
// Controls task 9; renamed from CHAIN_SKIPPED_COPY — "chain" was the old
// checkbox's vocabulary, "Ends on" is the new one). "not-requested" is
// omitted on purpose — the note only renders when shot.endsOn !== "free",
// so a request that was never made can never surface here. custom-frame's
// copy is included even though this task's UI can only reach "next" (Task
// 14 adds the "Custom…" segment) — a shot's stored endsOn could already be
// "custom" from a future rollback/replay, and the note must still read right.
const END_SKIPPED_COPY: Record<string, string> = {
  "model-no-end-frame": "Skipped — this model can't take an end frame",
  "no-next-shot": "Skipped — no next shot",
  "next-image-not-ready": "Skipped — the next shot's image wasn't ready",
  "custom-frame-not-ready": "Skipped — the custom end frame wasn't ready",
};

// Copy for the post-generation "Cast refs skipped — …" note under the Clip
// group (Directing Controls task 13). Mirrors END_SKIPPED_COPY's shape —
// keyed by the server's RefsSkipReason (src/lib/clip-references.ts).
const REFS_SKIPPED_COPY: Record<string, string> = {
  disabled: "featured toggle is off",
  "model-no-references": "this model can't take references",
  "no-ready-sheets": "no tagged entity has a finished sheet",
};

const MIN_HALF = 0.25; // seconds — mirror the server split guard

interface InspectorProps {
  playheadSeconds: number;
  onSeek: (s: number) => void;
  onPlayBeat: (startSeconds: number) => void;
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
}

export function Inspector({
  playheadSeconds,
  onSeek,
  onPlayBeat,
  voiceId,
  onVoiceChange,
}: InspectorProps) {
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
        <BeatPanel
          beat={selectedBeat}
          onPlayBeat={onPlayBeat}
          onSeek={onSeek}
          voiceId={voiceId}
          onVoiceChange={onVoiceChange}
        />
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
  voiceId,
  onVoiceChange,
}: {
  beat: EditorBeat;
  onPlayBeat: (startSeconds: number) => void;
  onSeek: (s: number) => void;
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
}) {
  const { revoiceBeat } = useEditor();
  const needsRevoice = beat.voStatus === "failed" || !beat.voUrl;
  const [showVoicePicker, setShowVoicePicker] = useState(false);

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

      {/* Voice — lives here because a voice change takes effect beat by
          beat: pick a voice, then Re-voice this beat (and any others you
          want in the new voice). */}
      <div className="space-y-1 pt-1">
        <button
          type="button"
          onClick={() => setShowVoicePicker((v) => !v)}
          className="text-[11px] text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
        >
          {showVoicePicker ? "Hide voice picker" : "Change voice…"}
        </button>
        {showVoicePicker && (
          <>
            <VoiceSelector selectedVoiceId={voiceId} onSelect={onVoiceChange} />
            <p className="text-[10px] text-muted-foreground">
              A new voice applies when you re-voice — this beat first, then any other beats you
              want to match.
            </p>
          </>
        )}
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
        <video
          key={shot.id}
          src={shot.sfxUrl ?? shot.clipUrl}
          autoPlay
          muted={!shot.sfxUrl}
          loop
          className="w-full rounded"
        />
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

// The four locked groups of the v3 shot inspector (spec: inspector-layout-v3
// mockup, left panel) — Image / Action / Clip / Sound. A thin visual wrapper
// only; every field inside keeps its existing handler and persistence.
function InspectorGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2 rounded-md border border-dashed p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
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
    projectNegativePrompt,
    beats,
    entities,
    shots,
    updateShot,
    deleteShot,
    splitShot,
    generateImage,
    editShotImage,
    generateClip,
    generateSfx,
    removeSfx,
    createEndFrame,
    removeEndFrame,
    tagShot,
  } = useEditor();
  // Narration under the shot's time range — the concatenated text of every
  // beat it overlaps (shots may spill past their anchor beat).
  const spanned = beatsSpanned(shot, beats);
  const voText = spanned.length > 0 ? spanned.map((b) => b.text).join(" ") : beat?.text ?? "";

  const [imagePrompt, setImagePrompt] = useState(shot.imagePrompt);
  const [motionPrompt, setMotionPrompt] = useState(shot.motionPrompt);
  const [negativePromptDraft, setNegativePromptDraft] = useState(shot.negativePrompt ?? "");
  const [suggestingImage, setSuggestingImage] = useState(false);
  const [suggestingMotion, setSuggestingMotion] = useState(false);

  // Which asset the preview shows. Auto-switches to whichever the user just
  // regenerated so regen results are always visible.
  const [previewMode, setPreviewMode] = useState<"image" | "clip">(
    shot.clipUrl ? "clip" : "image",
  );

  // Clip model selection + chaining (Clip Engine v2). `clipModelId` is local
  // UI state persisted to the shot only on change, so the dropdown reflects
  // the shot's saved model on mount / when the selection moves to another shot.
  const [clipModelId, setClipModelId] = useState(shot.clipModel ?? DEFAULT_CLIP_MODEL_ID);
  const [sfxPrompt, setSfxPrompt] = useState("");
  // Edit-image inline form (Directing Controls task 15) — a toggled
  // instruction input under the Image group, separate from the image
  // prompt textarea: this edits the EXISTING image in place via Kontext
  // rather than regenerating from the prompt.
  const [showEditImage, setShowEditImage] = useState(false);
  const [editImageInstruction, setEditImageInstruction] = useState("");
  // Custom end frame instruction draft — prefilled from the shot's
  // persisted endFrameInstruction so re-opening the panel shows the last
  // instruction used, editable before a re-create.
  const [endFrameInstructionDraft, setEndFrameInstructionDraft] = useState(
    shot.endFrameInstruction ?? "",
  );
  const selectedModel = getClipModel(clipModelId) ?? getClipModel(DEFAULT_CLIP_MODEL_ID)!;
  // Timeline order, not sortOrder (final-review finding #1) — EditorBeat
  // already carries `sortOrder` (its position on the timeline; the reducer
  // keeps beats sorted by it), so it mirrors orderShotsByTimeline's beat
  // ranking exactly. Must match shot-clip-generation.ts's server-side
  // resolution of "next shot" or the preview here can lie about what the
  // clip actually chains onto.
  const timelineOrderedShots = orderShotsByTimeline(shots, beats);
  const nextShot =
    timelineOrderedShots[timelineOrderedShots.findIndex((s) => s.id === shot.id) + 1] ?? null;
  const chainDisabledReason = !selectedModel.supportsEndFrame
    ? `${selectedModel.label} can't take an end frame — pick a model marked "chains"`
    : !nextShot
      ? "Last shot — nothing to chain into"
      : null;

  // Length (Directing Controls task 9): the model's resolved duration —
  // explicit choice wins, else nearest to the shot's timeline slot, else the
  // model default. Mirrors the server's own resolveClipDuration call in
  // shot-clip-generation.ts, so the estimate and the stepper never lie about
  // what a Generate click will actually produce.
  const slotSeconds =
    shot.startInBeat != null && shot.endInBeat != null ? shot.endInBeat - shot.startInBeat : null;
  const resolvedDuration = resolveClipDuration(selectedModel, slotSeconds, shot.clipDurationChoice ?? null);
  const durationIndex = selectedModel.durations.indexOf(resolvedDuration);
  const stepDuration = (delta: number) => {
    const idx = durationIndex + delta;
    if (idx < 0 || idx >= selectedModel.durations.length) return;
    updateShot(shot.id, { clipDurationChoice: selectedModel.durations[idx] });
  };

  useEffect(() => {
    setImagePrompt(shot.imagePrompt);
    setMotionPrompt(shot.motionPrompt);
    setNegativePromptDraft(shot.negativePrompt ?? "");
  }, [shot.id, shot.imagePrompt, shot.motionPrompt, shot.negativePrompt]);

  useEffect(() => {
    setClipModelId(shot.clipModel ?? DEFAULT_CLIP_MODEL_ID);
  }, [shot.id, shot.clipModel]);

  // Reset the SFX prompt only when the selection moves to another shot —
  // NOT on clipModel changes: picking a model in the dropdown optimistically
  // patches shot.clipModel, and that must not wipe an in-progress prompt.
  useEffect(() => {
    setSfxPrompt("");
  }, [shot.id]);

  // Selection moved to another shot — collapse the edit-image form and drop
  // any unsent draft instead of leaking it onto the newly selected shot.
  useEffect(() => {
    setShowEditImage(false);
    setEditImageInstruction("");
  }, [shot.id]);

  // Keep the end-frame instruction draft in sync with what's actually
  // persisted (selection change, or a create/re-create/remove landing) —
  // NOT on every render, so mid-typing edits before a re-create survive.
  useEffect(() => {
    setEndFrameInstructionDraft(shot.endFrameInstruction ?? "");
  }, [shot.id, shot.endFrameInstruction]);

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
      // Tagged entities are named in the suggestion so the prompt text,
      // the tag, and the reference-sheet conditioning stay in agreement.
      // Untagged entities go along as "available": if the model uses one's
      // exact name in the suggested prompt, we auto-tag it below — the
      // suggestion and the chips never disagree.
      const tagged = entitiesOfShot(shot, entities);
      const entityNames = tagged.map((e) => e.name);
      const taggedIds = new Set(tagged.map((e) => e.id));
      const availableEntityNames = entities
        .filter((e) => !taggedIds.has(e.id))
        .map((e) => e.name)
        .slice(0, 16);
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voText,
          ...(entityNames.length > 0 ? { entityNames } : {}),
          ...(availableEntityNames.length > 0 ? { availableEntityNames } : {}),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { imagePrompt: string };
        setImagePrompt(data.imagePrompt);
        await updateShot(shot.id, { imagePrompt: data.imagePrompt, motionPrompt });
        // Auto-tag (add-only, capped) any entity the suggestion named.
        const lower = data.imagePrompt.toLowerCase();
        const matchedIds = entities
          .filter((e) => lower.includes(e.name.toLowerCase()))
          .map((e) => e.id);
        const merged = [...new Set([...shot.referencedEntityIds, ...matchedIds])].slice(0, 8);
        if (merged.length !== shot.referencedEntityIds.length) {
          await tagShot(shot.id, merged);
        }
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

  const handleEditImage = async () => {
    const trimmed = editImageInstruction.trim();
    if (!trimmed) return;
    // Clear only on success — a failed paid call keeps the typed
    // instruction so the user can retry or tweak it.
    const ok = await editShotImage(shot.id, trimmed);
    if (ok) setEditImageInstruction("");
  };

  const hasImage = !!shot.imageUrl;
  const hasClip = !!shot.clipUrl;
  const effectiveMode = previewMode === "clip" && !hasClip ? "image" : previewMode;

  // Reference Bible tagging (v4.0 Phase 4) — the tagged entities and
  // whether any of them has a usable ("done") reference sheet yet.
  const taggedEntities = entitiesOfShot(shot, entities);
  const hasReadyReference = taggedEntities.some((e) => e.referenceStatus === "done");
  const primaryEntity = primaryEntityOfShot(shot, entities);
  const toggleEntity = (entityId: string) => {
    const current = shot.referencedEntityIds;
    const updated = current.includes(entityId)
      ? current.filter((id) => id !== entityId)
      : [...current, entityId];
    tagShot(shot.id, updated);
  };

  // Click a tagged chip → the entity's name lands in the image prompt, so
  // the tag and the prompt text describe the same subject. Persisted
  // immediately (the blur-persist flow only fires if the textarea is
  // focused later). No-op when the prompt already names the entity.
  const insertEntityIntoPrompt = (name: string) => {
    if (imagePrompt.toLowerCase().includes(name.toLowerCase())) return;
    const trimmed = imagePrompt.trimEnd();
    const next = trimmed.length > 0 ? `${trimmed}, ${name}` : name;
    setImagePrompt(next);
    updateShot(shot.id, { imagePrompt: next });
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
        <video
          key={shot.sfxUrl ?? shot.clipUrl}
          src={shot.sfxUrl ?? shot.clipUrl}
          autoPlay
          muted={!shot.sfxUrl}
          loop
          className="w-full rounded"
        />
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
              const isPrimary = primaryEntity?.id === entity.id;
              if (!selected) {
                // Untagged: clicking tags the entity onto the shot.
                return (
                  <button
                    key={entity.id}
                    type="button"
                    onClick={() => toggleEntity(entity.id)}
                    title={`Tag ${entity.name} in this shot`}
                    className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-muted/80"
                  >
                    <Icon className="size-3" />
                    {entity.name}
                  </button>
                );
              }
              // Tagged: the body toggles (untags) like any chip; the small
              // text-insert icon drops the name into the image prompt;
              // ★ marks the primary whose sheet conditions the image. A
              // tagged entity WITHOUT a finished sheet can never be primary
              // — it renders dimmed with a dashed ring so the missing sheet
              // is visible right on the chip.
              const hasSheet = entity.referenceStatus === "done";
              return (
                <span
                  key={entity.id}
                  className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] text-primary-foreground ${
                    isPrimary
                      ? "bg-primary ring-2 ring-amber-400"
                      : hasSheet
                        ? "bg-primary"
                        : "bg-primary/60 ring-1 ring-dashed ring-primary"
                  }`}
                >
                  {isPrimary && (
                    <Star
                      className="size-3 fill-amber-300 text-amber-300"
                      aria-label="Primary — its reference sheet conditions this image"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleEntity(entity.id)}
                    title={
                      hasSheet
                        ? `Untag ${entity.name}`
                        : `Untag ${entity.name} — no reference sheet yet, so it can't condition the image (Generate one in the rail)`
                    }
                    className="flex items-center gap-1 transition hover:opacity-80"
                  >
                    <Icon className="size-3" />
                    {entity.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => insertEntityIntoPrompt(entity.name)}
                    title={`Insert "${entity.name}" into the image prompt`}
                    className="rounded-full p-0.5 transition hover:bg-primary-foreground/20"
                  >
                    <TextCursorInput className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground">
            {taggedEntities.length > 0 && !hasReadyReference
              ? "no reference sheet yet — Generate one in the rail to condition this shot"
              : "★ primary · sheets condition the image and the clip · click a chip to tag/untag · the small icon inserts the name into the prompt"}
          </p>
        </div>
      )}

      <InspectorGroup label="Image — what we see">
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
        <Button
          size="sm"
          variant="default"
          className="w-full"
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
        {shot.imageStatus === "failed" && (
          <p className="text-[10px] text-destructive">Image generation failed. Retry above.</p>
        )}
        {shot.imagePath && (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setShowEditImage((v) => !v)}
              className="text-[10px] text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
            >
              {showEditImage ? "Hide edit image" : "Edit image…"}
            </button>
            {showEditImage && (
              <div className="flex gap-2">
                <input
                  value={editImageInstruction}
                  onChange={(e) => setEditImageInstruction(e.target.value)}
                  maxLength={500}
                  placeholder="Describe the edit, e.g. 'make the sky sunset orange'"
                  className="min-w-0 flex-1 rounded border bg-background p-1.5 text-xs"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleEditImage}
                  disabled={!editImageInstruction.trim() || shot.imageStatus === "generating"}
                  title="Edit the current image in place via FLUX Kontext — overwrites it"
                >
                  {shot.imageStatus === "generating" ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <Wand2 className="mr-1 h-3 w-3" />
                  )}
                  Apply
                </Button>
              </div>
            )}
          </div>
        )}
      </InspectorGroup>

      <InspectorGroup label="Action — what happens in the shot">
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
            placeholder={'e.g. "the boat sails toward the horizon"'}
            className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] text-muted-foreground">Camera move</label>
            <select
              value={shot.cameraMove ?? ""}
              onChange={(e) => {
                const move = e.target.value;
                if (move === "") {
                  // No override — leave camera direction to the prompt as
                  // written, distinct from "static" (an explicit
                  // locked-off directive).
                  updateShot(shot.id, { cameraMove: null, cameraStrength: null });
                  return;
                }
                updateShot(shot.id, {
                  cameraMove: move,
                  // Static has no strength — drop any leftover choice so it
                  // doesn't silently reappear when a move is picked again.
                  ...(move === "static" ? { cameraStrength: null } : {}),
                });
              }}
              className="rounded border bg-background p-1 text-xs"
            >
              <option value="">— (from prompt)</option>
              {CAMERA_MOVES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {shot.cameraMove && shot.cameraMove !== "static" && (
              <select
                value={shot.cameraStrength ?? "medium"}
                onChange={(e) => updateShot(shot.id, { cameraStrength: e.target.value })}
                className="rounded border bg-background p-1 text-xs"
              >
                <option value="subtle">Subtle</option>
                <option value="medium">Medium</option>
                <option value="strong">Strong</option>
              </select>
            )}
          </div>
          {shot.cameraMove && (
            <p className="text-[10px] text-muted-foreground">
              {selectedModel.supportsCameraControl
                ? "guaranteed ✓"
                : "best-effort — written into the prompt"}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] text-muted-foreground">Ends on</label>
            <div className="flex gap-1 text-[10px]">
              <button
                type="button"
                onClick={() => updateShot(shot.id, { endsOn: "free" })}
                className={`rounded px-2 py-1 transition ${
                  shot.endsOn === "free"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                }`}
              >
                Free
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!chainDisabledReason) updateShot(shot.id, { endsOn: "next" });
                }}
                disabled={!!chainDisabledReason}
                title={chainDisabledReason ?? "End this clip on the next shot's image"}
                className={`rounded px-2 py-1 transition disabled:opacity-40 ${
                  shot.endsOn === "next"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                }`}
              >
                Next shot
              </button>
              <button
                type="button"
                onClick={() => updateShot(shot.id, { endsOn: "custom" })}
                title="Author a custom end frame for this clip"
                className={`rounded px-2 py-1 transition ${
                  shot.endsOn === "custom"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-muted/80"
                }`}
              >
                Custom…
              </button>
            </div>
            {shot.endsOn === "next" && nextShot?.imageUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={nextShot.imageUrl}
                alt="Next shot's image (this clip's end frame)"
                className="ml-auto h-8 w-14 rounded object-cover"
              />
            )}
            {shot.endsOn === "custom" && shot.endFrameStatus === "done" && shot.endFrameUrl && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={shot.endFrameUrl}
                alt="Custom end frame (this clip's end frame)"
                className="ml-auto h-8 w-14 rounded object-cover"
              />
            )}
          </div>
          {chainDisabledReason && shot.endsOn !== "next" && (
            <p className="text-[10px] text-muted-foreground">{chainDisabledReason}</p>
          )}
          {(shot.endsOn === "next" || shot.endsOn === "custom") && shot.endFrameSkippedReason && (
            <p className="text-[10px] text-amber-600">
              {END_SKIPPED_COPY[shot.endFrameSkippedReason] ??
                `Skipped — ${shot.endFrameSkippedReason}`}
            </p>
          )}
          {shot.endsOn === "custom" && (
            <div className="space-y-1.5 rounded border border-dashed p-2">
              <div className="flex gap-2">
                <input
                  value={endFrameInstructionDraft}
                  onChange={(e) => setEndFrameInstructionDraft(e.target.value)}
                  maxLength={500}
                  placeholder="Describe the end frame, e.g. 'camera pulls back to reveal the city'"
                  className="min-w-0 flex-1 rounded border bg-background p-1.5 text-xs"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => createEndFrame(shot.id, endFrameInstructionDraft.trim())}
                  disabled={
                    !endFrameInstructionDraft.trim() ||
                    !shot.imagePath ||
                    shot.imageStatus !== "done" ||
                    shot.endFrameStatus === "generating"
                  }
                  title={
                    !shot.imagePath
                      ? "Generate the shot's image first"
                      : "Author the end frame via FLUX Kontext, sourced from the current image"
                  }
                >
                  {shot.endFrameStatus === "generating" ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <ImageIcon className="mr-1 h-3 w-3" />
                  )}
                  {shot.endFramePath ? "Re-create" : "Create end frame"}
                </Button>
                {shot.endFramePath && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => removeEndFrame(shot.id)}
                    title="Remove the custom end frame (reverts Ends on to Free)"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
              {shot.endFrameStatus === "failed" && (
                <p className="text-[10px] text-destructive">
                  End frame generation failed. Retry above.
                </p>
              )}
              {shot.endFrameStatus === "pending" && shot.endFrameInstruction && (
                <p className="text-[10px] text-muted-foreground">
                  End frame out of date — re-create it
                </p>
              )}
            </div>
          )}
        </div>
      </InspectorGroup>

      <InspectorGroup label="Clip — engine settings">
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Clip model
          </p>
          <select
            value={clipModelId}
            onChange={(e) => {
              setClipModelId(e.target.value);
              updateShot(shot.id, { clipModel: e.target.value });
            }}
            className="w-full rounded border bg-background p-1.5 text-xs"
            title={selectedModel.whenToUse}
          >
            {CLIP_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — ~${estClipUsd(m).toFixed(2)}
                {m.supportsEndFrame ? " · chains" : ""}
                {m.nativeAudio ? " · audio" : ""}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground">{selectedModel.whenToUse}</p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-[10px] text-muted-foreground">Length</span>
          <button
            type="button"
            onClick={() => stepDuration(-1)}
            disabled={durationIndex <= 0}
            title="Shorter"
            className="rounded border px-1.5 py-0.5 text-xs disabled:opacity-40"
          >
            −
          </button>
          <span className="font-mono text-xs">
            {resolvedDuration}s{shot.clipDurationChoice == null ? " (auto)" : ""}
          </span>
          <button
            type="button"
            onClick={() => stepDuration(1)}
            disabled={durationIndex < 0 || durationIndex >= selectedModel.durations.length - 1}
            title="Longer"
            className="rounded border px-1.5 py-0.5 text-xs disabled:opacity-40"
          >
            +
          </button>
          {shot.clipDurationChoice != null && (
            <button
              type="button"
              onClick={() => updateShot(shot.id, { clipDurationChoice: null })}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              auto
            </button>
          )}
        </div>

        <div className="space-y-1">
          <label
            className="flex items-center gap-2 text-xs"
            title={
              !selectedModel.supportsReferences
                ? `${selectedModel.label} can't take reference images`
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={shot.useEntityRefs}
              disabled={!selectedModel.supportsReferences}
              onChange={(e) => updateShot(shot.id, { useEntityRefs: e.target.checked })}
            />
            <span className="text-[10px] text-muted-foreground">Cast &amp; locations featured</span>
          </label>
          <p className="text-[10px] text-muted-foreground">
            {!selectedModel.supportsReferences
              ? "not supported by this model"
              : taggedEntities.length === 0
                ? "(none tagged)"
                : `${taggedEntities.map((e) => e.name).join(", ")} — from your tags`}
          </p>
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer select-none text-[10px] font-medium text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
            Advanced ▸
          </summary>
          <div className="mt-1.5 space-y-1">
            <p className="text-[10px] text-muted-foreground">Negative prompt (this shot)</p>
            <textarea
              value={negativePromptDraft}
              onChange={(e) => setNegativePromptDraft(e.target.value)}
              onBlur={() => {
                const trimmed = negativePromptDraft.trim();
                if (trimmed !== (shot.negativePrompt ?? "")) {
                  updateShot(shot.id, { negativePrompt: trimmed || null });
                }
              }}
              rows={2}
              maxLength={500}
              placeholder={projectNegativePrompt ?? ""}
              className="w-full rounded border bg-background p-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </details>

        <Button
          size="sm"
          variant="default"
          className="w-full"
          onClick={() => generateClip(shot.id, clipModelId)}
          disabled={!shot.imagePath || shot.clipStatus === "generating"}
          title={
            !shot.imagePath
              ? "Generate image first"
              : `${shot.clipPath ? "Regenerate" : "Generate"} clip with ${selectedModel.label} (~$${estClipUsd(selectedModel, resolvedDuration).toFixed(2)})`
          }
        >
          {shot.clipStatus === "generating" ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Film className="mr-1 h-3 w-3" />
          )}
          {shot.clipPath ? "Re-generate clip" : "Generate clip"} — ~$
          {estClipUsd(selectedModel, resolvedDuration).toFixed(2)}
        </Button>
        {shot.cameraBestEffort && (
          <p className="text-[10px] text-muted-foreground">
            Camera move applied as prompt text (best-effort) on the last generation — this model
            has no hard camera control.
          </p>
        )}
        {shot.refsSkippedReason && (
          <p className="text-[10px] text-muted-foreground">
            Cast refs skipped — {REFS_SKIPPED_COPY[shot.refsSkippedReason] ?? shot.refsSkippedReason}.
          </p>
        )}
        {shot.clipStatus === "failed" && (
          <p className="text-[10px] text-destructive">Clip generation failed. Retry above.</p>
        )}
      </InspectorGroup>

      <InspectorGroup label="Sound">
        {shot.clipPath && shot.clipStatus === "done" ? (
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <input
                value={sfxPrompt}
                onChange={(e) => setSfxPrompt(e.target.value)}
                maxLength={500}
                placeholder="Optional: steer the SFX (e.g. ticking clock, bell chime)"
                className="min-w-0 flex-1 rounded border bg-background p-1.5 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => generateSfx(shot.id, sfxPrompt)}
                disabled={shot.sfxStatus === "generating"}
                title="Generate synced sound effects with MMAudio (~$0.01) — the clip itself is untouched"
              >
                {shot.sfxStatus === "generating" ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Music className="mr-1 h-3 w-3" />
                )}
                {shot.sfxPath ? "Re-roll SFX" : "Add SFX"}
              </Button>
              {shot.sfxPath && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => removeSfx(shot.id)}
                  title="Remove SFX (keeps the clip)"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            {shot.sfxStatus === "failed" && (
              <p className="text-[10px] text-destructive">SFX generation failed. Retry above.</p>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Generate a clip first — SFX layers onto the finished clip.
          </p>
        )}
      </InspectorGroup>

      <DirectorGroup shot={shot} />

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

// ─── AI Director group (fifth inspector group, below Sound) ──────────
//
// Three states per shot, driven entirely by directorState[shot.id] (Task
// 8): at rest (budget/guidance/start — no run, or a terminal one the user
// can restart), running (live feed + Stop), and awaiting_approval (history
// row + the verdict card — DirectorVerdictCard, Task 14 — which owns
// approve/reject-retry/dismiss). A run counts as "active" (blocks a fresh
// start, matches the route's own 409 check) for status running OR
// awaiting_approval.

const DIRECTOR_BUDGET_OPTIONS = [0.75, 1.5, 3.0];
const DIRECTOR_DEFAULT_BUDGET = 1.5;
const DIRECTOR_GUIDANCE_MAX = 500;

function directorHistoryLabel(run: DirectorRunView): string {
  return `Last run: ${run.status} · $${run.spentUsd.toFixed(2)} spent`;
}

// Heading shown above the verdict card. A stopped run with a candidate is
// approvable too (spec + the resolve route's claimRunApproval both allow
// it — final-review I2), so it gets its own lead-in distinguishing it from
// the normal awaiting_approval case, rather than reusing "Last run:
// stopped …", which reads like a dead end when there's actually a
// candidate the user can still approve.
function directorVerdictHeading(run: DirectorRunView): string {
  return run.status === "stopped"
    ? `Stopped — candidate so far · $${run.spentUsd.toFixed(2)} spent`
    : directorHistoryLabel(run);
}

function DirectorFeedLine({ event, budgetUsd }: { event: DirectorEventView; budgetUsd: number }) {
  switch (event.type) {
    case "critique": {
      const payload = event.payload as {
        summary?: unknown;
        dimensions?: Array<{ name?: unknown; pass?: unknown; note?: unknown }>;
        frameUrls?: unknown;
      };
      const dimensions = Array.isArray(payload.dimensions) ? payload.dimensions : [];
      const frameUrls = Array.isArray(payload.frameUrls)
        ? payload.frameUrls.filter((u): u is string => typeof u === "string")
        : [];
      return (
        <div className="space-y-1 rounded border border-dashed p-1.5">
          <p className="text-xs">🎬 {typeof payload.summary === "string" ? payload.summary : ""}</p>
          {dimensions.length > 0 && (
            <ul className="space-y-0.5 pl-3 text-[10px] text-muted-foreground">
              {dimensions.map((d, i) => (
                <li key={i}>
                  {d.pass ? "✓" : "✗"} {typeof d.name === "string" ? d.name : ""}
                  {typeof d.note === "string" && d.note ? ` — ${d.note}` : ""}
                </li>
              ))}
            </ul>
          )}
          {frameUrls.length > 0 && (
            <div className="flex gap-1.5">
              {frameUrls.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not a static/Next-optimizable asset
                <img
                  key={i}
                  src={url}
                  alt={i === 0 ? "Candidate first frame" : "Candidate last frame"}
                  className="h-12 w-20 rounded object-cover"
                />
              ))}
            </div>
          )}
        </div>
      );
    }
    case "action": {
      const payload = event.payload as { message?: unknown };
      return <p className="text-xs">🔧 {typeof payload.message === "string" ? payload.message : ""}</p>;
    }
    case "cost": {
      const payload = event.payload as { usd?: unknown; runningTotal?: unknown };
      const usd = typeof payload.usd === "number" ? payload.usd : 0;
      const runningTotal = typeof payload.runningTotal === "number" ? payload.runningTotal : 0;
      return (
        <p className="text-xs text-muted-foreground">
          💸 +${usd.toFixed(2)} → ${runningTotal.toFixed(2)} / ${budgetUsd.toFixed(2)}
        </p>
      );
    }
    case "error": {
      const payload = event.payload as { message?: unknown };
      return <p className="text-xs text-destructive">❌ {typeof payload.message === "string" ? payload.message : ""}</p>;
    }
    case "note": {
      const payload = event.payload as { message?: unknown };
      return (
        <p className="text-xs text-muted-foreground">
          📝 {typeof payload.message === "string" ? payload.message : ""}
        </p>
      );
    }
    default:
      return null;
  }
}

function DirectorGroup({ shot }: { shot: EditorShot }) {
  const { directorState, startDirector, stopDirector } = useEditor();
  const [budgetUsd, setBudgetUsd] = useState(DIRECTOR_DEFAULT_BUDGET);
  const [guidance, setGuidance] = useState("");
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Fresh draft whenever the selection moves to a different shot.
  useEffect(() => {
    setBudgetUsd(DIRECTOR_DEFAULT_BUDGET);
    setGuidance("");
  }, [shot.id]);

  const shotState = directorState[shot.id];
  const run = shotState?.run ?? null;
  const isActive = run?.status === "running" || run?.status === "awaiting_approval";
  const noDoneImage = !shot.imagePath || shot.imageStatus !== "done";

  const handleStart = async () => {
    setStarting(true);
    try {
      await startDirector(shot.id, budgetUsd, guidance);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopDirector(shot.id);
    } finally {
      setStopping(false);
    }
  };

  return (
    <InspectorGroup label="AI Director">
      {run?.status === "running" ? (
        <div className="space-y-1.5">
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {(shotState?.events.length ?? 0) === 0 ? (
              <p className="text-[10px] text-muted-foreground">Starting…</p>
            ) : (
              shotState!.events.map((event) => (
                <DirectorFeedLine key={event.id} event={event} budgetUsd={run.budgetUsd} />
              ))
            )}
          </div>
          <Button size="sm" variant="outline" onClick={handleStop} disabled={stopping}>
            {stopping && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Stop
          </Button>
        </div>
      ) : run?.status === "awaiting_approval" || (run?.status === "stopped" && run.candidateUrl) ? (
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground">{directorVerdictHeading(run)}</p>
          <DirectorVerdictCard shot={shot} run={run} />
        </div>
      ) : (
        <div className="space-y-1.5">
          {run && <p className="text-[10px] text-muted-foreground">{directorHistoryLabel(run)}</p>}
          <div className="flex gap-2">
            <select
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(Number(e.target.value))}
              className="rounded border bg-background p-1.5 text-xs"
            >
              {DIRECTOR_BUDGET_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  ${opt.toFixed(2)}
                </option>
              ))}
            </select>
            <input
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              maxLength={DIRECTOR_GUIDANCE_MAX}
              placeholder='e.g. "the dog should react to the lantern"'
              className="min-w-0 flex-1 rounded border bg-background p-1.5 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleStart}
            disabled={noDoneImage || isActive || starting}
            title={noDoneImage ? "Generate the shot's still first" : undefined}
          >
            {starting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Direct this shot
          </Button>
        </div>
      )}
    </InspectorGroup>
  );
}

// ─── Gap create form (gap selection) ──────────────────────────────────

function GapCreateForm({
  selection,
}: {
  selection: { type: "gap"; beatId: string; startInBeat: number; endInBeat: number };
}) {
  const { projectId, beats, entities, createShot, tagShot, select } = useEditor();
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
  // Entities picked before the shot exists — applied as tags on create.
  const [selectedEntityIds, setSelectedEntityIds] = useState<string[]>([]);

  const toggleEntity = (entityId: string) =>
    setSelectedEntityIds((cur) =>
      cur.includes(entityId) ? cur.filter((id) => id !== entityId) : [...cur, entityId].slice(0, 8),
    );

  const insertEntityIntoPrompt = (name: string) => {
    setImagePrompt((cur) => {
      if (cur.toLowerCase().includes(name.toLowerCase())) return cur;
      const trimmed = cur.trimEnd();
      return trimmed.length > 0 ? `${trimmed}, ${name}` : name;
    });
  };

  const aiSuggestImage = async () => {
    if (!voText.trim()) return;
    setSuggestingImage(true);
    try {
      // Same entity loop as the shot panel: picked entities anchor the
      // suggestion, the rest are offered by exact name, and any the model
      // names in the result get auto-picked.
      const picked = entities.filter((e) => selectedEntityIds.includes(e.id));
      const entityNames = picked.map((e) => e.name);
      const availableEntityNames = entities
        .filter((e) => !selectedEntityIds.includes(e.id))
        .map((e) => e.name)
        .slice(0, 16);
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voText: voText.trim(),
          ...(entityNames.length > 0 ? { entityNames } : {}),
          ...(availableEntityNames.length > 0 ? { availableEntityNames } : {}),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { imagePrompt: string };
        setImagePrompt(data.imagePrompt);
        const lower = data.imagePrompt.toLowerCase();
        const matched = entities
          .filter((e) => lower.includes(e.name.toLowerCase()))
          .map((e) => e.id);
        setSelectedEntityIds((cur) => [...new Set([...cur, ...matched])].slice(0, 8));
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
      const created = await createShot(
        selection.beatId,
        selection.startInBeat,
        selection.endInBeat,
        imagePrompt.trim(),
        motionPrompt.trim() || undefined,
      );
      if (created && selectedEntityIds.length > 0) {
        await tagShot(created.id, selectedEntityIds);
      }
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

      {entities.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            In this shot
          </p>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((entity) => {
              const Icon = ENTITY_TYPE_ICON[entity.type];
              const selected = selectedEntityIds.includes(entity.id);
              const hasSheet = entity.referenceStatus === "done";
              if (!selected) {
                return (
                  <button
                    key={entity.id}
                    type="button"
                    onClick={() => toggleEntity(entity.id)}
                    title={`Tag ${entity.name} on the new shot`}
                    className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-muted/80"
                  >
                    <Icon className="size-3" />
                    {entity.name}
                  </button>
                );
              }
              return (
                <span
                  key={entity.id}
                  className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] text-primary-foreground ${
                    hasSheet ? "bg-primary" : "bg-primary/60 ring-1 ring-dashed ring-primary"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleEntity(entity.id)}
                    title={
                      hasSheet
                        ? `Untag ${entity.name}`
                        : `Untag ${entity.name} — no reference sheet yet (Generate one in the rail)`
                    }
                    className="flex items-center gap-1 transition hover:opacity-80"
                  >
                    <Icon className="size-3" />
                    {entity.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => insertEntityIntoPrompt(entity.name)}
                    title={`Insert "${entity.name}" into the image prompt`}
                    className="rounded-full p-0.5 transition hover:bg-primary-foreground/20"
                  >
                    <TextCursorInput className="size-3" />
                  </button>
                </span>
              );
            })}
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground">
            Applied as tags when the shot is created · AI suggest picks matching entities
            automatically
          </p>
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
