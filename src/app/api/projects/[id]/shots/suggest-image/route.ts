/**
 * POST /api/projects/[id]/shots/suggest-image
 * Body: { voText }
 * Returns { imagePrompt } — one Haiku-generated image prompt for the given
 * VO fragment, culturally / narratively anchored to the project's script.
 * Style is handled by the style profile layer; this prompt should describe
 * subject + composition only.
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

const IMAGE_TOOL: Anthropic.Tool = {
  name: "save_image_prompt",
  description: "Save the suggested image prompt for this shot.",
  input_schema: {
    type: "object" as const,
    properties: {
      image_prompt: {
        type: "string",
        description: "A frozen visual moment: ONE concrete subject, specific composition (wide / close-up / profile). 15-30 words. DO NOT specify colors, palette, lighting temperature, or art style — those come from the project's style profile layer. Focus only on subject + composition. NO motion verbs.",
      },
    },
    required: ["image_prompt"],
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
    ? `\n\nVisual style (how the image will LOOK — do not re-specify in your prompt): ${project.styleString}`
    : "";

  const projectContext = project.script
    ? `\n\n<project-script>\n${project.script}\n</project-script>\n\nEvery subject you propose must be historically / culturally / narratively consistent with this script.`
    : project.brief
      ? `\n\nThe video is about: ${project.brief}\n\nEvery subject you propose must be culturally / narratively consistent with this topic.`
      : "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: `You suggest a single image prompt for one shot in an AI video editor. The shot plays during the provided narration fragment.${projectContext}${styleContext}\n\nReturn via the save_image_prompt tool. Do not specify colors or art style — those come from the style layer.`,
      tools: [IMAGE_TOOL],
      tool_choice: { type: "tool", name: "save_image_prompt" },
      messages: [
        {
          role: "user",
          content: `Narration for this shot:\n\n"${body.voText.trim()}"`,
        },
      ],
    });
    const response = await stream.finalMessage();

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "save_image_prompt",
    );
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Haiku didn't call save_image_prompt");
    }
    const { image_prompt } = toolUse.input as { image_prompt: string };
    return NextResponse.json({ imagePrompt: image_prompt });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[shots/suggest-image] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
