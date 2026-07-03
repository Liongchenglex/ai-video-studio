/**
 * Two-layer timeline view (v4.0 Pillar B, mockup 01).
 *
 * Renders one horizontal timeline with four stacked bands sharing a single
 * pixel coordinate system (1s = PX_PER_SECOND px):
 *   - Ruler   — 5s ticks; click to seek.
 *   - BEATS   — one colored block per beat (the audio segments).
 *   - SHOTS   — draggable/trimmable shot blocks; anchored to the beat that
 *               contains their start but free to span into following beats
 *               (anchor-beat spillover).
 *   - VOICE   — one slim blue bar per beat so audio start/stop is visible.
 * A red playhead spans every band.
 *
 * All persistent state comes from `useEditor()`; this component owns only
 * transient drag-interaction state. Shot drags are optimistic (a local
 * absolute-seconds range) and persisted on drag-end as anchor + offsets via
 * `updateShot` — a drag that moves the start into a different beat
 * re-anchors the shot. Movement and trimming are clamped against the
 * neighboring shots and the timeline ends (absolute space) so the server
 * never bounces the drag.
 *
 * Ported from `editor-prototype.tsx` (PX_PER_SECOND, xToSeconds, the ruler,
 * the window-level mousemove/mouseup drag effect, playhead drag, and the
 * S/Del keyboard handler), adapted to the beat/shot two-layer model.
 */
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import {
  useEditor,
  beatColor,
  absoluteShotRange,
  type EditorBeat,
  type EditorShot,
} from "@/components/editor/editor-store";

const PX_PER_SECOND = 14;
const RULER_HEIGHT = 20;
const BEATS_HEIGHT = 40;
const SHOTS_HEIGHT = 110;
const VOICE_HEIGHT = 40;
const TOTAL_HEIGHT = RULER_HEIGHT + BEATS_HEIGHT + SHOTS_HEIGHT + VOICE_HEIGHT;
const TRIM_HANDLE_WIDTH = 8;
const MIN_SHOT_LENGTH = 0.25; // seconds — server MIN clamp
const MIN_HALF = 0.25; // seconds — each side of a split (server MIN_HALF_SECONDS)
const LABEL_GUTTER_PX = 64;

// Absolute-seconds range used while a shot is being dragged (optimistic);
// converted to anchor + offsets when persisted on drag-end.
interface DragRange {
  shotId: string;
  start: number;
  end: number;
}

type DragMode =
  | { type: "move"; shotId: string; grabOffsetSec: number }
  | { type: "trim-left"; shotId: string }
  | { type: "trim-right"; shotId: string }
  | { type: "playhead" };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function TimelineView({
  playheadSeconds,
  onSeek,
}: {
  playheadSeconds: number;
  onSeek: (s: number) => void;
}) {
  const { beats, shots, selection, select, updateShot, deleteShot, splitShot, totalDuration } =
    useEditor();

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineWidthPx = Math.max(900, totalDuration * PX_PER_SECOND + 40);

  const [drag, setDrag] = useState<DragMode | null>(null);
  const [dragRange, setDragRange] = useState<DragRange | null>(null);
  const dragAbsRef = useRef<DragRange | null>(null);

  // ── Pixel ⇄ seconds ──
  const xToSeconds = useCallback((clientX: number): number => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / PX_PER_SECOND);
  }, []);

  // The anchor beat for a timeline position: the beat containing it, with
  // the very end of the timeline resolving to the last beat.
  const anchorAt = useCallback(
    (seconds: number): EditorBeat | null => {
      const hit = beats.find((b) => seconds >= b.startSeconds && seconds < b.endSeconds);
      if (hit) return hit;
      const last = beats[beats.length - 1];
      return last && seconds >= last.endSeconds - 1e-6 ? last : null;
    },
    [beats],
  );

  // Free interval [lower, upper] (absolute seconds) around the shot's
  // persisted range, bounded by its neighboring shots and the timeline ends
  // so drags never overlap — shots may span beats.
  const freeBounds = useCallback(
    (shot: EditorShot) => {
      const orig = absoluteShotRange(shot, beats);
      if (!orig) return null;
      let lower = 0;
      let upper = totalDuration;
      for (const s of shots) {
        if (s.id === shot.id) continue;
        const r = absoluteShotRange(s, beats);
        if (!r) continue;
        if (r.end <= orig.start) lower = Math.max(lower, r.end);
        else if (r.start >= orig.end) upper = Math.min(upper, r.start);
      }
      return { origStart: orig.start, origEnd: orig.end, lower, upper };
    },
    [shots, beats, totalDuration],
  );

  // ── Window-level drag (mousemove/mouseup) ──
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const mouseSec = xToSeconds(e.clientX);
      if (drag.type === "playhead") {
        onSeek(mouseSec);
        return;
      }
      const shot = shots.find((s) => s.id === drag.shotId);
      const bounds = shot ? freeBounds(shot) : null;
      if (!shot || !bounds) return;
      const { origStart, origEnd, lower, upper } = bounds;

      let start = origStart;
      let end = origEnd;
      if (drag.type === "move") {
        const len = origEnd - origStart;
        start = clamp(mouseSec - drag.grabOffsetSec, lower, Math.max(lower, upper - len));
        end = start + len;
      } else if (drag.type === "trim-left") {
        start = clamp(mouseSec, lower, origEnd - MIN_SHOT_LENGTH);
      } else {
        end = clamp(mouseSec, origStart + MIN_SHOT_LENGTH, upper);
      }

      dragAbsRef.current = { shotId: shot.id, start, end };
      setDragRange({ shotId: shot.id, start, end });
    };

    const onUp = () => {
      if (drag.type !== "playhead") {
        const abs = dragAbsRef.current;
        const anchor = abs ? anchorAt(abs.start) : null;
        if (abs && abs.shotId === drag.shotId && anchor) {
          // Persist as anchor + offsets; the anchor may differ from the
          // shot's previous beat when the start crossed a boundary.
          updateShot(abs.shotId, {
            beatId: anchor.id,
            startInBeat: abs.start - anchor.startSeconds,
            endInBeat: abs.end - anchor.startSeconds,
          });
        }
      }
      setDrag(null);
      setDragRange(null);
      dragAbsRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, shots, xToSeconds, onSeek, anchorAt, freeBounds, updateShot]);

  // ── Drag starts ──
  const startMove = (e: React.MouseEvent, shot: EditorShot) => {
    const range = absoluteShotRange(shot, beats);
    if (!range) return;
    select({ type: "shot", shotId: shot.id });
    setDrag({ type: "move", shotId: shot.id, grabOffsetSec: xToSeconds(e.clientX) - range.start });
  };
  const startTrimLeft = (e: React.MouseEvent, shotId: string) => {
    e.stopPropagation();
    select({ type: "shot", shotId });
    setDrag({ type: "trim-left", shotId });
  };
  const startTrimRight = (e: React.MouseEvent, shotId: string) => {
    e.stopPropagation();
    select({ type: "shot", shotId });
    setDrag({ type: "trim-right", shotId });
  };
  const startPlayheadDrag = (e: React.MouseEvent) => {
    onSeek(xToSeconds(e.clientX));
    setDrag({ type: "playhead" });
  };

  // ── Empty shots-row click → select the free gap under the cursor ──
  // Gaps are continuous across beat boundaries: previous shot end → next
  // shot start (absolute), anchored to the beat containing the gap's start.
  const handleShotsRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // ignore clicks on shot blocks
    const clickSec = xToSeconds(e.clientX);
    if (clickSec >= totalDuration) return;
    let lower = 0;
    let upper = totalDuration;
    for (const s of shots) {
      const r = absoluteShotRange(s, beats);
      if (!r) continue;
      if (clickSec >= r.start && clickSec < r.end) return; // inside a shot
      if (r.end <= clickSec) lower = Math.max(lower, r.end);
      else if (r.start >= clickSec) upper = Math.min(upper, r.start);
    }
    if (upper - lower < MIN_SHOT_LENGTH) return;
    const anchor = anchorAt(lower);
    if (!anchor) return;
    select({
      type: "gap",
      beatId: anchor.id,
      startInBeat: lower - anchor.startSeconds,
      endInBeat: upper - anchor.startSeconds,
    });
  };

  // ── Keyboard: S splits at playhead, Del deletes ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return; // don't hijack Cmd/Ctrl+S (browser save) etc.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (selection?.type !== "shot") return;
      const shot = shots.find((s) => s.id === selection.shotId);
      if (!shot) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteShot(shot.id);
        return;
      }
      if (e.key === "s" || e.key === "S") {
        const anchor = shot.beatId ? beats.find((b) => b.id === shot.beatId) : null;
        const range = absoluteShotRange(shot, beats);
        if (!anchor || !range) return;
        if (playheadSeconds > range.start + MIN_HALF && playheadSeconds < range.end - MIN_HALF) {
          e.preventDefault();
          // atInBeat is relative to the ANCHOR — it may exceed the anchor's
          // duration when the split point lies in a spanned beat.
          splitShot(shot.id, playheadSeconds - anchor.startSeconds);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, shots, beats, playheadSeconds, deleteShot, splitShot]);

  const rowLabel = (text: string) => (
    <div
      className="flex items-center justify-end pr-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      style={{ height: text === "SHOTS" ? SHOTS_HEIGHT : text === "RULER" ? RULER_HEIGHT : BEATS_HEIGHT }}
    >
      {text === "RULER" ? "" : text}
    </div>
  );

  return (
    <div className="flex select-none" style={{ userSelect: "none" }}>
      {/* Fixed label gutter — does not scroll, keeps the timeline coord system clean */}
      <div className="shrink-0" style={{ width: LABEL_GUTTER_PX }}>
        {rowLabel("RULER")}
        {rowLabel("BEATS")}
        {rowLabel("SHOTS")}
        {rowLabel("VOICE")}
      </div>

      <div className="flex-1 overflow-x-auto">
        <div
          ref={timelineRef}
          className="relative"
          style={{ width: timelineWidthPx, height: TOTAL_HEIGHT }}
        >
          {/* Ruler — click to seek */}
          <div
            className="relative border-b cursor-pointer"
            style={{ height: RULER_HEIGHT }}
            onClick={(e) => {
              select(null);
              onSeek(xToSeconds(e.clientX));
            }}
          >
            {Array.from({ length: Math.ceil(totalDuration / 5) + 1 }).map((_, i) => (
              <div
                key={i}
                className="absolute top-0 h-full border-l border-border/60 pl-1 text-[10px] text-muted-foreground pointer-events-none"
                style={{ left: i * 5 * PX_PER_SECOND }}
              >
                {i * 5}s
              </div>
            ))}
          </div>

          {/* BEATS row */}
          <div className="relative border-b bg-muted/10" style={{ height: BEATS_HEIGHT }}>
            {beats.map((beat, index) => {
              const isSelected = selection?.type === "beat" && selection.beatId === beat.id;
              const color = beatColor(index);
              const label = `Beat ${beat.sortOrder + 1} · ${beat.text.split(/\s+/).slice(0, 4).join(" ")}`;
              return (
                <div
                  key={beat.id}
                  onClick={() => select({ type: "beat", beatId: beat.id })}
                  title={beat.text}
                  className={`absolute top-1 flex items-center overflow-hidden rounded px-2 cursor-pointer transition ${
                    isSelected ? "ring-2 ring-primary" : "ring-1 ring-black/20"
                  } ${beat.voStatus === "failed" ? "border-l-4 border-red-500" : ""}`}
                  style={{
                    left: beat.startSeconds * PX_PER_SECOND,
                    width: Math.max(20, (beat.endSeconds - beat.startSeconds) * PX_PER_SECOND),
                    height: BEATS_HEIGHT - 8,
                    background: color.block,
                  }}
                >
                  <span className="truncate text-[11px] font-medium text-white">{label}</span>
                  {beat.voStatus === "generating" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* SHOTS row — click empty space to select a gap */}
          <div
            className="relative border-b bg-muted/20"
            style={{ height: SHOTS_HEIGHT }}
            onClick={handleShotsRowClick}
          >
            {shots.map((shot) => {
              const range =
                dragRange && dragRange.shotId === shot.id
                  ? { start: dragRange.start, end: dragRange.end }
                  : absoluteShotRange(shot, beats);
              if (!range) return null;
              const isSelected = selection?.type === "shot" && selection.shotId === shot.id;
              return (
                <div
                  key={shot.id}
                  onMouseDown={(e) => startMove(e, shot)}
                  title={shot.imagePrompt}
                  className={`absolute top-2 overflow-hidden rounded cursor-grab active:cursor-grabbing ring-2 transition ${
                    isSelected ? "ring-primary shadow-lg z-10" : "ring-transparent"
                  }`}
                  style={{
                    left: range.start * PX_PER_SECOND,
                    width: Math.max(24, (range.end - range.start) * PX_PER_SECOND),
                    height: SHOTS_HEIGHT - 16,
                  }}
                >
                  {shot.imageUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={shot.imageUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover pointer-events-none"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-muted" />
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 pointer-events-none">
                    <span className="font-mono text-[10px] text-white">
                      {(range.end - range.start).toFixed(1)}s
                    </span>
                  </div>
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
            {selection?.type === "gap" &&
              (() => {
                const beat = beats.find((b) => b.id === selection.beatId);
                if (!beat) return null;
                const left = (beat.startSeconds + selection.startInBeat) * PX_PER_SECOND;
                const width = (selection.endInBeat - selection.startInBeat) * PX_PER_SECOND;
                return (
                  <div
                    className="absolute top-2 rounded border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
                    style={{ left, width, height: SHOTS_HEIGHT - 16 }}
                  />
                );
              })()}
          </div>

          {/* VOICE row — one slim blue bar per beat */}
          <div className="relative bg-muted/10" style={{ height: VOICE_HEIGHT }}>
            {beats.map((beat) => (
              <div
                key={beat.id}
                className="absolute rounded border border-blue-500/60 bg-blue-500/30"
                style={{
                  left: beat.startSeconds * PX_PER_SECOND,
                  width: Math.max(20, (beat.endSeconds - beat.startSeconds) * PX_PER_SECOND),
                  top: (VOICE_HEIGHT - 16) / 2,
                  height: 16,
                }}
              />
            ))}
          </div>

          {/* Playhead — spans every band */}
          <div
            onMouseDown={startPlayheadDrag}
            className="absolute top-0 cursor-ew-resize"
            style={{ left: playheadSeconds * PX_PER_SECOND - 4, width: 8, height: TOTAL_HEIGHT }}
          >
            <div className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-red-500" />
            <div className="absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-sm bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  );
}
