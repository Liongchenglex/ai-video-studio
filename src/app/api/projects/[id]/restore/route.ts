/**
 * API route to restore a soft-deleted project.
 * POST /api/projects/[id]/restore — restore project (owner only)
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
} from "@/lib/api-utils";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  if (!project) return notFoundResponse();
  if (project.userId !== session.user.id) return forbiddenResponse();
  if (!project.deletedAt) {
    return NextResponse.json(
      { error: "Project is not deleted" },
      { status: 400 },
    );
  }

  const [restored] = await db
    .update(projects)
    .set({ deletedAt: null })
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .returning();

  return NextResponse.json(restored);
}
