/**
 * Frame sampler — extracts evenly spaced JPEG frames from a video buffer
 * using the ffmpeg binary bundled by ffmpeg-static. Pure Node utility
 * (child_process + fs/tmp only): no DB, no fal, no Claude. Used by the AI
 * Assistant Director to pull representative frames from a candidate clip
 * for vision review.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const DURATION_REGEX = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/;

/** Resolves the ffmpeg binary path, throwing a clear error on unsupported platforms. */
function resolveFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg-static returned no binary path for this platform; frame sampling is unavailable here."
    );
  }
  return ffmpegPath;
}

/** Extracts a short, human-readable message from a failed execFile error. */
function describeExecError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = e.stderr?.trim();
  return stderr && stderr.length > 0 ? stderr.split("\n").slice(-5).join(" ") : (e.message ?? String(err));
}

/** Probes a video file's duration (seconds) by parsing ffmpeg's stderr output. */
async function probeDurationSeconds(binary: string, videoPath: string): Promise<number> {
  let stderr: string;
  try {
    const result = await execFileAsync(binary, ["-i", videoPath, "-f", "null", "-"]);
    stderr = result.stderr;
  } catch (err) {
    throw new Error(`ffmpeg could not read the video to probe its duration: ${describeExecError(err)}`);
  }

  const match = DURATION_REGEX.exec(stderr);
  if (!match) {
    throw new Error("ffmpeg did not report a Duration for this file; it may not be a valid video.");
  }
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const EXTRACT_MAX_ATTEMPTS = 5;
const EXTRACT_BACKOFF_SECONDS = 0.1;

/**
 * Extracts a single JPEG frame at (or just before) the given timestamp.
 *
 * ffmpeg can exit 0 while producing no output when the requested
 * timestamp falls after the last frame's presentation time (e.g. on a
 * low-fps clip, seeking a few hundredths of a second past the final
 * frame) — it isn't an error exit, just an empty file. When that
 * happens, retries a few times at progressively earlier timestamps
 * before giving up.
 */
async function extractFrame(
  binary: string,
  videoPath: string,
  timestampSeconds: number,
  framePath: string
): Promise<Buffer> {
  let lastError: unknown;

  for (let attempt = 0; attempt < EXTRACT_MAX_ATTEMPTS; attempt++) {
    const ts = Math.max(timestampSeconds - attempt * EXTRACT_BACKOFF_SECONDS, 0);
    try {
      await execFileAsync(binary, ["-y", "-ss", String(ts), "-i", videoPath, "-frames:v", "1", "-q:v", "3", framePath]);
      return await readFile(framePath);
    } catch (err) {
      lastError = err;
      if (ts <= 0) break;
    }
  }

  throw new Error(
    `ffmpeg failed to extract a frame near ${timestampSeconds.toFixed(2)}s: ${describeExecError(lastError)}`
  );
}

/**
 * Samples `count` evenly spaced JPEG frames from a video buffer.
 *
 * Writes the buffer to a random temp file under os.tmpdir(), probes its
 * duration via ffmpeg, extracts one frame per timestamp
 * `(i / (count - 1)) * duration` (clamped inside `[0, duration - 0.05]`),
 * and returns the frames as Buffers in order. All temp files (the source
 * video and every extracted frame) are removed in a `finally` block.
 *
 * Throws a descriptive Error when ffmpeg exits non-zero or the input
 * buffer isn't a readable video.
 */
export async function sampleVideoFrames(video: Buffer, count: number): Promise<Buffer[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`sampleVideoFrames requires an integer count >= 1, got ${count}.`);
  }

  const binary = resolveFfmpegPath();
  const runId = randomBytes(8).toString("hex");
  const videoPath = join(tmpdir(), `director-frame-sampler-${runId}.mp4`);
  const framePaths: string[] = [];

  try {
    await writeFile(videoPath, video);

    const duration = await probeDurationSeconds(binary, videoPath);
    const maxTimestamp = Math.max(duration - 0.05, 0);

    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const fraction = count > 1 ? i / (count - 1) : 0;
      const timestamp = Math.min(Math.max(fraction * duration, 0), maxTimestamp);
      const framePath = join(tmpdir(), `director-frame-sampler-${runId}-${i}.jpg`);
      framePaths.push(framePath);
      frames.push(await extractFrame(binary, videoPath, timestamp, framePath));
    }

    return frames;
  } finally {
    await Promise.all([videoPath, ...framePaths].map((p) => unlink(p).catch(() => undefined)));
  }
}
