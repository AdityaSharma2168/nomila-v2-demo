/**
 * probe.ts — ffprobe wrapper. The only place that reads encode params off a file.
 *
 * Everything downstream depends on these numbers being right: the normalization
 * decisions, the crossfade offsets and the expected output length are all derived
 * from probed durations, so a wrong duration here is a wrong stitch.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../../logger";
import type { ClipProbe } from "./types";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-probe");

const PROBE_TIMEOUT_MS = 30_000;

/** "30000/1001" -> 29.97. Returns 0 for "0/0" (which ffprobe reports for audio-only). */
export function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

export async function probeMedia(path: string): Promise<ClipProbe> {
  let raw: string;
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    raw = stdout;
  } catch (err: any) {
    throw new Error(
      `ffprobe failed for ${path}: ${String(err?.stderr ?? err?.message ?? err).slice(0, 400)}`,
    );
  }

  const parsed = JSON.parse(raw) as {
    streams?: Record<string, any>[];
    format?: Record<string, any>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video) throw new Error(`no video stream in ${path}`);

  // Prefer avg_frame_rate (honest about VFR); fall back to r_frame_rate.
  const fps =
    parseRational(video.avg_frame_rate) || parseRational(video.r_frame_rate);

  // Stream duration is absent in some containers — the format's is the fallback.
  const durationSec = Number(video.duration ?? parsed.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`could not determine duration of ${path}`);
  }

  // ffprobe reports "N/A" (or omits it) for square pixels.
  const sar = video.sample_aspect_ratio;
  const sampleAspectRatio =
    !sar || sar === "N/A" || sar === "0:1" ? "1:1" : String(sar);

  const probe: ClipProbe = {
    width: Number(video.width),
    height: Number(video.height),
    fps,
    pixFmt: String(video.pix_fmt ?? ""),
    sampleAspectRatio,
    durationSec,
    videoCodec: String(video.codec_name ?? ""),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name ?? "") : null,
    sampleRate:
      audio?.sample_rate === undefined ? null : Number(audio.sample_rate),
    channels: audio?.channels === undefined ? null : Number(audio.channels),
  };

  logger.debug(
    {
      path,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
    },
    "probed media",
  );
  return probe;
}

/**
 * How long is this video, in seconds? The ONE number, from an input ffprobe can open.
 *
 * ─── WHY IT TAKES A URL AS HAPPILY AS A PATH ────────────────────────────────────────────────────
 *
 * Every other function here is handed a local file, because the stitch engine's callers download
 * first (see video/types.ts). This one is also used at UPLOAD, where the bytes are in GCS and were
 * never in this process: the client PUTs straight to the bucket and then asks the server to
 * register the object. Downloading a 100 MB clip into a Cloud Run instance whose /tmp is RAM, to
 * learn one float, would be the wrong trade — so the caller signs a URL and ffprobe range-reads
 * the container header over https instead. THE CALLER SIGNS. This module knows about ffprobe and
 * nothing about GCS or tenancy, which is the same split materialize.ts's header draws.
 *
 * `-protocol_whitelist` is required for the https input, exactly as in services/videoPoster.ts.
 * It is harmless on a local path.
 *
 * ─── IT THROWS, AND THE UPLOAD CALLER FAILS OPEN ────────────────────────────────────────────────
 *
 * Same posture as probeHasAudio: a probe that could not be taken is an error here, and what to do
 * about it is the caller's decision, not this function's. routes/media.ts catches and registers
 * the row anyway — an unmeasurable clip is still her video — whereas the stitch path lets it
 * propagate, because joining a clip of unknown length is how the memory ceiling gets defeated.
 */
export async function probeDurationSeconds(input: string): Promise<number> {
  let raw: string;
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration:format=duration",
        "-of",
        "json",
        input,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    raw = stdout;
  } catch (err: any) {
    // REDACT THE WHOLE MESSAGE, not just the input. ffprobe ECHOES ITS INPUT BACK in stderr
    // ("https://…?X-Goog-Signature=…: Server returned 403"), so sanitizing the argument alone and
    // then concatenating the stderr would hand the credential straight to the caller's logger —
    // and both callers log this message.
    throw new Error(
      redact(
        `ffprobe failed for ${input}: ${String(err?.stderr ?? err?.message ?? err)}`,
      ).slice(0, 400),
    );
  }

  const parsed = JSON.parse(raw) as {
    streams?: Record<string, any>[];
    format?: Record<string, any>;
  };
  // Stream duration first, format duration as the fallback — the same order probeMedia uses, and
  // for the same reason: some containers carry it in only one of the two places.
  const seconds = Number(
    parsed.streams?.[0]?.duration ?? parsed.format?.duration ?? 0,
  );
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(redact(`could not determine duration of ${input}`));
  }
  return seconds;
}

/**
 * Strip the query string from every URL in a string.
 *
 * A signed GCS URL carries its credential there, so neither the input nor anything ffprobe says
 * about it may reach a log line intact. Applied to the whole message rather than to the URL we
 * passed in, because the one in ffprobe's stderr is the copy we did not put there.
 */
export function redact(text: string): string {
  return text.replace(/(https?:\/\/[^\s'"]*?)\?[^\s'"]*/gi, "$1?…");
}

/**
 * Does this file carry an audio stream? Separate from probeMedia because an audio bed is
 * a video-less file, which probeMedia rejects by design — using it here would make the
 * bed check throw on every valid bed and pass on every invalid one.
 */
export async function probeHasAudio(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "json",
        path,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { streams?: unknown[] };
    return (parsed.streams ?? []).length > 0;
  } catch (err: any) {
    throw new Error(
      `ffprobe failed for ${path}: ${String(err?.stderr ?? err?.message ?? err).slice(0, 400)}`,
    );
  }
}
