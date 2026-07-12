/**
 * AI Assistant Director verdict card (Task 14) — renders inside the
 * inspector's "AI Director" group whenever a shot's latest run is
 * `awaiting_approval`. Shows the candidate clip (untouched shot clip stays
 * live until approved), the director's verdict text, a client-computed
 * diff between the shot's current directing settings and the run's
 * `settingsSnapshot`/`candidateModel`, any proposed entity-description
 * updates as opt-in checkboxes, and the three resolving actions:
 *
 *   - Approve: promotes the candidate (+ any checked proposals) via
 *     `resolveDirector(shotId, "approve", undefined, checkedIndexes)`.
 *   - Reject & retry: reveals a note field + budget picker, then on
 *     confirm resolves `{action: "reject", note}` and immediately starts a
 *     fresh run via `startDirector(..., retryOfRunId: run.id)` — the
 *     server seeds the new run's guidance from the old run + the note.
 *   - Dismiss: resolves `{action: "dismiss"}` with no further action.
 *
 * All three funnel through the store's resolveDirector/startDirector,
 * which re-poll the run afterward — a resolved run's status flip out of
 * `awaiting_approval` is what makes the parent (inspector.tsx's
 * DirectorGroup) stop rendering this card, so no local "resolved" state is
 * kept here.
 */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Check, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getClipModel } from "@/lib/clip-models";
import { CAMERA_MOVES } from "@/lib/clip-camera";
import {
  useEditor,
  type EditorShot,
  type DirectorRunView,
} from "@/components/editor/editor-store";

// ─── Settings diff (pure, client-side — spec: settingsSnapshot vs shot) ──

const DIFF_TEXT_MAX_CHARS = 60;

function truncate(text: string, max = DIFF_TEXT_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function humanText(value: string | null, empty = "none"): string {
  const trimmed = value?.trim();
  return trimmed ? truncate(trimmed) : empty;
}

function formatCamera(move: string | null, strength: string | null): string {
  if (!move) return "none";
  const label = CAMERA_MOVES.find((m) => m.id === move)?.label ?? move;
  if (move === "static") return label;
  return `${label} (${strength ?? "medium"})`;
}

function formatDuration(choice: number | null): string {
  return choice == null ? "auto" : `${choice}s`;
}

function formatModel(id: string | null): string {
  if (!id) return "none";
  return getClipModel(id)?.label ?? id;
}

function readString(snap: Record<string, unknown>, key: string): string | null {
  const v = snap[key];
  return typeof v === "string" ? v : null;
}

function readNumber(snap: Record<string, unknown>, key: string): number | null {
  const v = snap[key];
  return typeof v === "number" ? v : null;
}

function readBool(snap: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = snap[key];
  return typeof v === "boolean" ? v : fallback;
}

function readStringArray(snap: Record<string, unknown>, key: string): string[] {
  const v = snap[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Only CHANGED rows render, `Label: old → new` joined with ` · ` — mirrors
 * what `promotionPlan` (director-resolve.ts) would actually write onto the
 * shot if this candidate is approved, so the diff never shows a field the
 * approve action won't touch. `clipModel` is the one exception: it always
 * compares against `run.candidateModel` (never a `clipModel` key in the
 * snapshot — see director-resolve.ts's DirectorSettingsSnapshot comment),
 * since that's the model that actually produced the candidate.
 */
function computeSettingsDiff(shot: EditorShot, run: DirectorRunView): string {
  const snap = run.settingsSnapshot;
  if (!snap) return "";
  const rows: string[] = [];

  const oldCamera = formatCamera(shot.cameraMove, shot.cameraStrength);
  const newCamera = formatCamera(readString(snap, "cameraMove"), readString(snap, "cameraStrength"));
  if (oldCamera !== newCamera) rows.push(`Camera: ${oldCamera} → ${newCamera}`);

  const oldEndsOn = shot.endsOn;
  const newEndsOn = readString(snap, "endsOn") ?? oldEndsOn;
  if (oldEndsOn !== newEndsOn) rows.push(`Ends on: ${oldEndsOn} → ${newEndsOn}`);

  const oldNegative = humanText(shot.negativePrompt);
  const newNegative = humanText(readString(snap, "negativePrompt"));
  if (oldNegative !== newNegative) rows.push(`Negative prompt: ${oldNegative} → ${newNegative}`);

  const oldDuration = formatDuration(shot.clipDurationChoice);
  const newDuration = formatDuration(readNumber(snap, "clipDurationChoice"));
  if (oldDuration !== newDuration) rows.push(`Duration: ${oldDuration} → ${newDuration}`);

  const oldModel = formatModel(shot.clipModel);
  const newModel = formatModel(run.candidateModel);
  if (oldModel !== newModel) rows.push(`Clip model: ${oldModel} → ${newModel}`);

  const oldRefsOn = shot.useEntityRefs ? "on" : "off";
  const newRefsOn = readBool(snap, "useEntityRefs", shot.useEntityRefs) ? "on" : "off";
  if (oldRefsOn !== newRefsOn) rows.push(`Cast refs: ${oldRefsOn} → ${newRefsOn}`);

  const oldRefCount = (shot.referencedEntityIds ?? []).length;
  const newRefCount = readStringArray(snap, "referencedEntityIds").length;
  if (oldRefCount !== newRefCount) rows.push(`References: ${oldRefCount} → ${newRefCount}`);

  const oldAction = humanText(shot.motionPrompt);
  const newAction = humanText(readString(snap, "motionPrompt"));
  if (oldAction !== newAction) rows.push(`Action: ${oldAction} → ${newAction}`);

  if (readBool(snap, "scratchImageEdited", false)) rows.push("Image: edited");

  return rows.join(" · ");
}

// ─── Proposal row ──────────────────────────────────────────────────────

function ProposalRow({
  proposal,
  index,
  checked,
  onToggle,
}: {
  proposal: Record<string, unknown>;
  index: number;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  const entityName = typeof proposal.entityName === "string" ? proposal.entityName : "Entity";
  const field = typeof proposal.field === "string" ? proposal.field : "field";
  const from = typeof proposal.from === "string" ? proposal.from : "";
  const to = typeof proposal.to === "string" ? proposal.to : "";
  const rationale = typeof proposal.rationale === "string" ? proposal.rationale : "";

  return (
    <label className="flex items-start gap-2 rounded border border-dashed p-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(index)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="font-medium">{entityName}</span> {field}: {truncate(from)} →{" "}
        {truncate(to)}
        {rationale && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">{rationale}</span>
        )}
      </span>
    </label>
  );
}

// ─── Verdict card ──────────────────────────────────────────────────────

// Same three amounts as the "at rest" budget picker in inspector.tsx's
// DirectorGroup — kept as its own constant (not exported/shared) because
// the two pickers serve independent forms with independent local state;
// duplicating three literals is cheaper than threading a prop through.
const RETRY_BUDGET_OPTIONS = [0.75, 1.5, 3.0];
const REJECT_NOTE_MAX_CHARS = 500;

export function DirectorVerdictCard({ shot, run }: { shot: EditorShot; run: DirectorRunView }) {
  const { resolveDirector, startDirector } = useEditor();
  const [checkedProposals, setCheckedProposals] = useState<Set<number>>(new Set());
  const [approving, setApproving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [retryBudget, setRetryBudget] = useState(run.budgetUsd);
  const [rejecting, setRejecting] = useState(false);

  // Fresh local state whenever the run itself changes (e.g. a retry
  // produced a new awaiting_approval run) — a stale checked-proposal set
  // or leftover reject note from the PREVIOUS run must never carry over.
  useEffect(() => {
    setCheckedProposals(new Set());
    setApproving(false);
    setDismissing(false);
    setShowRejectForm(false);
    setRejectNote("");
    setRetryBudget(run.budgetUsd);
    setRejecting(false);
  }, [run.id, run.budgetUsd]);

  const busy = approving || dismissing || rejecting;

  const toggleProposal = (index: number) => {
    setCheckedProposals((cur) => {
      const next = new Set(cur);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      await resolveDirector(shot.id, "approve", undefined, [...checkedProposals]);
    } finally {
      setApproving(false);
    }
  };

  const handleDismiss = async () => {
    setDismissing(true);
    try {
      await resolveDirector(shot.id, "dismiss");
    } finally {
      setDismissing(false);
    }
  };

  const handleConfirmReject = async () => {
    setRejecting(true);
    try {
      const result = await resolveDirector(shot.id, "reject", rejectNote);
      if (result) {
        await startDirector(shot.id, retryBudget, undefined, run.id);
      }
    } finally {
      setRejecting(false);
    }
  };

  const settingsDiff = computeSettingsDiff(shot, run);

  return (
    <div className="space-y-2 rounded border p-2">
      {run.candidateUrl && (
        <div className="space-y-1">
          <video
            src={run.candidateUrl}
            muted
            loop
            autoPlay
            playsInline
            className="w-full rounded bg-black"
          />
          <p className="text-[10px] text-muted-foreground">
            Candidate — your current clip is untouched
          </p>
        </div>
      )}

      {run.verdict && <p className="text-xs">{run.verdict}</p>}

      {settingsDiff && (
        <p className="text-[10px] text-muted-foreground">
          <span className="font-semibold uppercase tracking-wide">Settings: </span>
          {settingsDiff}
        </p>
      )}

      {run.proposals.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Proposed entity updates
          </p>
          {run.proposals.map((proposal, index) => (
            <ProposalRow
              key={index}
              proposal={proposal}
              index={index}
              checked={checkedProposals.has(index)}
              onToggle={toggleProposal}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="default" onClick={handleApprove} disabled={busy}>
          {approving ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1 h-3 w-3" />
          )}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowRejectForm((v) => !v)}
          disabled={busy}
        >
          <RotateCcw className="mr-1 h-3 w-3" />
          Reject &amp; retry
        </Button>
        <Button size="sm" variant="ghost" onClick={handleDismiss} disabled={busy}>
          {dismissing ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <X className="mr-1 h-3 w-3" />
          )}
          Dismiss
        </Button>
      </div>

      {showRejectForm && (
        <div className="space-y-1.5 rounded border border-dashed p-1.5">
          <textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            maxLength={REJECT_NOTE_MAX_CHARS}
            rows={2}
            placeholder="What should the next attempt do differently?"
            className="w-full rounded border bg-background p-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <select
              value={retryBudget}
              onChange={(e) => setRetryBudget(Number(e.target.value))}
              className="rounded border bg-background p-1.5 text-xs"
            >
              {RETRY_BUDGET_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  ${opt.toFixed(2)}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={handleConfirmReject} disabled={busy}>
              {rejecting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Confirm reject &amp; retry
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
