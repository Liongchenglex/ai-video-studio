/**
 * Script generation service using Claude with web search + tool use.
 * Claude researches the topic via web search, then generates a structured
 * scene-by-scene video script from the video brief.
 */
import Anthropic from "@anthropic-ai/sdk";
import { durationToWords, countWords, wordsToDuration } from "@/lib/scene-utils";

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
  description: "Saves the generated video script as a structured array of scenes. You MUST call this tool after completing your research.",
  input_schema: {
    type: "object" as const,
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            scene_id: { type: "number", description: "Sequential scene number starting from 1" },
            voiceover: { type: "string", description: "The narration text spoken during this scene. Must be substantial — aim for 40-80 words per scene." },
            scene_description: { type: "string", description: "Visual description of what happens on screen" },
            image_prompt: { type: "string", description: "Detailed image generation prompt for the scene's key visual" },
            duration_seconds: { type: "number", description: "Duration in seconds. Calculate as: (word count of voiceover / 150) * 60, rounded to nearest integer." },
            is_hook: { type: "boolean", description: "True if this scene is part of the opening hook (first ~30 seconds)" },
          },
          required: ["scene_id", "voiceover", "scene_description", "image_prompt", "duration_seconds", "is_hook"],
        },
      },
    },
    required: ["scenes"],
  },
};

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  type: "web_search_20250305" as Anthropic.Tool["type"],
} as Anthropic.Tool;

function buildSystemPrompt(input: GenerateScriptInput): string {
  const targetWords = durationToWords(input.targetDurationMinutes);
  const targetSeconds = input.targetDurationMinutes * 60;
  const minScenes = Math.ceil(targetSeconds / 30);
  const maxScenes = Math.ceil(targetSeconds / 10);
  const styleContext = input.styleString
    ? `\n\nVisual style context (use this to inform scene descriptions and image prompts): ${input.styleString}`
    : "";

  return `You are a professional video scriptwriter who produces factually accurate, well-researched content.

## Process
1. FIRST: Use web_search to research the topic thoroughly. Make 2-4 searches to gather key facts, dates, figures, and interesting details. This is critical for accuracy.
2. THEN: Write the script using the save_script tool, incorporating your research findings.

## Script Requirements
- **CRITICAL: Target total duration is EXACTLY ${input.targetDurationMinutes} minutes (${targetSeconds} seconds)**
- The sum of all scene duration_seconds MUST be between ${Math.floor(targetSeconds * 0.85)} and ${Math.ceil(targetSeconds * 1.15)} seconds
- You need approximately ${minScenes} to ${maxScenes} scenes
- Total word count across all voiceover fields must be approximately ${targetWords} words (at 150 words per minute)
- Each scene's duration_seconds = round((word count of that scene's voiceover / 150) * 60)
- Tone: ${input.tone}

## Content Rules
- The first ~30 seconds of scenes should have is_hook: true — dramatic, attention-grabbing opening
- Each scene: one visual concept, one narration segment
- Voiceover: actual narration text to be spoken aloud — substantive, detailed, 40-80 words per scene
- Scene descriptions: what the viewer sees (camera movement, transitions, visual narrative)
- Image prompts: detailed enough for AI image generation — composition, subject, mood, colors${styleContext}

## Duration Enforcement
Before calling save_script, mentally verify:
- Count the words in each voiceover
- Calculate each duration as round((words / 150) * 60)
- Sum all durations — it MUST be close to ${targetSeconds} seconds
- If too short, add more scenes or expand voiceover text
- If too long, trim voiceover text or remove scenes

You MUST use the save_script tool to return the final script. Do not return script as plain text.`;
}

/**
 * Recalculates duration_seconds from actual voiceover word count.
 * Claude sometimes estimates duration incorrectly — this ensures consistency.
 */
function recalculateDurations(scenes: GeneratedScene[]): GeneratedScene[] {
  return scenes.map((s) => ({
    ...s,
    duration_seconds: Math.max(wordsToDuration(countWords(s.voiceover)), 3),
  }));
}

/**
 * Runs the multi-turn conversation with Claude (web search → save_script).
 * Returns the raw generated scenes from the tool call.
 */
async function runGeneration(
  systemPrompt: string,
  userMessage: string,
): Promise<GeneratedScene[]> {
  const tools: Anthropic.Tool[] = [WEB_SEARCH_TOOL, SCRIPT_TOOL];

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const maxIterations = 10;
  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: systemPrompt,
      tools,
      messages,
    });

    const saveToolUse = response.content.find(
      (block) => block.type === "tool_use" && block.name === "save_script",
    );

    if (saveToolUse && saveToolUse.type === "tool_use") {
      const result = saveToolUse.input as { scenes: GeneratedScene[] };
      if (!result.scenes || !Array.isArray(result.scenes) || result.scenes.length === 0) {
        throw new Error("Claude returned an empty script");
      }
      return result.scenes;
    }

    if (response.stop_reason === "end_turn") {
      throw new Error("Claude finished without generating a script");
    }

    messages = [
      ...messages,
      { role: "assistant", content: response.content },
    ];

    if (response.stop_reason === "tool_use") {
      const clientToolUses = response.content.filter(
        (block) => block.type === "tool_use" && block.name !== "web_search",
      );
      if (clientToolUses.length === 0) {
        continue;
      }
    }
  }

  throw new Error("Script generation exceeded maximum iterations");
}

/**
 * Generates a full video script from a brief using Claude with web search + tool use.
 * If the first pass is too short, Claude expands the script in a second pass.
 */
export async function generateScript(input: GenerateScriptInput): Promise<GeneratedScene[]> {
  const systemPrompt = buildSystemPrompt(input);
  let scenes = recalculateDurations(await runGeneration(systemPrompt, input.brief));

  // Check if the script is too short — if so, expand it
  const targetSeconds = input.targetDurationMinutes * 60;
  const actualSeconds = scenes.reduce((sum, s) => sum + s.duration_seconds, 0);
  const shortfall = ((targetSeconds - actualSeconds) / targetSeconds) * 100;

  if (shortfall > 15) {
    const expandPrompt = `The script below is too short. It currently runs ${actualSeconds} seconds but the target is ${targetSeconds} seconds (${input.targetDurationMinutes} minutes). That's ${Math.round(shortfall)}% under target.

Expand the script by:
1. Adding more scenes to cover additional aspects of the topic
2. Expanding existing voiceovers with more detail and depth
3. Adding transitional scenes between major sections

Current script:
${scenes.map((s) => `Scene ${s.scene_id}: [${s.duration_seconds}s] ${s.voiceover.substring(0, 100)}...`).join("\n")}

Generate the complete expanded script using the save_script tool. Include ALL scenes (existing + new), not just the additions. The total must reach approximately ${targetSeconds} seconds.`;

    scenes = recalculateDurations(await runGeneration(systemPrompt, expandPrompt));
  }

  return scenes;
}

/**
 * Regenerates only the image prompt for a scene.
 * The voiceover and scene description are user-owned and not touched.
 * Returns a fresh image prompt based on the scene description and style context.
 */
export async function regenerateImagePrompt(input: {
  sceneDescription: string;
  voiceover: string;
  tone: string;
  styleString?: string | null;
}): Promise<string> {
  const styleContext = input.styleString
    ? ` Visual style to match: ${input.styleString}`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: `You are an AI image prompt specialist. Generate a detailed image generation prompt based on the scene description and voiceover context provided. The prompt should describe composition, subject, mood, colors, and visual details suitable for an AI image generator.${styleContext}\n\nReturn ONLY the image prompt text. No explanation. No preamble.`,
    messages: [
      {
        role: "user",
        content: `Scene description: ${input.sceneDescription}\n\nVoiceover context: ${input.voiceover}\n\nTone: ${input.tone}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  return textBlock.text.trim();
}
