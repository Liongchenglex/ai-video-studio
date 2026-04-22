/**
 * POST /api/projects/[id]/voiceover/generate
 * Generates a continuous voiceover for the whole project script via ElevenLabs.
 * Persists r2 key + char-level timestamps + duration on the project row.
 * The editor (F-08) reads these to render the waveform and map shot time ranges.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { generateProjectVoiceover } from "@/lib/voiceover-generation";
import { getDownloadUrl } from "@/lib/r2";

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
    return badRequestResponse("Generate a script before generating voiceover");
  }

  await db.update(projects).set({ voiceoverStatus: "generating" }).where(eq(projects.id, id));

  try {
    console.log(`[voiceover/generate] project ${id} | ${project.script.length} chars`);
    const result = await generateProjectVoiceover({
      projectId: id,
      text: project.script,
      voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
    });

    await db
      .update(projects)
      .set({
        voiceoverPath: result.r2Key,
        voiceoverStatus: "done",
        voiceoverTimestamps: result.timestamps,
        durationSeconds: result.durationSeconds,
      })
      .where(eq(projects.id, id));

    const downloadUrl = await getDownloadUrl(result.r2Key);
    console.log(`[voiceover/generate] done — ${result.durationSeconds}s, r2=${result.r2Key}`);
    return NextResponse.json({
      r2Key: result.r2Key,
      durationSeconds: result.durationSeconds,
      voiceoverUrl: downloadUrl,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[voiceover/generate] failed:`, msg);
    await db.update(projects).set({ voiceoverStatus: "failed" }).where(eq(projects.id, id)).catch(() => {});
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
