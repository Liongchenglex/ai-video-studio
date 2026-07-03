/**
 * Sequential per-beat audio playback (v4.0). The timeline has no single
 * master audio file any more — each beat owns a clip. This hook plays
 * beat N and chains into beat N+1 on `ended`, exposing one global
 * playhead in absolute timeline seconds. The next beat's clip is
 * preloaded while the current one plays so seams stay tight.
 */
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { EditorBeat } from "@/components/editor/editor-store";

export function useBeatPlayback(beats: EditorBeat[]) {
  const [playing, setPlaying] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preloadRef = useRef<HTMLAudioElement | null>(null);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const playBeat = useCallback(
    (index: number, offsetInBeat: number) => {
      const list = beatsRef.current;
      // Unvoiced beats: skip forward.
      let i = index;
      let offset = offsetInBeat;
      while (list[i] && !list[i].voUrl) {
        i += 1;
        offset = 0;
      }
      const beat = list[i];
      if (!beat || !beat.voUrl) {
        setPlaying(false);
        return;
      }
      stopAudio();
      const a = new Audio(beat.voUrl);
      audioRef.current = a;
      a.currentTime = offset;
      a.ontimeupdate = () => setPlayheadSeconds(beat.startSeconds + a.currentTime);
      a.onended = () => playBeat(i + 1, 0);
      a.onerror = () => playBeat(i + 1, 0);
      a.play().catch(() => setPlaying(false));
      // Preload the next beat's audio for a tight seam.
      const next = list[i + 1];
      if (next?.voUrl) {
        preloadRef.current = new Audio(next.voUrl);
        preloadRef.current.preload = "auto";
      } else {
        preloadRef.current = null;
      }
    },
    [stopAudio],
  );

  const findBeatAt = useCallback((seconds: number) => {
    const list = beatsRef.current;
    const i = list.findIndex((b) => seconds >= b.startSeconds && seconds < b.endSeconds);
    return i === -1 ? (seconds <= 0 ? 0 : list.length) : i;
  }, []);

  const play = useCallback(
    (fromSeconds?: number) => {
      const from = fromSeconds ?? playheadSeconds;
      const i = findBeatAt(from);
      const beat = beatsRef.current[i];
      setPlaying(true);
      setPlayheadSeconds(from);
      playBeat(i, beat ? Math.max(0, from - beat.startSeconds) : 0);
    },
    [findBeatAt, playBeat, playheadSeconds],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const total = beatsRef.current.at(-1)?.endSeconds ?? 0;
      const t = Math.max(0, Math.min(seconds, total));
      setPlayheadSeconds(t);
      if (playing) {
        const i = findBeatAt(t);
        const beat = beatsRef.current[i];
        playBeat(i, beat ? t - beat.startSeconds : 0);
      } else {
        stopAudio();
      }
    },
    [playing, findBeatAt, playBeat, stopAudio],
  );

  useEffect(() => () => stopAudio(), [stopAudio]);

  return { playing, playheadSeconds, play, pause, seek };
}
