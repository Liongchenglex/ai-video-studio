/**
 * POST /api/projects/[id]/generate-all
 * Dispatches the batch "Generate all" run (v4 P3): recomputes missing-only
 * targets server-side (never trusts client counts), refuses while a batch is
 * already running (409), then emits one `project/batch.generate` Inngest
 * event — the orchestrator does all paid work in the background. Body:
 * { includeClips: boolean }.
 * Known small race: between this 202 and the orchestrator's first step no
 * row is `generating` yet, so a second POST in that window double-dispatches
 * — harmless, because the function has per-project concurrency 1 and
 * recomputes missing-only targets when it starts.
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
import { computeBatchTargets } from "@/lib/batch-targeting";
import { inngest } from "@/inngest";

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

  let includeClips = false;
  try {
    const body = (await request.json()) as { includeClips?: unknown };
    if (typeof body.includeClips !== "boolean") {
      return badRequestResponse("includeClips must be a boolean");
    }
    includeClips = body.includeClips;
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const targets = await computeBatchTargets(id);
  if (targets.anyGenerating) {
    return NextResponse.json({ error: "A batch is already running" }, { status: 409 });
  }

  const sheets = targets.sheetEntityIds.length;
  const images = targets.imageShotIds.length;
  const clips = includeClips ? targets.clipShotIds.length : 0;
  if (sheets + images + clips === 0) {
    return NextResponse.json({ dispatched: false, reason: "nothing-to-do" });
  }

  await inngest.send({
    name: "project/batch.generate",
    data: { projectId: id, includeClips },
  });

  console.log(
    `[generate-all] dispatched project=${id} sheets=${sheets} images=${images} clips=${clips}`,
  );
  return NextResponse.json({ dispatched: true, sheets, images, clips }, { status: 202 });
}
