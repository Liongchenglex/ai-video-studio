/**
 * POST /api/projects/[id]/shots/suggest-prompt
 * Body: { voText }
 * Returns { imagePrompt, motionPrompt } suggested by Claude for the given
 * voiceover fragment, using the project's style string for conditioning.
 * Used inline from the editor's gap-create form and the shot-edit side panel.
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

const SUGGEST_TOOL: Anthropic.Tool = {
  name: "save_prompts",
  description: "Save the suggested image and motion prompts for this shot.",
  input_schema: {
    type: "object" as const,
    properties: {
      image_prompt: {
        type: "string",
        description: "A frozen visual moment: ONE concrete subject, specific composition (wide/close-up/profile), dominant colors, lighting, mood. 20-40 words. NO motion verbs.",
      },
      motion_prompt: {
        type: "string",
        description: "One or two camera/subject motion actions for ~6 seconds. Short. Example: 'slow push-in as torches flicker' or 'parallax pan across the skyline'.",
      },
    },
    required: ["image_prompt", "motion_prompt"],
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

  let body: { voText: string };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }
  if (!body.voText || body.voText.trim().length === 0) {
    return badRequestResponse("voText required");
  }

  const styleContext = project.styleString
    ? `\n\nVisual style (fit this style): ${project.styleString}`
    : "";

  try {
    // Haiku — this is a small creative call, no need for Sonnet's reasoning.
    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: `You suggest image + motion prompts for one shot in an AI video editor. The shot plays during this narration fragment.${styleContext}\n\nReturn via the save_prompts tool.`,
      tools: [SUGGEST_TOOL],
      tool_choice: { type: "tool", name: "save_prompts" },
      messages: [
        {
          role: "user",
          content: `Narration for this shot:\n\n"${body.voText.trim()}"`,
        },
      ],
    });
    const response = await stream.finalMessage();

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "save_prompts",
    );
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Haiku didn't call save_prompts");
    }

    const { image_prompt, motion_prompt } = toolUse.input as {
      image_prompt: string;
      motion_prompt: string;
    };

    return NextResponse.json({
      imagePrompt: image_prompt,
      motionPrompt: motion_prompt,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shots/suggest-prompt] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
