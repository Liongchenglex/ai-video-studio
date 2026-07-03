/**
 * Inline editable script (v4.0 Pillar B). Renders every beat's text as a
 * flowing paragraph of segments, each underlined in its beat's accent
 * color. Click a segment → seek + select the beat; double-click → edit in
 * a textarea; committing a change re-voices ONLY that beat.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useEditor, beatColor } from "@/components/editor/editor-store";

export function ScriptStrip({ onSeek }: { onSeek: (s: number) => void }) {
  const { beats, selection, select, revoiceBeat } = useEditor();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The strip is a fixed-height band (the full script would push the
  // timeline below the fold), so keep the selected beat's sentence in view
  // by scrolling the band — never the page — when selection changes.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedBeatId = selection?.type === "beat" ? selection.beatId : null;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !selectedBeatId) return;
    const el = container.querySelector<HTMLElement>(`[data-beat-id="${selectedBeatId}"]`);
    if (!el) return;
    const er = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    if (er.top < cr.top || er.bottom > cr.bottom) {
      container.scrollTop += er.top - cr.top - cr.height / 2 + er.height / 2;
    }
  }, [selectedBeatId]);
  // Guards against double-commit: pressing Enter (or Escape) calls commit()
  // or setEditingId(null) directly, which unmounts the textarea and fires
  // its onBlur. Setting this flag beforehand tells onBlur to no-op instead
  // of re-running commit() (Enter) or saving a draft that should be
  // discarded (Escape).
  const skipBlurRef = useRef(false);

  const commit = async (beatId: string, original: string) => {
    setEditingId(null);
    const next = draft.trim();
    // Empty text is treated as an explicit cancel (same as Escape) —
    // close the editor without re-voicing, no silent-discard ambiguity.
    if (next.length === 0 || next === original) return;
    if (next.length > 2000) return; // mirror the server cap
    await revoiceBeat(beatId, next);
  };

  return (
    <div className="rounded border bg-muted/20 p-3 text-sm leading-7">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Script — edit in place, re-voices only the beat you touch
      </p>
      <div ref={scrollRef} className="max-h-[6.5rem] overflow-y-auto pr-1">
        <p>
        {beats.map((beat, i) =>
          editingId === beat.id ? (
            <textarea
              key={beat.id}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (skipBlurRef.current) {
                  skipBlurRef.current = false;
                  return;
                }
                commit(beat.id, beat.text);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  skipBlurRef.current = true;
                  commit(beat.id, beat.text);
                }
                if (e.key === "Escape") {
                  skipBlurRef.current = true;
                  setEditingId(null); // true cancel — no commit, draft discarded
                }
              }}
              rows={2}
              maxLength={2000}
              title="Enter saves & re-voices this beat · Esc cancels · empty text cancels"
              className="my-1 w-full rounded border bg-background p-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span
              key={beat.id}
              data-beat-id={beat.id}
              onClick={() => {
                select({ type: "beat", beatId: beat.id });
                onSeek(beat.startSeconds);
              }}
              onDoubleClick={() => {
                skipBlurRef.current = false; // stale flag must never suppress this session's blur
                setEditingId(beat.id);
                setDraft(beat.text);
              }}
              title="Click to select · double-click to edit (re-voices this beat)"
              className={`cursor-pointer rounded-sm px-0.5 transition-colors hover:bg-muted ${
                selection?.type === "beat" && selection.beatId === beat.id ? "bg-muted" : ""
              }`}
              style={{
                boxShadow: `inset 0 -2px 0 ${beatColor(i).textUnderline}`,
              }}
            >
              {beat.text}{" "}
              {beat.voStatus === "generating" && (
                <Loader2 className="inline h-3 w-3 animate-spin text-muted-foreground" />
              )}
              {beat.voStatus === "failed" && (
                <span className="text-[10px] text-destructive">(voice failed — see inspector)</span>
              )}
            </span>
          ),
        )}
        </p>
      </div>
    </div>
  );
}
