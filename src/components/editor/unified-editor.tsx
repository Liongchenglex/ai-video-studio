/**
 * Unified directing editor (v4.0 Pillar B, mockup 01).
 *
 * One screen that replaces the old Script + Editor steps. It owns the two
 * entry gates (generate script → voice the script) and, once past them,
 * mounts the shared editor store and renders the whole
 * directing surface: a top bar (view toggle, counts, transport, voice,
 * recommend), a static "Cast & Locations" left rail (Reference Bible lands
 * later), a center column (video preview → inline script → Timeline or
 * Storyboard), and the sticky Inspector on the right.
 *
 * The store owns beats/shots; this shell owns the gates and the transport
 * (sequential per-beat playback). The video preview follows the shot under
 * the playhead — the three sync effects are ported from editor-prototype and
 * adapted to the beat/shot model via absoluteShotRange().
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Play,
  Square,
  Sparkles,
  Loader2,
  Mic,
  LayoutList,
  LayoutGrid,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VoiceSelector } from "@/components/voice-selector";
import {
  EditorProvider,
  useEditor,
  absoluteShotRange,
  type EditorBeat,
  type EditorShot,
} from "@/components/editor/editor-store";
import { useBeatPlayback } from "@/components/editor/use-beat-playback";
import { TimelineView } from "@/components/editor/timeline-view";
import { StoryboardView } from "@/components/editor/storyboard-view";
import { ScriptStrip } from "@/components/editor/script-strip";
import { Inspector } from "@/components/editor/inspector";

interface UnifiedEditorProps {
  projectId: string;
  script: string | null;
  voiceId: string;
  initialBeats: EditorBeat[];
  initialShots: EditorShot[];
  onVoiceChange: (voiceId: string) => void;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function UnifiedEditor({
  projectId,
  script: initialScript,
  voiceId,
  initialBeats,
  initialShots,
  onVoiceChange,
}: UnifiedEditorProps) {
  const [script, setScript] = useState(initialScript ?? "");
  // Beats can arrive either from the server (props) or from voicing the
  // script in gate 2; keep a local copy so the editor mounts with the right
  // set once gate 2 completes.
  const [beats, setBeats] = useState<EditorBeat[]>(initialBeats);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [scriptError, setScriptError] = useState(false);

  const hasScript = script.trim().length > 0;

  // ── Gate 1: no script ──
  if (!hasScript) {
    return (
      <GenerateScriptGate
        projectId={projectId}
        generating={generatingScript}
        error={scriptError}
        onGenerate={async () => {
          setScriptError(false);
          setGeneratingScript(true);
          try {
            const res = await fetch(`/api/projects/${projectId}/script/generate`, {
              method: "POST",
            });
            if (res.ok) {
              const data = (await res.json()) as { script: string };
              setScript(data.script);
            } else {
              setScriptError(true);
            }
          } catch {
            setScriptError(true);
          } finally {
            setGeneratingScript(false);
          }
        }}
      />
    );
  }

  // ── Gate 2: script but no beats ──
  if (beats.length === 0) {
    return (
      <VoiceScriptGate
        projectId={projectId}
        voiceId={voiceId}
        onVoiceChange={onVoiceChange}
        onVoiced={setBeats}
      />
    );
  }

  // ── Editor ──
  return (
    <EditorProvider projectId={projectId} initialBeats={beats} initialShots={initialShots}>
      <EditorShell voiceId={voiceId} onVoiceChange={onVoiceChange} />
    </EditorProvider>
  );
}

// ─── Gate 1: generate script ──────────────────────────────────────────

function GenerateScriptGate({
  generating,
  error,
  onGenerate,
}: {
  projectId: string;
  generating: boolean;
  error: boolean;
  onGenerate: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-6 text-center">
        <div>
          <h2 className="text-lg font-semibold">Generate the script</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            The editor writes from your brief and style. Once the script exists you&rsquo;ll voice
            it, then direct every shot on one screen.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button onClick={onGenerate} disabled={generating}>
            {generating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Writing script…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate script
              </>
            )}
          </Button>
          {error && <span className="text-sm text-destructive">Script generation failed. Try again.</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Gate 2: voice the script ─────────────────────────────────────────

function VoiceScriptGate({
  projectId,
  voiceId,
  onVoiceChange,
  onVoiced,
}: {
  projectId: string;
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  onVoiced: (beats: EditorBeat[]) => void;
}) {
  const [voicing, setVoicing] = useState(false);
  const [error, setError] = useState(false);

  const handleVoice = async () => {
    setError(false);
    setVoicing(true);
    try {
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
        <div>
          <h2 className="text-lg font-semibold">Voice the script</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We segment the script into beats and voice each one so you can re-voice a single line
            later without redoing the whole track. This takes ~30–90 seconds.
          </p>
        </div>

        <VoiceSelector selectedVoiceId={voiceId} onSelect={onVoiceChange} disabled={voicing} />

        <div className="flex items-center gap-3">
          <Button onClick={handleVoice} disabled={voicing}>
            {voicing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Voicing the script…
              </>
            ) : (
              <>
                <Mic className="mr-2 h-4 w-4" />
                Voice the script
              </>
            )}
          </Button>
          {error && <span className="text-sm text-destructive">Voicing failed. Try again.</span>}
        </div>
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
  const { beats, shots, view, setView, totalDuration, recommendShots, recommending } = useEditor();
  const { playing, playheadSeconds, play, pause, seek } = useBeatPlayback(beats);

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
    if (!playheadShot?.clipUrl) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      return;
    }
    if (!v.src.endsWith(encodeURI(playheadShot.clipUrl)) && v.src !== playheadShot.clipUrl) {
      v.src = playheadShot.clipUrl;
      v.load();
    }
    const range = absoluteShotRange(playheadShot, beats);
    const localTime = Math.max(0, playheadSeconds - (range?.start ?? 0));
    if (Math.abs(v.currentTime - localTime) > 0.5) v.currentTime = localTime;
    if (playing) v.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadShot?.id, playheadShot?.clipUrl]);

  // Sync the video element when play/pause toggles.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    if (playing && playheadShot?.clipUrl) v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Re-seek the video when the user scrubs while paused.
  useEffect(() => {
    if (playing) return;
    const v = previewVideoRef.current;
    if (!v || !playheadShot?.clipUrl) return;
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
        voiceId={voiceId}
        onVoiceChange={onVoiceChange}
        recommending={recommending}
        onRecommend={recommendShots}
      />

      <div className="flex gap-4">
        <LeftRail />

        {/* Center column */}
        <div className="min-w-0 flex-1 space-y-3">
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
  voiceId,
  onVoiceChange,
  recommending,
  onRecommend,
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
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  recommending: boolean;
  onRecommend: () => void;
}) {
  const [voiceOpen, setVoiceOpen] = useState(false);

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
        {/* Voice picker — collapsed into a popover so the full selector card
            doesn't dominate the bar. */}
        <div className="relative">
          <Button size="sm" variant="outline" onClick={() => setVoiceOpen((o) => !o)}>
            <Mic className="mr-1 h-3.5 w-3.5" /> Voice
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
          {voiceOpen && (
            <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border bg-background p-2 shadow-lg">
              <VoiceSelector
                selectedVoiceId={voiceId}
                onSelect={(id) => {
                  onVoiceChange(id);
                  setVoiceOpen(false);
                }}
              />
            </div>
          )}
        </div>

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
      </div>
    </div>
  );
}

// ─── Left rail (static placeholder — Reference Bible lands in F-16) ────

function LeftRail(): ReactNode {
  return (
    <aside className="hidden w-56 shrink-0 xl:block">
      <div className="sticky top-4 space-y-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Cast &amp; Locations
        </h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Recurring characters &amp; places get reference sheets that keep every shot on-model.
          Arrives with the Reference Bible (F-16).
        </p>
      </div>
    </aside>
  );
}
