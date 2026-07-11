/**
 * Entity reference resolution logic (Directing Controls task 12). Pure
 * function deciding which of a shot's tagged entities' reference sheets ride
 * into a clip request as `elements`/cast references, based on the
 * useEntityRefs toggle, the clip model's supportsReferences capability, and
 * each entity's reference-sheet readiness (referenceStatus === "done" and a
 * non-null referenceSheetPath). Ready sheets are returned in tag order,
 * capped at 4 (fal's Kling `elements` limit). Reasons are surfaced to the UI
 * so skipped references degrade loudly, never failing the clip.
 */
import type { ClipModelSpec } from "@/lib/clip-models";

export type RefsSkipReason = "disabled" | "model-no-references" | "no-ready-sheets";

const MAX_REFERENCE_SHEETS = 4;

export function resolveClipReferences(args: {
  useEntityRefs: boolean;
  spec: Pick<ClipModelSpec, "supportsReferences">;
  taggedEntities: Array<{
    id: string;
    name: string;
    referenceStatus: string | null;
    referenceSheetPath: string | null;
  }>;
}): { sheetPaths: string[]; skipReason?: RefsSkipReason } {
  // Toggled off at the shot level: no refs, no reason to look further.
  if (!args.useEntityRefs) {
    return { sheetPaths: [], skipReason: "disabled" };
  }

  // Model doesn't accept reference images at all.
  if (!args.spec.supportsReferences) {
    return { sheetPaths: [], skipReason: "model-no-references" };
  }

  // Ready = generation finished and a sheet actually exists. Tag order is
  // preserved by filtering rather than re-sorting.
  const readySheetPaths = args.taggedEntities
    .filter((e) => e.referenceStatus === "done" && e.referenceSheetPath)
    .map((e) => e.referenceSheetPath as string);

  if (readySheetPaths.length === 0) {
    return { sheetPaths: [], skipReason: "no-ready-sheets" };
  }

  return { sheetPaths: readySheetPaths.slice(0, MAX_REFERENCE_SHEETS) };
}
