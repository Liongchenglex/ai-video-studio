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
  const beatIndexRef = useRef(0);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const playBeat = useCallback(
    (index: number, offsetInBeat: number) => {
      const list = beatsRef.current;
      const beat = list[index];
      if (!beat) {
        setPlaying(false);
        return;
      }
      if (!beat.voUrl) {
        // Unvoiced beat: skip forward.
        playBeat(index + 1, 0);
        return;
      }
      stopAudio();
      beatIndexRef.current = index;
      const a = new Audio(beat.voUrl);
      audioRef.current = a;
      a.currentTime = offsetInBeat;
      a.ontimeupdate = () => setPlayheadSeconds(beat.startSeconds + a.currentTime);
      a.onended = () => playBeat(index + 1, 0);
      a.play().catch(() => setPlaying(false));
      // Preload the next beat's audio for a tight seam.
      const next = list[index + 1];
      if (next?.voUrl) {
        const pre = new Audio(next.voUrl);
        pre.preload = "auto";
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
