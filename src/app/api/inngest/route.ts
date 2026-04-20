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
