/**
 * Script generation service using Claude with tool use.
 * Generates a structured scene-by-scene video script from a video brief.
 * Returns typed scene objects ready for database insertion.
 */
import Anthropic from "@anthropic-ai/sdk";
import { durationToWords } from "@/lib/scene-utils";

const anthropic = new Anthropic();

interface GenerateScriptInput {
  brief: string;
  targetDurationMinutes: number;
  tone: string;
  styleString?: string | null;
}

export interface GeneratedScene {
  scene_id: number;
  voiceover: string;
  scene_description: string;
  image_prompt: string;
  duration_seconds: number;
  is_hook: boolean;
}

const SCRIPT_TOOL: Anthropic.Tool = {
  name: "save_script",
  description: "Saves the generated video script as a structured array of scenes.",
  input_schema: {
    type: "object" as const,
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            scene_id: { type: "number", description: "Sequential scene number starting from 1" },
            voiceover: { type: "string", description: "The narration text spoken during this scene" },
            scene_description: { type: "string", description: "Visual description of what happens on screen" },
            image_prompt: { type: "string", description: "Detailed image generation prompt for the scene's key visual" },
            duration_seconds: { type: "number", description: "Estimated duration in seconds based on voiceover word count at 150 wpm" },
            is_hook: { type: "boolean", description: "True if this scene is part of the opening hook (first ~30 seconds)" },
          },
          required: ["scene_id", "voiceover", "scene_description", "image_prompt", "duration_seconds", "is_hook"],
        },
      },
    },
    required: ["scenes"],
  },
};

function buildSystemPrompt(input: GenerateScriptInput): string {
  const targetWords = durationToWords(input.targetDurationMinutes);
  const styleContext = input.styleString
    ? `\n\nVisual style context (use this to inform scene descriptions and image prompts): ${input.styleString}`
    : "";

  return `You are a professional video scriptwriter. Generate a complete video script based on the user's brief.

Rules:
- Target total duration: ${input.targetDurationMinutes} minutes (~${targetWords} words total across all scenes)
- Tone: ${input.tone}
- Reading pace: 150 words per minute — calculate each scene's duration_seconds from its voiceover word count
- The first ~30 seconds of scenes should have is_hook: true — this is the attention-grabbing opening
- Each scene should be self-contained: one visual concept, one narration segment
- Image prompts should be detailed enough for an AI image generator — include composition, subject, mood, colors
- Scene descriptions describe what the viewer sees on screen (camera movement, transitions, visual narrative)
- Voiceover is the actual narration text that will be spoken aloud${styleContext}

Use the save_script tool to return the structured script. Do not return the script as text — you MUST use the tool.`;
}

/**
 * Generates a full video script from a brief using Claude with tool use.
 */
export async function generateScript(input: GenerateScriptInput): Promise<GeneratedScene[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8000,
    system: buildSystemPrompt(input),
    tools: [SCRIPT_TOOL],
    tool_choice: { type: "tool", name: "save_script" },
    messages: [
      {
        role: "user",
        content: input.brief,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool use response");
  }

  const result = toolUse.input as { scenes: GeneratedScene[] };
  if (!result.scenes || !Array.isArray(result.scenes) || result.scenes.length === 0) {
    throw new Error("Claude returned an empty script");
  }

  return result.scenes;
}

/**
 * Regenerates a single scene given context about the surrounding scenes.
 */
export async function regenerateScene(input: {
  brief: string;
  tone: string;
  styleString?: string | null;
  sceneNumber: number;
  totalScenes: number;
  previousSceneVoiceover?: string;
  nextSceneVoiceover?: string;
  currentVoiceover: string;
  currentSceneDescription: string;
}): Promise<GeneratedScene> {
  const contextParts: string[] = [];
  if (input.previousSceneVoiceover) {
    contextParts.push(`Previous scene narration: "${input.previousSceneVoiceover}"`);
  }
  contextParts.push(`Current scene (to regenerate) narration: "${input.currentVoiceover}"`);
  contextParts.push(`Current scene description: "${input.currentSceneDescription}"`);
  if (input.nextSceneVoiceover) {
    contextParts.push(`Next scene narration: "${input.nextSceneVoiceover}"`);
  }

  const prompt = `Regenerate scene ${input.sceneNumber} of ${input.totalScenes} for this video.

Video brief: ${input.brief}

Context:
${contextParts.join("\n")}

Generate a fresh version of this scene that fits naturally between its neighbors. Keep the same general topic but improve the voiceover, scene description, and image prompt. Maintain the same approximate duration.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system: `You are a professional video scriptwriter. Tone: ${input.tone}.${input.styleString ? ` Visual style: ${input.styleString}` : ""}\n\nUse the save_script tool to return exactly one scene.`,
    tools: [SCRIPT_TOOL],
    tool_choice: { type: "tool", name: "save_script" },
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool use response");
  }

  const result = toolUse.input as { scenes: GeneratedScene[] };
  if (!result.scenes || result.scenes.length === 0) {
    throw new Error("Claude returned no scene");
  }

  return result.scenes[0];
}
