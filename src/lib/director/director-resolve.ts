/**
 * AI Assistant Director resolve logic (Task 13). `promotionPlan` is the
 * PURE heart of "approve": it turns a terminal DirectorRun's
 * `settingsSnapshot` (written by direct-shot.ts's finalizeRun — see that
 * file's `finalizeRun` for the exact snapshot shape) plus the run's
 * candidate fields (`clipCandidatePath`, `candidateDurationSeconds`,
 * `candidateModel`) into:
 *   - `shotPatch`: the shots-row update that makes the shot's directing
 *     settings match what actually produced the approved candidate, plus
 *     the clip/SFX fields that land the promoted clip.
 *   - `copyOps`: the R2 `{ from, to }` pairs the route must execute (via
 *     `CopyObjectCommand`) BEFORE writing `shotPatch`, so the shot's
 *     standard keys (`clip.mp4`, `image.png`, `end-frame.png`) always
 *     point at real objects once the shot row is updated.
 *
 * No DB, no R2, no network — this module only computes plans from data the
 * caller already has in hand. The resolve route (Task 13) is the only
 * caller; it owns fetching the run, executing the copies, writing the shot
 * row, flipping run status, and applying proposals.
 *
 * `buildRejectionGuidance` is the equally-pure counterpart used by
 * reject: it appends the user's feedback note onto the run's existing
 * `guidance` text (which may itself already carry an earlier round's
 * feedback — rejection notes accumulate across "reject & retry" cycles).
 */
import type { DirectorRun } from "@/lib/db/schema";

export interface PromotionPlan {
  shotPatch: Record<string, unknown>;
  copyOps: Array<{ from: string; to: string }>;
}

/**
 * The subset of `DirectingSettings` (src/lib/shot-clip-generation.ts) plus
 * the two extra keys `finalizeRun` stamps on every terminal run —
 * `scratchImagePath` (== `imagePath` at finalize time) and
 * `scratchImageEdited`. Declared locally (not imported) because jsonb
 * columns are typed `Record<string, unknown>` at the schema level; this is
 * the shape this module assumes and validates nothing beyond presence.
 */
interface DirectorSettingsSnapshot {
  imagePath: string;
  motionPrompt: string;
  clipModel: string | null;
  cameraMove: string | null;
  cameraStrength: string | null;
  endsOn: "free" | "next" | "custom";
  endFramePath: string | null;
  endFrameStatus: string | null;
  clipDurationChoice: number | null;
  negativePrompt: string | null;
  useEntityRefs: boolean;
  referencedEntityIds: string[];
  slotSeconds: number | null;
  scratchImagePath: string | null;
  scratchImageEdited: boolean;
}

function standardShotKeys(projectId: string, shotId: string) {
  return {
    clip: `projects/${projectId}/shots/${shotId}/clip.mp4`,
    image: `projects/${projectId}/shots/${shotId}/image.png`,
    endFrame: `projects/${projectId}/shots/${shotId}/end-frame.png`,
  };
}

/**
 * Builds the shot-row patch and R2 copy operations that promote a run's
 * approved candidate onto its shot. Requires the run to carry both a
 * `settingsSnapshot` and a `clipCandidatePath` — the resolve route only
 * calls this after validating the run is in a resolvable state with a
 * candidate present, so a missing value here means a caller contract
 * violation, not a user-facing condition; it throws rather than returning
 * a partial plan.
 */
export function promotionPlan(run: DirectorRun): PromotionPlan {
  if (!run.settingsSnapshot) {
    throw new Error(`promotionPlan: run ${run.id} has no settingsSnapshot to promote from.`);
  }
  if (!run.clipCandidatePath) {
    throw new Error(`promotionPlan: run ${run.id} has no clip candidate to promote.`);
  }

  const snap = run.settingsSnapshot as unknown as DirectorSettingsSnapshot;
  const keys = standardShotKeys(run.projectId, run.shotId);
  const copyOps: Array<{ from: string; to: string }> = [
    { from: run.clipCandidatePath, to: keys.clip },
  ];

  const shotPatch: Record<string, unknown> = {
    motionPrompt: snap.motionPrompt,
    cameraMove: snap.cameraMove,
    cameraStrength: snap.cameraStrength,
    endsOn: snap.endsOn,
    endFramePath: snap.endFramePath ? keys.endFrame : null,
    endFrameStatus: snap.endFrameStatus,
    clipDurationChoice: snap.clipDurationChoice,
    negativePrompt: snap.negativePrompt,
    useEntityRefs: snap.useEntityRefs,
    referencedEntityIds: snap.referencedEntityIds,
    clipModel: run.candidateModel,
    clipPath: keys.clip,
    clipDurationSeconds: run.candidateDurationSeconds,
    clipStatus: "done",
    // SFX reset: the promoted clip is new, so the old audio no longer
    // matches — mirrors shot-clip-generation.ts's own regeneration
    // semantics for a fresh clip.
    sfxPath: null,
    sfxStatus: "pending",
  };

  // The scratch still is only promoted onto the shot's real image.png when
  // the director actually edited it this run — an unedited scratch still
  // is just the shot's own (already-standard) image, so there's nothing to
  // copy or patch.
  if (snap.scratchImageEdited && snap.scratchImagePath) {
    shotPatch.imagePath = keys.image;
    copyOps.push({ from: snap.scratchImagePath, to: keys.image });
  }

  // The end frame is only copied when it's not already sitting at the
  // shot's standard key — a run that inherited `endsOn: "custom"` from the
  // shot without the director calling create_custom_end_frame carries the
  // shot's own (already-standard) end-frame path in the snapshot, and
  // copying a key onto itself is both pointless and, for S3-compatible
  // stores, an error.
  if (snap.endFramePath && snap.endFramePath !== keys.endFrame) {
    copyOps.push({ from: snap.endFramePath, to: keys.endFrame });
  }

  return { shotPatch, copyOps };
}

/**
 * Appends a reject note onto the run's existing guidance, matching the
 * spec's `\n\nUser feedback: …` join — used verbatim (never blank-line
 * prefixed) when the run has no prior guidance, e.g. because this is the
 * first round or a previous retry seeded no guidance either.
 */
export function buildRejectionGuidance(existingGuidance: string | null, note: string): string {
  const trimmedNote = note.trim();
  return existingGuidance ? `${existingGuidance}\n\nUser feedback: ${trimmedNote}` : `User feedback: ${trimmedNote}`;
}
