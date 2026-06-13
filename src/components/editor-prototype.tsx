/**
 * Timeline editor (PRD v3.0 Iter 1.5).
 *
 * Interactions:
 * - Drag clip body → reposition (PATCH startSeconds/endSeconds on drag-end)
 * - Drag left/right edges → trim (PATCH on drag-end)
 * - Click ruler → seek playhead (clears selection)
 * - Drag playhead → scrub
 * - Click a clip → select shot; side panel shows editable prompts + actions
 * - Click empty clip-track area → select gap; side panel shows create form
 * - Keyboard: S splits selected shot at playhead; Del/Backspace deletes selected
 * - "Play" scrubs VO; the active shot's image/clip shows in the side panel
 */
"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Play,
  Square,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
  Scissors,
  Sparkles,
  Loader2,
  Plus,
  ImageIcon,
  Film,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { deriveVOText } from "@/lib/vo-text";
import type { ShotData } from "@/components/project-workspace";

const PX_PER_SECOND = 14;
const CLIP_TRACK_HEIGHT = 110;
const VO_TRACK_HEIGHT = 56;
const TRIM_HANDLE_WIDTH = 8;

interface Gap {
  startSeconds: number;
  endSeconds: number;
}

interface Props {
  projectId: string;
  script: string;
  voiceoverUrl: string | null;
  durationSeconds: number;
  shots: ShotData[];
}

type Selection =
  | { type: "shot"; shotId: string }
  | { type: "gap"; gap: Gap }
  | null;

export function EditorPrototype({ projectId, script, voiceoverUrl, durationSeconds, shots: propShots }: Props) {
  const totalDuration = Math.max(durationSeconds, 30);
  const timelineWidthPx = Math.max(900, totalDuration * PX_PER_SECOND + 40);

  // Keep local mirror of shots so drag edits feel instant; persist on drag-end.
  const [shots, setShots] = useState<ShotData[]>(propShots);
  useEffect(() => setShots(propShots), [propShots]);

  const timelineRef = useRef<HTMLDivElement | null>(null);

  // ── Playback ──
  const [playing, setPlaying] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const ensureAudio = useCallback((): HTMLAudioElement | null => {
    if (!voiceoverUrl) return null;
    if (!audioRef.current) {
      const a = new Audio(voiceoverUrl);
      a.ontimeupdate = () => setPlayheadSeconds(a.currentTime);
      a.onended = () => setPlaying(false);
      audioRef.current = a;
    }
    return audioRef.current;
  }, [voiceoverUrl]);

  const playFromPlayhead = () => {
    const a = ensureAudio();
    if (!a) return;
    // If we're at the very end, restart from 0; otherwise resume from the playhead.
    const start = playheadSeconds >= totalDuration - 0.1 ? 0 : playheadSeconds;
    a.currentTime = start;
    setPlayheadSeconds(start);
    a.play().catch(() => setPlaying(false));
    setPlaying(true);
  };
  const playFromStart = () => {
    const a = ensureAudio();
    if (!a) return;
    a.currentTime = 0;
    setPlayheadSeconds(0);
    a.play().catch(() => setPlaying(false));
    setPlaying(true);
  };
  const stopPlayback = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };
  const seekTo = (globalSeconds: number) => {
    const clamped = Math.max(0, Math.min(globalSeconds, totalDuration));
    setPlayheadSeconds(clamped);
    const a = ensureAudio();
    if (a) a.currentTime = clamped;
  };
  useEffect(() => () => audioRef.current?.pause(), []);

  // ── Selection ──
  const [selection, setSelection] = useState<Selection>(null);
  const selectedShot = useMemo(
    () => (selection?.type === "shot" ? shots.find((s) => s.id === selection.shotId) ?? null : null),
    [selection, shots],
  );
  const selectedGap = selection?.type === "gap" ? selection.gap : null;

  // Active "shot under the playhead" for preview when nothing is explicitly selected.
  const playheadShot = useMemo(
    () =>
      shots.find(
        (s) => playheadSeconds >= s.startSeconds && playheadSeconds < s.endSeconds,
      ) ?? null,
    [shots, playheadSeconds],
  );
  const activeShot = selectedShot ?? playheadShot;

  // ── Gap detection ──
  const getGapAt = useCallback(
    (seconds: number): Gap | null => {
      if (seconds < 0 || seconds > totalDuration) return null;
      const sorted = [...shots].sort((a, b) => a.startSeconds - b.startSeconds);
      let cursor = 0;
      for (const s of sorted) {
        if (seconds >= cursor && seconds < s.startSeconds) {
          return { startSeconds: cursor, endSeconds: s.startSeconds };
        }
        if (seconds >= s.startSeconds && seconds < s.endSeconds) {
          return null; // inside a shot
        }
        cursor = Math.max(cursor, s.endSeconds);
      }
      if (seconds >= cursor && seconds <= totalDuration) {
        return { startSeconds: cursor, endSeconds: Math.round(totalDuration) };
      }
      return null;
    },
    [shots, totalDuration],
  );

  // ── Drag ──
  type DragMode =
    | { type: "move"; shotId: string; grabOffsetPx: number; startDuration: number }
    | { type: "trim-left"; shotId: string }
    | { type: "trim-right"; shotId: string }
    | { type: "playhead" };

  const [dragging, setDragging] = useState<DragMode | null>(null);

  const xToSeconds = (clientX: number): number => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / PX_PER_SECOND);
  };

  const persistBounds = useCallback(
    async (shotId: string, startSeconds: number, endSeconds: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startSeconds, endSeconds }),
        });
        if (!res.ok) {
          const err = await res.text();
          console.warn("[editor] PATCH bounds rejected:", err);
          setShots(propShots);
        }
        // KNOWN-ISSUE: cached shot.text doesn't refresh in local state after
        // a drag resize — only reflects the new bounds' VO on next page load.
        // Fixing this caused unrelated drag flicker; revisit in a later pass.
      } catch (err) {
        console.error("[editor] PATCH bounds failed:", err);
        setShots(propShots);
      }
    },
    [projectId, propShots],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const mouseSeconds = xToSeconds(e.clientX);
      if (dragging.type === "move") {
        if (!timelineRef.current) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const xWithinTimeline = e.clientX - rect.left - dragging.grabOffsetPx;
        const newStart = Math.max(0, Math.round(xWithinTimeline / PX_PER_SECOND));
        setShots((prev) =>
          prev.map((s) =>
            s.id === dragging.shotId
              ? { ...s, startSeconds: newStart, endSeconds: newStart + dragging.startDuration }
              : s,
          ),
        );
      } else if (dragging.type === "trim-left") {
        setShots((prev) =>
          prev.map((s) => {
            if (s.id !== dragging.shotId) return s;
            const newStart = Math.max(0, Math.min(Math.round(mouseSeconds), s.endSeconds - 1));
            return { ...s, startSeconds: newStart };
          }),
        );
      } else if (dragging.type === "trim-right") {
        setShots((prev) =>
          prev.map((s) => {
            if (s.id !== dragging.shotId) return s;
            const newEnd = Math.max(s.startSeconds + 1, Math.round(mouseSeconds));
            return { ...s, endSeconds: newEnd };
          }),
        );
      } else if (dragging.type === "playhead") {
        seekTo(mouseSeconds);
      }
    };
    const onUp = () => {
      // Persist on drag-end for any bounds-changing drag.
      if (dragging.type === "move" || dragging.type === "trim-left" || dragging.type === "trim-right") {
        const current = shots.find((s) => s.id === dragging.shotId);
        if (current) persistBounds(dragging.shotId, current.startSeconds, current.endSeconds);
      }
      setDragging(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, shots]);

  const startMove = (e: React.MouseEvent<HTMLDivElement>, shot: ShotData) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clipStartPx = shot.startSeconds * PX_PER_SECOND;
    const grabOffsetPx = e.clientX - rect.left - clipStartPx;
    setSelection({ type: "shot", shotId: shot.id });
    setDragging({
      type: "move",
      shotId: shot.id,
      grabOffsetPx,
      startDuration: shot.endSeconds - shot.startSeconds,
    });
  };

  const startTrimLeft = (e: React.MouseEvent<HTMLDivElement>, shotId: string) => {
    e.stopPropagation();
    setSelection({ type: "shot", shotId });
    setDragging({ type: "trim-left", shotId });
  };
  const startTrimRight = (e: React.MouseEvent<HTMLDivElement>, shotId: string) => {
    e.stopPropagation();
    setSelection({ type: "shot", shotId });
    setDragging({ type: "trim-right", shotId });
  };
  const startPlayheadDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    seekTo(xToSeconds(e.clientX));
    setDragging({ type: "playhead" });
  };

  // Click on empty clip track area → select gap
  const handleClipTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only fire when the user clicked the track itself (not a shot block)
    if (e.target !== e.currentTarget) return;
    const seconds = xToSeconds(e.clientX);
    const gap = getGapAt(seconds);
    if (gap && gap.endSeconds - gap.startSeconds >= 1) {
      setSelection({ type: "gap", gap });
    }
  };

  // ── Mutations via API ──
  const [busy, setBusy] = useState(false);

  const deleteShot = useCallback(
    async (shotId: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setShots((prev) => prev.filter((s) => s.id !== shotId));
          setSelection(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const splitShot = useCallback(
    async (shotId: string, atSeconds: number) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/split`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ atSeconds: Math.round(atSeconds) }),
        });
        if (res.ok) {
          const { left, right } = (await res.json()) as { left: ShotData; right: ShotData };
          setShots((prev) => {
            const original = prev.find((s) => s.id === shotId);
            const without = prev.filter((s) => s.id !== shotId);
            // Preserve the original's presigned URLs on the LEFT half — the
            // R2 asset didn't move, only the shot bounds narrowed.
            const mergedLeft: ShotData = original
              ? { ...original, ...left, imageUrl: original.imageUrl, clipUrl: original.clipUrl }
              : left;
            return [...without, mergedLeft, right].sort((a, b) => a.startSeconds - b.startSeconds);
          });
          setSelection({ type: "shot", shotId: right.id });
        } else {
          const err = await res.text();
          console.warn("[editor] split rejected:", err);
        }
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const createShot = useCallback(
    async (gap: Gap, imagePrompt: string, motionPrompt?: string): Promise<ShotData | null> => {
      setBusy(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/shots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startSeconds: gap.startSeconds,
            endSeconds: gap.endSeconds,
            imagePrompt,
            motionPrompt,
          }),
        });
        if (!res.ok) {
          console.warn("[editor] create shot failed:", await res.text());
          return null;
        }
        const shot = (await res.json()) as ShotData;
        setShots((prev) => [...prev, shot].sort((a, b) => a.startSeconds - b.startSeconds));
        setSelection({ type: "shot", shotId: shot.id });
        return shot;
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const updatePrompts = useCallback(
    async (shotId: string, imagePrompt: string, motionPrompt: string) => {
      const res = await fetch(`/api/projects/${projectId}/shots/${shotId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagePrompt, motionPrompt }),
      });
      if (res.ok) {
        const updated = (await res.json()) as ShotData;
        // Spread-merge so client-only fields (imageUrl, clipUrl) survive —
        // the PATCH response only contains raw DB fields.
        setShots((prev) =>
          prev.map((s) => (s.id === shotId ? { ...s, ...updated } : s)),
        );
      }
    },
    [projectId],
  );

  const generateShotImage = useCallback(
    async (shotId: string) => {
      setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, imageStatus: "generating" } : s)));
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/image`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor] image generation failed:", await res.text());
          setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, imageStatus: "failed" } : s)));
          return;
        }
        const data = (await res.json()) as {
          imagePath: string;
          imageUrl: string;
          imageStatus: string;
        };
        setShots((prev) =>
          prev.map((s) =>
            s.id === shotId
              ? { ...s, imagePath: data.imagePath, imageUrl: data.imageUrl, imageStatus: "done" }
              : s,
          ),
        );
      } catch (err) {
        console.error("[editor] image generation error:", err);
        setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, imageStatus: "failed" } : s)));
      }
    },
    [projectId],
  );

  const generateShotClip = useCallback(
    async (shotId: string, model: "ltx" | "hailuo" = "ltx") => {
      const endpoint = model === "hailuo" ? "clip-hailuo" : "clip";
      setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, clipStatus: "generating" } : s)));
      try {
        const res = await fetch(`/api/projects/${projectId}/shots/${shotId}/${endpoint}`, {
          method: "POST",
        });
        if (!res.ok) {
          console.warn("[editor] clip generation failed:", await res.text());
          setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, clipStatus: "failed" } : s)));
          return;
        }
        const data = (await res.json()) as {
          clipPath: string;
          clipUrl: string;
          clipStatus: string;
          clipDurationSeconds: number;
        };
        setShots((prev) =>
          prev.map((s) =>
            s.id === shotId
              ? {
                  ...s,
                  clipPath: data.clipPath,
                  clipUrl: data.clipUrl,
                  clipStatus: "done",
                  clipDurationSeconds: data.clipDurationSeconds,
                }
              : s,
          ),
        );
      } catch (err) {
        console.error("[editor] clip generation error:", err);
        setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, clipStatus: "failed" } : s)));
      }
    },
    [projectId],
  );

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedShot) {
          e.preventDefault();
          deleteShot(selectedShot.id);
        }
      } else if (e.key === "s" || e.key === "S") {
        if (
          selectedShot &&
          playheadSeconds > selectedShot.startSeconds + 1 &&
          playheadSeconds < selectedShot.endSeconds - 1
        ) {
          e.preventDefault();
          splitShot(selectedShot.id, playheadSeconds);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedShot, playheadSeconds, deleteShot, splitShot]);

  // ── Side panel ──
  const [panelOpen, setPanelOpen] = useState(true);

  // ── Main preview sync ──
  // A full-size video player that plays the shot-under-playhead's clip in sync
  // with the scrubbing VO. Uses `playheadShot` (not selection) so the preview
  // always reflects what's playing, even when the user has clicked a different
  // shot to edit its prompts.
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  // When the shot under the playhead changes, swap to its clip.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;

    if (!playheadShot?.clipUrl) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      return;
    }

    // Only swap source when shot changes, otherwise let the video run naturally.
    if (!v.src.endsWith(encodeURI(playheadShot.clipUrl)) && v.src !== playheadShot.clipUrl) {
      v.src = playheadShot.clipUrl;
      v.load();
    }

    const localTime = Math.max(0, playheadSeconds - playheadShot.startSeconds);
    if (Math.abs(v.currentTime - localTime) > 0.5) {
      v.currentTime = localTime;
    }
    if (playing) {
      v.play().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadShot?.id, playheadShot?.clipUrl]);

  // When play/pause toggles, sync the video.
  useEffect(() => {
    const v = previewVideoRef.current;
    if (!v) return;
    if (playing && playheadShot?.clipUrl) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // When user seeks while paused, re-seek the video too.
  useEffect(() => {
    if (playing) return;
    const v = previewVideoRef.current;
    if (!v || !playheadShot?.clipUrl) return;
    const localTime = Math.max(0, playheadSeconds - playheadShot.startSeconds);
    if (Math.abs(v.currentTime - localTime) > 0.2) {
      v.currentTime = localTime;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadSeconds]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Timeline</h2>
          <p className="text-sm text-muted-foreground">
            Drag shots to reposition. Trim edges. Click gaps to create. Select a shot: S to split, Del to delete.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{totalDuration}s total</Badge>
          <Badge variant="outline">{shots.length} shots</Badge>
          {!playing && (
            <Button
              variant="outline"
              onClick={playFromStart}
              disabled={!voiceoverUrl}
              title="Play from 0:00"
            >
              <Play className="mr-2 h-4 w-4" /> Start
            </Button>
          )}
          <Button onClick={playing ? stopPlayback : playFromPlayhead} disabled={!voiceoverUrl}>
            {playing ? (
              <>
                <Square className="mr-2 h-4 w-4" /> Stop
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" /> Play
              </>
            )}
          </Button>
          {!panelOpen && (
            <Button variant="outline" size="icon" onClick={() => setPanelOpen(true)} title="Show panel">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Main video preview — plays the active shot's clip synced to VO */}
      <Card>
        <CardContent className="p-3">
          <div className="relative mx-auto bg-black rounded overflow-hidden aspect-video" style={{ maxHeight: "50vh" }}>
            <video
              ref={previewVideoRef}
              muted
              playsInline
              className="w-full h-full object-contain"
            />
            {!playheadShot?.clipUrl && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60 z-10">
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
              <img
                src={playheadShot.imageUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-contain opacity-80"
              />
            )}
          </div>
        </CardContent>
      </Card>

      <div className={`grid gap-4 ${panelOpen ? "md:grid-cols-[minmax(0,2fr)_22rem]" : "md:grid-cols-1"}`}>
        <Card>
          <CardContent className="p-3">
            <div className="overflow-x-auto">
              <div
                ref={timelineRef}
                className="relative select-none"
                style={{ width: timelineWidthPx, userSelect: "none" }}
              >
                {/* Time ruler — click to seek, clears selection */}
                <div
                  className="relative h-5 border-b cursor-pointer"
                  onClick={(e) => {
                    setSelection(null);
                    seekTo(xToSeconds(e.clientX));
                  }}
                >
                  {Array.from({ length: Math.ceil(totalDuration / 5) + 1 }).map((_, i) => (
                    <div
                      key={i}
                      className="absolute top-0 text-[10px] text-muted-foreground border-l border-border/60 pl-1 h-full pointer-events-none"
                      style={{ left: i * 5 * PX_PER_SECOND }}
                    >
                      {i * 5}s
                    </div>
                  ))}
                </div>

                {/* Clip track — click empty area to select gap */}
                <div
                  className="relative border-b bg-muted/20"
                  style={{ height: CLIP_TRACK_HEIGHT }}
                  onClick={handleClipTrackClick}
                >
                  {shots.map((shot) => {
                    const isSelected =
                      selection?.type === "shot" && selection.shotId === shot.id;
                    const isActive = activeShot?.id === shot.id;
                    const leftPx = shot.startSeconds * PX_PER_SECOND;
                    const widthPx = Math.max(40, (shot.endSeconds - shot.startSeconds) * PX_PER_SECOND);
                    return (
                      <div
                        key={shot.id}
                        onMouseDown={(e) => startMove(e, shot)}
                        className={`absolute top-2 rounded overflow-hidden cursor-grab active:cursor-grabbing ring-2 transition-all ${
                          isSelected
                            ? "ring-primary shadow-lg z-10"
                            : isActive
                              ? "ring-yellow-400 shadow-md"
                              : "ring-transparent"
                        }`}
                        style={{
                          left: leftPx,
                          width: widthPx,
                          height: CLIP_TRACK_HEIGHT - 16,
                        }}
                        title={shot.text ?? ""}
                      >
                        {shot.imageUrl ? (
                          <img
                            src={shot.imageUrl}
                            alt=""
                            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                          />
                        ) : (
                          <div className="absolute inset-0 bg-muted" />
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 pointer-events-none">
                          <span className="text-[10px] text-white font-mono">
                            {shot.endSeconds - shot.startSeconds}s
                          </span>
                        </div>
                        {/* Trim handles */}
                        <div
                          onMouseDown={(e) => startTrimLeft(e, shot.id)}
                          className="absolute left-0 top-0 bottom-0 cursor-ew-resize bg-white/30 hover:bg-white/60"
                          style={{ width: TRIM_HANDLE_WIDTH }}
                          title="Drag to trim start"
                        />
                        <div
                          onMouseDown={(e) => startTrimRight(e, shot.id)}
                          className="absolute right-0 top-0 bottom-0 cursor-ew-resize bg-white/30 hover:bg-white/60"
                          style={{ width: TRIM_HANDLE_WIDTH }}
                          title="Drag to trim end"
                        />
                      </div>
                    );
                  })}

                  {/* Gap-selection highlight */}
                  {selectedGap && (
                    <div
                      className="absolute top-2 rounded border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
                      style={{
                        left: selectedGap.startSeconds * PX_PER_SECOND,
                        width: (selectedGap.endSeconds - selectedGap.startSeconds) * PX_PER_SECOND,
                        height: CLIP_TRACK_HEIGHT - 16,
                      }}
                    />
                  )}
                </div>

                {/* VO track */}
                <div className="relative bg-muted/10" style={{ height: VO_TRACK_HEIGHT }}>
                  <div
                    className="absolute top-2 rounded bg-blue-500/20 border border-blue-500/60 flex items-center px-2"
                    style={{
                      left: 0,
                      width: totalDuration * PX_PER_SECOND,
                      height: VO_TRACK_HEIGHT - 16,
                    }}
                  >
                    <span className="text-xs font-mono truncate">Voiceover · {totalDuration}s</span>
                  </div>
                </div>

                {/* Playhead */}
                <div
                  onMouseDown={startPlayheadDrag}
                  className="absolute top-0 cursor-ew-resize"
                  style={{
                    left: playheadSeconds * PX_PER_SECOND - 4,
                    width: 8,
                    height: 20 + CLIP_TRACK_HEIGHT + VO_TRACK_HEIGHT,
                  }}
                >
                  <div className="absolute left-1/2 top-0 -translate-x-1/2 w-0.5 h-full bg-red-500" />
                  <div className="absolute left-1/2 top-0 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-sm" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {panelOpen && (
          <Card className="md:sticky md:top-4 md:self-start md:max-h-[calc(100vh-2rem)] md:overflow-y-auto">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  {selectedGap ? "New shot" : selectedShot ? "Shot details" : "Preview"}
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setPanelOpen(false)}
                  title="Hide panel"
                >
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>

              {selectedGap ? (
                <GapCreateForm
                  projectId={projectId}
                  gap={selectedGap}
                  voText={deriveVOText(
                    script,
                    totalDuration,
                    selectedGap.startSeconds,
                    selectedGap.endSeconds,
                  )}
                  onCreate={createShot}
                  busy={busy}
                  onCancel={() => setSelection(null)}
                />
              ) : selectedShot ? (
                <ShotEditPanel
                  key={selectedShot.id}
                  projectId={projectId}
                  shot={selectedShot}
                  playheadSeconds={playheadSeconds}
                  onUpdatePrompts={updatePrompts}
                  onSplit={(at) => splitShot(selectedShot.id, at)}
                  onDelete={() => deleteShot(selectedShot.id)}
                  onGenerateImage={() => generateShotImage(selectedShot.id)}
                  onGenerateClip={() => generateShotClip(selectedShot.id, "ltx")}
                  onGenerateClipHailuo={() => generateShotClip(selectedShot.id, "hailuo")}
                  busy={busy}
                />
              ) : activeShot ? (
                <ActiveShotPreview shot={activeShot} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No shot at the playhead. Click a shot to select, or click empty timeline to insert.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function ActiveShotPreview({ shot }: { shot: ShotData }) {
  return (
    <>
      {shot.clipUrl ? (
        <video key={shot.id} src={shot.clipUrl} autoPlay muted loop className="w-full rounded" />
      ) : shot.imageUrl ? (
        <img src={shot.imageUrl} alt="" className="w-full rounded" />
      ) : (
        <div className="w-full aspect-video rounded bg-muted flex items-center justify-center">
          <span className="text-xs text-muted-foreground">No image yet</span>
        </div>
      )}
      <div className="flex gap-2 text-[10px] text-muted-foreground flex-wrap">
        <Badge variant="outline">
          {shot.endSeconds - shot.startSeconds}s • {shot.startSeconds}→{shot.endSeconds}s
        </Badge>
      </div>
      {shot.text && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">VO</p>
          <p className="text-xs font-mono">{shot.text}</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Image prompt</p>
        <p className="text-xs">{shot.imagePrompt}</p>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Motion prompt</p>
        <p className="text-xs">{shot.motionPrompt}</p>
      </div>
    </>
  );
}

function ShotEditPanel({
  projectId,
  shot,
  playheadSeconds,
  onUpdatePrompts,
  onSplit,
  onDelete,
  onGenerateImage,
  onGenerateClip,
  onGenerateClipHailuo,
  busy,
}: {
  projectId: string;
  shot: ShotData;
  playheadSeconds: number;
  onUpdatePrompts: (shotId: string, imagePrompt: string, motionPrompt: string) => Promise<void>;
  onSplit: (atSeconds: number) => void;
  onDelete: () => void;
  onGenerateImage: () => void;
  onGenerateClip: () => void;
  onGenerateClipHailuo: () => void;
  busy: boolean;
}) {
  const [imagePrompt, setImagePrompt] = useState(shot.imagePrompt);
  const [motionPrompt, setMotionPrompt] = useState(shot.motionPrompt);
  const [suggestingImage, setSuggestingImage] = useState(false);
  const [suggestingMotion, setSuggestingMotion] = useState(false);

  // Which asset the side panel preview shows. Auto-switches to whichever
  // the user just regenerated, so regen results are always visible.
  const [previewMode, setPreviewMode] = useState<"image" | "clip">(
    shot.clipUrl ? "clip" : "image",
  );

  useEffect(() => {
    setImagePrompt(shot.imagePrompt);
    setMotionPrompt(shot.motionPrompt);
  }, [shot.id, shot.imagePrompt, shot.motionPrompt]);

  // Flip to the image preview when an image URL updates (regen happened).
  // useRef the previous URL so we only react to actual changes.
  const prevImageUrl = useRef(shot.imageUrl);
  const prevClipUrl = useRef(shot.clipUrl);
  useEffect(() => {
    if (shot.imageUrl && shot.imageUrl !== prevImageUrl.current) {
      setPreviewMode("image");
    }
    prevImageUrl.current = shot.imageUrl;
  }, [shot.imageUrl]);
  useEffect(() => {
    if (shot.clipUrl && shot.clipUrl !== prevClipUrl.current) {
      setPreviewMode("clip");
    }
    prevClipUrl.current = shot.clipUrl;
  }, [shot.clipUrl]);

  const persistIfChanged = () => {
    if (imagePrompt !== shot.imagePrompt || motionPrompt !== shot.motionPrompt) {
      onUpdatePrompts(shot.id, imagePrompt, motionPrompt);
    }
  };

  const canSplit =
    playheadSeconds > shot.startSeconds + 1 && playheadSeconds < shot.endSeconds - 1;

  const aiSuggestImage = async () => {
    if (!shot.text) return;
    setSuggestingImage(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText: shot.text }),
      });
      if (res.ok) {
        const data = (await res.json()) as { imagePrompt: string };
        setImagePrompt(data.imagePrompt);
        await onUpdatePrompts(shot.id, data.imagePrompt, motionPrompt);
      }
    } finally {
      setSuggestingImage(false);
    }
  };

  const aiSuggestMotion = async () => {
    if (!shot.text || !imagePrompt.trim()) return;
    setSuggestingMotion(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shots/suggest-motion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voText: shot.text, imagePrompt }),
      });
      if (res.ok) {
        const data = (await res.json()) as { motionPrompt: string };
        setMotionPrompt(data.motionPrompt);
        await onUpdatePrompts(shot.id, imagePrompt, data.motionPrompt);
      }
    } finally {
      setSuggestingMotion(false);
    }
  };

  const hasImage = !!shot.imageUrl;
  const hasClip = !!shot.clipUrl;
  const effectiveMode = previewMode === "clip" && !hasClip ? "image" : previewMode;

  return (
    <>
      {(hasImage || hasClip) && (
        <div className="flex gap-1 text-[10px]">
          <button
            type="button"
            onClick={() => setPreviewMode("image")}
            disabled={!hasImage}
            className={`flex-1 px-2 py-1 rounded transition ${
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
            className={`flex-1 px-2 py-1 rounded transition ${
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
        <img key={shot.imageUrl} src={shot.imageUrl} alt="" className="w-full rounded" />
      ) : (
        <div className="w-full aspect-video rounded bg-muted flex items-center justify-center">
          <span className="text-xs text-muted-foreground">No image yet</span>
        </div>
      )}

      <div className="flex gap-2 text-[10px] text-muted-foreground flex-wrap">
        <Badge variant="outline">
          {shot.endSeconds - shot.startSeconds}s • {shot.startSeconds}→{shot.endSeconds}s
        </Badge>
      </div>

      {shot.text && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">VO</p>
          <p className="text-xs font-mono">{shot.text}</p>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Image prompt</p>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={aiSuggestImage} disabled={suggestingImage || !shot.text}>
            {suggestingImage ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Motion prompt</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestMotion}
            disabled={suggestingMotion || !shot.text || !imagePrompt.trim()}
            title={!imagePrompt.trim() ? "Write an image prompt first — motion suggestions need it" : "AI suggest motion"}
          >
            {suggestingMotion ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
          onClick={onGenerateImage}
          disabled={shot.imageStatus === "generating" || busy}
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
          onClick={onGenerateClip}
          disabled={!shot.imagePath || shot.clipStatus === "generating" || busy}
          title={!shot.imagePath ? "Generate image first" : shot.clipPath ? "Regenerate clip (LTX-2.3)" : "Generate clip (LTX-2.3)"}
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
          onClick={onGenerateClipHailuo}
          disabled={!shot.imagePath || shot.clipStatus === "generating" || busy}
          title={!shot.imagePath ? "Generate image first" : "A/B test: generate with Hailuo 02 instead of LTX (overwrites current clip)"}
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
          onClick={() => onSplit(playheadSeconds)}
          disabled={!canSplit || busy}
          title={canSplit ? "Split shot at playhead" : "Move the playhead inside the shot to split"}
        >
          <Scissors className="mr-1 h-3 w-3" />
          Split {canSplit ? `(${Math.round(playheadSeconds)}s)` : ""}
        </Button>
        <Button size="sm" variant="destructive" onClick={onDelete} disabled={busy}>
          <Trash2 className="mr-1 h-3 w-3" />
          Delete
        </Button>
      </div>
    </>
  );
}

function GapCreateForm({
  projectId,
  gap,
  voText,
  onCreate,
  onCancel,
  busy,
}: {
  projectId: string;
  gap: Gap;
  voText: string;
  onCreate: (gap: Gap, imagePrompt: string, motionPrompt?: string) => Promise<ShotData | null>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [imagePrompt, setImagePrompt] = useState("");
  const [motionPrompt, setMotionPrompt] = useState("");
  const [suggestingImage, setSuggestingImage] = useState(false);
  const [suggestingMotion, setSuggestingMotion] = useState(false);

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
    await onCreate(gap, imagePrompt.trim(), motionPrompt.trim() || undefined);
  };

  return (
    <>
      <div className="flex gap-2 text-[10px] text-muted-foreground flex-wrap">
        <Badge variant="outline">
          {gap.endSeconds - gap.startSeconds}s • {gap.startSeconds}→{gap.endSeconds}s
        </Badge>
      </div>

      {voText && (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">VO here</p>
          <p className="text-xs font-mono">{voText}</p>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Image prompt</p>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={aiSuggestImage} disabled={suggestingImage || !voText.trim()}>
            {suggestingImage ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Motion prompt (optional)</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={aiSuggestMotion}
            disabled={suggestingMotion || !voText.trim() || !imagePrompt.trim()}
            title={!imagePrompt.trim() ? "Write or suggest an image prompt first" : "AI suggest motion"}
          >
            {suggestingMotion ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
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
        <Button size="sm" onClick={handleCreate} disabled={!imagePrompt.trim() || busy} className="flex-1">
          <Plus className="mr-1 h-3 w-3" />
          Create shot
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </>
  );
}
