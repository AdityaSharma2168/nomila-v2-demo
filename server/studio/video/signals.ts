/**
 * studio/video/signals — a clip's measured quality signals, for $0, on bytes the clip read already holds (media-intake
 * plan fix 2, behind MEDIA_VIDEO_FIXES). What a post kit or Studio needs to choose and cut a clip without reading it
 * again: is it slow motion, is it loud enough, where does it go silent, is it sharp, does it freeze or go black.
 *
 *   ffprobe      frame rate (average, and whether it varies), size, codec, bitrate, audio present
 *   ebur128      integrated loudness (LUFS)
 *   silencedetect   silent stretches (below -40 dB for at least 1 s)
 *   blurdetect   mean blur (0 sharp … higher is blurrier), on 2 frames a second
 *   freezedetect frozen stretches (at least 1 s)
 *   blackdetect  black stretches (at least 0.5 s)
 *
 * Camera shake is NOT measured here: ffmpeg's vidstabdetect needs a library the production build is not known to
 * carry, and the clip read already says it per beat (`stability`: steady · handheld · shaky) from the same frames.
 *
 * EVERY PASS IS ITS OWN: an ffmpeg without one filter (blurdetect arrived in 5.1) loses that one number, never the
 * record. A pass that fails leaves its field null. The parsers are pure and take the tool's own text; the runner is
 * injected so the tests never start ffmpeg.
 *
 * Written to `metadata.signals` — one key, jsonb_set, her row only (the writeShots discipline in video/shots.ts).
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { rm, writeFile } from "fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../logger";
import { ebur128Filter, stderrTail } from "./ebur128";
import { parseRational } from "./probe";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-signals");

const PASS_TIMEOUT_MS = 120_000;

/** At or above this average frame rate a clip is slow motion (phones record slow-mo at 120 or 240 fps). */
export const SLOW_MOTION_FPS = 100;

export type Span = [number, number];

export interface ClipSignals {
  version: 1;
  fps: number | null;
  /** The frame rate varies (avg ≠ nominal by more than 1%) — what phones record. */
  vfr: boolean | null;
  slow_motion: boolean | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate_kbps: number | null;
  has_audio: boolean | null;
  /** Integrated loudness, LUFS (−14 is a typical social-platform target; −70 is silence). Null with no audio. */
  loudness_lufs: number | null;
  silence: Span[] | null;
  /** blurdetect's mean over the sampled frames. Lower is sharper. */
  blur_mean: number | null;
  freezes: Span[] | null;
  black: Span[] | null;
  /**
   * The signals whose pass RAN and failed (or, for loudness, printed no summary) — null because ffmpeg could not
   * measure them, not because there was nothing to measure. ABSENT when every pass that ran succeeded.
   */
  failed?: Array<"loudness_lufs" | "silence" | "blur_mean" | "freezes" | "black">;
  at: string;
}

/** Runs one tool and hands back its stdout and stderr. Rejects on failure. */
export type ToolRunner = (tool: "ffprobe" | "ffmpeg", args: string[]) => Promise<{ stdout: string; stderr: string }>;

const realRunner: ToolRunner = async (tool, args) => {
  const { stdout, stderr } = await execFileP(tool, args, { timeout: PASS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  return { stdout: String(stdout), stderr: String(stderr) };
};

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const finite = (n: unknown): number | null => {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? v : null;
};

/** ffprobe's JSON → the stream facts. Pure. */
export function probeFacts(json: string): Pick<ClipSignals, "fps" | "vfr" | "slow_motion" | "width" | "height" | "codec" | "bitrate_kbps" | "has_audio"> {
  const p = JSON.parse(json) as { streams?: Record<string, any>[]; format?: Record<string, any> };
  const v = (p.streams ?? []).find((s) => s.codec_type === "video");
  const a = (p.streams ?? []).find((s) => s.codec_type === "audio");
  const avg = parseRational(v?.avg_frame_rate);
  const nominal = parseRational(v?.r_frame_rate);
  const fps = avg || nominal || null;
  const bitrate = finite(p.format?.bit_rate);
  return {
    fps: fps ? round(fps, 2) : null,
    vfr: avg && nominal ? Math.abs(avg - nominal) / nominal > 0.01 : null,
    slow_motion: fps ? fps >= SLOW_MOTION_FPS : null,
    width: finite(v?.width),
    height: finite(v?.height),
    codec: typeof v?.codec_name === "string" ? v.codec_name : null,
    bitrate_kbps: bitrate !== null ? Math.round(bitrate / 1000) : null,
    has_audio: v ? Boolean(a) : null,
  };
}

/** ebur128's summary → integrated loudness. Pure. Null when the summary is absent. */
export function loudnessFrom(stderr: string): number | null {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const m = /Integrated loudness:\s*\n?\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary);
  if (!m) return null;
  return m[1] === "-inf" ? -70 : finite(m[1]);
}

/**
 * `<kind>_start` / `<kind>_end` pairs out of a detect filter's log (silencedetect, freezedetect). Pure. A start with no
 * end runs to `end` (the clip's end), or is dropped when the end is unknown.
 */
export function spansFrom(stderr: string, kind: "silence" | "freeze", end: number | null = null): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  const re = new RegExp(`(?:lavfi\\.)?${kind}_(start|end)[:=]\\s*(-?[\\d.]+)`, "g");
  for (const m of stderr.matchAll(re)) {
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === "start") open = Math.max(0, t);
    else if (open !== null) { if (t > open) out.push([round(open), round(t)]); open = null; }
  }
  if (open !== null && end !== null && end > open) out.push([round(open), round(end)]);
  return out;
}

/** blackdetect's `black_start:X black_end:Y` lines. Pure. */
export function blackFrom(stderr: string): Span[] {
  const out: Span[] = [];
  for (const m of stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) {
    const s = Number(m[1]);
    const e = Number(m[2]);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push([round(s), round(e)]);
  }
  return out;
}

/** blurdetect's closing summary (`blur mean: X`). Pure. */
export function blurFrom(stderr: string): number | null {
  const m = /blur mean:\s*([\d.]+)/i.exec(stderr);
  return m ? finite(round(Number(m[1]))) : null;
}

/** The clip's length, for a span left open at the end. */
function durationOf(json: string): number | null {
  try {
    const p = JSON.parse(json) as { format?: { duration?: unknown } };
    return finite(p.format?.duration);
  } catch {
    return null;
  }
}

type PassResult = { ok: true; stderr: string } | { ok: false; error: string; stderrTail: string };

/** One ffmpeg filter pass over the file, discarding the output; its stderr, or why it failed. */
async function pass(run: ToolRunner, path: string, filter: { v?: string; a?: string }, clipId: string | null): Promise<PassResult> {
  const args = ["-hide_banner", "-nostdin", "-nostats", "-i", path];
  if (filter.v) args.push("-map", "0:v:0", "-vf", filter.v);
  if (filter.a) args.push("-map", "0:a:0", "-af", filter.a);
  args.push("-f", "null", "-");
  try {
    return { ok: true, stderr: (await run("ffmpeg", args)).stderr };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const tail = stderrTail((err as { stderr?: unknown } | null)?.stderr);
    logger.info({ clipId, filter: filter.v ?? filter.a, error, stderrTail: tail }, "signal pass failed — that one signal is left empty");
    return { ok: false, error, stderrTail: tail };
  }
}

/** Measure one LOCAL file. Never throws: what could not be measured is null (and named in `failed`). */
export async function measureSignals(
  path: string,
  run: ToolRunner = realRunner,
  now: Date = new Date(),
  /** The media asset being measured, for the warning when a pass fails. */
  clipId: string | null = null,
): Promise<ClipSignals> {
  let facts: ReturnType<typeof probeFacts> = {
    fps: null, vfr: null, slow_motion: null, width: null, height: null, codec: null, bitrate_kbps: null, has_audio: null,
  };
  let duration: number | null = null;
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
    facts = probeFacts(stdout);
    duration = durationOf(stdout);
  } catch (err) {
    logger.info({ error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }, "signal probe failed");
  }
  const audio = facts.has_audio !== false;
  const [loud, silent, blur, freeze, black] = await Promise.all([
    audio ? pass(run, path, { a: ebur128Filter() }, clipId) : Promise.resolve(null),
    audio ? pass(run, path, { a: "silencedetect=noise=-40dB:d=1" }, clipId) : Promise.resolve(null),
    pass(run, path, { v: "fps=2,blurdetect" }, clipId),
    pass(run, path, { v: "freezedetect=n=-60dB:d=1" }, clipId),
    pass(run, path, { v: "blackdetect=d=0.5:pix_th=0.10" }, clipId),
  ]);
  const failed: NonNullable<ClipSignals["failed"]> = [];
  const read = <T>(r: PassResult | null, key: NonNullable<ClipSignals["failed"]>[number], parse: (stderr: string) => T): T | null => {
    if (r === null) return null; // not run: nothing to measure
    if (!r.ok) { failed.push(key); return null; }
    return parse(r.stderr);
  };
  const loudness = read(loud, "loudness_lufs", loudnessFrom);
  // LOUD, not silent: a loudness pass that failed, or ran and printed no summary, is how every clip on prod's ffmpeg
  // 5.1 once came out with an empty loudness unnoticed (ebur128.ts). Silence is a value (−70), never this.
  if (loud !== null && loudness === null) {
    if (loud.ok) failed.push("loudness_lufs");
    logger.warn(
      {
        clipId,
        error: loud.ok ? "no ebur128 summary" : loud.error,
        stderrTail: loud.ok ? stderrTail(loud.stderr) : loud.stderrTail,
      },
      "clip loudness could not be measured — loudness_lufs is left empty",
    );
  }
  return {
    version: 1,
    ...facts,
    loudness_lufs: loudness,
    silence: read(silent, "silence", (s) => spansFrom(s, "silence", duration)),
    blur_mean: read(blur, "blur_mean", blurFrom),
    freezes: read(freeze, "freezes", (s) => spansFrom(s, "freeze", duration)),
    black: read(black, "black", blackFrom),
    ...(failed.length ? { failed } : {}),
    at: now.toISOString(),
  };
}

/** The same, on bytes in hand, through a private temp file that is removed whatever happens. */
export async function measureSignalsBytes(bytes: Buffer, run: ToolRunner = realRunner, clipId: string | null = null): Promise<ClipSignals> {
  const path = join(tmpdir(), `studio-signals-${randomUUID()}.mp4`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await measureSignals(path, run, new Date(), clipId);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** Write `metadata.signals` — one key, jsonb_set, her row only. Never throws; true when the row was written. */
export async function writeSignals(assetId: string, athleteId: string, record: ClipSignals): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      UPDATE media_assets
         SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{signals}', ${JSON.stringify(record)}::jsonb),
             metadata_updated_at = now()
       WHERE id = ${assetId} AND athlete_id = ${athleteId}
      RETURNING id`);
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
    return rows.length > 0;
  } catch (err) {
    logger.warn({ assetId, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }, "signals not written");
    return false;
  }
}
