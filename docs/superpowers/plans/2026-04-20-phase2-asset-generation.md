# Phase 2: Asset Generation (F-04 + F-05 + F-06) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate scene images (FLUX.1 Kontext), voiceover audio (ElevenLabs TTS with timestamps), and background music (ElevenLabs Music) for every scene in a project — orchestrated via Inngest for parallel execution, retry, and progress tracking.

**Architecture:** Inngest functions handle all generation work: one event triggers a fan-out that generates images in parallel, voiceover sequentially (rate limits), and music in a single call. Each generated asset is uploaded to R2 and its path stored on the scene/project record. The UI shows a new Step 3 (Visuals + Voice) with per-scene cards showing image + audio, a voice selector panel, and generation progress indicators. Music surfaces on Step 4 (future) but generates in the background from Step 3.

**Tech Stack:** Inngest (durable functions, fan-out), fal.ai SDK (FLUX.1 Kontext for images), ElevenLabs JS SDK (TTS with timestamps, Music API), Cloudflare R2 (asset storage), Drizzle ORM + Neon Postgres, React + shadcn/ui.

---

## Prerequisites

Install new dependencies:

```bash
npm install inngest @elevenlabs/elevenlabs-js
```

Add to `.env`:
```
# ElevenLabs
ELEVENLABS_API_KEY=your-elevenlabs-key
```

Add to `.env.example`:
```
# ElevenLabs
ELEVENLABS_API_KEY=your-elevenlabs-key
```

---

## File Structure

```
src/
├── inngest/
│   ├── client.ts                          # CREATE — Inngest client instance
│   ├── functions/
│   │   ├── generate-scene-image.ts        # CREATE — per-scene image generation function
│   │   ├── generate-scene-voiceover.ts    # CREATE — per-scene voiceover generation function
│   │   ├── generate-music.ts              # CREATE — project-level music generation function
│   │   └── generate-all-assets.ts         # CREATE — orchestrator that fans out scene jobs
│   └── index.ts                           # CREATE — exports all functions for serve
├── lib/
│   ├── db/
│   │   └── schema.ts                      # MODIFY — add asset fields to scenes + music fields to projects
│   ├── image-generation.ts                # CREATE — FLUX.1 Kontext / Imagen 4 image gen service
│   ├── voiceover-generation.ts            # CREATE — ElevenLabs TTS with timestamps
│   ├── music-generation.ts                # CREATE — ElevenLabs Music generation
│   └── voice-presets.ts                   # CREATE — 6 preset voice IDs config
├── app/
│   └── api/
│       ├── inngest/route.ts               # CREATE — Inngest serve endpoint
│       └── projects/
│           └── [id]/
│               ├── generate-assets/route.ts  # CREATE — POST triggers all asset generation
│               └── scenes/
│                   └── [sceneId]/
│                       ├── regenerate-image/route.ts   # CREATE — POST regenerate single image
│                       └── regenerate-voice/route.ts   # CREATE — POST regenerate single VO
├── components/
│   ├── scene-card.tsx                     # CREATE — visual card with image + audio player
│   ├── voice-selector.tsx                 # CREATE — voice preset picker panel
│   ├── generation-progress.tsx            # CREATE — progress indicator for asset generation
│   └── step-visuals.tsx                   # CREATE — Step 3 Visuals + Voice content
│   └── project-workspace.tsx              # MODIFY — add Step 3 to stepper
```

---

## Task 1: Database Schema — Asset Fields on Scenes + Music on Projects

**Files:**
- Modify: `src/lib/db/schema.ts`

Adds asset tracking fields to the scenes table (image path, voiceover path, timestamps) and music fields to the projects table.

- [ ] **Step 1: Add asset fields to scenes and music fields to projects**

In `src/lib/db/schema.ts`:

Add a new enum before the `projects` table:
```typescript
export const generationStatusEnum = pgEnum("generation_status", [
  "pending",
  "generating",
  "done",
  "failed",
]);
```

Add these columns to the `projects` table after the `tone` field:
```typescript
    // ── Music (F-06) ──
    musicPath: text("music_path"),
    musicStatus: generationStatusEnum("music_status").default("pending"),
    musicMood: text("music_mood").default("ambient"),
    voiceId: text("voice_id").default("21m00Tcm4TlvDq8ikWAM"),
```

Add these columns to the `scenes` table after `isHook`:
```typescript
    // ── Generated assets (F-04 + F-05) ──
    imagePath: text("image_path"),
    imageStatus: generationStatusEnum("image_status").default("pending"),
    voiceoverPath: text("voiceover_path"),
    voiceoverStatus: generationStatusEnum("voiceover_status").default("pending"),
    voiceoverTimestamps: jsonb("voiceover_timestamps").$type<{
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    }>(),
```

- [ ] **Step 2: Push schema**

Run: `npm run db:push`

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts
git commit -m "feat(Phase2): add asset generation fields to scenes and music fields to projects"
```

---

## Task 2: Inngest Client + Serve Endpoint

**Files:**
- Create: `src/inngest/client.ts`
- Create: `src/inngest/index.ts`
- Create: `src/app/api/inngest/route.ts`

Sets up the Inngest client and the Next.js serve endpoint. This is the infrastructure all generation functions plug into.

- [ ] **Step 1: Create the Inngest client**

Create `src/inngest/client.ts`:

```typescript
/**
 * Inngest client instance for the AI Video Studio app.
 * Used by all Inngest functions and the serve endpoint.
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "ai-video-studio",
});
```

- [ ] **Step 2: Create the index file (will export functions later)**

Create `src/inngest/index.ts`:

```typescript
/**
 * Inngest function registry. All functions are exported here
 * and served via the /api/inngest endpoint.
 */
export { inngest } from "./client";

// Functions will be added as they're created
export const functions: Array<ReturnType<typeof import("./client").inngest.createFunction>> = [];
```

- [ ] **Step 3: Create the serve endpoint**

Create `src/app/api/inngest/route.ts`:

```typescript
/**
 * Inngest serve endpoint. Exposes all Inngest functions
 * via HTTP for the Inngest Dev Server / Cloud to invoke.
 */
import { serve } from "inngest/next";
import { inngest, functions } from "@/inngest";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/inngest/ src/app/api/inngest/
git commit -m "feat(Phase2): set up Inngest client and serve endpoint"
```

---

## Task 3: Voice Presets Config

**Files:**
- Create: `src/lib/voice-presets.ts`

Hardcoded list of 6 ElevenLabs voice IDs (3 female, 3 male) for v1.0. These are curated from ElevenLabs' default library for narration clarity.

- [ ] **Step 1: Create the voice presets config**

Create `src/lib/voice-presets.ts`:

```typescript
/**
 * Curated voice presets for v1.0 (6 voices: 3 female, 3 male).
 * Selected from ElevenLabs' default library for narration warmth and clarity.
 * Voice IDs are from ElevenLabs' pre-made voices.
 */

export interface VoicePreset {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
}

export const VOICE_PRESETS: VoicePreset[] = [
  // Female voices
  {
    id: "21m00Tcm4TlvDq8ikWAM",
    name: "Rachel",
    gender: "female",
    description: "Calm, clear, American",
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Bella",
    gender: "female",
    description: "Warm, engaging, American",
  },
  {
    id: "MF3mGyEYCl7XYWbV9V6O",
    name: "Elli",
    gender: "female",
    description: "Young, energetic, American",
  },
  // Male voices
  {
    id: "ErXwobaYiN019PkySvjV",
    name: "Antoni",
    gender: "male",
    description: "Warm, conversational, American",
  },
  {
    id: "VR6AewLTigWG4xSOukaG",
    name: "Arnold",
    gender: "male",
    description: "Deep, authoritative, American",
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    name: "Adam",
    gender: "male",
    description: "Deep, narration, American",
  },
];

export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel

export function getVoicePreset(id: string): VoicePreset | undefined {
  return VOICE_PRESETS.find((v) => v.id === id);
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/voice-presets.ts
git commit -m "feat(F-05): add 6 curated voice presets for v1.0"
```

---

## Task 4: Image Generation Service

**Files:**
- Create: `src/lib/image-generation.ts`

Wraps fal.ai FLUX.1 Kontext calls. Takes an image prompt + optional style refs, generates an image, downloads it to R2, returns the R2 key.

- [ ] **Step 1: Create the image generation service**

Create `src/lib/image-generation.ts`:

```typescript
/**
 * Image generation service using FLUX.1 Kontext via fal.ai.
 * Generates a scene image from an image prompt and optional style references.
 * Downloads the result and stores it in R2.
 */
import { fal } from "@fal-ai/client";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, getDownloadUrl } from "@/lib/r2";

fal.config({ credentials: process.env.FAL_KEY! });

interface GenerateImageInput {
  projectId: string;
  sceneId: string;
  imagePrompt: string;
  styleString?: string | null;
  styleRefPaths?: string[] | null;
}

interface GenerateImageResult {
  r2Key: string;
  downloadUrl: string;
}

/**
 * Generates a scene image and stores it in R2.
 * Uses FLUX.1 Kontext when style references exist, otherwise text-only.
 */
export async function generateSceneImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const prompt = input.styleString
    ? `${input.styleString}. ${input.imagePrompt}`
    : input.imagePrompt;

  let imageUrl: string;

  if (input.styleRefPaths && input.styleRefPaths.length > 0) {
    // FLUX.1 Kontext with style references
    const refUrls = await Promise.all(input.styleRefPaths.map(getDownloadUrl));

    const result = await fal.subscribe("fal-ai/flux-pro/kontext/max/multi", {
      input: {
        prompt,
        image_urls: refUrls,
        num_images: 1,
        output_format: "png",
        safety_tolerance: "2",
      },
    });

    const output = result.data as { images?: Array<{ url: string }> };
    if (!output.images || output.images.length === 0) {
      throw new Error("FLUX.1 Kontext returned no images");
    }
    imageUrl = output.images[0].url;
  } else {
    // Text-only fallback — still use FLUX.1 Kontext without refs
    const result = await fal.subscribe("fal-ai/flux-pro/kontext/max/multi", {
      input: {
        prompt,
        num_images: 1,
        output_format: "png",
        safety_tolerance: "2",
      },
    });

    const output = result.data as { images?: Array<{ url: string }> };
    if (!output.images || output.images.length === 0) {
      throw new Error("Image generation returned no images");
    }
    imageUrl = output.images[0].url;
  }

  // Download from fal.ai and upload to R2
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error("Failed to download generated image");
  }
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const contentType = imageRes.headers.get("content-type") || "image/png";

  const r2Key = `projects/${input.projectId}/scenes/${input.sceneId}/image.png`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );

  const downloadUrl = await getDownloadUrl(r2Key);
  return { r2Key, downloadUrl };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/image-generation.ts
git commit -m "feat(F-04): add image generation service with FLUX.1 Kontext"
```

---

## Task 5: Voiceover Generation Service

**Files:**
- Create: `src/lib/voiceover-generation.ts`

Wraps ElevenLabs TTS with timestamps. Generates audio for a scene's voiceover text, uploads MP3 to R2, returns the R2 key and word-level timing data.

- [ ] **Step 1: Create the voiceover generation service**

Create `src/lib/voiceover-generation.ts`:

```typescript
/**
 * Voiceover generation service using ElevenLabs TTS.
 * Generates narration audio with word-level timestamps for sync.
 * Stores MP3 in R2 and returns timing data for captions/assembly.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

interface GenerateVoiceoverInput {
  projectId: string;
  sceneId: string;
  text: string;
  voiceId: string;
}

interface VoiceoverTimestamps {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface GenerateVoiceoverResult {
  r2Key: string;
  timestamps: VoiceoverTimestamps;
  durationSeconds: number;
}

/**
 * Generates voiceover audio with timestamps and stores in R2.
 */
export async function generateSceneVoiceover(
  input: GenerateVoiceoverInput,
): Promise<GenerateVoiceoverResult> {
  const result = await elevenlabs.textToSpeech.convertWithTimestamps(
    input.voiceId,
    {
      text: input.text,
      model_id: "eleven_multilingual_v2",
      output_format: "mp3_44100_128",
    },
  );

  if (!result.audio_base64) {
    throw new Error("ElevenLabs returned no audio");
  }

  // Decode base64 audio
  const audioBuffer = Buffer.from(result.audio_base64, "base64");

  // Upload to R2
  const r2Key = `projects/${input.projectId}/scenes/${input.sceneId}/voiceover.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  // Extract timestamps
  const timestamps: VoiceoverTimestamps = {
    characters: result.alignment?.characters || [],
    character_start_times_seconds: result.alignment?.character_start_times_seconds || [],
    character_end_times_seconds: result.alignment?.character_end_times_seconds || [],
  };

  // Calculate duration from the last timestamp
  const endTimes = timestamps.character_end_times_seconds;
  const durationSeconds = endTimes.length > 0
    ? Math.ceil(endTimes[endTimes.length - 1])
    : 0;

  return { r2Key, timestamps, durationSeconds };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/voiceover-generation.ts
git commit -m "feat(F-05): add voiceover generation service with ElevenLabs TTS timestamps"
```

---

## Task 6: Music Generation Service

**Files:**
- Create: `src/lib/music-generation.ts`

Wraps ElevenLabs Music API. Generates a background music track for the full video duration.

- [ ] **Step 1: Create the music generation service**

Create `src/lib/music-generation.ts`:

```typescript
/**
 * Background music generation service using ElevenLabs Music API.
 * Generates a commercially cleared music track matching the video mood.
 * Stores MP3 in R2.
 */
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "@/lib/r2";

interface GenerateMusicInput {
  projectId: string;
  mood: string;
  durationSeconds: number;
}

interface GenerateMusicResult {
  r2Key: string;
}

const MOOD_PROMPTS: Record<string, string> = {
  epic: "Epic cinematic orchestral music, dramatic and powerful, suitable for documentary narration",
  ambient: "Calm ambient background music, soft and atmospheric, suitable for educational narration",
  playful: "Playful upbeat background music, light and fun, suitable for entertaining narration",
};

/**
 * Generates background music and stores in R2.
 * Uses ElevenLabs Music API for commercially cleared tracks.
 */
export async function generateMusic(
  input: GenerateMusicInput,
): Promise<GenerateMusicResult> {
  const prompt = MOOD_PROMPTS[input.mood] || MOOD_PROMPTS.ambient;

  const response = await fetch("https://api.elevenlabs.io/v1/music", {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      duration_seconds: input.durationSeconds,
      output_format: "mp3_44100_128",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs Music API failed: ${response.status} ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  const r2Key = `projects/${input.projectId}/music.mp3`;
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: r2Key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
    }),
  );

  return { r2Key };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/music-generation.ts
git commit -m "feat(F-06): add music generation service with ElevenLabs Music API"
```

---

## Task 7: Inngest Functions — Per-Scene Image + Voiceover + Music + Orchestrator

**Files:**
- Create: `src/inngest/functions/generate-scene-image.ts`
- Create: `src/inngest/functions/generate-scene-voiceover.ts`
- Create: `src/inngest/functions/generate-music.ts`
- Create: `src/inngest/functions/generate-all-assets.ts`
- Modify: `src/inngest/index.ts`

These are the durable Inngest functions that orchestrate generation. The orchestrator fires one event per scene for images (parallel), loops scenes sequentially for voiceover, and fires one music event.

- [ ] **Step 1: Create the image generation function**

Create `src/inngest/functions/generate-scene-image.ts`:

```typescript
/**
 * Inngest function: generates a single scene's image.
 * Triggered per-scene in parallel by the orchestrator.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { scenes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateSceneImage } from "@/lib/image-generation";

export const generateSceneImageFn = inngest.createFunction(
  {
    id: "generate-scene-image",
    retries: 3,
    concurrency: { limit: 5 },
  },
  { event: "scene/image.generate" },
  async ({ event, step }) => {
    const { sceneId, projectId, imagePrompt, styleString, styleRefPaths } = event.data;

    await step.run("set-status-generating", async () => {
      await db
        .update(scenes)
        .set({ imageStatus: "generating" })
        .where(eq(scenes.id, sceneId));
    });

    const result = await step.run("generate-image", async () => {
      return await generateSceneImage({
        projectId,
        sceneId,
        imagePrompt,
        styleString,
        styleRefPaths,
      });
    });

    await step.run("save-result", async () => {
      await db
        .update(scenes)
        .set({
          imagePath: result.r2Key,
          imageStatus: "done",
        })
        .where(eq(scenes.id, sceneId));
    });

    return { sceneId, imagePath: result.r2Key };
  },
);
```

- [ ] **Step 2: Create the voiceover generation function**

Create `src/inngest/functions/generate-scene-voiceover.ts`:

```typescript
/**
 * Inngest function: generates a single scene's voiceover.
 * Triggered per-scene sequentially by the orchestrator.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { scenes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateSceneVoiceover } from "@/lib/voiceover-generation";

export const generateSceneVoiceoverFn = inngest.createFunction(
  {
    id: "generate-scene-voiceover",
    retries: 3,
    concurrency: { limit: 2 },
  },
  { event: "scene/voiceover.generate" },
  async ({ event, step }) => {
    const { sceneId, projectId, text, voiceId } = event.data;

    await step.run("set-status-generating", async () => {
      await db
        .update(scenes)
        .set({ voiceoverStatus: "generating" })
        .where(eq(scenes.id, sceneId));
    });

    const result = await step.run("generate-voiceover", async () => {
      return await generateSceneVoiceover({
        projectId,
        sceneId,
        text,
        voiceId,
      });
    });

    await step.run("save-result", async () => {
      await db
        .update(scenes)
        .set({
          voiceoverPath: result.r2Key,
          voiceoverStatus: "done",
          voiceoverTimestamps: result.timestamps,
          durationSeconds: result.durationSeconds,
        })
        .where(eq(scenes.id, sceneId));
    });

    return { sceneId, voiceoverPath: result.r2Key };
  },
);
```

- [ ] **Step 3: Create the music generation function**

Create `src/inngest/functions/generate-music.ts`:

```typescript
/**
 * Inngest function: generates background music for the project.
 * One track per project, matching the total video duration.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateMusic } from "@/lib/music-generation";

export const generateMusicFn = inngest.createFunction(
  {
    id: "generate-music",
    retries: 3,
  },
  { event: "project/music.generate" },
  async ({ event, step }) => {
    const { projectId, mood, durationSeconds } = event.data;

    await step.run("set-status-generating", async () => {
      await db
        .update(projects)
        .set({ musicStatus: "generating" })
        .where(eq(projects.id, projectId));
    });

    const result = await step.run("generate-music", async () => {
      return await generateMusic({
        projectId,
        mood,
        durationSeconds,
      });
    });

    await step.run("save-result", async () => {
      await db
        .update(projects)
        .set({
          musicPath: result.r2Key,
          musicStatus: "done",
        })
        .where(eq(projects.id, projectId));
    });

    return { projectId, musicPath: result.r2Key };
  },
);
```

- [ ] **Step 4: Create the orchestrator function**

Create `src/inngest/functions/generate-all-assets.ts`:

```typescript
/**
 * Inngest orchestrator: fans out image + voiceover + music generation
 * for all scenes in a project. Triggered when user finalises the script.
 */
import { inngest } from "../client";
import { db } from "@/lib/db";
import { projects, scenes } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";

export const generateAllAssetsFn = inngest.createFunction(
  {
    id: "generate-all-assets",
  },
  { event: "project/assets.generate" },
  async ({ event, step }) => {
    const { projectId } = event.data;

    const { project, projectScenes } = await step.run("load-project-data", async () => {
      const [proj] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      const scns = await db
        .select()
        .from(scenes)
        .where(eq(scenes.projectId, projectId))
        .orderBy(asc(scenes.sortOrder));

      return { project: proj, projectScenes: scns };
    });

    if (!project || projectScenes.length === 0) {
      throw new Error("Project or scenes not found");
    }

    // Fan out image generation — all scenes in parallel
    const imageEvents = projectScenes.map((scene) => ({
      name: "scene/image.generate" as const,
      data: {
        sceneId: scene.id,
        projectId,
        imagePrompt: scene.imagePrompt,
        styleString: project.styleString,
        styleRefPaths: project.styleRefPaths,
      },
    }));

    await step.sendEvent("trigger-image-generation", imageEvents);

    // Fan out voiceover generation — all scenes (concurrency limit handles rate limiting)
    const voiceoverEvents = projectScenes.map((scene) => ({
      name: "scene/voiceover.generate" as const,
      data: {
        sceneId: scene.id,
        projectId,
        text: scene.voiceover,
        voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
      },
    }));

    await step.sendEvent("trigger-voiceover-generation", voiceoverEvents);

    // Trigger music generation
    const totalDuration = projectScenes.reduce(
      (sum, s) => sum + s.durationSeconds,
      0,
    );

    await step.sendEvent("trigger-music-generation", {
      name: "project/music.generate",
      data: {
        projectId,
        mood: project.musicMood || "ambient",
        durationSeconds: totalDuration,
      },
    });

    return { projectId, scenesCount: projectScenes.length };
  },
);
```

- [ ] **Step 5: Update the index to export all functions**

Replace `src/inngest/index.ts` with:

```typescript
/**
 * Inngest function registry. All functions are exported here
 * and served via the /api/inngest endpoint.
 */
export { inngest } from "./client";

import { generateSceneImageFn } from "./functions/generate-scene-image";
import { generateSceneVoiceoverFn } from "./functions/generate-scene-voiceover";
import { generateMusicFn } from "./functions/generate-music";
import { generateAllAssetsFn } from "./functions/generate-all-assets";

export const functions = [
  generateSceneImageFn,
  generateSceneVoiceoverFn,
  generateMusicFn,
  generateAllAssetsFn,
];
```

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/inngest/
git commit -m "feat(Phase2): add Inngest functions for image, voiceover, music generation and orchestrator"
```

---

## Task 8: Generate Assets API Endpoint + Per-Scene Regeneration

**Files:**
- Create: `src/app/api/projects/[id]/generate-assets/route.ts`
- Create: `src/app/api/projects/[id]/scenes/[sceneId]/regenerate-image/route.ts`
- Create: `src/app/api/projects/[id]/scenes/[sceneId]/regenerate-voice/route.ts`

- [ ] **Step 1: Create the generate-all-assets trigger endpoint**

Create `src/app/api/projects/[id]/generate-assets/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/generate-assets
 * Triggers Inngest to generate all assets (images + voiceover + music)
 * for every scene in the project.
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
import { inngest } from "@/inngest";

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

  // Verify scenes exist
  const sceneCount = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, id));

  if (sceneCount.length === 0) {
    return badRequestResponse("Generate a script first");
  }

  // Reset all scene asset statuses to pending
  await db
    .update(scenes)
    .set({ imageStatus: "pending", voiceoverStatus: "pending" })
    .where(eq(scenes.projectId, id));

  await db
    .update(projects)
    .set({ musicStatus: "pending" })
    .where(eq(projects.id, id));

  // Trigger the orchestrator
  await inngest.send({
    name: "project/assets.generate",
    data: { projectId: id },
  });

  return NextResponse.json({ message: "Asset generation started" });
}
```

- [ ] **Step 2: Create the regenerate-image endpoint**

Create `src/app/api/projects/[id]/scenes/[sceneId]/regenerate-image/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate-image
 * Triggers regeneration of a single scene's image via Inngest.
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
import { inngest } from "@/inngest";

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

  const [scene] = await db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .limit(1);

  if (!scene) return notFoundResponse();

  await db
    .update(scenes)
    .set({ imageStatus: "pending" })
    .where(eq(scenes.id, sceneId));

  await inngest.send({
    name: "scene/image.generate",
    data: {
      sceneId,
      projectId: id,
      imagePrompt: scene.imagePrompt,
      styleString: project.styleString,
      styleRefPaths: project.styleRefPaths,
    },
  });

  return NextResponse.json({ message: "Image regeneration started" });
}
```

- [ ] **Step 3: Create the regenerate-voice endpoint**

Create `src/app/api/projects/[id]/scenes/[sceneId]/regenerate-voice/route.ts`:

```typescript
/**
 * POST /api/projects/[id]/scenes/[sceneId]/regenerate-voice
 * Triggers regeneration of a single scene's voiceover via Inngest.
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
import { inngest } from "@/inngest";

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

  const [scene] = await db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, sceneId), eq(scenes.projectId, id)))
    .limit(1);

  if (!scene) return notFoundResponse();

  await db
    .update(scenes)
    .set({ voiceoverStatus: "pending" })
    .where(eq(scenes.id, sceneId));

  await inngest.send({
    name: "scene/voiceover.generate",
    data: {
      sceneId,
      projectId: id,
      text: scene.voiceover,
      voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
    },
  });

  return NextResponse.json({ message: "Voiceover regeneration started" });
}
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/[id]/generate-assets/ src/app/api/projects/[id]/scenes/[sceneId]/regenerate-image/ src/app/api/projects/[id]/scenes/[sceneId]/regenerate-voice/
git commit -m "feat(Phase2): add asset generation trigger and per-scene regeneration endpoints"
```

---

## Task 9: Scene Card Component

**Files:**
- Create: `src/components/scene-card.tsx`

A visual card for Step 3 showing the generated image, an audio player for voiceover, scene description, and regenerate buttons. Replaces the table view from Step 2.

- [ ] **Step 1: Create the scene card component**

Create `src/components/scene-card.tsx`:

```typescript
/**
 * Scene card for the Visuals + Voice step.
 * Shows generated image, voiceover audio player, scene description,
 * and regeneration controls per scene.
 */
"use client";

import { useState } from "react";
import { RefreshCw, Loader2, ImageIcon, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SceneCardProps {
  scene: {
    id: string;
    sortOrder: number;
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    isHook: boolean;
    imagePath: string | null;
    imageStatus: string;
    voiceoverPath: string | null;
    voiceoverStatus: string;
    imageUrl?: string | null;
    voiceoverUrl?: string | null;
  };
  projectId: string;
  onRegenerateImage: (sceneId: string) => void;
  onRegenerateVoice: (sceneId: string) => void;
}

export function SceneCard({
  scene,
  projectId: _projectId,
  onRegenerateImage,
  onRegenerateVoice,
}: SceneCardProps) {
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioRef] = useState<HTMLAudioElement | null>(
    typeof window !== "undefined" && scene.voiceoverUrl
      ? new Audio(scene.voiceoverUrl)
      : null,
  );

  const toggleAudio = () => {
    if (!audioRef) return;
    if (audioPlaying) {
      audioRef.pause();
      audioRef.currentTime = 0;
      setAudioPlaying(false);
    } else {
      audioRef.play();
      setAudioPlaying(true);
      audioRef.onended = () => setAudioPlaying(false);
    }
  };

  const imageGenerating = scene.imageStatus === "generating" || scene.imageStatus === "pending";
  const voiceGenerating = scene.voiceoverStatus === "generating" || scene.voiceoverStatus === "pending";

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video bg-muted">
        {scene.imageUrl && scene.imageStatus === "done" ? (
          <img
            src={scene.imageUrl}
            alt={`Scene ${scene.sortOrder + 1}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            {imageGenerating ? (
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            ) : scene.imageStatus === "failed" ? (
              <div className="text-center">
                <ImageIcon className="mx-auto h-8 w-8 text-destructive" />
                <p className="mt-1 text-xs text-destructive">Failed</p>
              </div>
            ) : (
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1">
          <Badge variant="secondary" className="text-xs">
            #{scene.sortOrder + 1}
          </Badge>
          {scene.isHook && (
            <Badge variant="default" className="text-xs">
              Hook
            </Badge>
          )}
        </div>
        <div className="absolute right-2 top-2">
          <Badge variant="secondary" className="text-xs">
            {scene.durationSeconds}s
          </Badge>
        </div>
      </div>

      <CardContent className="p-3 space-y-2">
        <p className="text-sm line-clamp-2">{scene.sceneDescription}</p>

        <div className="flex items-center gap-2">
          {/* Audio player */}
          {scene.voiceoverUrl && scene.voiceoverStatus === "done" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={toggleAudio}
            >
              <Volume2 className="mr-1 h-3 w-3" />
              {audioPlaying ? "Stop" : "Play VO"}
            </Button>
          ) : voiceGenerating ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating VO...
            </span>
          ) : scene.voiceoverStatus === "failed" ? (
            <span className="text-xs text-destructive">VO failed</span>
          ) : null}

          <div className="flex-1" />

          {/* Regenerate buttons */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerateImage(scene.id)}
            disabled={imageGenerating}
            title="Regenerate image"
          >
            {imageGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ImageIcon className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onRegenerateVoice(scene.id)}
            disabled={voiceGenerating}
            title="Regenerate voiceover"
          >
            {voiceGenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Volume2 className="h-3 w-3" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/scene-card.tsx
git commit -m "feat(Phase2): add scene card component with image and voiceover display"
```

---

## Task 10: Voice Selector + Step Visuals Component

**Files:**
- Create: `src/components/voice-selector.tsx`
- Create: `src/components/step-visuals.tsx`

The voice selector panel and the Step 3 (Visuals + Voice) wrapper that shows the scene cards grid + voice selector + generate button.

- [ ] **Step 1: Create the voice selector**

Create `src/components/voice-selector.tsx`:

```typescript
/**
 * Voice preset selector panel for Step 3.
 * Shows 6 preset voices (3F/3M) with selection state.
 */
"use client";

import { VOICE_PRESETS, VoicePreset } from "@/lib/voice-presets";
import { Card, CardContent } from "@/components/ui/card";

interface VoiceSelectorProps {
  selectedVoiceId: string;
  onSelect: (voiceId: string) => void;
  disabled?: boolean;
}

export function VoiceSelector({
  selectedVoiceId,
  onSelect,
  disabled = false,
}: VoiceSelectorProps) {
  const femaleVoices = VOICE_PRESETS.filter((v) => v.gender === "female");
  const maleVoices = VOICE_PRESETS.filter((v) => v.gender === "male");

  function VoiceCard({ voice }: { voice: VoicePreset }) {
    const isSelected = voice.id === selectedVoiceId;
    return (
      <Card
        className={`cursor-pointer transition-all ${
          isSelected
            ? "border-primary ring-1 ring-primary"
            : "hover:border-primary/50"
        } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
        onClick={() => !disabled && onSelect(voice.id)}
      >
        <CardContent className="p-3">
          <p className="text-sm font-medium">{voice.name}</p>
          <p className="text-xs text-muted-foreground">{voice.description}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <h3 className="text-sm font-medium">Voice</h3>

      <div>
        <p className="text-xs text-muted-foreground mb-2">Female</p>
        <div className="grid gap-2">
          {femaleVoices.map((v) => (
            <VoiceCard key={v.id} voice={v} />
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2">Male</p>
        <div className="grid gap-2">
          {maleVoices.map((v) => (
            <VoiceCard key={v.id} voice={v} />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the Step Visuals component**

Create `src/components/step-visuals.tsx`:

```typescript
/**
 * Step 3: Visuals + Voice — shows scene cards with images and voiceover,
 * voice selector panel, and generate assets button.
 */
"use client";

import { useState, useCallback, useEffect } from "react";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SceneCard } from "@/components/scene-card";
import { VoiceSelector } from "@/components/voice-selector";
import { BriefSummary } from "@/components/brief-summary";

interface SceneData {
  id: string;
  sortOrder: number;
  voiceover: string;
  sceneDescription: string;
  imagePrompt: string;
  durationSeconds: number;
  isHook: boolean;
  imagePath: string | null;
  imageStatus: string;
  voiceoverPath: string | null;
  voiceoverStatus: string;
  imageUrl?: string | null;
  voiceoverUrl?: string | null;
}

interface StepVisualsProps {
  projectId: string;
  brief: string;
  duration: number;
  tone: string;
  scenes: SceneData[];
  voiceId: string;
  onVoiceChange: (voiceId: string) => void;
  onBriefChange: (brief: string) => void;
  onDurationChange: (duration: number) => void;
  onToneChange: (tone: string) => void;
  onBack: () => void;
}

export function StepVisuals({
  projectId,
  brief,
  duration,
  tone,
  scenes: initialScenes,
  voiceId,
  onVoiceChange,
  onBriefChange,
  onDurationChange,
  onToneChange,
  onBack,
}: StepVisualsProps) {
  const [scenes, setScenes] = useState(initialScenes);
  const [generating, setGenerating] = useState(false);
  const [pollingActive, setPollingActive] = useState(false);

  const hasAnyPending = scenes.some(
    (s) =>
      s.imageStatus === "pending" ||
      s.imageStatus === "generating" ||
      s.voiceoverStatus === "pending" ||
      s.voiceoverStatus === "generating",
  );

  // Poll for scene status updates while generation is in progress
  useEffect(() => {
    if (!pollingActive && !hasAnyPending) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/projects/${projectId}/scenes`);
      if (res.ok) {
        const data = await res.json();
        setScenes(data);
        const stillPending = data.some(
          (s: SceneData) =>
            s.imageStatus === "pending" ||
            s.imageStatus === "generating" ||
            s.voiceoverStatus === "pending" ||
            s.voiceoverStatus === "generating",
        );
        if (!stillPending) {
          setPollingActive(false);
          setGenerating(false);
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [pollingActive, hasAnyPending, projectId]);

  const handleGenerateAssets = useCallback(async () => {
    setGenerating(true);
    setPollingActive(true);
    const res = await fetch(`/api/projects/${projectId}/generate-assets`, {
      method: "POST",
    });
    if (!res.ok) {
      setGenerating(false);
      setPollingActive(false);
    }
  }, [projectId]);

  const handleRegenerateImage = useCallback(
    async (sceneId: string) => {
      setScenes((prev) =>
        prev.map((s) =>
          s.id === sceneId ? { ...s, imageStatus: "pending" } : s,
        ),
      );
      setPollingActive(true);
      await fetch(
        `/api/projects/${projectId}/scenes/${sceneId}/regenerate-image`,
        { method: "POST" },
      );
    },
    [projectId],
  );

  const handleRegenerateVoice = useCallback(
    async (sceneId: string) => {
      setScenes((prev) =>
        prev.map((s) =>
          s.id === sceneId ? { ...s, voiceoverStatus: "pending" } : s,
        ),
      );
      setPollingActive(true);
      await fetch(
        `/api/projects/${projectId}/scenes/${sceneId}/regenerate-voice`,
        { method: "POST" },
      );
    },
    [projectId],
  );

  const handleVoiceChange = useCallback(
    async (newVoiceId: string) => {
      onVoiceChange(newVoiceId);
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId: newVoiceId }),
      });
    },
    [projectId, onVoiceChange],
  );

  const allDone = scenes.every(
    (s) => s.imageStatus === "done" && s.voiceoverStatus === "done",
  );
  const noneStarted = scenes.every(
    (s) => s.imageStatus === "pending" && !s.imagePath,
  );

  return (
    <section className="space-y-6">
      <BriefSummary
        projectId={projectId}
        brief={brief}
        duration={duration}
        tone={tone}
        onBriefChange={onBriefChange}
        onDurationChange={onDurationChange}
        onToneChange={onToneChange}
      />

      <div className="flex items-center gap-3">
        <Button
          onClick={handleGenerateAssets}
          disabled={generating || hasAnyPending}
        >
          {generating || hasAnyPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating assets...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {noneStarted ? "Generate visuals + voice" : "Regenerate all"}
            </>
          )}
        </Button>
        {hasAnyPending && (
          <span className="text-sm text-muted-foreground">
            {scenes.filter((s) => s.imageStatus === "done").length}/{scenes.length} images,{" "}
            {scenes.filter((s) => s.voiceoverStatus === "done").length}/{scenes.length} voiceovers
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            {scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                projectId={projectId}
                onRegenerateImage={handleRegenerateImage}
                onRegenerateVoice={handleRegenerateVoice}
              />
            ))}
          </div>
        </div>

        <div>
          <VoiceSelector
            selectedVoiceId={voiceId}
            onSelect={handleVoiceChange}
            disabled={hasAnyPending}
          />
        </div>
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/components/voice-selector.tsx src/components/step-visuals.tsx
git commit -m "feat(Phase2): add voice selector and Step 3 Visuals + Voice component"
```

---

## Task 11: Integrate Step 3 into Project Workspace + Update Stepper

**Files:**
- Modify: `src/components/project-workspace.tsx`
- Modify: `src/app/projects/[id]/page.tsx`
- Modify: `src/app/api/projects/[id]/route.ts`

Wire up Step 3 (Visuals + Voice) into the stepper. Update the project page to pass asset data. Add `voiceId` to the PATCH endpoint.

- [ ] **Step 1: Add `voiceId` to the project PATCH endpoint**

In `src/app/api/projects/[id]/route.ts`, add to the body type:
```typescript
let body: { name?: string; topic?: string; status?: string; brief?: string; targetDuration?: number; tone?: string; voiceId?: string };
```

Add validation after the `tone` block:
```typescript
  if (body.voiceId !== undefined) {
    if (typeof body.voiceId !== "string" || body.voiceId.length === 0 || body.voiceId.length > 100) {
      return NextResponse.json(
        { error: "Invalid voice ID" },
        { status: 400 },
      );
    }
    updates.voiceId = body.voiceId;
  }
```

- [ ] **Step 2: Update the project page to pass asset data**

In `src/app/projects/[id]/page.tsx`, the scenes query already exists. Update the `ProjectWorkspace` props to include the new fields. Add to the project object:
```typescript
          voiceId: project.voiceId || "21m00Tcm4TlvDq8ikWAM",
          musicPath: project.musicPath,
          musicStatus: project.musicStatus,
          musicMood: project.musicMood || "ambient",
```

Also generate download URLs for scene assets. After the scenes query, add:
```typescript
  // Generate download URLs for scene assets
  const scenesWithUrls = await Promise.all(
    projectScenes.map(async (scene) => ({
      ...scene,
      imageUrl: scene.imagePath ? await getDownloadUrl(scene.imagePath) : null,
      voiceoverUrl: scene.voiceoverPath ? await getDownloadUrl(scene.voiceoverPath) : null,
    })),
  );
```

Replace `initialScenes={projectScenes}` with `initialScenes={scenesWithUrls}`.

- [ ] **Step 3: Update the workspace component**

In `src/components/project-workspace.tsx`:

Add the import:
```typescript
import { StepVisuals } from "@/components/step-visuals";
```

Update the project interface to include new fields:
```typescript
    voiceId: string;
    musicPath: string | null;
    musicStatus: string | null;
    musicMood: string;
```

Update the initialScenes type to include asset fields:
```typescript
  initialScenes: Array<{
    id: string;
    sortOrder: number;
    voiceover: string;
    sceneDescription: string;
    imagePrompt: string;
    durationSeconds: number;
    isHook: boolean;
    imagePath: string | null;
    imageStatus: string;
    voiceoverPath: string | null;
    voiceoverStatus: string;
    imageUrl?: string | null;
    voiceoverUrl?: string | null;
  }>;
```

Add voice state:
```typescript
  const [voiceId, setVoiceId] = useState(project.voiceId);
```

Update the steps array to add Step 3:
```typescript
  const steps = [
    {
      label: "Concept",
      description: "Video brief",
      completed: brief.trim().length > 0,
    },
    {
      label: "Style",
      description: "Visual identity",
      completed: styleString.length > 0 || hasRefImages,
    },
    {
      label: "Script",
      description: "Scene breakdown",
      completed: scenes.length > 0,
    },
    {
      label: "Visuals",
      description: "Images + Voice",
      completed: scenes.length > 0 && scenes.every(
        (s) => s.imageStatus === "done" && s.voiceoverStatus === "done",
      ),
    },
  ];
```

Update the auto-advance logic:
```typescript
  const [currentStep, setCurrentStep] = useState(() => {
    if (initialScenes.length > 0 && initialScenes.some((s) => s.imagePath)) return 3;
    if (initialScenes.length > 0) return 2;
    if (project.styleString || (project.styleRefPaths && project.styleRefPaths.length > 0)) return 1;
    return 0;
  });
```

Add the Step 3 render block after the Step 2 (Script) block:
```tsx
      {currentStep === 3 && (
        <StepVisuals
          projectId={project.id}
          brief={brief}
          duration={targetDuration}
          tone={tone}
          scenes={scenes}
          voiceId={voiceId}
          onVoiceChange={setVoiceId}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
          onBack={() => setCurrentStep(2)}
        />
      )}
```

Update `StepScript`'s `onBack` to go to step 1 (Style) and add `onNext`:
- In the `StepScript` component usage, update the back handler and add a next handler:
```tsx
      {currentStep === 2 && (
        <StepScript
          projectId={project.id}
          brief={brief}
          duration={targetDuration}
          tone={tone}
          scenes={scenes}
          scriptKey={scriptKey}
          generatingScript={generatingScript}
          onBriefChange={setBrief}
          onDurationChange={setTargetDuration}
          onToneChange={setTone}
          onGenerateScript={handleGenerateScript}
          onBack={() => setCurrentStep(1)}
        />
      )}
```

Note: The Script step's "Next" to Visuals will be handled by a button in step-script.tsx. Add to `StepScriptProps`: `onNext?: () => void` and render a Next button when scenes exist.

- [ ] **Step 4: Add Next button to StepScript**

In `src/components/step-script.tsx`, add `onNext` to the props interface:
```typescript
  onNext?: () => void;
```

Update the bottom buttons to include Next when scenes exist:
```tsx
      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        {scenes.length > 0 && onNext && (
          <Button onClick={onNext}>
            Next: Visuals
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>
```

Add `ArrowRight` to the lucide imports.

Then in the workspace, pass `onNext` to StepScript:
```tsx
          onNext={() => setCurrentStep(3)}
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/components/project-workspace.tsx src/components/step-script.tsx src/app/projects/[id]/page.tsx src/app/api/projects/[id]/route.ts
git commit -m "feat(Phase2): integrate Step 3 Visuals + Voice into stepper"
```

---

## Task 12: Update .env.example + Test Inngest Dev Server

No code changes — setup and verification.

- [ ] **Step 1: Update .env.example**

Add to `.env.example`:
```
# ElevenLabs
ELEVENLABS_API_KEY=your-elevenlabs-key
```

- [ ] **Step 2: Start the Inngest Dev Server**

In a separate terminal:
```bash
npx inngest-cli@latest dev
```

This starts the Inngest Dev Server at `http://localhost:8288`.

- [ ] **Step 3: Start the Next.js dev server**

```bash
npm run dev
```

The Inngest Dev Server should auto-discover your functions at `http://localhost:3000/api/inngest`.

- [ ] **Step 4: Verify functions registered**

Open `http://localhost:8288` — you should see 4 functions:
- `generate-all-assets`
- `generate-scene-image`
- `generate-scene-voiceover`
- `generate-music`

- [ ] **Step 5: End-to-end test**

1. Open a project with a script
2. Navigate to Step 3 (Visuals + Voice)
3. Click "Generate visuals + voice"
4. Watch the Inngest Dev Server UI — you should see events being processed
5. Scene cards should update with images and voiceover as they complete
6. Test "Play VO" on a completed scene

- [ ] **Step 6: Commit**

```bash
git add .env.example
git commit -m "chore: add ElevenLabs env var to .env.example"
```
