/**
 * Inngest orchestrator: fans out image + voiceover + music generation
 * for all scenes in a project.
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

    const data = await step.run("load-project-data", async () => {
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

    if (!data.project || data.projectScenes.length === 0) {
      throw new Error("Project or scenes not found");
    }

    // Fan out image generation — all scenes in parallel
    const imageEvents = data.projectScenes.map((scene) => ({
      name: "scene/image.generate" as const,
      data: {
        sceneId: scene.id,
        projectId,
        stillImagePrompt: scene.stillImagePrompt || scene.sceneDescription,
        styleString: data.project.styleString,
      },
    }));

    await step.sendEvent("trigger-image-generation", imageEvents);

    // Fan out voiceover generation
    const voiceoverEvents = data.projectScenes.map((scene) => ({
      name: "scene/voiceover.generate" as const,
      data: {
        sceneId: scene.id,
        projectId,
        text: scene.voiceover,
        voiceId: data.project.voiceId || "21m00Tcm4TlvDq8ikWAM",
      },
    }));

    await step.sendEvent("trigger-voiceover-generation", voiceoverEvents);

    // Trigger music generation
    const totalDuration = data.projectScenes.reduce(
      (sum, s) => sum + s.durationSeconds,
      0,
    );

    await step.sendEvent("trigger-music-generation", {
      name: "project/music.generate",
      data: {
        projectId,
        mood: data.project.musicMood || "ambient",
        durationSeconds: totalDuration,
      },
    });

    return { projectId, scenesCount: data.projectScenes.length };
  },
);
