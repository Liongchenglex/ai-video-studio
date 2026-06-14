/**
 * GET /api/projects/[id]/beats
 * Lists a project's beats in order, with presigned audio URLs and absolute
 * timeline offsets (stacked from per-beat durations). Auth + ownership.
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
} from "@/lib/api-utils";
import { getDownloadUrl } from "@/lib/r2";
import { computeBeatOffsets } from "@/lib/beat-timing";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
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

  const rows = await db
    .select()
    .from(beats)
    .where(eq(beats.projectId, id))
    .orderBy(asc(beats.sortOrder));

  const offsets = computeBeatOffsets(rows);
  const offsetById = new Map(offsets.map((o) => [o.id, o]));

  const withUrls = await Promise.all(
    rows.map(async (b) => ({
      ...b,
      voUrl: b.voPath ? await getDownloadUrl(b.voPath) : null,
      startSeconds: offsetById.get(b.id)?.startSeconds ?? 0,
      endSeconds: offsetById.get(b.id)?.endSeconds ?? 0,
    })),
  );

  return NextResponse.json({ beats: withUrls });
}
