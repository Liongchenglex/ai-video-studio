/**
 * Inngest client instance for the AI Video Studio app.
 * Used by all Inngest functions and the serve endpoint.
 */
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "ai-video-studio",
});
