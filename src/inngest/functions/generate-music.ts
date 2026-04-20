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
