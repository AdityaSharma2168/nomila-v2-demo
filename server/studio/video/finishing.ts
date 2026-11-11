/**
 * finishing.ts — the stitcher's finishing pass (quality-scrappy piece 6, docs/probes/quality-scrappy.md, ADI-QS-GO),
 * behind the opt-in STUDIO_FINISHING. $0, local ffmpeg, and all of it optional: with the flag off the stitch runner
 * passes nothing and plan.ts's argv is byte for byte what it was.
 *
 *   the bed      normalized to BED_REFERENCE_LUFS BEFORE its level gain (R3) — so Quiet / Medium / Loud stay
 *                RELATIVE offsets from one reference instead of from whatever each master happened to be. Measured
 *                here, at run time, on the local file: a curated track and her own video's sound alike.
 *   the mix      a true-peak limiter at TRUE_PEAK_DBTP on the final mix (plan.ts). No whole-mix loudnorm (R3).
 *   the cuts     each CUT join moved back onto the bed's beat grid when one falls within reach — by shortening the
 *                outgoing clip, never lengthening it, never below MIN_CLIP_SEC. Crossfades and stills are left as
 *                they are (a still's hold is already cut to the beat by the client's "On the beat").
 *   the frame    a source of another shape is cropped to fill instead of padded (plan.ts `cropToFill`), at a subject
 *                hint when one exists — none does today: a clip read carries no position (enrich/videoTag.ts), so
 *                every crop is centred.
 *   captions     Reels' safe zones, in video/captionRender.ts, beside the geometry both the preview and the render
 *                read.
 *
 * A timeline with no sound of its own (music only) used to land about 12 LU under Reels' −14 (ledger, P6b′: the bed at
 * the reference, then Medium's −12 dB, a level meant for music under speech). Now, with nothing to sit under, the level
 * is read relative to Medium and clamped at the reference (plan.ts bedLevelGain: min(level / Medium, 1)): Medium and
 * Loud music-only land at −14 LUFS under the −1 dBTP ceiling, Quiet its offset under it.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../../logger";
import { MUSIC_TRACKS, isTrackId } from "../music/tracks";
import type { BeatGrid } from "./beatGrid";
import { beatAt } from "./beatGrid";
import { STITCH_BEDS, type BedName } from "./beds";
import { ebur128Filter, stderrTail } from "./ebur128";
import { assertLocalPath } from "./plan";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-finishing");

/** The loudness every bed is brought to before its level gain (R3). Reels' integrated target. */
export const BED_REFERENCE_LUFS = -14;
/** The ceiling the final mix is limited to (R3). */
export const TRUE_PEAK_DBTP = -1;
/** A bed is never pushed or pulled further than this — a near-silent file is not made into noise. */
export const MAX_BED_GAIN_DB = 24;
/** A cut moves at most this far back to land on a beat. */
export const MAX_BEAT_SHIFT_SEC = 0.5;
/** And never leaves a clip shorter than this. */
export const MIN_CLIP_SEC = 0.5;

/**
 * Integrated loudness (LUFS) of a file's first audio stream — of the WINDOW that will play, when one is given — or
 * null when it has none or ffmpeg cannot say.
 *
 * ⚠️ THE WINDOW IS THE POINT, AND IT WAS LEARNED BY MISSING (ledger, P6b′). Measured over the whole track, the ten beds
 * came out 4.5 LU apart under a 15 s timeline, because a stitch plays the track's OPENING and intros run quieter than
 * the track's average. So the bed is measured from where it starts for as long as the programme runs, looped as the
 * stitch loops it — the loudness she will actually hear.
 */
export async function measureLoudness(
  path: string,
  window?: { startSec: number; durationSec: number },
  /** Hard kill for the measuring ffmpeg. Default 120 s; a caller inside a budget passes what is left of it. */
  timeoutMs = 120_000,
  /** Who is asking (a stitch id, a render job id), for the warning when the measurement fails. */
  label?: string,
): Promise<number | null> {
  assertLocalPath(path, "loudness source");
  const filter = ebur128Filter();
  let stderr: string;
  try {
    ({ stderr } = await execFileP(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        // The bed loops under a programme longer than itself (plan.ts), so the measured window loops too.
        ...(window ? ["-stream_loop", "-1"] : []),
        "-i",
        path,
        "-map",
        "0:a:0",
        "-af",
        window
          ? `atrim=start=${Math.max(0, window.startSec)}:duration=${Math.max(3, window.durationSec)},${filter}`
          : filter,
        "-f",
        "null",
        "-",
      ],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (err) {
    // LOUD, not silent: this is how every bed on prod's ffmpeg 5.1 once went unlevelled unnoticed (ebur128.ts).
    logger.warn(
      {
        label: label ?? null,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        stderrTail: stderrTail((err as { stderr?: unknown } | null)?.stderr),
      },
      "bed loudness could not be measured — it is mixed unlevelled",
    );
    return null;
  }
  // The summary's last "I:" line is the integrated figure.
  const hits = [...stderr.matchAll(/^\s+I:\s+(-?[\d.]+|-inf)\s+LUFS/gm)];
  const last = hits.at(-1)?.[1];
  if (last === undefined) {
    logger.warn(
      { label: label ?? null, stderrTail: stderrTail(stderr) },
      "bed loudness: ffmpeg printed no ebur128 summary — it is mixed unlevelled",
    );
    return null;
  }
  // Silence (-inf, or under the meter's -70 floor) is a real answer, not a failure: there is nothing to level.
  const value = last === "-inf" ? null : Number(last);
  return value !== null && Number.isFinite(value) && value > -70 ? value : null;
}

/** The gain (dB) that brings a bed measured at `lufs` to the reference, clamped; null leaves it as it is. */
export function bedGainDb(lufs: number | null): number | null {
  if (lufs === null) return null;
  const g = BED_REFERENCE_LUFS - lufs;
  return (
    Math.round(Math.max(-MAX_BED_GAIN_DB, Math.min(MAX_BED_GAIN_DB, g)) * 100) /
    100
  );
}

/** A curated bed's measured grid, or null — her own video's sound has none, and neither does an unmeasured bed. */
export function gridForBed(name: BedName | undefined): BeatGrid | null {
  if (!name) return null;
  if (isTrackId(name)) {
    const t = MUSIC_TRACKS[name];
    return t.firstBeatSec === null
      ? null
      : { bpm: t.bpm, firstBeatSec: t.firstBeatSec };
  }
  return (
    (STITCH_BEDS as Record<string, { beat: BeatGrid | null }>)[name]?.beat ??
    null
  );
}

/** How long a timeline runs, on plan.ts's clock: every position's effective length, less what crossfades overlap. */
export function programmeSec(clips: readonly SnapClip[]): number {
  return clips.reduce((t, c, i) => {
    const start = c.trimStartSec ?? 0;
    const end = Math.min(c.trimEndSec ?? c.sourceSec, c.sourceSec);
    return t + (end - start) - (i > 0 ? (c.crossfadeSec ?? 0) : 0);
  }, 0);
}

/** One timeline position, as the snap needs it: where it is cut from, how long it runs, and how it joins. */
export interface SnapClip {
  trimStartSec?: number;
  trimEndSec?: number;
  /** Seconds the source runs — the probed duration for a clip, the hold for a still. */
  sourceSec: number;
  /** A still's hold is not the snap's to move. */
  still: boolean;
  /** Present when this position fades IN from the one before — that join is not a cut. */
  crossfadeSec?: number;
}

/**
 * Move each CUT join back onto the nearest beat at or before it, within MAX_BEAT_SHIFT_SEC, by shortening the clip that
 * ends there. Pure. Returns the new trimEndSec per position (undefined = unchanged) and how many joins moved.
 *
 * A join is only moved when the clip ENDING there is a clip (not a still), the next position cuts in (no crossfade),
 * and the shortened clip keeps MIN_CLIP_SEC. The programme clock runs on from where each join actually lands, so a
 * moved join moves every later one with it — which is what "cut on the beat" means.
 */
export function snapCutsToBeat(
  clips: readonly SnapClip[],
  grid: BeatGrid,
  bedStartSec = 0,
): { trimEndSec: (number | undefined)[]; moved: number } {
  const out: (number | undefined)[] = clips.map(() => undefined);
  // The programme clock, as plan.ts's accumulator runs it: a crossfade INTO a position overlaps the timeline by its
  // length, a cut adds the whole clip.
  let t = 0;
  let moved = 0;
  clips.forEach((c, i) => {
    const start = c.trimStartSec ?? 0;
    const end = Math.min(c.trimEndSec ?? c.sourceSec, c.sourceSec);
    let dur = end - start;
    const fadeIn = i > 0 ? (c.crossfadeSec ?? 0) : 0;
    const next = clips[i + 1];
    if (next && !c.still && next.crossfadeSec === undefined) {
      const join = t - fadeIn + dur;
      // The latest beat at or before the join, on the programme clock (beatGrid.ts `beatAt`).
      const k = Math.floor(
        ((join + bedStartSec - grid.firstBeatSec) * grid.bpm) / 60,
      );
      const shift = join - beatAt(grid, k, bedStartSec);
      if (
        shift > 1e-6 &&
        shift <= MAX_BEAT_SHIFT_SEC &&
        dur - shift >= MIN_CLIP_SEC
      ) {
        dur -= shift;
        out[i] = Math.round((start + dur) * 1000) / 1000;
        moved++;
      }
    }
    t = t - fadeIn + dur;
  });
  return { trimEndSec: out, moved };
}
