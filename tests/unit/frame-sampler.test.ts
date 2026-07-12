/**
 * Frame-sampler tests. Hermetic: synthesizes a 2s test video with the
 * bundled ffmpeg (lavfi testsrc), then samples frames from it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ffmpegPath from "ffmpeg-static";
import { sampleVideoFrames } from "@/lib/director/frame-sampler";

let video: Buffer;
beforeAll(() => {
  const out = join(tmpdir(), `fs-test-${process.pid}.mp4`);
  execFileSync(ffmpegPath as string, ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", out]);
  video = readFileSync(out);
});

describe("sampleVideoFrames", () => {
  it("returns the requested number of JPEG frames in order", async () => {
    const frames = await sampleVideoFrames(video, 4);
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect(f.length).toBeGreaterThan(500);
      expect(f[0]).toBe(0xff); // JPEG SOI
      expect(f[1]).toBe(0xd8);
    }
  });
  it("throws a descriptive error on a non-video buffer", async () => {
    await expect(sampleVideoFrames(Buffer.from("not a video"), 2)).rejects.toThrow(/ffmpeg/i);
  });
});
