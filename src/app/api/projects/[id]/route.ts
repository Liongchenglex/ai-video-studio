/**
 * API routes for a single project.
 * GET    /api/projects/[id] — get project details (owner only)
 * PATCH  /api/projects/[id] — update project name/topic/status (owner only)
 * DELETE /api/projects/[id] — soft-delete project (owner only)
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

const MAX_NAME_LENGTH = 200;
const MAX_TOPIC_LENGTH = 500;
const VALID_STATUSES = ["draft", "generating", "ready", "published"] as const;

type Params = { params: Promise<{ id: string }> };

async function getOwnedProject(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return { project: null, error: "not_found" as const };
  if (project.userId !== userId) return { project: null, error: "forbidden" as const };
  return { project, error: null };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  const { project, error } = await getOwnedProject(id, session.user.id);

  if (error === "not_found") return notFoundResponse();
  if (error === "forbidden") return forbiddenResponse();

  return NextResponse.json(project);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  const { project, error } = await getOwnedProject(id, session.user.id);

  if (error === "not_found") return notFoundResponse();
  if (error === "forbidden") return forbiddenResponse();
  if (project!.deletedAt) return notFoundResponse();

  let body: { name?: string; topic?: string; status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (name.length === 0) {
      return NextResponse.json(
        { error: "Project name cannot be empty" },
        { status: 400 },
      );
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Project name must be under ${MAX_NAME_LENGTH} characters` },
        { status: 400 },
      );
    }
    updates.name = name;
  }

  if (body.topic !== undefined) {
    const topic = body.topic.trim();
    if (topic.length > MAX_TOPIC_LENGTH) {
      return NextResponse.json(
        { error: `Topic must be under ${MAX_TOPIC_LENGTH} characters` },
        { status: 400 },
      );
    }
    updates.topic = topic || null;
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
      return NextResponse.json(
        { error: `Status must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .returning();

  return NextResponse.json(updated);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  const { project, error } = await getOwnedProject(id, session.user.id);

  if (error === "not_found") return notFoundResponse();
  if (error === "forbidden") return forbiddenResponse();
  if (project!.deletedAt) return notFoundResponse();

  await db
    .update(projects)
    .set({ deletedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)));

  return NextResponse.json({ message: "Project deleted" });
}
