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
