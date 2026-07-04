/**
 * Claude auto-extract + auto-tag for the Reference Bible (F-16, v4.0).
 * Same forced-tool-use pattern as shot-recommendation.ts: model id,
 * anthropic client, messages.stream().finalMessage(), stop_reason
 * max_tokens check, count-mismatch tolerance, console.log telemetry.
 *
 *   1. extractEntities — one forced-tool call over the full script text.
 *      Identifies RECURRING visual entities (characters, locations,
 *      objects) and returns validated/clamped { name, type, description }.
 *   2. tagShots — per-batch (40 shots) forced-tool calls, sequential.
 *      Given the entity list and every shot's visual prompt + spanned
 *      narration, returns per-shot entity NAME arrays; the lib resolves
 *      names -> ids case-insensitively, drops unknowns, caps 8/shot.
 */
import Anthropic from "@anthropic-ai/sdk";
import { entityTypeEnum } from "@/lib/db/schema";

const anthropic = new Anthropic();

const MAX_ENTITIES = 12;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ENTITIES_PER_SHOT = 8;
const SHOT_BATCH_SIZE = 40;
const VALID_TYPES = entityTypeEnum.enumValues;
type EntityType = (typeof VALID_TYPES)[number];

// ─── extractEntities ───────────────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "save_entities",
  description:
    "Save the recurring visual entities (characters, locations, objects) identified in the script.",
  input_schema: {
    type: "object" as const,
    properties: {
      entities: {
        type: "array",
        description: `At most ${MAX_ENTITIES} recurring entities (a maximum, not a target — fewer or none is fine), most narratively central first, with no two entries overlapping the same visual subject.`,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short, natural name (e.g. a person's name or a place's name)." },
            type: { type: "string", enum: [...VALID_TYPES] },
            description: {
              type: "string",
              description:
                "1-3 sentence VISUAL description for an image generator: appearance, age, dress, materials. No plot or backstory.",
            },
          },
          required: ["name", "type", "description"],
        },
      },
    },
    required: ["entities"],
  },
};

const EXTRACT_SYSTEM_PROMPT = `You extract recurring visual entities from a video script for a "Reference Bible" feature — each extracted entity later gets one AI-generated reference image so it looks consistent across every shot.

Identify entities (characters, locations, objects) that RECUR — they appear or are referenced in at least 2 distinct moments of the script. Skip one-off background details.

Entities are PEOPLE, PLACES, and PHYSICAL THINGS only — never events, scenes, or abstract concepts. A battle, a ceremony, a dynasty's rise, or a era of history is not an entity; if it involves a recurring person, place, or object worth a reference image, extract that instead.

For each entity return:
- name: short, natural (a person's name, a place's name, an object's name).
- type: "character", "location", or "object".
- description: 1-3 sentences describing ONLY what it looks like — appearance, age, build, dress, materials, colors — written for an image generator. Do NOT describe plot, motivations, or backstory.

## Selection discipline — fewer is better
${MAX_ENTITIES} is a HARD MAXIMUM, not a target to fill. Only propose an entity when you are genuinely confident it (a) recurs across multiple distinct scenes and (b) is visually distinctive enough that a reference image is worth generating for it. Do not pad the list with marginal, one-off, or barely-recurring candidates just because budget remains — returning fewer than ${MAX_ENTITIES}, or even zero, is the correct answer whenever the script doesn't clearly warrant more (including when the existing bible below already covers it).

## No subject overlap
Never propose two entities whose visual subject substantially overlaps — either two of your own proposals, or one of yours against an already-registered entity (see below). "Iron plows and farming tools" and "Iron tools and weapons" are the same subject wearing different words; merge them into a single entity or drop the redundant one. If in doubt whether two candidates are the same thing, they are — merge or skip rather than propose both.

Return AT MOST ${MAX_ENTITIES} entities, ordered with the most narratively central / most-recurring first.

Call save_entities with your array.`;

/** Builds the exclusion block appended to the system prompt when the project already has registered entities. */
function buildExistingEntitiesBlock(existingNames: string[]): string {
  const list = existingNames.map((n) => `- ${n}`).join("\n");
  return `

## ALREADY-REGISTERED ENTITIES — DO NOT RE-PROPOSE
The following entities are ALREADY in this project's reference bible:
${list}

These entities must NOT be re-proposed — not under the same name, an alias, a title, an epithet, a near-synonym, or any other variant whose visual subject substantially overlaps one already listed. For example, if "Liu Bang" is listed above, do NOT propose "Liu Bang", "Emperor Gaozu", "the Emperor", or any other name that refers to the same individual. Likewise, if "Iron tools and weapons" is listed above, do NOT also propose "Iron plows and farming tools" or any other close variant of the same physical subject — that overlap is exactly as disqualifying as reusing the name. Only propose entities that are genuinely NEW and visually distinct from everything above. If, after applying this and the selection-discipline rules, nothing new clears the bar, return an empty array — that is a correct and expected result.`;
}

/** Validates and clamps one raw extracted-entity candidate. Returns null to drop it. */
function validateExtractedEntity(raw: unknown): ExtractedEntity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.type !== "string" || typeof r.description !== "string") {
    return null;
  }
  const name = r.name.trim().slice(0, MAX_NAME_LENGTH);
  if (name.length === 0) return null;
  if (!(VALID_TYPES as readonly string[]).includes(r.type)) return null;
  const description = r.description.trim().slice(0, MAX_DESCRIPTION_LENGTH);
  return { name, type: r.type as EntityType, description };
}

/**
 * Identifies recurring visual entities in the full project script. One
 * forced-tool call; response is validated/clamped (invalid types dropped,
 * name/description truncated to caps, empty names dropped) and capped at
 * MAX_ENTITIES.
 *
 * existingNames — names of entities already registered in the project's
 * reference bible (pre-insert). When non-empty, the system prompt is
 * extended with an explicit exclusion block so Claude doesn't re-propose
 * an existing entity under an alias, title, or epithet (which the caller's
 * exact-string dedup can't catch). Always pass the pre-insert list.
 */
export async function extractEntities(
  script: string,
  existingNames: string[],
): Promise<ExtractedEntity[]> {
  const systemPrompt =
    existingNames.length > 0
      ? EXTRACT_SYSTEM_PROMPT + buildExistingEntitiesBlock(existingNames)
      : EXTRACT_SYSTEM_PROMPT;
  const tStart = Date.now();
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    system: systemPrompt,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "save_entities" },
    messages: [
      {
        role: "user",
        content: `Here is the full project script:\n\n<script>\n${script}\n</script>\n\nExtract the recurring visual entities and call save_entities.`,
      },
    ],
  });
  const response = await stream.finalMessage();
  console.log(
    `[entity-extract] Claude returned | stop=${response.stop_reason} | ${((Date.now() - tStart) / 1000).toFixed(1)}s | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens extracting entities — very long script.");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "save_entities");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude didn't call save_entities");
  }
  const { entities: rawEntities } = toolUse.input as { entities?: unknown[] };
  if (!Array.isArray(rawEntities)) {
    throw new Error("save_entities call had no entities array");
  }

  const validated: ExtractedEntity[] = [];
  for (const raw of rawEntities) {
    const entity = validateExtractedEntity(raw);
    if (entity) validated.push(entity);
    if (validated.length >= MAX_ENTITIES) break;
  }
  if (validated.length !== rawEntities.length) {
    console.warn(
      `[entity-extract] dropped/clamped entities — got ${rawEntities.length} raw, ${validated.length} valid.`,
    );
  }
  return validated;
}

// ─── tagShots ──────────────────────────────────────────────────────────────

export interface TaggableEntity {
  id: string;
  name: string;
  type: EntityType;
}

export interface TaggableShot {
  id: string;
  imagePrompt: string;
  narration: string;
}

const TAG_TOOL: Anthropic.Tool = {
  name: "save_shot_tags",
  description: "Save which entities appear in each shot, keyed by the shot's given id.",
  input_schema: {
    type: "object" as const,
    properties: {
      shot_tags: {
        type: "array",
        description: "One entry per input shot, using the EXACT shot_id provided.",
        items: {
          type: "object",
          properties: {
            shot_id: { type: "string", description: "Must exactly match one of the given shot ids." },
            entity_names: {
              type: "array",
              description: "Names of entities (from the given list) visually depicted in this shot. Empty array if none.",
              items: { type: "string" },
            },
          },
          required: ["shot_id", "entity_names"],
        },
      },
    },
    required: ["shot_tags"],
  },
};

function buildTagSystemPrompt(entities: TaggableEntity[]): string {
  const entityList = entities.map((e) => `- ${e.name} (${e.type})`).join("\n");
  return `You tag which recurring entities are visually depicted in each shot of a video.

## Entities
${entityList}

## Rules
1. For every shot, return ONE entry keyed by its exact given shot_id.
2. entity_names lists only entities from the list above (by exact name) whose subject is depicted in that shot's image — judge from the shot's image prompt and its spoken narration.
3. Empty array is fine and expected for many shots — do not force a tag.
4. Do not invent entities or shot ids not given to you.

Call save_shot_tags with your array.`;
}

/** Case-insensitive resolves entity names to ids, drops unknowns, caps the array. */
function resolveEntityNames(
  names: unknown,
  nameToId: Map<string, string>,
): string[] {
  if (!Array.isArray(names)) return [];
  const ids: string[] = [];
  for (const n of names) {
    if (typeof n !== "string") continue;
    const id = nameToId.get(n.trim().toLowerCase());
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_ENTITIES_PER_SHOT) break;
  }
  return ids;
}

async function tagShotBatch(
  entities: TaggableEntity[],
  batch: TaggableShot[],
  nameToId: Map<string, string>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const validShotIds = new Set(batch.map((s) => s.id));

  const tStart = Date.now();
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8000,
    system: buildTagSystemPrompt(entities),
    tools: [TAG_TOOL],
    tool_choice: { type: "tool", name: "save_shot_tags" },
    messages: [
      {
        role: "user",
        content: `Here are ${batch.length} shots. Return one entry per shot, keyed by its shot_id.\n\n${JSON.stringify(
          batch.map((s) => ({ shot_id: s.id, image_prompt: s.imagePrompt, narration: s.narration })),
          null,
          2,
        )}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  console.log(
    `[entity-tag] batch of ${batch.length} | stop=${response.stop_reason} | ${((Date.now() - tStart) / 1000).toFixed(1)}s | in=${response.usage.input_tokens} out=${response.usage.output_tokens}`,
  );
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude hit max_tokens tagging shots — batch too large.");
  }
  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "save_shot_tags");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude didn't call save_shot_tags");
  }
  const { shot_tags: rawTags } = toolUse.input as { shot_tags?: unknown[] };
  if (!Array.isArray(rawTags)) {
    throw new Error("save_shot_tags call had no shot_tags array");
  }
  if (rawTags.length !== batch.length) {
    console.warn(
      `[entity-tag] shot count mismatch — got ${rawTags.length}, expected ${batch.length}. Using whatever's present.`,
    );
  }

  for (const raw of rawTags) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.shot_id !== "string" || !validShotIds.has(r.shot_id)) continue;
    result.set(r.shot_id, resolveEntityNames(r.entity_names, nameToId));
  }
  return result;
}

/**
 * Tags every shot with the entities visually depicted in it. Shots are sent
 * in sequential batches of SHOT_BATCH_SIZE to bound tokens. Returns a Map of
 * shotId -> entity ids (only for shots Claude actually returned an entry for
 * — callers should leave any shot missing from the map untouched).
 */
export async function tagShots(
  entities: TaggableEntity[],
  shots: TaggableShot[],
): Promise<Map<string, string[]>> {
  const nameToId = new Map(entities.map((e) => [e.name.trim().toLowerCase(), e.id]));
  const combined = new Map<string, string[]>();

  if (entities.length === 0 || shots.length === 0) return combined;

  for (let i = 0; i < shots.length; i += SHOT_BATCH_SIZE) {
    const batch = shots.slice(i, i + SHOT_BATCH_SIZE);
    const batchResult = await tagShotBatch(entities, batch, nameToId);
    for (const [shotId, ids] of batchResult) {
      combined.set(shotId, ids);
    }
  }

  return combined;
}
