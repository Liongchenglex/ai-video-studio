/**
 * API routes for project listing and creation.
 * GET  /api/projects — list active projects for the authenticated user
 * POST /api/projects — create a new project
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, isNull, and, desc } from "drizzle-orm";
import { getSession, unauthorizedResponse, verifyCsrf, applyRateLimit } from "@/lib/api-utils";

const MAX_NAME_LENGTH = 200;
const MAX_TOPIC_LENGTH = 500;

export async function GET() {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const userProjects = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, session.user.id),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(desc(projects.updatedAt));

  return NextResponse.json(userProjects);
}

export async function POST(request: NextRequest) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  let body: { name?: string; topic?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const name = body.name?.trim();
  if (!name || name.length === 0) {
    return NextResponse.json(
      { error: "Project name is required" },
      { status: 400 },
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Project name must be under ${MAX_NAME_LENGTH} characters` },
      { status: 400 },
    );
  }

  const topic = body.topic?.trim() || null;
  if (topic && topic.length > MAX_TOPIC_LENGTH) {
    return NextResponse.json(
      { error: `Topic must be under ${MAX_TOPIC_LENGTH} characters` },
      { status: 400 },
    );
  }

  const [project] = await db
    .insert(projects)
    .values({
      userId: session.user.id,
      name,
      topic,
    })
    .returning();

  return NextResponse.json(project, { status: 201 });
}
