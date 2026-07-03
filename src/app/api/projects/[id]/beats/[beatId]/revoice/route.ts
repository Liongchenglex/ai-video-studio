/**
 * POST /api/projects/[id]/beats/[beatId]/revoice
 * Regenerates a single beat's voiceover, using its neighbour beats' text as
 * prosody context. Used to fix one line without re-voicing the whole script.
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
import { generateBeatVoiceover } from "@/lib/beat-voiceover-generation";

type Params = { params: Promise<{ id: string; beatId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, beatId } = await params;
  if (!isValidUUID(id) || !isValidUUID(beatId)) {
    return badRequestResponse("Invalid ID");
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();

  // Load the project's beats in order to find this beat + its neighbours.
  const rows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const idx = rows.findIndex((b) => b.id === beatId);
  if (idx === -1) return notFoundResponse();

  const beat = rows[idx];

  // Optional body: { text } — edit the beat's words, then re-voice.
  // An empty/absent body means "re-voice the existing text".
  let newText: string | undefined;
  const raw = await request.text();
  if (raw) {
    try {
      const body = JSON.parse(raw) as { text?: unknown };
      if (body.text !== undefined) {
        if (typeof body.text !== "string") {
          return badRequestResponse("text must be a string");
        }
        const trimmed = body.text.trim();
        if (trimmed.length === 0) {
          return badRequestResponse("text cannot be empty");
        }
        if (trimmed.length > 2000) {
          return badRequestResponse("text too long (max 2000 characters)");
        }
        newText = trimmed;
      }
    } catch {
      return badRequestResponse("Invalid request body");
    }
  }

  const effectiveText = newText ?? beat.text;
  const voiceId = project.voiceId || "21m00Tcm4TlvDq8ikWAM";

  await db
    .update(beats)
    .set({ voStatus: "generating", ...(newText ? { text: newText } : {}) })
    .where(eq(beats.id, beatId));

  try {
    const result = await generateBeatVoiceover({
      projectId: id,
      beatId,
      text: effectiveText,
      voiceId,
      previousText: rows[idx - 1]?.text,
      nextText: rows[idx + 1]?.text,
    });
    const [updated] = await db
      .update(beats)
      .set({
        voPath: result.r2Key,
        voStatus: "done",
        voDurationSeconds: result.durationSeconds,
        voTimestamps: result.timestamps,
      })
      .where(eq(beats.id, beatId))
      .returning();

    return NextResponse.json({
      ...updated,
      voUrl: updated.voPath ? await getDownloadUrl(updated.voPath) : null,
    });
  } catch (err) {
    console.error(`Beat re-voice failed for ${beatId}:`, err);
    await db.update(beats).set({ voStatus: "failed" }).where(eq(beats.id, beatId));
    return NextResponse.json({ error: "Voiceover generation failed" }, { status: 502 });
  }
}
