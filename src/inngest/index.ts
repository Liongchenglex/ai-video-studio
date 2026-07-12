/**
 * Inngest function registry. All functions are exported here
 * and served via the /api/inngest endpoint.
 *
 * Post-pivot (PRD v3.0): most generation is user-driven from the
 * Timeline Editor. Inngest remains for long-running jobs that still
 * make sense as background work (music, final render, publish) and,
 * as of v4 P3, the batch "Generate all" orchestrator.
 */
export { inngest } from "./client";

import { generateMusicFn } from "./functions/generate-music";
import { generateBatchFn } from "./functions/generate-batch";
import { directShotFn } from "./functions/direct-shot";

export const functions = [
  generateMusicFn,
  generateBatchFn,
  directShotFn,
];
