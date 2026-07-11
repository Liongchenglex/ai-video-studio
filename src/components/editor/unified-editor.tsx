/**
 * Unified directing editor (v4.0 Pillar B, mockup 01).
 *
 * One screen that replaces the old Script + Editor steps. It owns the
 * staged entry flow — script generation starts AUTOMATICALLY on arrival
 * (with a visible working state), then lands on a full-page script REVIEW
 * stage where the user reads/edits the whole script before paying to
 * voice it. The stages are derived from server data (script? beats?), so
 * a user who leaves mid-review returns to the review stage, and the
 * editor itself only ever appears once VO beats exist. Past the stages it
 * mounts the shared editor store and renders the whole
 * directing surface: a top bar (view toggle, counts, transport, voice,
 * recommend), the Reference Bible left rail (Cast & Locations —
 * ReferenceBiblePanel, F-16), a center column (video preview → inline
 * script → Timeline or Storyboard), and the sticky Inspector on the right.
 *
 * The store owns beats/shots; this shell owns the gates and the transport
 * (sequential per-beat playback). The video preview follows the shot under
 * the playhead — the three sync effects are ported from editor-prototype and
 * adapted to the beat/shot model via absoluteShotRange().
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Square,
  Sparkles,
  Loader2,
  Mic,
  LayoutList,
  LayoutGrid,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VoiceSelector } from "@/components/voice-selector";
import {
  EditorProvider,
  useEditor,
  absoluteShotRange,
  type EditorBeat,
  type EditorEntity,
  type EditorShot,
} from "@/components/editor/editor-store";
import { useBeatPlayback } from "@/components/editor/use-beat-playback";
import { TimelineView } from "@/components/editor/timeline-view";
import { StoryboardView } from "@/components/editor/storyboard-view";
import { ScriptStrip } from "@/components/editor/script-strip";
import { Inspector } from "@/components/editor/inspector";
import { ReferenceBiblePanel } from "@/components/editor/reference-bible-panel";
import { GenerateAllDialog } from "@/components/editor/generate-all-dialog";

interface UnifiedEditorProps {
  projectId: string;
  script: string | null;
  /** Whether the project has a brief — auto-generation only fires with one. */
  hasBrief: boolean;
  voiceId: string;
  initialBeats: EditorBeat[];
  initialShots: EditorShot[];
  initialEntities: EditorEntity[];
  /** Project-level negative-prompt default (Directing Controls task 9). */
  negativePrompt: string | null;
  onVoiceChange: (voiceId: string) => void;
}

// Seed for an empty project negative prompt — the toolbar popover's
// placeholder and its "use suggested" fill (Global Constraints copy list).
const SUGGESTED_NEGATIVE_PROMPT =
  "blur, warping, morphing, distorted faces, extra limbs, text artifacts";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function UnifiedEditor({
  projectId,
  script: initialScript,
  hasBrief,
  voiceId,
  initialBeats,
  initialShots,
  initialEntities,
  negativePrompt,
  onVoiceChange,
}: UnifiedEditorProps) {
  const [script, setScript] = useState(initialScript ?? "");
  // Beats can arrive either from the server (props) or from voicing the
  // script in the review stage; keep a local copy so the editor mounts with
  // the right set once voicing completes.
  const [beats, setBeats] = useState<EditorBeat[]>(initialBeats);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  // "I have my own script" — skips (and aborts) generation and opens the
  // review stage with an empty draft to paste into.
  const [pasteMode, setPasteMode] = useState(false);
  const genAbortRef = useRef<AbortController | null>(null);

  const hasScript = script.trim().length > 0;

  const generateScript = useCallback(async () => {
    setScriptError(false);
    setGeneratingScript(true);
    const controller = new AbortController();
    genAbortRef.current = controller;
    try {
      const res = await fetch(`/api/projects/${projectId}/script/generate`, {
        method: "POST",
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as { script: string };
        setScript(data.script);
      } else {
        setScriptError(true);
      }
    } catch (err) {
      // An abort means the user chose to paste their own script — not an error.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setScriptError(true);
      }
    } finally {
      setGeneratingScript(false);
    }
  }, [projectId]);

  const useOwnScript = useCallback(() => {
    genAbortRef.current?.abort(); // the route discards an aborted generation
    setScriptError(false);
    setPasteMode(true);
  }, []);

  // ── Stage 1: no script → generation starts automatically ──
  // The user arrived here deliberately (brief + style done), so the AI gets
  // to work without another click; the working state below makes it visible.
  // Fires once per mount; failures surface a manual retry.
  const autoGenStarted = useRef(false);
  useEffect(() => {
    if (!hasScript && hasBrief && !pasteMode && !autoGenStarted.current) {
      autoGenStarted.current = true;
      generateScript();
    }
  }, [hasScript, hasBrief, pasteMode, generateScript]);

  if (!hasScript && !pasteMode) {
    return (
      <GenerateScriptStage
        hasBrief={hasBrief}
        generating={generatingScript}
        error={scriptError}
        onRetry={generateScript}
        onUseOwnScript={useOwnScript}
      />
    );
  }

  // ── Stage 2: script but no beats → full-page review before voicing ──
  // Derived from server data, so leaving mid-review and coming back lands
  // here again; the editor is only reachable once VO beats exist.
  if (beats.length === 0) {
    return (
      <ScriptReviewStage
        projectId={projectId}
        script={script}
        onScriptChange={setScript}
        onRegenerate={generateScript}
        regenerating={generatingScript}
        voiceId={voiceId}
        onVoiceChange={onVoiceChange}
        onVoiced={setBeats}
      />
    );
  }

  // ── Editor ──
  return (
    <EditorProvider
      projectId={projectId}
      initialBeats={beats}
      initialShots={initialShots}
      initialEntities={initialEntities}
      initialNegativePrompt={negativePrompt}
    >
      <EditorShell voiceId={voiceId} onVoiceChange={onVoiceChange} />
    </EditorProvider>
  );
}

// ─── Stage 1: script generation (auto-started) ────────────────────────

function GenerateScriptStage({
  hasBrief,
  generating,
  error,
  onRetry,
  onUseOwnScript,
}: {
  hasBrief: boolean;
  generating: boolean;
  error: boolean;
  onRetry: () => void;
  onUseOwnScript: () => void;
}) {
  const pasteInstead = (
    <button
      type="button"
      onClick={onUseOwnScript}
      className="text-xs text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
    >
      …or paste your own script instead
    </button>
  );

  if (!hasBrief) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6 text-center">
          <h2 className="text-lg font-semibold">Write your concept first</h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            The script is written from your brief — go back to the Concept step and describe the
            video, then return here.
          </p>
          {pasteInstead}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-10 text-center">
        {error ? (
          <>
            <h2 className="text-lg font-semibold">Script generation failed</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Something went wrong while writing the script. Nothing was saved — try again.
            </p>
            <Button onClick={onRetry} disabled={generating}>
              <Sparkles className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <h2 className="text-lg font-semibold">Writing your script…</h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              The AI is drafting the full narration from your brief and style. This takes about
              30–60 seconds — you&rsquo;ll review and edit it before anything is voiced.
            </p>
          </>
        )}
        {pasteInstead}
      </CardContent>
    </Card>
  );
}

// ─── Stage 2: review the script, then voice it ────────────────────────

function ScriptReviewStage({
  projectId,
  script,
  onScriptChange,
  onRegenerate,
  regenerating,
  voiceId,
  onVoiceChange,
  onVoiced,
}: {
  projectId: string;
  script: string;
  onScriptChange: (script: string) => void;
  onRegenerate: () => void;
  regenerating: boolean;
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  onVoiced: (beats: EditorBeat[]) => void;
}) {
  const [voicing, setVoicing] = useState(false);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState(script);
  const [saving, setSaving] = useState(false);
  // Regenerate replaces the script from outside — resync the textarea.
  useEffect(() => setDraft(script), [script]);

  const words = draft.trim().length === 0 ? 0 : draft.trim().split(/\s+/).length;
  const estSeconds = Math.round((words / 150) * 60); // 150 wpm baseline
  const estClock = `${Math.floor(estSeconds / 60)}:${(estSeconds % 60).toString().padStart(2, "0")}`;

  // Autosave on blur so a user who leaves mid-review keeps their edits —
  // this stage is re-entered on every visit until the script is voiced.
  // `force` is used right before voicing: the draft is ALWAYS written then,
  // so whatever is on screen is exactly what gets voiced.
  const persistDraft = async (force = false) => {
    if (!force && draft === script) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: draft }),
      });
      if (res.ok) onScriptChange(draft);
      else console.warn("[review] script autosave failed:", await res.text());
    } catch (err) {
      console.error("[review] script autosave error:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleVoice = async () => {
    setError(false);
    setVoicing(true);
    try {
      await persistDraft(true); // what's on screen is exactly what gets voiced
      const gen = await fetch(`/api/projects/${projectId}/beats/generate`, { method: "POST" });
      if (!gen.ok) {
        setError(true);
        return;
      }
      // beats/generate already returns the voiced beats, but the brief calls
      // for a GET /beats read-back to enter the editor from the canonical
      // list shape — do that so the two paths never drift.
      const list = await fetch(`/api/projects/${projectId}/beats`);
      if (!list.ok) {
        setError(true);
        return;
      }
      const data = (await list.json()) as { beats: EditorBeat[] };
      if (data.beats.length === 0) {
        setError(true);
        return;
      }
      onVoiced(data.beats);
    } catch {
      setError(true);
    } finally {
      setVoicing(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">
              {script.trim().length === 0
                ? "Paste your script"
                : "✨ Your script is ready — review it"}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {script.trim().length === 0
                ? "Drop your own script in below — plain prose with paragraph breaks works best. You can still have the AI write one instead with Regenerate."
                : "Read and edit the full script now — or replace it entirely by pasting your own. Changes here are free, while edits after voicing re-voice one line at a time. When it reads right, voice it below."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRegenerate}
            disabled={regenerating || voicing}
            title="Throw this draft away and write a new one from the brief"
          >
            {regenerating ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-3.5" />
            )}
            Regenerate
          </Button>
        </div>

        <div className="space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => persistDraft()}
            disabled={voicing || regenerating}
            maxLength={50000}
            placeholder="Paste or write your script here — plain prose, blank line between paragraphs…"
            className="min-h-[50vh] w-full resize-y rounded border bg-background p-4 text-sm leading-7 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>
              {words} words · ~{estClock} at 150 wpm
            </span>
            <span>{saving ? "Saving…" : draft !== script ? "Unsaved edits (saved on blur)" : "Saved"}</span>
          </div>
        </div>

        <VoiceSelector selectedVoiceId={voiceId} onSelect={onVoiceChange} disabled={voicing} />

        <div className="flex items-center gap-3">
          <Button
            onClick={handleVoice}
            disabled={voicing || regenerating || words === 0}
            title={words === 0 ? "Write or paste a script first" : undefined}
          >
            {voicing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Voicing the script… (~30–90s)
              </>
            ) : (
              <>
                <Mic className="mr-2 h-4 w-4" />
                Voice the script →
              </>
            )}
          </Button>
          {error && <span className="text-sm text-destructive">Voicing failed. Try again.</span>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Voicing segments the script into beats — each sentence gets its own audio so you can
          later re-voice a single line without redoing the whole track.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Editor shell (mounted inside the store) ──────────────────────────

function EditorShell({
  voiceId,
  onVoiceChange,
}: {
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
}) {
  const {
    beats,
    shots,
    entities,
    view,
    setView,
    totalDuration,
    recommendShots,
    recommending,
    batchActive,
  } = useEditor();
  const { playing, playheadSeconds, play, pause, seek } = useBeatPlayback(beats);
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Rows still in flight for the running batch: generating reference sheets,
  // plus shots whose image is generating|pending (pending ones will still be
  // reached by the batch) or whose clip is generating. Pending clips are
  // excluded — clips may not have been opted into this run.
  const batchRemaining = useMemo(
    () =>
      entities.filter((e) => e.referenceStatus === "generating").length +
      shots.filter(
        (s) =>
          s.imageStatus === "generating" ||
          s.imageStatus === "pending" ||
          s.clipStatus === "generating",
      ).length,
    [entities, shots],
  );

  // A stable onSeek identity: TimelineView's drag effect re-subscribes on
  // identity change, and `seek` changes on every play/pause toggle.
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const onSeek = useCallback((s: number) => seekRef.current(s), []);

  const playRef = useRef(play);
  playRef.current = play;
  const onPlayBeat = useCallback((startSeconds: number) => playRef.current(startSeconds), []);

  // ── Video preview: the shot whose absolute range holds the playhead ──
  const playheadShot = useMemo(
    () =>
      shots.find((s) => {
        const r = absoluteShotRange(s, beats);
        return r && playheadSeconds >= r.start && playheadSeconds < r.end;
      }) ?? null,
    [shots, beats, playheadSeconds],
  );

  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  // Swap source when the shot under the playhead changes.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    const activeClipUrl = playheadShot?.sfxUrl ?? playheadShot?.clipUrl ?? null;
    if (!playheadShot || !activeClipUrl) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      return;
    }
    if (!v.src.endsWith(encodeURI(activeClipUrl)) && v.src !== activeClipUrl) {
      v.muted = !playheadShot?.sfxUrl;
      v.src = activeClipUrl;
      v.load();
    }
    const range = absoluteShotRange(playheadShot, beats);
    const localTime = Math.max(0, playheadSeconds - (range?.start ?? 0));
    if (Math.abs(v.currentTime - localTime) > 0.5) v.currentTime = localTime;
    if (playing) v.play().catch(() => {});
    // `view` is a dependency because the <video> element unmounts in the
    // storyboard view — returning to the timeline must re-sync the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadShot?.id, playheadShot?.clipUrl, playheadShot?.sfxUrl, view]);

  // Sync the video element when play/pause toggles.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    const activeClipUrl = playheadShot?.sfxUrl ?? playheadShot?.clipUrl ?? null;
    if (playing && activeClipUrl) v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Re-seek the video when the user scrubs while paused.
  useEffect(() => {
    if (playing) return;
    const v = previewVideoRef.current;
    const activeClipUrl = playheadShot?.sfxUrl ?? playheadShot?.clipUrl ?? null;
    if (!v || !playheadShot || !activeClipUrl) return;
    const range = absoluteShotRange(playheadShot, beats);
    const localTime = Math.max(0, playheadSeconds - (range?.start ?? 0));
    if (Math.abs(v.currentTime - localTime) > 0.2) v.currentTime = localTime;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadSeconds]);

  return (
    <div className="space-y-3">
      <TopBar
        beatCount={beats.length}
        shotCount={shots.length}
        totalDuration={totalDuration}
        view={view}
        onViewChange={setView}
        playing={playing}
        canPlay={beats.some((b) => b.voUrl)}
        onPlay={() => play()}
        onStop={pause}
        recommending={recommending}
        onRecommend={recommendShots}
        batchActive={batchActive}
        batchRemaining={batchRemaining}
        onGenerateAll={() => setGenerateAllOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <GenerateAllDialog open={generateAllOpen} onOpenChange={setGenerateAllOpen} />
      <ProjectSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <div className="flex gap-4">
        <ReferenceBiblePanel />

        {/* Center column. The video preview and script band belong to the
            timeline (directing) view; the storyboard is a scan-only board
            (mockup 02) — toggle to it and the cards ARE the screen. */}
        <div className="min-w-0 flex-1 space-y-3">
          {view === "timeline" && (
            <>
              <div
                className="relative mx-auto aspect-video overflow-hidden rounded bg-black"
                style={{ maxHeight: "45vh" }}
              >
                <video ref={previewVideoRef} muted playsInline className="h-full w-full object-contain" />
                {!playheadShot?.clipUrl && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-white/60">
                    {playheadShot
                      ? playheadShot.imageUrl
                        ? "Clip not generated yet — showing image only"
                        : "No clip here"
                      : playheadSeconds > 0
                        ? "Gap — no shot at this time"
                        : "Press Play to preview"}
                  </div>
                )}
                {playheadShot?.imageUrl && !playheadShot.clipUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={playheadShot.imageUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-contain opacity-80"
                  />
                )}
              </div>

              <ScriptStrip onSeek={onSeek} />
            </>
          )}

          <Card>
            <CardContent className="p-3">
              {view === "timeline" ? (
                <TimelineView playheadSeconds={playheadSeconds} onSeek={onSeek} />
              ) : (
                <StoryboardView />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right inspector */}
        <div className="hidden w-[22rem] shrink-0 lg:block">
          <Card className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto">
            <CardContent className="p-4">
              <Inspector
                playheadSeconds={playheadSeconds}
                onSeek={onSeek}
                onPlayBeat={onPlayBeat}
                voiceId={voiceId}
                onVoiceChange={onVoiceChange}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────

function TopBar({
  beatCount,
  shotCount,
  totalDuration,
  view,
  onViewChange,
  playing,
  canPlay,
  onPlay,
  onStop,
  recommending,
  onRecommend,
  batchActive,
  batchRemaining,
  onGenerateAll,
  onOpenSettings,
}: {
  beatCount: number;
  shotCount: number;
  totalDuration: number;
  view: "timeline" | "storyboard";
  onViewChange: (v: "timeline" | "storyboard") => void;
  playing: boolean;
  canPlay: boolean;
  onPlay: () => void;
  onStop: () => void;
  recommending: boolean;
  onRecommend: () => void;
  batchActive: boolean;
  batchRemaining: number;
  onGenerateAll: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/20 p-2">
      {/* View toggle */}
      <div className="flex overflow-hidden rounded-md border">
        <button
          type="button"
          onClick={() => onViewChange("timeline")}
          className={`flex items-center gap-1 px-3 py-1 text-xs ${
            view === "timeline" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          <LayoutList className="h-3.5 w-3.5" /> Timeline
        </button>
        <button
          type="button"
          onClick={() => onViewChange("storyboard")}
          className={`flex items-center gap-1 px-3 py-1 text-xs ${
            view === "storyboard" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
          }`}
        >
          <LayoutGrid className="h-3.5 w-3.5" /> Storyboard
        </button>
      </div>

      <Badge variant="outline">
        {beatCount} beats · {shotCount} shots
      </Badge>
      <Badge variant="outline" className="font-mono">
        {formatClock(totalDuration)}
      </Badge>

      <Button size="sm" onClick={playing ? onStop : onPlay} disabled={!canPlay}>
        {playing ? (
          <>
            <Square className="mr-1 h-3.5 w-3.5" /> Stop
          </>
        ) : (
          <>
            <Play className="mr-1 h-3.5 w-3.5" /> Play
          </>
        )}
      </Button>

      <div className="ml-auto flex items-center gap-2">
        {/* The voice picker lives in the beat inspector panel — voice
            changes take effect beat by beat via Re-voice. */}
        <Button size="sm" onClick={onGenerateAll} disabled={batchActive}>
          {batchActive ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Generating… {batchRemaining} left
            </>
          ) : (
            <>
              <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate all
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant={shotCount === 0 ? "default" : "outline"}
          onClick={onRecommend}
          disabled={recommending}
        >
          {recommending ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Recommending…
            </>
          ) : (
            <>
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              {shotCount === 0 ? "Recommend shots" : "Re-recommend"}
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenSettings}
          title="Project settings — negative-prompt default for clips"
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Project settings popover (gear icon) ─────────────────────────────

function ProjectSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { projectNegativePrompt, saveProjectSettings } = useEditor();
  const [draft, setDraft] = useState(projectNegativePrompt ?? "");
  const [saving, setSaving] = useState(false);

  // Resync the draft to the store's current value every time the popover
  // opens, so a stale edit from a previous open (never saved) doesn't linger.
  useEffect(() => {
    if (open) setDraft(projectNegativePrompt ?? "");
  }, [open, projectNegativePrompt]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProjectSettings({ negativePrompt: draft.trim() || null });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            The project default applies to every clip whose shot doesn&rsquo;t set its own
            negative prompt (Advanced ▸ in the inspector).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-medium text-muted-foreground">
              Negative prompt (project default)
            </label>
            <button
              type="button"
              onClick={() => setDraft(SUGGESTED_NEGATIVE_PROMPT)}
              className="text-[11px] text-muted-foreground underline underline-offset-2 transition hover:text-foreground"
            >
              use suggested
            </button>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder={SUGGESTED_NEGATIVE_PROMPT}
            className="w-full rounded border bg-background p-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
