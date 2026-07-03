/**
 * POST /api/projects/[id]/shots/recommend
 * AI-suggests a shot breakdown per beat. Calls Claude with the full script
 * for context, receives one image prompt per fragment (fragments computed
 * deterministically within each voiced beat), replaces any existing shots
 * for this project, returns the new list.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, shots, beats } from "@/lib/db/schema";
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
import { recommendShotsForBeats } from "@/lib/shot-recommendation";

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

  const beatRows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));
  const voiced = beatRows.filter((b) => b.voStatus === "done" && b.voDurationSeconds);
  if (voiced.length === 0) {
    return badRequestResponse("Voice the script into beats before recommending shots");
  }

  try {
    const recommended = await recommendShotsForBeats({
      beats: voiced.map((b) => ({
        id: b.id,
        text: b.text,
        voDurationSeconds: b.voDurationSeconds,
      })),
      styleString: project.styleString,
    });

    // Replace existing shots for this project.
    await db.delete(shots).where(eq(shots.projectId, id));

    const rows = recommended.map((r, i) => ({
      projectId: id,
      beatId: r.beatId,
      sortOrder: i,
      startInBeat: r.startInBeat,
      endInBeat: r.endInBeat,
      imagePrompt: r.imagePrompt,
      motionPrompt: r.motionPrompt,
    }));

    const inserted = await db.insert(shots).values(rows).returning();

    console.log(`[shots/recommend] inserted ${inserted.length} shots for project ${id}`);
    return NextResponse.json({ shots: inserted });
  } catch (error) {
    console.error("[shots/recommend] failed:", error);
    return NextResponse.json({ error: "Shot recommendation failed" }, { status: 500 });
  }
}
