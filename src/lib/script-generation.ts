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
- Your ENTIRE response must be the narration itself, starting with its first spoken word. Never open with meta commentary ("Now I have my research…", "Here is the script:", "Let me write…"), never insert a separator line (---), and never describe what you are about to do — none of that is speakable and it corrupts the voiceover.
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

// Meta lead-ins the model sometimes emits after web-search rounds despite
// the prompt ("Now I have comprehensive research… Let me write the script
// directly:"). Matched only against the FIRST paragraph, conservatively.
const META_OPENERS =
  /^(now (that )?i('ve| have)|let me (write|draft)|here('s| is) (the|your|a)|i('ll| will) (now )?(write|draft)|based on (my|the) research|i('ve| have) (gathered|researched|completed))/i;

/**
 * Strips non-narration lead-ins from a generated script: a fully
 * code-fenced wrapper, leading separator lines (---), and up to a few
 * opening paragraphs that read as meta commentary rather than narration.
 * Deterministic and deliberately conservative — a paragraph is only
 * dropped when it clearly matches a meta pattern, so real narration
 * (including short dramatic hooks) is never removed.
 */
export function sanitizeScript(raw: string): string {
  let text = raw.trim();

  const fenced = text.match(/^```(?:\w+)?\n([\s\S]*)\n```$/);
  if (fenced) text = fenced[1].trim();

  for (let i = 0; i < 3; i++) {
    const paragraphs = text.split(/\n\s*\n/);
    if (paragraphs.length < 2) break;
    const first = paragraphs[0].trim();
    const isSeparator = /^[-*_]{3,}$/.test(first);
    const isMeta =
      first.length < 300 &&
      (META_OPENERS.test(first) ||
        (/:$/.test(first) && /\b(script|research|narration|draft)\b/i.test(first)));
    if (!isSeparator && !isMeta) break;
    text = paragraphs.slice(1).join("\n\n").trim();
  }

  return text;
}

/**
 * Generates a script as plain text with paragraph breaks. Returns the
 * sanitized script string; callers persist it to projects.script.
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
      const cleaned = sanitizeScript(scriptText);
      if (!cleaned) {
        throw new Error("Script was empty after stripping non-narration lead-in");
      }
      if (cleaned.length !== scriptText.length) {
        console.log(
          `[script-gen] sanitizer stripped ${scriptText.length - cleaned.length} chars of lead-in`,
        );
      }
      console.log(`[script-gen] script: ${cleaned.length} chars, ~${cleaned.split(/\s+/).length} words`);
      return cleaned;
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
