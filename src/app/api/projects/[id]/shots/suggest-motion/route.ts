/**
 * POST /api/projects/[id]/shots/suggest-motion
 * Body: { voText, imagePrompt }
 * Returns { motionPrompt } — a Haiku-generated motion description for the
 * shot. Requires imagePrompt so Haiku can propose motion that fits the
 * actual visual composition (rather than generic "slow zoom").
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";

const anthropic = new Anthropic();
type Params = { params: Promise<{ id: string }> };

const MOTION_TOOL: Anthropic.Tool = {
  name: "save_motion_prompt",
  description: "Save the suggested motion prompt for this shot.",
  input_schema: {
    type: "object" as const,
    properties: {
      motion_prompt: {
        type: "string",
        description: "Describe what HAPPENS over the clip (~5-6 seconds) in 2-3 phases so video models can follow it: (1) the subject's action and how it evolves — start state, movement, end state (e.g. 'The pendulum swings rapidly, decelerates, and settles pointing at 12'); (2) an optional subtle camera move; (3) pacing (where the motion is fast vs. settled). REQUIRED: a subject action. Avoid dramatic zooms and 'slow pan' clichés. If no subject action fits the still, keep camera motion minimal.",
      },
    },
    required: ["motion_prompt"],
  },
};

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

  let body: { voText: string; imagePrompt: string };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  if (!body.voText?.trim()) return badRequestResponse("voText required");
  if (!body.imagePrompt?.trim()) {
    return badRequestResponse("imagePrompt required — motion suggestions depend on the visual");
  }

  const projectContext = project.script
    ? `\n\n<project-script>\n${project.script}\n</project-script>`
    : project.brief
      ? `\n\nThe video is about: ${project.brief}`
      : "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: `You suggest a single motion prompt for one shot in an AI video editor. Motion prompts describe what HAPPENS in the shot over ~5-6 seconds as a short phased action (start state → movement → end state) — prefer subject action over camera moves, and make the phases explicit so image-to-video models can follow them.${projectContext}\n\nReturn via the save_motion_prompt tool.`,
      tools: [MOTION_TOOL],
      tool_choice: { type: "tool", name: "save_motion_prompt" },
      messages: [
        {
          role: "user",
          content: `Narration for this shot:\n"${body.voText.trim()}"\n\nImage prompt (what the still depicts):\n"${body.imagePrompt.trim()}"\n\nPropose a motion prompt that fits this still and matches what the narration implies.`,
        },
      ],
    });
    const response = await stream.finalMessage();

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "save_motion_prompt",
    );
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Haiku didn't call save_motion_prompt");
    }
    const { motion_prompt } = toolUse.input as { motion_prompt: string };
    return NextResponse.json({ motionPrompt: motion_prompt });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shots/suggest-motion] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
