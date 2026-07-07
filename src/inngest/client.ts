/**
 * Inngest client instance for the AI Video Studio app.
 * Used by all Inngest functions and the serve endpoint.
 */
import { Inngest } from "inngest";

// INNGEST_DEV disables /api/inngest signature verification. In production
// that would let unauthenticated callers run paid batch generation on any
// project — fail closed at boot instead of relying on deploy discipline.
if (process.env.NODE_ENV === "production" && process.env.INNGEST_DEV) {
  throw new Error("INNGEST_DEV must not be set in production — it disables Inngest request signing.");
}

export const inngest = new Inngest({
  id: "ai-video-studio",
});
