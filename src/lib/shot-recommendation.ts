/**
 * Shot recommendation (v4.0 per-beat model).
 *
 * Shots are recommended per beat rather than against the whole script:
 *   1. Each voiced beat is fragmented deterministically — walks the beat's
 *      text, cuts at sentence/semicolon/em-dash/comma boundaries to keep
 *      every fragment under the per-shot char budget (derived from that
 *      beat's own measured char/sec rate). No AI, no hallucination risk.
 *      Fragment offsets are proportional character positions WITHIN the
 *      beat's duration (startInBeat/endInBeat), never absolute timeline
 *      seconds.
 *   2. Claude generates ONE image prompt per fragment across all beats in a
 *      single call. Output is a flat array of strings matching the
 *      fragments order — much cheaper and faster than the prior "Claude
 *      outputs text + prompts" approach.
 *
 * Motion prompts default to a generic camera move and are intended to be
 * replaced (or AI-suggested on demand) at clip generation time.
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

const MAX_SHOT_SECONDS = 8;
// Placeholder only — meant to be overridden by "AI suggest" or manual edit
// before clip generation. Kept deliberately neutral: no dramatic zoom, no
// camera-only bias. Motion quality actually improves by the user (or Haiku)
// writing a subject-action-first prompt before generating the clip.
const DEFAULT_MOTION_PROMPT =
  "the subject holds its pose while the scene breathes — faint ambient motion, minimal camera drift";

// ─── Stage 1: deterministic text split ────────────────────────────────────

/**
 * Collects break positions (char index AFTER the punctuation+space).
 * Priority order in the match: period > semicolon > em-dash > comma —
 * but practically we treat them all as valid break points since the
 * greedy packer picks whichever lets the next shot fit.
 */
function collectBreaks(script: string): number[] {
  const breaks: number[] = [];
  const PUNCT = /([.!?][ \t\n]|;[ \t\n]|—[ \t\n]?|,[ \t\n])/g;
  let m: RegExpExecArray | null;
  while ((m = PUNCT.exec(script)) !== null) {
    breaks.push(m.index + m[0].length);
  }
  if (breaks.length === 0 || breaks[breaks.length - 1] !== script.length) {
    breaks.push(script.length);
  }
  return breaks;
}

/**
 * Greedy packer: extends the current shot until the next break would
 * exceed maxChars, then closes at the previous break.
 */
export function splitScriptDeterministic(script: string, maxCharsPerShot: number): string[] {
  const breaks = collectBreaks(script);
  const fragments: string[] = [];

  let shotStart = 0;
  let lastSafeBreak = 0;

  for (const br of breaks) {
    if (br - shotStart > maxCharsPerShot && lastSafeBreak > shotStart) {
      fragments.push(script.slice(shotStart, lastSafeBreak).trim());
      shotStart = lastSafeBreak;
    }
    lastSafeBreak = br;
  }

  if (shotStart < script.length) {
    fragments.push(script.slice(shotStart).trim());
  }

  // Emergency: any fragment still over budget (e.g. one 200-char sentence
  // with no internal punctuation) gets hard-split at the nearest mid-point
  // space. Rare but non-fatal.
  const out: string[] = [];
  for (const f of fragments) {
    if (f.length <= maxCharsPerShot) {
      if (f) out.push(f);
      continue;
    }
    let remaining = f;
    while (remaining.length > maxCharsPerShot) {
      const targetCut = Math.floor(maxCharsPerShot * 0.9);
      const cut = remaining.indexOf(" ", targetCut);
      const safeCut = cut > 0 && cut <= maxCharsPerShot ? cut + 1 : maxCharsPerShot;
      out.push(remaining.slice(0, safeCut).trim());
      remaining = remaining.slice(safeCut).trim();
    }
    if (remaining) out.push(remaining);
  }

  return out.filter(Boolean);
}

// ─── Stage 2: Claude generates image prompts for each fragment ────────────

const PROMPTS_TOOL: Anthropic.Tool = {
  name: "save_image_prompts",
  description: "Save one image prompt per input fragment, matching input order exactly.",
  input_schema: {
    type: "object" as const,
    properties: {
      image_prompts: {
        type: "array",
        description: "Array of image prompts, one per input fragment, in the SAME ORDER as the input.",
        items: { type: "string" },
      },
    },
    required: ["image_prompts"],
  },
};

function buildSystemPrompt(script: string, styleString?: string | null): string {
  const styleContext = styleString
    ? `\n\nVisual style (the project's style profile will handle how the images LOOK): ${styleString}`
    : "";

  return `You generate image prompts for an AI-assisted video editor.

You'll receive the full project script (for context) and a JSON array of short voiceover fragments. For each fragment, return ONE image prompt describing the frozen visual moment the viewer sees while that narration is spoken.

## Project script context
The following is the full narrated script for this video. Every image prompt you generate MUST be historically, culturally, and narratively consistent with this script. If the script is about the Qin Dynasty, every subject (people, buildings, dress, props) must be ancient Chinese — not European, not generic medieval. If it's about the moon landing, every subject must fit 1960s space-age. Read the script and internalize the world before writing prompts.

<script>
${script}
</script>

## Rules
1. Return the same number of prompts as input fragments, in the same order. A validator will check count.
2. Each prompt: ONE concrete subject with specific composition (wide shot / close-up / bird's eye / profile). 15-30 words.
3. **DO NOT specify colors, color palettes, lighting temperature, or art style.** The project's style profile handles all of that via a separate layer — your prompts get "double-styled" if you add color or style words. Focus ONLY on subject + composition.
4. NO motion verbs ("zooms", "pans", "transitions", "moves"). NO abstract concepts. Think "what's in this still photograph — who, where, doing what".
5. Each prompt should feel distinct from its neighbors — different subject, angle, or moment. Don't repeat the same mental image.${styleContext}

Call save_image_prompts with your array.`;
}

// ─── Public entry point ──────────────────────────────────────────────────

export interface BeatRecommendedShot {
  beatId: string;
  startInBeat: number;
  endInBeat: number;
  imagePrompt: string;
  motionPrompt: string;
}

interface BeatsInput {
  beats: Array<{ id: string; text: string; voDurationSeconds: number | null }>;
  styleString?: string | null;
}

/**
 * v4.0 recommendation: fragments are computed per beat (a beat longer than
 * MAX_SHOT_SECONDS is split into ~equal sub-shots at punctuation), offsets
 * are proportional to character position within the beat, and Claude
 * writes one image prompt per fragment exactly as before.
 */
export async function recommendShotsForBeats(
  input: BeatsInput,
): Promise<BeatRecommendedShot[]> {
  // 1. Deterministic per-beat fragmenting.
  const placed: Array<{ beatId: string; startInBeat: number; endInBeat: number; text: string }> = [];
  for (const beat of input.beats) {
    const dur = beat.voDurationSeconds ?? 0;
    if (dur <= 0 || beat.text.trim().length === 0) continue;
    const charsPerSecond = beat.text.length / dur;
    const maxChars = Math.max(20, Math.floor(charsPerSecond * MAX_SHOT_SECONDS));
    const fragments = splitScriptDeterministic(beat.text, maxChars);
    let charCursor = 0;
    for (const frag of fragments) {
      const pos = beat.text.indexOf(frag, charCursor);
      const startChar = pos >= 0 ? pos : charCursor;
      const endChar = startChar + frag.length;
      charCursor = endChar;
      placed.push({
        beatId: beat.id,
        startInBeat: (startChar / beat.text.length) * dur,
        endInBeat: (endChar / beat.text.length) * dur,
        text: frag,
      });
    }
  }
  if (placed.length === 0) throw new Error("No voiced beats to recommend shots for");

  // 2. One image prompt per fragment (unchanged Claude call).
  const fullScript = input.beats.map((b) => b.text).join(" ");
  const fragmentTexts = placed.map((p) => p.text);
  const tStart = Date.now();
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 16000,
    system: buildSystemPrompt(fullScript, input.styleString),
    tools: [PROMPTS_TOOL],
    tool_choice: { type: "tool", name: "save_image_prompts" },
    messages: [
      {
        role: "user",
        content: `Here are ${fragmentTexts.length} voiceover fragments. Return an array of ${fragmentTexts.length} image prompts in the same order.\n\n${JSON.stringify(fragmentTexts, null, 2)}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  console.log(
    `[shot-recommend] Claude returned | stop=${response.stop_reason} | ${((Date.now() - tStart) / 1000).toFixed(1)}s | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens generating image prompts — very long script.");
  }
  const saveToolUse = response.content.find(
    (b) => b.type === "tool_use" && b.name === "save_image_prompts",
  );
  if (!saveToolUse || saveToolUse.type !== "tool_use") {
    throw new Error("Claude didn't call save_image_prompts");
  }
  const { image_prompts: rawPrompts } = saveToolUse.input as { image_prompts: string[] };
  if (!rawPrompts || rawPrompts.length !== fragmentTexts.length) {
    console.warn(
      `[shot-recommend] prompt count mismatch — got ${rawPrompts?.length ?? 0}, expected ${fragmentTexts.length}. Using fallback for missing.`,
    );
  }

  return placed.map((p, i) => {
    const raw = rawPrompts?.[i];
    const imagePrompt =
      typeof raw === "string" && raw.trim().length > 0
        ? raw
        : `A cinematic still capturing the moment: ${p.text.slice(0, 80)}`;
    return {
      beatId: p.beatId,
      startInBeat: p.startInBeat,
      endInBeat: p.endInBeat,
      imagePrompt,
      motionPrompt: DEFAULT_MOTION_PROMPT,
    };
  });
}
