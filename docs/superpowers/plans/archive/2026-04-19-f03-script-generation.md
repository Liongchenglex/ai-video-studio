# F-03 Script Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users write a video brief, select duration/tone, and generate a structured scene-by-scene script via Claude — with inline editing, per-row regeneration, drag reordering, and add/delete scenes.

**Architecture:** The video brief, target duration, and tone are new fields on the `projects` table. A new `scenes` table stores one row per scene (voiceover, scene_description, image_prompt, duration_seconds, sort_order). Script generation calls Claude with tool use to return structured JSON. The UI is an editable table below the style profile section in the project workspace, with a "Video concept" section above it for the brief/duration/tone inputs.

**Tech Stack:** Claude Sonnet 4 via Anthropic API (tool use for structured output), Drizzle ORM + Neon Postgres, React table UI with inline editing, shadcn/ui components.

---

## File Structure

```
src/
├── lib/
│   ├── db/
│   │   └── schema.ts                        # MODIFY — add brief/duration/tone to projects + scenes table
│   ├── script-generation.ts                  # CREATE — Claude prompt + tool use for script generation
│   └── scene-utils.ts                        # CREATE — word count, duration estimation, reading pace helpers
├── app/
│   └── api/
│       └── projects/
│           └── [id]/
│               ├── route.ts                  # MODIFY — accept brief/targetDuration/tone in PATCH
│               ├── script/
│               │   └── generate/route.ts     # CREATE — POST triggers full script generation
│               └── scenes/
│                   ├── route.ts              # CREATE — GET list scenes, POST add scene
│                   ├── [sceneId]/
│                   │   └── route.ts          # CREATE — PATCH update scene, DELETE remove scene
│                   ├── [sceneId]/
│                   │   └── regenerate/route.ts # CREATE — POST regenerate single scene
│                   └── reorder/route.ts      # CREATE — PUT reorder scenes
├── components/
│   ├── video-brief.tsx                       # CREATE — brief textarea + duration/tone selectors
│   ├── script-table.tsx                      # CREATE — editable scene table with inline editing
│   ├── scene-row.tsx                         # CREATE — single editable row in the script table
│   └── project-workspace.tsx                 # MODIFY — add brief section + script table below style
└── app/
    └── projects/
        └── [id]/
            └── page.tsx                      # MODIFY — pass brief/scenes data to workspace
```

---

## Task 1: Database Schema — Brief Fields on Projects + Scenes Table

**Files:**
- Modify: `src/lib/db/schema.ts`

Adds video brief, target duration, and tone to the projects table. Creates the scenes table for storing script output.

- [ ] **Step 1: Add new imports and enums, then add fields to projects table and create scenes table**

Add `integer` to the drizzle-orm/pg-core import. Add a new enum for tone. Add brief fields to `projects` after the style profile columns. Add the `scenes` table after `styleTemplates`.

In the import statement, add `integer`:
```typescript
import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  pgEnum,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
```

Add a new enum before the `projects` table:
```typescript
export const toneEnum = pgEnum("tone", [
  "educational",
  "entertaining",
  "documentary",
  "satirical",
]);
```

Add these columns to the `projects` table after `stylePreviewPath`:
```typescript
    // ── Video brief (F-03) ──
    brief: text("brief"),
    targetDuration: integer("target_duration").default(5),
    tone: toneEnum("tone").default("educational"),
```

Add the `scenes` table after the `styleTemplates` type exports:
```typescript
// ─── Scenes (F-03) ──────────────────────────────────────────────────

export const scenes = pgTable(
  "scenes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    voiceover: text("voiceover").notNull(),
    sceneDescription: text("scene_description").notNull(),
    imagePrompt: text("image_prompt").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    isHook: boolean("is_hook").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("scenes_project_id_sort_order_idx").on(table.projectId, table.sortOrder),
  ],
);

export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;
```

- [ ] **Step 2: Push the schema**

Run:
```bash
npm run db:push
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts
git commit -m "feat(F-03): add video brief fields to projects and scenes table"
```

---

## Task 2: Scene Utility Helpers

**Files:**
- Create: `src/lib/scene-utils.ts`

Provides word count estimation, duration calculation from word count, and reading pace constants. Used by both the generation service and the UI.

- [ ] **Step 1: Create the scene utils module**

Create `src/lib/scene-utils.ts`:

```typescript
/**
 * Scene utility helpers for script generation and display.
 * Provides word counting, duration estimation, and reading pace calculations.
 */

/** Average narration pace: 150 words per minute */
const WORDS_PER_MINUTE = 150;

/**
 * Counts words in a text string.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Estimates speaking duration in seconds from a word count.
 */
export function wordsToDuration(wordCount: number): number {
  return Math.round((wordCount / WORDS_PER_MINUTE) * 60);
}

/**
 * Estimates the target word count for a given duration in minutes.
 */
export function durationToWords(durationMinutes: number): number {
  return durationMinutes * WORDS_PER_MINUTE;
}

/**
 * Calculates total duration in seconds from an array of scene durations.
 */
export function totalDuration(scenes: Array<{ durationSeconds: number }>): number {
  return scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
}

/**
 * Checks if the total duration drifts more than 15% from the target.
 * Returns the drift percentage (positive = over, negative = under).
 */
export function durationDrift(
  actualSeconds: number,
  targetMinutes: number,
): { drift: number; overTarget: boolean; warning: boolean } {
  const targetSeconds = targetMinutes * 60;
  if (targetSeconds === 0) return { drift: 0, overTarget: false, warning: false };
  const drift = ((actualSeconds - targetSeconds) / targetSeconds) * 100;
  return {
    drift: Math.round(drift),
    overTarget: drift > 0,
    warning: Math.abs(drift) > 15,
  };
}

/**
 * Formats seconds into a human-readable duration string (e.g. "5:30").
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/scene-utils.ts
git commit -m "feat(F-03): add scene utility helpers for duration and word count"
```

---

## Task 3: Script Generation Service (Claude Tool Use)

**Files:**
- Create: `src/lib/script-generation.ts`

The core service that calls Claude with tool use to generate a structured script. Takes the video brief, style context, duration, and tone as input. Returns an array of scene objects.

- [ ] **Step 1: Create the script generation service**

Create `src/lib/script-generation.ts`:

```typescript
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
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/script-generation.ts
git commit -m "feat(F-03): add Claude script generation service with tool use"
```

---

## Task 4: Update Project PATCH Endpoint for Brief/Duration/Tone

**Files:**
- Modify: `src/app/api/projects/[id]/route.ts`

Extends the existing PATCH endpoint to accept the new `brief`, `targetDuration`, and `tone` fields.

- [ ] **Step 1: Add validation for new fields**

In `src/app/api/projects/[id]/route.ts`, add the new fields to the PATCH handler. After the existing `status` validation block (around line 119), add:

```typescript
  if (body.brief !== undefined) {
    const brief = body.brief.trim();
    if (brief.length > 5000) {
      return NextResponse.json(
        { error: "Brief must be under 5000 characters" },
        { status: 400 },
      );
    }
    updates.brief = brief || null;
  }

  if (body.targetDuration !== undefined) {
    const validDurations = [3, 5, 8, 10];
    if (!validDurations.includes(body.targetDuration)) {
      return NextResponse.json(
        { error: `Target duration must be one of: ${validDurations.join(", ")} minutes` },
        { status: 400 },
      );
    }
    updates.targetDuration = body.targetDuration;
  }

  if (body.tone !== undefined) {
    const validTones = ["educational", "entertaining", "documentary", "satirical"];
    if (!validTones.includes(body.tone)) {
      return NextResponse.json(
        { error: `Tone must be one of: ${validTones.join(", ")}` },
        { status: 400 },
      );
    }
    updates.tone = body.tone;
  }
```

Also update the `body` type annotation to include the new fields:

```typescript
  let body: { name?: string; topic?: string; status?: string; brief?: string; targetDuration?: number; tone?: string };
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/[id]/route.ts
git commit -m "feat(F-03): extend project PATCH to accept brief, targetDuration, tone"
```

---

## Task 5: Script Generation Endpoint

**Files:**
- Create: `src/app/api/projects/[id]/script/generate/route.ts`

POST endpoint that triggers full script generation from the project's brief. Deletes existing scenes and replaces them with the new script.

- [ ] **Step 1: Create the generation endpoint**

Create `src/app/api/projects/[id]/script/generate/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/script/generate
 * Generates a full video script from the project's brief using Claude.
 * Replaces any existing scenes for this project.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { generateScript } from "@/lib/script-generation";

type Params = { params: Promise<{ id: string }> };

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

  if (!project.brief || project.brief.trim().length === 0) {
    return badRequestResponse("A video brief is required before generating a script");
  }

  try {
    const generatedScenes = await generateScript({
      brief: project.brief,
      targetDurationMinutes: project.targetDuration ?? 5,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
    });

    // Delete existing scenes for this project
    await db.delete(scenes).where(eq(scenes.projectId, id));

    // Insert new scenes
    const sceneRows = generatedScenes.map((s, i) => ({
      projectId: id,
      sortOrder: i,
      voiceover: s.voiceover,
      sceneDescription: s.scene_description,
      imagePrompt: s.image_prompt,
      durationSeconds: s.duration_seconds,
      isHook: s.is_hook,
    }));

    const inserted = await db.insert(scenes).values(sceneRows).returning();

    return NextResponse.json({ scenes: inserted });
  } catch (error) {
    console.error("Script generation failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Script generation failed. Please try again." },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/app/api/projects/[id]/script/generate/route.ts
git commit -m "feat(F-03): add script generation endpoint"
```

---

## Task 6: Scenes CRUD Endpoints

**Files:**
- Create: `src/app/api/projects/[id]/scenes/route.ts`
- Create: `src/app/api/projects/[id]/scenes/[sceneId]/route.ts`
- Create: `src/app/api/projects/[id]/scenes/[sceneId]/regenerate/route.ts`
- Create: `src/app/api/projects/[id]/scenes/reorder/route.ts`

Full CRUD for scenes: list, update inline, delete, regenerate single scene, reorder.

- [ ] **Step 1: Create the scenes list/add endpoint**

Create `src/app/api/projects/[id]/scenes/route.ts`:

```typescript
/**
 * GET  /api/projects/[id]/scenes — list all scenes for a project, ordered by sortOrder
 * POST /api/projects/[id]/scenes — add a new scene at a given position
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and, asc, gte } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
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

  const projectScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  return NextResponse.json(projectScenes);
}

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
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

  let body: {
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    insertAfter?: number;
  };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!body.voiceover?.trim() || !body.sceneDescription?.trim() || !body.imagePrompt?.trim()) {
    return badRequestResponse("voiceover, sceneDescription, and imagePrompt are required");
  }
  if (!body.durationSeconds || body.durationSeconds < 1 || body.durationSeconds > 120) {
    return badRequestResponse("durationSeconds must be between 1 and 120");
  }

  const insertAt = (body.insertAfter ?? -1) + 1;

  // Shift existing scenes down to make room
  await db
    .update(scenes)
    .set({ sortOrder: scenes.sortOrder })
    .where(and(eq(scenes.projectId, id), gte(scenes.sortOrder, insertAt)));

  // For the shift, we need raw SQL since Drizzle doesn't support column + 1 in set easily
  // Instead, fetch all scenes, recalculate order, and batch update
  const existing = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  // Insert the new scene
  const [newScene] = await db
    .insert(scenes)
    .values({
      projectId: id,
      sortOrder: insertAt,
      voiceover: body.voiceover.trim(),
      sceneDescription: body.sceneDescription.trim(),
      imagePrompt: body.imagePrompt.trim(),
      durationSeconds: body.durationSeconds,
      isHook: false,
    })
    .returning();

  // Re-number all scenes to ensure contiguous order
  const allScenes = [...existing.slice(0, insertAt), newScene, ...existing.slice(insertAt)];
  for (let i = 0; i < allScenes.length; i++) {
    if (allScenes[i].sortOrder !== i) {
      await db
        .update(scenes)
        .set({ sortOrder: i })
        .where(eq(scenes.id, allScenes[i].id));
    }
  }

  return NextResponse.json(newScene, { status: 201 });
}
```

- [ ] **Step 2: Create the single scene update/delete endpoint**

Create `src/app/api/projects/[id]/scenes/[sceneId]/route.ts`:

```typescript
/**
 * PATCH  /api/projects/[id]/scenes/[sceneId] — update scene fields inline
 * DELETE /api/projects/[id]/scenes/[sceneId] — remove a scene
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";

type Params = { params: Promise<{ id: string; sceneId: string }> };

async function verifyOwnership(projectId: string, userId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return project && !project.deletedAt ? project : null;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  if (!await verifyOwnership(id, session.user.id)) return notFoundResponse();

  let body: { voiceover?: string; sceneDescription?: string; imagePrompt?: string; durationSeconds?: number };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  const updates: Record<string, unknown> = {};

  if (body.voiceover !== undefined) {
    const v = body.voiceover.trim();
    if (v.length === 0) return badRequestResponse("Voiceover cannot be empty");
    updates.voiceover = v;
  }
  if (body.sceneDescription !== undefined) {
    const d = body.sceneDescription.trim();
    if (d.length === 0) return badRequestResponse("Scene description cannot be empty");
    updates.sceneDescription = d;
  }
  if (body.imagePrompt !== undefined) {
    const p = body.imagePrompt.trim();
    if (p.length === 0) return badRequestResponse("Image prompt cannot be empty");
    updates.imagePrompt = p;
  }
  if (body.durationSeconds !== undefined) {
    if (body.durationSeconds < 1 || body.durationSeconds > 120) {
      return badRequestResponse("Duration must be between 1 and 120 seconds");
    }
    updates.durationSeconds = body.durationSeconds;
  }

  if (Object.keys(updates).length === 0) {
    return badRequestResponse("No valid fields to update");
  }

  const [updated] = await db
    .update(scenes)
    .set(updates)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .returning();

  if (!updated) return notFoundResponse();

  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  if (!await verifyOwnership(id, session.user.id)) return notFoundResponse();

  const [deleted] = await db
    .delete(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .returning();

  if (!deleted) return notFoundResponse();

  // Re-number remaining scenes
  const remaining = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].sortOrder !== i) {
      await db.update(scenes).set({ sortOrder: i }).where(eq(scenes.id, remaining[i].id));
    }
  }

  return NextResponse.json({ message: "Scene deleted" });
}
```

- [ ] **Step 3: Create the regenerate endpoint**

Create `src/app/api/projects/[id]/scenes/[sceneId]/regenerate/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate
 * Regenerates a single scene using Claude, preserving surrounding context.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";
import { regenerateScene } from "@/lib/script-generation";

type Params = { params: Promise<{ id: string; sceneId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "generation");
  if (rateLimitError) return rateLimitError;

  const csrfError = await verifyCsrf(request);
  if (csrfError) return csrfError;

  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id, sceneId } = await params;
  if (!isValidUUID(id) || !isValidUUID(sceneId)) return badRequestResponse("Invalid ID");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, session.user.id)))
    .limit(1);

  if (!project || project.deletedAt) return notFoundResponse();

  if (!project.brief) {
    return badRequestResponse("Project has no brief");
  }

  const allScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));

  const sceneIndex = allScenes.findIndex((s) => s.id === sceneId);
  if (sceneIndex === -1) return notFoundResponse();

  const currentScene = allScenes[sceneIndex];
  const prevScene = sceneIndex > 0 ? allScenes[sceneIndex - 1] : undefined;
  const nextScene = sceneIndex < allScenes.length - 1 ? allScenes[sceneIndex + 1] : undefined;

  try {
    const regenerated = await regenerateScene({
      brief: project.brief,
      tone: project.tone ?? "educational",
      styleString: project.styleString,
      sceneNumber: sceneIndex + 1,
      totalScenes: allScenes.length,
      previousSceneVoiceover: prevScene?.voiceover,
      nextSceneVoiceover: nextScene?.voiceover,
      currentVoiceover: currentScene.voiceover,
      currentSceneDescription: currentScene.sceneDescription,
    });

    const [updated] = await db
      .update(scenes)
      .set({
        voiceover: regenerated.voiceover,
        sceneDescription: regenerated.scene_description,
        imagePrompt: regenerated.image_prompt,
        durationSeconds: regenerated.duration_seconds,
      })
      .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Scene regeneration failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Scene regeneration failed. Please try again." },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Create the reorder endpoint**

Create `src/app/api/projects/[id]/scenes/reorder/route.ts`:

```typescript
/**
 * PUT /api/projects/[id]/scenes/reorder
 * Reorders scenes by accepting an array of scene IDs in the desired order.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getSession,
  unauthorizedResponse,
  notFoundResponse,
  badRequestResponse,
  isValidUUID,
  verifyCsrf,
  applyRateLimit,
} from "@/lib/api-utils";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  const rateLimitError = applyRateLimit(request, "mutation");
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

  let body: { sceneIds: string[] };
  try {
    body = await request.json();
  } catch {
    return badRequestResponse("Invalid request body");
  }

  if (!Array.isArray(body.sceneIds) || body.sceneIds.length === 0) {
    return badRequestResponse("sceneIds array is required");
  }

  for (const sceneId of body.sceneIds) {
    if (!isValidUUID(sceneId)) {
      return badRequestResponse("Invalid scene ID in array");
    }
  }

  // Verify all scene IDs belong to this project
  const existingScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id));

  const existingIds = new Set(existingScenes.map((s) => s.id));
  for (const sceneId of body.sceneIds) {
    if (!existingIds.has(sceneId)) {
      return badRequestResponse("Scene ID does not belong to this project");
    }
  }

  // Update sort orders
  for (let i = 0; i < body.sceneIds.length; i++) {
    await db
      .update(scenes)
      .set({ sortOrder: i })
      .where(and(eq(scenes.id, body.sceneIds[i]), eq(scenes.projectId, id)));
  }

  return NextResponse.json({ message: "Scenes reordered" });
}
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/app/api/projects/[id]/scenes/ src/app/api/projects/[id]/script/
git commit -m "feat(F-03): add scenes CRUD, reorder, and regenerate endpoints"
```

---

## Task 7: Video Brief Component

**Files:**
- Create: `src/components/video-brief.tsx`

Textarea for the creative brief + duration/tone selectors. Auto-saves on blur.

- [ ] **Step 1: Add shadcn select component**

Run:
```bash
npx shadcn@latest add select --yes
```

- [ ] **Step 2: Create the video brief component**

Create `src/components/video-brief.tsx`:

```typescript
/**
 * Video brief input section. Captures the creative brief, target duration,
 * and tone — the three inputs that feed script generation (F-03).
 */
"use client";

import { useState, useCallback } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VideoBriefProps {
  projectId: string;
  initialBrief: string;
  initialDuration: number;
  initialTone: string;
  onGenerateScript: () => void;
  generating: boolean;
  hasScenes: boolean;
}

const DURATIONS = [
  { value: "3", label: "3 minutes" },
  { value: "5", label: "5 minutes" },
  { value: "8", label: "8 minutes" },
  { value: "10", label: "10 minutes" },
];

const TONES = [
  { value: "educational", label: "Educational" },
  { value: "entertaining", label: "Entertaining" },
  { value: "documentary", label: "Documentary" },
  { value: "satirical", label: "Satirical" },
];

export function VideoBrief({
  projectId,
  initialBrief,
  initialDuration,
  initialTone,
  onGenerateScript,
  generating,
  hasScenes,
}: VideoBriefProps) {
  const [brief, setBrief] = useState(initialBrief);
  const [duration, setDuration] = useState(String(initialDuration));
  const [tone, setTone] = useState(initialTone);
  const [saving, setSaving] = useState(false);

  const saveField = useCallback(
    async (field: string, value: string | number) => {
      setSaving(true);
      try {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: value }),
        });
      } finally {
        setSaving(false);
      }
    },
    [projectId],
  );

  const handleBriefBlur = useCallback(() => {
    if (brief.trim()) {
      saveField("brief", brief.trim());
    }
  }, [brief, saveField]);

  const handleDurationChange = useCallback(
    (value: string) => {
      setDuration(value);
      saveField("targetDuration", Number(value));
    },
    [saveField],
  );

  const handleToneChange = useCallback(
    (value: string) => {
      setTone(value);
      saveField("tone", value);
    },
    [saveField],
  );

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Video concept</h2>

      <div className="space-y-2">
        <Label htmlFor="brief">Brief</Label>
        <Textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          onBlur={handleBriefBlur}
          placeholder="Describe your video concept in detail. Include the topic, key points to cover, structure preferences, and any specific instructions..."
          rows={5}
          disabled={generating}
          className="resize-none"
        />
      </div>

      <div className="flex gap-4">
        <div className="space-y-2">
          <Label>Target duration</Label>
          <Select value={duration} onValueChange={handleDurationChange} disabled={generating}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Tone</Label>
          <Select value={tone} onValueChange={handleToneChange} disabled={generating}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button
        onClick={onGenerateScript}
        disabled={generating || !brief.trim()}
      >
        {generating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Generating script...
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-4 w-4" />
            {hasScenes ? "Regenerate script" : "Generate script"}
          </>
        )}
      </Button>
    </section>
  );
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/video-brief.tsx src/components/ui/select.tsx
git commit -m "feat(F-03): add video brief component with duration and tone selectors"
```

---

## Task 8: Script Table and Scene Row Components

**Files:**
- Create: `src/components/scene-row.tsx`
- Create: `src/components/script-table.tsx`

The editable table that displays the generated script. Each row is an inline-editable scene. Supports drag reorder, regenerate, add, and delete.

- [ ] **Step 1: Create the scene row component**

Create `src/components/scene-row.tsx`:

```typescript
/**
 * Single editable row in the script table.
 * Supports inline editing of voiceover, scene description, and image prompt.
 * Changes persist to the server on blur.
 */
"use client";

import { useState, useCallback } from "react";
import { GripVertical, RefreshCw, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface SceneRowProps {
  scene: SceneData;
  projectId: string;
  onUpdate: (sceneId: string, updated: SceneData) => void;
  onDelete: (sceneId: string) => void;
  onRegenerate: (sceneId: string) => void;
  regenerating: boolean;
  dragHandleProps?: Record<string, unknown>;
}

export function SceneRow({
  scene,
  projectId,
  onUpdate,
  onDelete,
  onRegenerate,
  regenerating,
}: SceneRowProps) {
  const [voiceover, setVoiceover] = useState(scene.voiceover);
  const [sceneDescription, setSceneDescription] = useState(scene.sceneDescription);
  const [imagePrompt, setImagePrompt] = useState(scene.imagePrompt);

  const saveField = useCallback(
    async (field: string, value: string) => {
      const res = await fetch(`/api/projects/${projectId}/scenes/${scene.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        const updated = await res.json();
        onUpdate(scene.id, updated);
      }
    },
    [projectId, scene.id, onUpdate],
  );

  return (
    <tr className="group border-b transition-colors hover:bg-muted/50">
      <td className="w-8 px-2 py-3 text-center align-top">
        <div className="flex items-center gap-1">
          <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground opacity-0 group-hover:opacity-100" />
          <span className="text-sm text-muted-foreground">{scene.sortOrder + 1}</span>
        </div>
        {scene.isHook && (
          <Badge variant="secondary" className="mt-1 text-[10px]">
            Hook
          </Badge>
        )}
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={voiceover}
          onChange={(e) => setVoiceover(e.target.value)}
          onBlur={() => {
            if (voiceover.trim() !== scene.voiceover) {
              saveField("voiceover", voiceover.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={sceneDescription}
          onChange={(e) => setSceneDescription(e.target.value)}
          onBlur={() => {
            if (sceneDescription.trim() !== scene.sceneDescription) {
              saveField("sceneDescription", sceneDescription.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="px-2 py-3 align-top">
        <textarea
          value={imagePrompt}
          onChange={(e) => setImagePrompt(e.target.value)}
          onBlur={() => {
            if (imagePrompt.trim() !== scene.imagePrompt) {
              saveField("imagePrompt", imagePrompt.trim());
            }
          }}
          className="w-full resize-none rounded border-0 bg-transparent p-1 text-sm focus:bg-background focus:ring-1 focus:ring-ring"
          rows={3}
          disabled={regenerating}
        />
      </td>
      <td className="w-16 px-2 py-3 text-center align-top">
        <span className="text-sm">{scene.durationSeconds}s</span>
      </td>
      <td className="w-20 px-2 py-3 align-top">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerate(scene.id)}
            disabled={regenerating}
            title="Regenerate scene"
          >
            {regenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => onDelete(scene.id)}
            disabled={regenerating}
            title="Delete scene"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Create the script table component**

Create `src/components/script-table.tsx`:

```typescript
/**
 * Editable script table displaying all scenes for a project.
 * Supports inline editing, regeneration, deletion, and shows
 * a running duration counter with drift warning.
 */
"use client";

import { useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SceneRow } from "@/components/scene-row";
import { totalDuration, durationDrift, formatDuration } from "@/lib/scene-utils";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
}

interface ScriptTableProps {
  projectId: string;
  initialScenes: SceneData[];
  targetDuration: number;
}

export function ScriptTable({
  projectId,
  initialScenes,
  targetDuration,
}: ScriptTableProps) {
  const [scenes, setScenes] = useState<SceneData[]>(initialScenes);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const total = totalDuration(scenes);
  const drift = durationDrift(total, targetDuration);

  const handleUpdate = useCallback((sceneId: string, updated: SceneData) => {
    setScenes((prev) => prev.map((s) => (s.id === sceneId ? updated : s)));
  }, []);

  const handleDelete = useCallback(
    async (sceneId: string) => {
      const res = await fetch(`/api/projects/${projectId}/scenes/${sceneId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setScenes((prev) => {
          const filtered = prev.filter((s) => s.id !== sceneId);
          return filtered.map((s, i) => ({ ...s, sortOrder: i }));
        });
      }
    },
    [projectId],
  );

  const handleRegenerate = useCallback(
    async (sceneId: string) => {
      setRegeneratingId(sceneId);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/scenes/${sceneId}/regenerate`,
          { method: "POST" },
        );
        if (res.ok) {
          const updated = await res.json();
          setScenes((prev) => prev.map((s) => (s.id === sceneId ? updated : s)));
        }
      } finally {
        setRegeneratingId(null);
      }
    },
    [projectId],
  );

  const handleAddScene = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voiceover: "New scene voiceover...",
        sceneDescription: "Describe what happens on screen...",
        imagePrompt: "Describe the key visual for this scene...",
        durationSeconds: 10,
        insertAfter: scenes.length - 1,
      }),
    });
    if (res.ok) {
      const newScene = await res.json();
      setScenes((prev) => [...prev, newScene]);
    }
  }, [projectId, scenes.length]);

  if (scenes.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Script</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {scenes.length} scenes
          </span>
          <span
            className={`text-sm font-medium ${drift.warning ? "text-destructive" : "text-muted-foreground"}`}
          >
            {formatDuration(total)} / {targetDuration}:00 target
            {drift.warning && ` (${drift.drift > 0 ? "+" : ""}${drift.drift}%)`}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className="w-8 px-2 py-2 text-xs font-medium text-muted-foreground">#</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Voiceover</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Scene description</th>
              <th className="px-2 py-2 text-xs font-medium text-muted-foreground">Image prompt</th>
              <th className="w-16 px-2 py-2 text-xs font-medium text-muted-foreground">Duration</th>
              <th className="w-20 px-2 py-2 text-xs font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {scenes.map((scene) => (
              <SceneRow
                key={scene.id}
                scene={scene}
                projectId={projectId}
                onUpdate={handleUpdate}
                onDelete={handleDelete}
                onRegenerate={handleRegenerate}
                regenerating={regeneratingId === scene.id}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Button variant="outline" size="sm" onClick={handleAddScene}>
        <Plus className="mr-1 h-3 w-3" />
        Add scene
      </Button>
    </section>
  );
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/scene-row.tsx src/components/script-table.tsx
git commit -m "feat(F-03): add script table and scene row components with inline editing"
```

---

## Task 9: Integrate Brief + Script Table into Project Workspace

**Files:**
- Modify: `src/components/project-workspace.tsx`
- Modify: `src/app/projects/[id]/page.tsx`

Wires the video brief section and script table into the project workspace, below the style profile section.

- [ ] **Step 1: Update the server component to pass brief and scene data**

In `src/app/projects/[id]/page.tsx`, add the scenes import and query. Add `scenes` import:

```typescript
import { projects, scenes } from "@/lib/db/schema";
```

Add `asc` to the drizzle-orm import:

```typescript
import { eq, asc } from "drizzle-orm";
```

After the existing project query, add the scenes query:

```typescript
  const projectScenes = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id))
    .orderBy(asc(scenes.sortOrder));
```

Add the new fields to the `ProjectWorkspace` props:

```typescript
      <ProjectWorkspace
        project={{
          id: project.id,
          name: project.name,
          topic: project.topic,
          status: project.status,
          styleString: project.styleString,
          styleRefPaths: project.styleRefPaths,
          styleRefUrls,
          stylePreviewUrl,
          brief: project.brief,
          targetDuration: project.targetDuration ?? 5,
          tone: project.tone ?? "educational",
        }}
        initialScenes={projectScenes}
      />
```

- [ ] **Step 2: Update the workspace component**

In `src/components/project-workspace.tsx`:

Add imports for the new components:

```typescript
import { VideoBrief } from "@/components/video-brief";
import { ScriptTable } from "@/components/script-table";
```

Update the `ProjectWorkspaceProps` interface to include the new fields:

```typescript
interface ProjectWorkspaceProps {
  project: {
    id: string;
    name: string;
    topic: string | null;
    status: string;
    styleString: string | null;
    styleRefPaths: string[] | null;
    styleRefUrls: string[];
    stylePreviewUrl: string | null;
    brief: string | null;
    targetDuration: number;
    tone: string;
  };
  initialScenes: Array<{
    id: string;
    sortOrder: number;
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    isHook: boolean;
  }>;
}
```

Update the function signature:

```typescript
export function ProjectWorkspace({ project, initialScenes }: ProjectWorkspaceProps) {
```

Add script generation state inside the component:

```typescript
  const [scenes, setScenes] = useState(initialScenes);
  const [generatingScript, setGeneratingScript] = useState(false);
```

Add the generate script handler:

```typescript
  const handleGenerateScript = useCallback(async () => {
    setGeneratingScript(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/script/generate`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setScenes(data.scenes);
      }
    } finally {
      setGeneratingScript(false);
    }
  }, [project.id]);
```

Add the Video Brief and Script Table sections after the style profile closing `</div>` (after the grid with style + templates), before the closing `</main>`:

```typescript
      <Separator className="my-8" />

      {/* Video Brief Section */}
      <VideoBrief
        projectId={project.id}
        initialBrief={project.brief || ""}
        initialDuration={project.targetDuration}
        initialTone={project.tone}
        onGenerateScript={handleGenerateScript}
        generating={generatingScript}
        hasScenes={scenes.length > 0}
      />

      {/* Script Table */}
      {scenes.length > 0 && (
        <>
          <Separator className="my-8" />
          <ScriptTable
            projectId={project.id}
            initialScenes={scenes}
            targetDuration={project.targetDuration}
          />
        </>
      )}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Start dev server and verify the UI renders**

Run: `npm run dev`

Navigate to a project. Verify:
1. The "Video concept" section appears below the style profile
2. The brief textarea, duration selector, and tone selector render correctly
3. The "Generate script" button is disabled when the brief is empty

- [ ] **Step 5: Commit**

```bash
git add src/components/project-workspace.tsx src/app/projects/[id]/page.tsx
git commit -m "feat(F-03): integrate video brief and script table into project workspace"
```

---

## Task 10: End-to-End Test

This task validates the full F-03 flow. No new files.

**Prerequisites:** `ANTHROPIC_API_KEY` set in `.env`.

- [ ] **Step 1: Test script generation**

1. Open a project with style profile already set up
2. Write a brief: "Produce a 5-minute educational video about how black holes form. Cover stellar collapse, the event horizon, and Hawking radiation. Start with a dramatic hook about what would happen if you fell into one."
3. Set duration to 5 minutes, tone to educational
4. Click "Generate script"
5. Verify: scenes appear in the table within ~10 seconds, total duration is near 5:00, first scenes have "Hook" badge

- [ ] **Step 2: Test inline editing**

1. Edit a voiceover cell — change some text, click away
2. Verify the change persists after page reload

- [ ] **Step 3: Test scene regeneration**

1. Click the regenerate button on a scene
2. Verify the scene updates with new content while preserving its position

- [ ] **Step 4: Test add/delete**

1. Click "Add scene" — verify a new row appears at the bottom
2. Click the delete button on a scene — verify it's removed and rows renumber

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(F-03): polish script generation after manual testing"
```
