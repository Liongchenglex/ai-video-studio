/**
 * AI Assistant Director context assembly (spec §Context & vision, Task 5).
 * Two halves, deliberately split for testability:
 *
 * - buildBriefingText: PURE. Turns plain DirectorBriefingData into the
 *   markdown briefing Claude reads each iteration (project brief/style,
 *   full script, this beat, this shot's prompts + scratch settings,
 *   timeline neighbors, entity roster with sheet status, budget state,
 *   guidance incl. rejection notes). No DB, no network — fully unit
 *   tested. Section order is fixed: Script, This beat, This shot,
 *   Neighbors, Cast & locations, Budget, Guidance (omitted when null).
 *
 * - gatherBriefingImages: network. Downloads the images Claude should
 *   see this iteration straight from R2 via GetObjectCommand +
 *   transformToByteArray (the fal-upload.ts idiom) and returns them as
 *   base64 Anthropic image blocks paired with a caller-facing label (the
 *   caller precedes each block with its own text block in the message,
 *   per the design doc). Sources: the scratch still, the authored end
 *   frame (if any), the previous/next shots' stills (timeline order via
 *   orderShotsByTimeline, only when done), and the run's persisted
 *   candidate sample frames (frame-0.png..frame-3.png under the run's R2
 *   prefix, only once a candidate exists). Every key is probed with a
 *   GET and skipped silently on failure (missing asset, not-yet-generated
 *   frame, etc.) — a director run must never fail because one reference
 *   image happens to be absent.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";
import type { Project, Shot, DirectorRun } from "@/lib/db/schema";
import { loadOrderedProjectShots, type DirectingSettings } from "@/lib/shot-clip-generation";

/** Plain data the pure text builder needs — decoupled from the DB rows so it's trivial to unit test. */
export interface DirectorBriefingData {
  projectBrief: string | null;
  styleString: string | null;
  script: string | null;
  beatText: string;
  shot: { imagePrompt: string; motionPrompt: string };
  scratch: DirectingSettings;
  neighbors: {
    prev?: { imagePrompt: string; endsOn: string };
    next?: { imagePrompt: string; endsOn: string };
  };
  entities: Array<{ id: string; name: string; type: string; sheetReady: boolean; taggedHere: boolean }>;
  budgetUsd: number;
  spentUsd: number;
  guidance: string | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function scratchSettingsLine(scratch: DirectingSettings): string {
  const camera = scratch.cameraMove ? `${scratch.cameraMove} (${scratch.cameraStrength ?? "medium"})` : "none";
  const model = scratch.clipModel ?? "default";
  const duration = scratch.clipDurationChoice != null ? `${scratch.clipDurationChoice}s` : "auto";
  return `Camera: ${camera} · Ends on: ${scratch.endsOn} · Model: ${model} · Duration: ${duration}`;
}

function neighborLine(label: string, n?: { imagePrompt: string; endsOn: string }): string {
  if (!n) return `${label}: (none)`;
  return `${label}: "${n.imagePrompt}" (ends on ${n.endsOn})`;
}

function entityLine(e: DirectorBriefingData["entities"][number]): string {
  const sheet = e.sheetReady ? "(sheet ready)" : "(no sheet)";
  const tagged = e.taggedHere ? ", tagged on this shot" : "";
  return `- ${e.name} (${e.type}) ${sheet}${tagged}`;
}

/**
 * Pure markdown briefing builder. Section order is fixed and load-bearing
 * (the loop's system prompt assumes this shape) — do not reorder without
 * updating the spec.
 */
export function buildBriefingText(d: DirectorBriefingData): string {
  const sections: string[] = [];

  sections.push(
    [
      "## Script",
      "",
      `Project brief: ${d.projectBrief ?? "(none)"}`,
      `Style: ${d.styleString ?? "(none)"}`,
      "",
      d.script ?? "(no script)",
    ].join("\n"),
  );

  sections.push(["## This beat", "", d.beatText].join("\n"));

  sections.push(
    [
      "## This shot",
      "",
      `Image prompt: ${d.shot.imagePrompt}`,
      `Motion prompt: ${d.shot.motionPrompt}`,
      scratchSettingsLine(d.scratch),
    ].join("\n"),
  );

  sections.push(
    ["## Neighbors", "", neighborLine("Previous shot", d.neighbors.prev), neighborLine("Next shot", d.neighbors.next)].join(
      "\n",
    ),
  );

  sections.push(
    [
      "## Cast & locations",
      "",
      d.entities.length > 0 ? d.entities.map(entityLine).join("\n") : "(none tagged in this project)",
    ].join("\n"),
  );

  sections.push(
    [
      "## Budget",
      "",
      `spent ${usd(d.spentUsd)} of ${usd(d.budgetUsd)} (${usd(Math.max(d.budgetUsd - d.spentUsd, 0))} remaining)`,
    ].join("\n"),
  );

  if (d.guidance != null) {
    sections.push(["## Guidance", "", d.guidance].join("\n"));
  }

  return sections.join("\n\n");
}

/** One downloaded reference image plus the label the caller should render as a preceding text block. */
export interface BriefingImage {
  label: string;
  block: Anthropic.ImageBlockParam;
}

/** Downloads one R2 object and returns it as a base64 image block, or null when it can't be fetched (missing, not yet generated, etc). */
async function tryFetchImageBlock(r2Key: string): Promise<Anthropic.ImageBlockParam | null> {
  try {
    const object = await r2Client.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: r2Key }),
    );
    const bytes = await object.Body!.transformToByteArray();
    const mediaType = object.ContentType === "image/jpeg" ? "image/jpeg" : "image/png";
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") },
    };
  } catch {
    return null;
  }
}

const CANDIDATE_FRAME_LABELS = ["0%", "33%", "66%", "100%"];

/**
 * Resolves this shot's timeline neighbors (prev/next, TRUE timeline order
 * — shared loadOrderedProjectShots query, same ordering renderDirectedClip
 * uses, not the possibly-stale sortOrder column) and returns only the ones
 * with a done still.
 */
async function resolveNeighborImagePaths(
  project: Project,
  shot: Shot,
): Promise<{ prev?: string; next?: string }> {
  const ordered = await loadOrderedProjectShots(project.id);
  const currentIndex = ordered.findIndex((s) => s.id === shot.id);
  if (currentIndex < 0) return {};

  const prevShot = ordered[currentIndex - 1];
  const nextShot = ordered[currentIndex + 1];
  return {
    prev: prevShot?.imageStatus === "done" && prevShot.imagePath ? prevShot.imagePath : undefined,
    next: nextShot?.imageStatus === "done" && nextShot.imagePath ? nextShot.imagePath : undefined,
  };
}

/**
 * Gathers this iteration's reference images: the scratch still, the
 * authored end frame (if set), prev/next shots' stills (if done), and the
 * run's persisted candidate sample frames (if a candidate exists yet).
 * Every source is probed independently and skipped silently on failure —
 * see the module doc for why.
 */
export async function gatherBriefingImages(
  project: Project,
  shot: Shot,
  run: DirectorRun,
  scratch: DirectingSettings,
): Promise<BriefingImage[]> {
  const sources: Array<{ label: string; key: string }> = [
    { label: "Current still (start frame)", key: scratch.imagePath },
  ];
  if (scratch.endFramePath) {
    sources.push({ label: "Authored end frame", key: scratch.endFramePath });
  }

  const neighbors = await resolveNeighborImagePaths(project, shot);
  if (neighbors.prev) sources.push({ label: "Previous shot's still", key: neighbors.prev });
  if (neighbors.next) sources.push({ label: "Next shot's still", key: neighbors.next });

  if (run.clipCandidatePath) {
    for (let i = 0; i < CANDIDATE_FRAME_LABELS.length; i++) {
      sources.push({
        label: `Candidate clip frame ${i} (${CANDIDATE_FRAME_LABELS[i]})`,
        key: `projects/${project.id}/shots/${shot.id}/director/${run.id}/frame-${i}.png`,
      });
    }
  }

  const results = await Promise.all(
    sources.map(async (s) => {
      const block = await tryFetchImageBlock(s.key);
      return block ? { label: s.label, block } : null;
    }),
  );

  return results.filter((r): r is BriefingImage => r !== null);
}
