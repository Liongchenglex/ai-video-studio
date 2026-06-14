/**
 * POST /api/projects/[id]/beats/generate
 * Segments the project's prose script into beats and generates a voiceover
 * clip for each (in order, with previous/next context for smooth prosody).
 * Replaces any existing beats for the project. Auth + ownership enforced.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, beats } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { segmentIntoBeats } from "@/lib/beat-segmentation";
import { generateBeatVoiceover } from "@/lib/beat-voiceover-generation";
import { computeBeatOffsets } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  if (!isValidUUID(id)) return badRequestResponse("Invalid project ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();
  if (!project.script || project.script.trim().length === 0) {
    return badRequestResponse("Generate a script first");
  }

  const beatTexts = segmentIntoBeats(project.script);
  if (beatTexts.length === 0) {
    return badRequestResponse("Script produced no beats");
  }

  const voiceId = project.voiceId || "21m00Tcm4TlvDq8ikWAM";

  // Replace existing beats (regen semantics, mirrors recommend-shots).
  await db.delete(beats).where(eq(beats.projectId, id));

  // Insert all beats as pending so the rows (and ids) exist before voicing.
  const inserted = await db
    .insert(beats)
    .values(
      beatTexts.map((text, i) => ({
        projectId: id,
        sortOrder: i,
        text,
        voStatus: "generating" as const,
      })),
    )
    .returning();

  const ordered = [...inserted].sort((a, b) => a.sortOrder - b.sortOrder);

  // Voice each beat in order, with neighbour text as context (not billed).
  for (let i = 0; i < ordered.length; i++) {
    const beat = ordered[i];
    try {
      const result = await generateBeatVoiceover({
        projectId: id,
        beatId: beat.id,
        text: beat.text,
        voiceId,
        previousText: ordered[i - 1]?.text,
        nextText: ordered[i + 1]?.text,
      });
      await db
        .update(beats)
        .set({
          voPath: result.r2Key,
          voStatus: "done",
          voDurationSeconds: result.durationSeconds,
          voTimestamps: result.timestamps,
        })
        .where(eq(beats.id, beat.id));
    } catch (err) {
      console.error(`Beat voiceover failed for ${beat.id}:`, err);
      await db
        .update(beats)
        .set({ voStatus: "failed" })
        .where(eq(beats.id, beat.id));
    }
  }

  // Return fresh rows with presigned URLs + computed offsets.
  const finalBeats = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const offsets = computeBeatOffsets(finalBeats);
  const offsetById = new Map(offsets.map((o) => [o.id, o]));

  const withUrls = await Promise.all(
    finalBeats.map(async (b) => ({
      ...b,
      voUrl: b.voPath ? await getDownloadUrl(b.voPath) : null,
      startSeconds: offsetById.get(b.id)?.startSeconds ?? 0,
      endSeconds: offsetById.get(b.id)?.endSeconds ?? 0,
    })),
  );

  return NextResponse.json({ beats: withUrls });
}
