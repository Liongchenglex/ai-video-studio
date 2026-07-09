/**
 * AI chain suggestions for batch "Generate all" (Clip Engine v2). One Haiku
 * call classifies each adjacent shot pair: should the earlier shot's clip
 * end on the next shot's image ("chain")? Criteria: same scene/subject,
 * continuous action — chains across scene cuts produce morphy interpolation,
 * so the prompt is conservative. Best-effort: any failure returns [] and the
 * batch proceeds unchained.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ChainPair {
  shotId: string;
  nextShotId: string;
  sameBeat: boolean;
  sharedEntityIds: string[];
}

interface ChainShotInput {
  id: string;
  sortOrder: number;
  beatId: string | null;
  imagePrompt: string;
  referencedEntityIds: string[] | null;
}

export function buildChainPairs(shots: ChainShotInput[]): ChainPair[] {
  const ordered = [...shots].sort((a, b) => a.sortOrder - b.sortOrder);
  const pairs: ChainPair[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    const nextIds = new Set(next.referencedEntityIds ?? []);
    pairs.push({
      shotId: cur.id,
      nextShotId: next.id,
      sameBeat: cur.beatId !== null && cur.beatId === next.beatId,
      sharedEntityIds: (cur.referencedEntityIds ?? []).filter((e) => nextIds.has(e)),
    });
  }
  return pairs;
}

export function sanitizeChainSuggestions(suggestedIds: unknown, pairs: ChainPair[]): string[] {
  if (!Array.isArray(suggestedIds)) return [];
  const valid = new Set(pairs.map((p) => p.shotId));
  return suggestedIds.filter((id): id is string => typeof id === "string" && valid.has(id));
}

const CHAIN_TOOL: Anthropic.Tool = {
  name: "save_chain_suggestions",
  description: "Save which shots should chain into their next shot.",
  input_schema: {
    type: "object" as const,
    properties: {
      chained_shot_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Ids of shots whose clip should END on the next shot's image. Only include a pair when both stills clearly show the same scene and subject with continuous action between them. When in doubt, leave it out — a hard cut beats a morphy interpolation.",
      },
    },
    required: ["chained_shot_ids"],
  },
};

export async function suggestChains(
  shots: ChainShotInput[],
  projectBrief: string | null,
): Promise<string[]> {
  const pairs = buildChainPairs(shots);
  if (pairs.length === 0) return [];

  const byId = new Map(shots.map((s) => [s.id, s]));
  const pairList = pairs
    .map((p, i) => {
      const a = byId.get(p.shotId)!;
      const b = byId.get(p.nextShotId)!;
      return `Pair ${i + 1} — shot id "${p.shotId}"\n  A: ${a.imagePrompt}\n  B: ${b.imagePrompt}\n  same narration beat: ${p.sameBeat}, shared tagged entities: ${p.sharedEntityIds.length}`;
    })
    .join("\n\n");

  try {
    const anthropic = new Anthropic();
    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: `You decide which adjacent shot pairs in an AI video should be "chained": the earlier clip animates from its own still INTO the next shot's still, so the cut is seamless. Chain ONLY pairs that show the same scene and subject with continuous action. Different locations, subjects, or time jumps must NOT chain.${projectBrief ? `\n\nThe video is about: ${projectBrief}` : ""}\n\nReturn via the save_chain_suggestions tool.`,
      tools: [CHAIN_TOOL],
      tool_choice: { type: "tool", name: "save_chain_suggestions" },
      messages: [{ role: "user", content: `Adjacent shot pairs:\n\n${pairList}` }],
    });
    const response = await stream.finalMessage();
    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "save_chain_suggestions",
    );
    if (!toolUse || toolUse.type !== "tool_use") return [];
    const { chained_shot_ids } = toolUse.input as { chained_shot_ids: unknown };
    return sanitizeChainSuggestions(chained_shot_ids, pairs);
  } catch (error) {
    console.error("[chain-suggestion] failed, proceeding unchained:", error);
    return [];
  }
}
