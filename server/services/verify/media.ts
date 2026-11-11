/**
 * verify/media.ts — the file probes behind verifyDeliverable's video and image checks: ffprobe for a video, sharp for
 * an image. Local and $0. Each reads facts and never throws: a file that cannot be read is a fact ("not valid"), which
 * the check turns into a failure.
 *
 * The parse is pure (videoFactsFromFfprobe), so the offline evals replay RECORDED ffprobe output and need no binary.
 */
import { execFile } from "child_process";
import { stat } from "fs/promises";
import { promisify } from "util";
import type { ImageFacts, VideoFacts } from "./deliverable";

const execFileP = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;

/** ffprobe's `-show_streams -show_format -of json` output, as facts. Pure. */
export function videoFactsFromFfprobe(json: unknown, sizeBytes: number | null): VideoFacts {
  const p = (json ?? {}) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = Array.isArray(p.streams) ? p.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video) return { valid: false, error: "no video stream", durationSec: null, hasAudio: !!audio, width: null, height: null, sizeBytes };
  const d = Number(video.duration ?? p.format?.duration);
  const size = sizeBytes ?? (p.format?.size !== undefined ? Number(p.format.size) : null);
  return {
    valid: true,
    durationSec: Number.isFinite(d) && d > 0 ? d : null,
    hasAudio: !!audio,
    width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
    height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
    sizeBytes: size !== null && Number.isFinite(size) ? size : null,
  };
}

const sizeOf = async (path: string): Promise<number | null> => {
  try { return (await stat(path)).size; } catch { return null; }
};

export async function readVideoFacts(path: string): Promise<VideoFacts> {
  const sizeBytes = await sizeOf(path);
  try {
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    return videoFactsFromFfprobe(JSON.parse(stdout), sizeBytes);
  } catch (err: any) {
    // Never the path in the error: it names her workspace.
    return { valid: false, error: String(err?.stderr ?? err?.message ?? err).replace(path, "<file>").slice(0, 200), durationSec: null, hasAudio: false, width: null, height: null, sizeBytes };
  }
}

export async function readImageFacts(path: string): Promise<ImageFacts> {
  const sizeBytes = await sizeOf(path);
  try {
    const sharp = (await import("sharp")).default;
    // stats() decodes every pixel: a truncated file fails here, where metadata() would read only the header.
    const img = sharp(path, { failOn: "error" });
    const meta = await img.metadata();
    await img.stats();
    return { decoded: true, width: meta.width ?? null, height: meta.height ?? null, sizeBytes };
  } catch (err: any) {
    return { decoded: false, error: String(err?.message ?? err).replace(path, "<file>").slice(0, 200), width: null, height: null, sizeBytes };
  }
}
