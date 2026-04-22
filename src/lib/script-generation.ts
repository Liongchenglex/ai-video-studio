/**
 * Script generation (F-03, PRD v3.0).
 * Claude produces a narrative script as plain prose with paragraph
 * breaks. No scenes, no shots — shots are user-defined on the editor
 * timeline. Web search is used for factual grounding.
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// ElevenLabs narration averages ~150 wpm across preset voices.
// Claude targets this rate; actual VO duration is re-measured after generation.
const WORDS_PER_MINUTE = 150;

export interface GenerateScriptInput {
  brief: string;
  targetDurationMinutes: number;
  tone: string;
  styleString?: string | null;
}

const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  type: "web_search_20250305" as Anthropic.Tool["type"],
} as Anthropic.Tool;

function buildSystemPrompt(input: GenerateScriptInput): string {
  const targetSeconds = input.targetDurationMinutes * 60;
  const targetWords = input.targetDurationMinutes * WORDS_PER_MINUTE;
  const styleContext = input.styleString
    ? `\n\nVisual style context (informs tone and imagery language): ${input.styleString}`
    : "";

  return `You are a professional video scriptwriter who produces factually accurate, well-researched content for YouTube.

## Process
1. FIRST: Use web_search 2-4 times to research the topic. Gather key facts, dates, figures, specific details.
2. THEN: Write the complete script as your final response. Do NOT use a tool to save it — just write the prose directly.

## Output Format
- Plain prose only. No headings, no bullet points, no markdown, no labels ("Scene 1:", "Hook:", etc).
- Paragraph breaks (blank line between paragraphs) divide the script into natural narrative beats. Aim for 3-8 paragraphs for a ${input.targetDurationMinutes}-minute video.
- Write as the voiceover will be spoken. Do not include stage directions, visual descriptions, or camera language — a separate system handles visuals.

## Length
- Target: approximately ${targetWords} words total (ElevenLabs narrates at ~${WORDS_PER_MINUTE} wpm, so ${targetWords} words ≈ ${targetSeconds} seconds).
- Acceptable range: ${Math.floor(targetWords * 0.85)} to ${Math.ceil(targetWords * 1.15)} words.
- Count your words mentally before finalising. If you're outside the range, revise.

## Content
- Tone: ${input.tone}
- The opening paragraph is the hook — dramatic, attention-grabbing, establishes stakes in the first ~30 seconds.
- Use specific facts from your web research. Avoid vague generalities.
- Each paragraph is a coherent narrative beat — a single idea, argument, or moment. Readers should feel a natural transition when a paragraph ends.${styleContext}

Write the script now as your response. Nothing else — just the script prose.`;
}

/**
 * Generates a script as plain text with paragraph breaks. Returns the
 * raw script string; callers persist it to projects.script.
 */
export async function generateScript(input: GenerateScriptInput): Promise<string> {
  const systemPrompt = buildSystemPrompt(input);
  const tools: Anthropic.Tool[] = [WEB_SEARCH_TOOL];

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: input.brief },
  ];

  const maxIterations = 6;
  for (let i = 0; i < maxIterations; i++) {
    const tStart = Date.now();
    // Streaming — Anthropic SDK requires it when operations may exceed 10 min
    // (web search + long output pushes us over).
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 16000,
      system: systemPrompt,
      tools,
      messages,
    });
    const response = await stream.finalMessage();
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(
      `[script-gen] iter ${i + 1}/${maxIterations} | stop=${response.stop_reason} | ${elapsed}s | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
    );

    if (response.stop_reason === "max_tokens") {
      throw new Error("Claude hit max_tokens before finishing the script — shorten target or retry.");
    }

    if (response.stop_reason === "end_turn") {
      // Concatenate all text blocks — Claude's final output.
      const scriptText = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();

      if (!scriptText) {
        throw new Error("Claude finished without producing script text");
      }
      console.log(`[script-gen] script: ${scriptText.length} chars, ~${scriptText.split(/\s+/).length} words`);
      return scriptText;
    }

    // stop_reason is "tool_use" — web search ran server-side. Append the
    // assistant's content and loop to let Claude continue to its final answer.
    messages = [
      ...messages,
      { role: "assistant", content: response.content },
    ];
  }

  throw new Error(`Script generation exceeded ${maxIterations} iterations without finishing`);
}
