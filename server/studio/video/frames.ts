/**
 * frames.ts — a clip's frames as pictures, and how far each one has moved from where it started.
 *
 * This is TIER 1 of video QA, and the whole reason it exists is that TIER 2 costs money. A 6s Veo
 * clip at 24fps is 145 frames; running the five creative checks on all of them is ~700 vision calls
 * against a $1.20 generation. Nobody is proposing that. The question is WHICH frames, and this file
 * is the half that answers it for free: extract a strip, measure how far each frame has drifted from
 * frame 0, and hand the curve to `selectFrames` so the paid checks are pointed rather than sprinkled.
 *
 * Every function here is $0 by construction. No model call, no network, no database — ffmpeg, sharp
 * and arithmetic. The same property studio/video/stitch.ts has, for the same reason.
 *
 * ─── ⚠️  THE CURVE MEASURES CHANGE. IT IS NOT AN IDENTITY NUMBER, AND IT NEVER WILL BE. ────────
 *
 * Inherited verbatim from the bake-off harness this was lifted out of
 * (server/scripts/studioVideoBakeoff.ts), because the warning is the most important thing about it:
 *
 *     a clip that pans scores a large drift and may hold identity perfectly;
 *     a clip that holds still and swaps her face scores a small one.
 *
 * That is not a shortcoming to be tuned away. It is what a mean pixel difference IS. The project has
 * no identity number at all — `qa/identity.ts` carries DEAD_RULER_CAVEAT because
 * multimodalembedding@001 scored an invented person at 0.3584 against her held-out photographs,
 * INSIDE her own same-person band of 0.3158–0.4186. So nothing in this file may be read as evidence
 * about her face, and no verdict may be derived from it. Its only job is to RANK FRAMES FOR
 * ATTENTION.
 *
 * ─── LOCAL PATHS ONLY ──────────────────────────────────────────────────────────────────────────
 *
 * Same rule as video/types.ts states for the stitch engine: ffmpeg can stream https, but this module
 * has nowhere to carry a bearer token, so an expired or 401'd URL would surface as a deep decode
 * failure instead of a clean "fetch it first". A url is refused by name here rather than handed to
 * ffmpeg — `materialize.ts` already owns downloading, and the runner holds the bytes anyway.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import sharp from "sharp";

import { createLogger } from "../../logger";
import { probeMedia } from "./probe";

const execFileP = promisify(execFile);
const logger = createLogger("studio/video/frames");

/** One ffmpeg invocation's ceiling. Matches probe.ts, which is doing the same kind of work. */
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * How many stills per second the dense pass takes.
 *
 * 4 is a budget, not a measurement, and it is chosen against what the curve is FOR. The defect the
 * spike actually produced — a competitor's mark fading in — took about a second to appear, and the
 * turn in V2b's hard cell peaks over roughly two. A quarter-second grid resolves both with room to
 * spare, and costs one ffmpeg process either way because the whole strip comes out of a single call.
 *
 * Read at CALL time, like every other knob in this area (studio/videoJobs.ts leaseMs, materialize.ts
 * clipMaxBytes): a constant captured at import can only be changed by a deploy.
 */
export const stripFps = () => Number(process.env.STUDIO_QA_STRIP_FPS ?? 4);

/**
 * The hard ceiling on strip length, so a long clip cannot turn into thousands of files in a tmpfs.
 *
 * ⚠️ ON CLOUD RUN /tmp IS RAM — services/videoPoster.ts:13-16 and video/materialize.ts are both
 * explicit about it. 240 frames at 180x320 JPEG is a couple of MB, which is nothing; the cap exists
 * so that stays true for a 3-minute stitched timeline someone points this at by mistake.
 */
export const maxStripFrames = () =>
  Number(process.env.STUDIO_QA_MAX_STRIP_FRAMES ?? 240);

/**
 * The geometry every frame is reduced to before it is differenced.
 *
 * ⚠️ NOT ENV-OVERRIDABLE, DELIBERATELY, AND THIS IS THE ONE PLACE THIS AREA BREAKS ITS OWN RULE.
 * Everything else here is a knob because a wrong knob should be a config change. These two are not
 * knobs: they define the instrument. Every drift number ever recorded — V2b's published
 * 0.035 / 0.087 / 0.199, and everything this stage writes from now on — is only comparable to
 * another number taken at the same geometry. An env var would let two runs disagree silently, with
 * nothing on the record to say why, which is exactly the failure `qa/types.ts` refuses when it makes
 * `unknown` a distinct value. Changing these is a code change, and it invalidates the corpus.
 *
 * `fit: "fill"` distorts aspect on purpose: it makes a 9:16 clip and a 16:9 clip produce curves on
 * the same scale, and the distortion is identical for every frame of one clip so it cancels in the
 * difference.
 */
export const DRIFT_WIDTH = 180;
export const DRIFT_HEIGHT = 320;

/** How the strip is taken. Two modes, because they answer two different questions — see below. */
export type StripPlan =
  /**
   * DENSE. One ffmpeg call, `-vf fps=R`, every frame in time order. This is what production uses,
   * because `selectFrames` can only be adaptive if the curve it reads is dense enough to have a
   * peak worth finding.
   */
  | { kind: "fps"; fps?: number }
  /**
   * EXACT STAMPS. One `-ss` seek per timestamp — the bake-off's own method, kept byte-for-byte so a
   * reproduction of V2b's published numbers is an actual reproduction. A dense pass picks the
   * nearest decoded frame to each stamp, which is CLOSE to a seek and not identical, and "close"
   * is not what a reproduction means.
   */
  | { kind: "stamps"; seconds: number[] };

export interface StripFrame {
  path: string;
  /** Seconds into the clip. Derived from the plan, never guessed from the filename. */
  timeSec: number;
}

export interface FrameStrip {
  /** A disposable directory holding the stills. */
  dir: string;
  /** In time order. May be SHORTER than the plan asked for — see `extractStrip`. */
  frames: StripFrame[];
  /** ffprobe's own figure for the source. */
  durationSec: number;
  /** How the strip was taken, for the record — two runs are only comparable at the same plan. */
  plan: { kind: "fps"; fps: number } | { kind: "stamps"; seconds: number[] };
  /** Idempotent. Safe to call twice, and safe to call after a throw. */
  dispose(): Promise<void>;
}

export class FramesError extends Error {
  constructor(
    message: string,
    readonly code: "not_a_path" | "no_frames" | "ffmpeg_failed",
  ) {
    super(message);
    this.name = "FramesError";
  }
}

/** A url is refused BY NAME rather than handed to ffmpeg. See the header. */
function assertLocalPath(source: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new FramesError(
      `frames.ts takes a local path and was given a URL (${source.split("?")[0]}). ` +
        "Download it first — this module carries no credential and cannot fetch.",
      "not_a_path",
    );
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileP(
      "ffmpeg",
      ["-y", "-nostdin", "-loglevel", "error", ...args],
      {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    // ⚠️ THE MESSAGE ONLY, AND TRUNCATED. ffmpeg echoes its whole input back in stderr — the lesson
    // duration-precision had to learn twice — so a signed URL's query string, which IS the
    // credential, would land in a log line if the raw error were carried. Nothing here is ever given
    // a URL (assertLocalPath), and the redaction stays anyway because that is one refactor away from
    // being false.
    throw new FramesError(
      `ffmpeg failed: ${String(e?.stderr ?? e?.message ?? err).slice(0, 300)}`,
      "ffmpeg_failed",
    );
  }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
};

/**
 * Take a strip of stills off a clip.
 *
 * ⚠️ THE RESULT MAY BE SHORTER THAN THE PLAN, AND THAT IS NOT AN ERROR. A stamp past the end of the
 * clip produces no file; a dense pass on a clip shorter than one frame interval produces one. Both
 * are ordinary and both are reported by the strip simply being short — the bake-off's rule ("a
 * missing stamp is not a failed cell"), kept. A strip with NO frames at all IS an error, because
 * there is nothing to measure and silently returning an empty curve would read as "no drift".
 */
export async function extractStrip(
  source: string,
  plan: StripPlan = { kind: "fps" },
): Promise<FrameStrip> {
  assertLocalPath(source);

  const probed = await probeMedia(source);
  const dir = await mkdtemp(join(tmpdir(), "studio-strip-"));
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const frames =
      plan.kind === "fps"
        ? await denseStrip(source, dir, plan.fps ?? stripFps())
        : await stampStrip(source, dir, plan.seconds, probed.durationSec);

    if (!frames.length) {
      throw new FramesError(
        `No frames came out of ${source} (${probed.durationSec}s) — nothing to measure`,
        "no_frames",
      );
    }

    logger.debug(
      {
        source,
        frames: frames.length,
        durationSec: probed.durationSec,
        plan: plan.kind,
      },
      "strip extracted",
    );
    return {
      dir,
      frames,
      durationSec: probed.durationSec,
      plan:
        plan.kind === "fps"
          ? { kind: "fps", fps: plan.fps ?? stripFps() }
          : { kind: "stamps", seconds: plan.seconds },
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}

/**
 * ONE ffmpeg call for the whole strip. `-vf fps=R` resamples the clip to R stills per second, so
 * output frame n (1-indexed) is the frame at t = (n-1)/R — derived, never parsed back out of a
 * filename.
 */
async function denseStrip(
  source: string,
  dir: string,
  fps: number,
): Promise<StripFrame[]> {
  const cap = maxStripFrames();
  await ffmpeg([
    "-i",
    source,
    "-vf",
    `fps=${fps}`,
    "-frames:v",
    String(cap),
    "-q:v",
    "3",
    join(dir, "f-%05d.jpg"),
  ]);

  const frames: StripFrame[] = [];
  for (let n = 1; n <= cap; n++) {
    const path = join(dir, `f-${String(n).padStart(5, "0")}.jpg`);
    // The first gap ends the strip: ffmpeg numbers consecutively, so a missing n means it stopped.
    if (!(await exists(path))) break;
    frames.push({ path, timeSec: (n - 1) / fps });
  }
  return frames;
}

/**
 * ONE `-ss` seek per stamp — the bake-off's exact method, and the reason `StripPlan` has two arms.
 * `-ss` BEFORE `-i` is an input seek, which is the fast one and is what the harness used.
 */
async function stampStrip(
  source: string,
  dir: string,
  seconds: number[],
  durationSec: number,
): Promise<StripFrame[]> {
  const frames: StripFrame[] = [];
  for (const t of seconds) {
    if (!Number.isFinite(t) || t < 0 || t >= durationSec) continue;
    const path = join(dir, `t-${String(t).replace(/\./g, "_")}.jpg`);
    try {
      await ffmpeg([
        "-ss",
        String(t),
        "-i",
        source,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        path,
      ]);
    } catch {
      // A stamp that will not render is skipped, not fatal. See extractStrip's note.
      continue;
    }
    if (await exists(path)) frames.push({ path, timeSec: t });
  }
  return frames;
}

/**
 * How far each frame has moved from frame 0 — mean absolute greyscale difference at DRIFT_WIDTH x
 * DRIFT_HEIGHT, normalized to 0..1 and rounded to three places.
 *
 * ⚠️ THE ARITHMETIC IS THE BAKE-OFF'S, UNCHANGED, and that is the point: V2b's published numbers
 * (0.035·0.031 easy, 0.087·0.166 med, 0.199·0.163 hard) have to remain reproducible by this
 * function or the corpus it was measured against is worthless as a baseline.
 *
 * ONE DIFFERENCE, and it is indexing rather than arithmetic: the harness returned n-1 values,
 * skipping the base. This returns n, with `curve[0] === 0` for frame 0 against itself, so a curve
 * index is a FRAME index and `selectFrames` can read `strip.frames[i]` without an off-by-one. To
 * compare against a published pair, take `curve.slice(1)`.
 */
export async function driftCurve(strip: FrameStrip): Promise<number[]> {
  if (!strip.frames.length) return [];
  const grey = (path: string) =>
    sharp(path)
      .resize(DRIFT_WIDTH, DRIFT_HEIGHT, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

  const base = await grey(strip.frames[0].path);
  const out: number[] = [0];
  for (const f of strip.frames.slice(1)) {
    const cur = await grey(f.path);
    let sum = 0;
    // Guarded rather than assumed: a decode that came back a different size would otherwise read
    // past the end of one buffer and quietly produce a number.
    const len = Math.min(base.length, cur.length);
    for (let i = 0; i < len; i++) sum += Math.abs(base[i] - cur[i]);
    out.push(Math.round((sum / len / 255) * 1000) / 1000);
  }
  return out;
}
// ─── TIER 2's SAMPLE — A2, appended to frames.ts ───────────────────────────────────────────────

/** Why a frame is in the sample. Three ROLES, not a quota — see `selectFrames`. */
export type FrameRole = "anchor" | "peak" | "last";

export interface SelectedFrame {
  /** Index into BOTH `strip.frames` and the curve. They are the same index by construction. */
  index: number;
  timeSec: number;
  drift: number;
  role: FrameRole;
}

export interface FrameSample {
  /** In time order, deduplicated. At most three, and fewer on a short or motionless clip. */
  frames: SelectedFrame[];
  /**
   * ─── THE HONEST DENOMINATOR, IN THREE PARTS ──────────────────────────────────────────────────
   *
   * A single ratio would hide which half of the stage did what, and the difference matters: the
   * cheap pass looked at `scanned` frames and the PAID checks looked at `checked` of them. A
   * verdict that said "3 of 145" alone would read as though the other 142 were never seen at all,
   * and a verdict that said "3 of 24" would quietly redefine the clip as its own strip.
   *
   * `total` is DERIVED (fps x duration), not counted — ffprobe's nb_frames is absent on plenty of
   * containers and a guess dressed as a count is worse than an admitted derivation.
   */
  coverage: {
    /** Frames the paid checks actually ran on. */
    checked: number;
    /** Frames the $0 drift pass looked at. */
    scanned: number;
    /** Frames in the clip, derived from its own fps and duration. */
    total: number;
  };
  /**
   * True when the curve is flat — nothing moved, so there is no peak to aim at and the sample is
   * the anchor and the last frame. Recorded rather than inferred from `frames.length`, because
   * "nothing moved" and "the clip was two frames long" are different facts.
   */
  motionless: boolean;
}

/**
 * How much drift counts as a peak worth aiming at.
 *
 * A clip whose largest excursion is under this has not really gone anywhere, and the argmax of
 * noise is a random frame — spending a paid check on it buys nothing and puts an arbitrary frame on
 * the record as though it were interesting. Below the floor the sample is anchor + last and
 * `motionless` says so.
 *
 * 0.02 is where the uniform-clip fixture sits (measured: every value under 0.02 on a clip in which
 * literally nothing changes, so this is the noise floor of JPEG round-tripping rather than a taste
 * call). Env-overridable, read at call time — unlike DRIFT_WIDTH/HEIGHT this IS a knob: it decides
 * what to look at, not what the number means.
 */
export const peakFloor = () => Number(process.env.STUDIO_QA_PEAK_FLOOR ?? 0.02);

/**
 * Pick the frames the paid checks run on.
 *
 * ─── ⚠️  THREE ROLES, NOT A GRID, AND NOT A COUNT ──────────────────────────────────────────────
 *
 *   anchor  frame 0. It is the i2v first frame, so it is also the thing the clip is supposed to
 *           still BE — every comparison check needs it as its source half.
 *   peak    argmax of the drift curve. Where the clip is furthest from its anchor, which is where
 *           a defect that arrived during the render is most likely to be visible.
 *   last    the final frame. Continuity into the next segment depends on it — a stitch makes clip
 *           N's last frame clip N+1's neighbour.
 *
 * There is deliberately NO count knob. "Sample 5 frames" has no defined meaning here: the three are
 * roles with reasons, and a fourth would need its own reason before it could have its own frame.
 * (A second, well-separated peak is detectable from the same curve for $0 and is a later card, not
 * a bigger number.)
 *
 * ─── WHY NOT first / middle / last, WHICH IS THE OBVIOUS THING ─────────────────────────────────
 *
 * Because it spends exactly the same money in the wrong place. V2b's hard cell peaks at t=2 on a 6s
 * clip; a fixed grid's midpoint is t=3. The test for this asserts BOTH arms — the peak is found AND
 * the grid misses it — because a sampler that happened to agree with the grid would pass a
 * one-armed test while being no better than it.
 */
export function selectFrames(
  strip: FrameStrip,
  curve: number[],
  sourceFps: number,
): FrameSample {
  const n = Math.min(strip.frames.length, curve.length);
  const total = Math.max(
    n,
    Math.round((sourceFps || 0) * strip.durationSec) || n,
  );
  const coverageOf = (checked: number) => ({ checked, scanned: n, total });

  if (n === 0) {
    return { frames: [], coverage: coverageOf(0), motionless: true };
  }

  const at = (index: number, role: FrameRole): SelectedFrame => ({
    index,
    timeSec: strip.frames[index].timeSec,
    drift: curve[index],
    role,
  });

  // The anchor is unconditional: every comparison check needs a source half, and on a one-frame
  // strip it is also the only thing there is.
  const picked = new Map<number, SelectedFrame>();
  picked.set(0, at(0, "anchor"));

  // THE PEAK. Searched over 1..n-1 — index 0 is the base against itself and is always 0, so
  // including it would make a motionless clip's peak its own anchor.
  let peakIndex = -1;
  let peakDrift = -1;
  for (let i = 1; i < n; i++) {
    if (curve[i] > peakDrift) {
      peakDrift = curve[i];
      peakIndex = i;
    }
  }
  const motionless = peakIndex < 0 || peakDrift < peakFloor();
  if (!motionless && !picked.has(peakIndex))
    picked.set(peakIndex, at(peakIndex, "peak"));

  // THE LAST FRAME. Added after the peak so that when they coincide the record keeps the reason
  // that costs money to find — a frame is in the sample because it is the peak, and being last too
  // is a coincidence rather than the reason.
  if (n > 1 && !picked.has(n - 1)) picked.set(n - 1, at(n - 1, "last"));

  const frames = [...picked.values()].sort((a, b) => a.index - b.index);
  return { frames, coverage: coverageOf(frames.length), motionless };
}
