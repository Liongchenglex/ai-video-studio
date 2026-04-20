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
    const { sceneId, projectId, sceneDescription, styleString, styleRefPaths } = event.data;

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
        sceneDescription,
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
