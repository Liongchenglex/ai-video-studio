/**
 * Inngest function: generates a single scene's voiceover.
 * Triggered per-scene by the orchestrator.
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
