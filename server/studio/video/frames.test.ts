/**
 * frames.test.ts — the tier-1 instrument, against clips whose content we chose.
 *
 * ─── WHY THE FIXTURES ARE BUILT HERE AND NOT CHECKED IN ────────────────────────────────────────
 *
 * Two reasons, and the second one is a rule rather than a preference.
 *
 * 1. A clip whose brightness we DECIDED is the only way to know what the curve should say. Against
 *    real footage every number is plausible, which is the same trap `qa/labeledSet.ts` describes —
 *    a check tuned until it memorises a corpus has been fitted, not tested.
 * 2. The real corpus is footage of a real athlete. CLAUDE.local.md: all fixtures are synthetic. The
 *    clips on disk under probe-out/ are a LOCAL validation corpus read by a script
 *    (server/scripts/studioVideoQaCorpus.ts), never a committed fixture, and nothing derived from
 *    them — not an id, not a frame, not a verdict string — enters the repo.
 *
 * ffmpeg's own `lavfi` sources make both free and byte-reproducible, which is the same argument
 * video/testFixtures.ts already makes for the stitch suite. Measured on this machine: a 6s clip
 * builds in ~54ms and three frames come out in ~75ms, so a suite that shells out to ffmpeg costs
 * milliseconds rather than being a reason to mock it.
 *
 * ⚠️ THE CONCAT **FILTER**, NEVER THE DEMUXER. The demuxer produces a file ffmpeg exits 0 on and
 * later stages read as corrupt (video V6). Every multi-segment fixture below is built with
 * `-filter_complex concat`.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

import {
  DRIFT_HEIGHT,
  DRIFT_WIDTH,
  driftCurve,
  extractStrip,
  FramesError,
  selectFrames,
  type FrameStrip,
} from "./frames";

const execFileP = promisify(execFile);

/** Every fixture is this size, so a strip is small and the drift resize is close to a no-op. */
const W = 180;
const H = 320;
const FPS = 24;

/**
 * Build a clip out of solid-colour segments.
 *
 * Solid colours are the point: greyscale black is ~0 and greyscale white is ~235-255 depending on
 * the range h264 writes, so a black-vs-white frame pair is the largest difference the instrument can
 * report and a black-vs-black pair is the smallest. Every assertion below is stated as a SEPARATION
 * rather than as a literal, because the exact value depends on whether the encoder used limited or
 * full range and that is not what any of these tests are about.
 */
async function makeClip(
  dir: string,
  name: string,
  segments: { color: string; durationSec: number }[],
): Promise<string> {
  const path = join(dir, `${name}.mp4`);
  const inputs = segments.flatMap((s) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=${s.color}:s=${W}x${H}:d=${s.durationSec}:r=${FPS}`,
  ]);
  const chain = segments.map((_, i) => `[${i}:v]`).join("");
  await execFileP(
    "ffmpeg",
    [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      `${chain}concat=n=${segments.length}:v=1:a=0[v]`,
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return path;
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

let dir: string;
/** 4s of solid black. Nothing changes, so every drift value must be ~0. */
let uniform: string;
/** 3s black then 3s white. One join, and the curve has to find it. */
let step: string;
/**
 * ─── THE SPIKE. 6s: black 0-1.5, white 1.5-2.5, black 2.5-6. ──────────────────────────────────
 *
 * Built to have V2b's hard cell's SHAPE rather than its content: the excursion is early and the
 * clip ENDS BACK WHERE IT STARTED. That is what separates an adaptive sampler from a grid —
 * `hard-veo-3.1` peaks at t=2 on a 6s clip and a fixed first/middle/last samples t=3, so the grid
 * spends the same money and sees nothing. Here the arithmetic is exact instead of photographic:
 * the grid's three stamps are all inside a black stretch.
 */
let spike: string;
/** The fixtures' own frame rate, which `selectFrames` needs for the coverage denominator. */
const SOURCE_FPS = FPS;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "frames-test-"));
  [uniform, step, spike] = await Promise.all([
    makeClip(dir, "uniform", [{ color: "black", durationSec: 4 }]),
    makeClip(dir, "step", [
      { color: "black", durationSec: 3 },
      { color: "white", durationSec: 3 },
    ]),
    makeClip(dir, "spike", [
      { color: "black", durationSec: 1.5 },
      { color: "white", durationSec: 1 },
      { color: "black", durationSec: 3.5 },
    ]),
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Strips are disposable; every test that takes one gives it back. */
const withStrip = async <T>(
  strip: Promise<FrameStrip>,
  fn: (s: FrameStrip) => Promise<T>,
): Promise<T> => {
  const s = await strip;
  try {
    return await fn(s);
  } finally {
    await s.dispose();
  }
};

describe("extractStrip", () => {
  it("takes a dense strip at the requested rate, with times derived from the plan", async () => {
    await withStrip(
      extractStrip(uniform, { kind: "fps", fps: 4 }),
      async (s) => {
        // 4s at 4fps. ffmpeg's resampler can land one either side of the nominal count depending on
        // where the last frame falls, so the assertion is a range rather than a number — the property
        // under test is the RATE and the derived times, not ffmpeg's rounding.
        expect(s.frames.length).toBeGreaterThanOrEqual(15);
        expect(s.frames.length).toBeLessThanOrEqual(17);
        expect(s.frames[0].timeSec).toBe(0);
        expect(s.frames[1].timeSec).toBeCloseTo(0.25, 6);
        expect(s.frames[4].timeSec).toBeCloseTo(1, 6);
        expect(s.durationSec).toBeCloseTo(4, 1);
        expect(s.plan).toEqual({ kind: "fps", fps: 4 });
      },
    );
  });

  it("takes an exact-stamp strip, which is the bake-off's own method", async () => {
    await withStrip(
      extractStrip(step, { kind: "stamps", seconds: [0, 2, 4] }),
      async (s) => {
        expect(s.frames.map((f) => f.timeSec)).toEqual([0, 2, 4]);
        expect(s.plan).toEqual({ kind: "stamps", seconds: [0, 2, 4] });
      },
    );
  });

  it("drops a stamp past the end rather than failing the strip", async () => {
    // The bake-off's rule, kept: "a missing stamp is not a failed cell". The clip is 4s; 9 is past
    // it and 2 is not, and asking for both must yield the one that exists.
    await withStrip(
      extractStrip(uniform, { kind: "stamps", seconds: [2, 9] }),
      async (s) => {
        expect(s.frames.map((f) => f.timeSec)).toEqual([2]);
      },
    );
  });

  it("refuses a URL by name instead of handing it to ffmpeg", async () => {
    // Not a style check: a signed URL's query string IS the credential, and ffmpeg echoes its input
    // back in stderr (the lesson duration-precision had to learn twice). A clean refusal here is
    // what keeps that out of a log line.
    await expect(
      extractStrip(
        "https://storage.googleapis.com/bucket/clip.mp4?X-Goog-Signature=secret",
      ),
    ).rejects.toMatchObject({ code: "not_a_path" });
    await expect(
      extractStrip("https://example.test/a.mp4"),
    ).rejects.toBeInstanceOf(FramesError);
  });

  it("disposes its directory, and is safe to dispose twice", async () => {
    const s = await extractStrip(uniform, { kind: "stamps", seconds: [0] });
    expect(await exists(s.dir)).toBe(true);
    await s.dispose();
    expect(await exists(s.dir)).toBe(false);
    await expect(s.dispose()).resolves.toBeUndefined();
  });
});

describe("driftCurve", () => {
  it("indexes by FRAME — curve[0] is the base against itself, and the lengths match", async () => {
    // The one difference from the harness this was lifted from: it returned n-1 values, skipping the
    // base, so a curve index was off by one from a frame index. Pinned because `selectFrames` reads
    // `strip.frames[argmax(curve)]` and an off-by-one there returns the wrong picture.
    await withStrip(
      extractStrip(step, { kind: "stamps", seconds: [0, 2, 4] }),
      async (s) => {
        const curve = await driftCurve(s);
        expect(curve).toHaveLength(s.frames.length);
        expect(curve[0]).toBe(0);
      },
    );
  });

  it("reports ~0 across a clip in which nothing changes", async () => {
    await withStrip(
      extractStrip(uniform, { kind: "fps", fps: 4 }),
      async (s) => {
        const curve = await driftCurve(s);
        expect(curve.length).toBeGreaterThan(8);
        for (const v of curve) expect(v).toBeLessThan(0.02);
      },
    );
  });

  /**
   * ⭐ REVERT CHECK `drift-curve-measures-change`.
   *
   * MUTATION: in frames.ts `driftCurve`, replace `Math.abs(base[i] - cur[i])` with any constant
   * (e.g. `1`). Every frame then scores identically, `after - before` collapses to 0, and the
   * separation assertion below reds by name.
   *
   * Both halves are asserted, not just one: a curve that reported a large number everywhere would
   * satisfy "the white half is high" while being useless, so the black half being LOW is half the
   * claim.
   */
  it("drift-curve-measures-change: the step clip's two halves separate", async () => {
    await withStrip(
      extractStrip(step, { kind: "stamps", seconds: [0, 1, 2, 4, 5] }),
      async (s) => {
        const curve = await driftCurve(s);
        const at = (t: number) =>
          curve[s.frames.findIndex((f) => f.timeSec === t)];

        // Still black — the same picture as the base.
        expect(at(1)).toBeLessThan(0.02);
        expect(at(2)).toBeLessThan(0.02);
        // White — the largest difference this instrument can report.
        expect(at(4)).toBeGreaterThan(0.5);
        expect(at(5)).toBeGreaterThan(0.5);
        // And the separation itself, which is the thing a constant difference destroys.
        expect(at(4) - at(2)).toBeGreaterThan(0.5);
      },
    );
  });

  it("is measured at a FIXED geometry, because a curve is only comparable to one taken the same way", async () => {
    // Not a behaviour test — a pin on the two constants that define the instrument. V2b's published
    // numbers, and every number this stage records from now on, are only comparable at this
    // geometry, which is why these two are deliberately not env-overridable.
    expect([DRIFT_WIDTH, DRIFT_HEIGHT]).toEqual([180, 320]);
  });
});

describe("selectFrames", () => {
  /**
   * ⭐⭐ REVERT CHECK `adaptive-sampling-hits-the-peak`.
   *
   * MUTATION, and there are TWO because the obvious one reds for the wrong reason:
   *
   *   A. `peakIndex = Math.floor(n / 2); peakDrift = curve[peakIndex]` — the literal grid
   *      midpoint. This DOES red (3 failed / 11 passed) but via `expect(peak).toBeDefined()`:
   *      the midpoint frame is black, its drift is under `peakFloor()`, so the sampler declares
   *      the clip motionless and emits no peak at all. A correct red, and not the claim.
   *   B. `peakIndex = Math.floor(n / 2); peakDrift = 1` — the same midpoint with the floor
   *      bypassed, so a peak role really is emitted at t≈3. This reds on
   *      `expect(peak.timeSec).toBeLessThan(2.5)` (2 failed / 12 passed), which IS the claim:
   *      the grid selected a frame outside the excursion.
   *
   * Written down rather than left to be rediscovered, because "it went red" is not the same as
   * "it went red for the reason on the tin".
   *
   * ⚠️ BOTH ARMS ARE ASSERTED IN ONE TEST, and that is the whole design of this check. A sampler
   * that happened to agree with the grid would satisfy "it found a high-drift frame" while being
   * no better than the thing it replaced. So the grid's MISS is proven here too: the same clip,
   * the same curve, the obvious three stamps, and nothing above the noise floor. Without that
   * half the test would pass on a sampler with no advantage at all.
   */
  it("adaptive-sampling-hits-the-peak: the peak is found, and a fixed grid misses it", async () => {
    await withStrip(extractStrip(spike, { kind: "fps", fps: 4 }), async (s) => {
      const curve = await driftCurve(s);
      const sample = selectFrames(s, curve, SOURCE_FPS);

      // ── THE ADAPTIVE ARM ──
      const peak = sample.frames.find((f) => f.role === "peak");
      expect(peak).toBeDefined();
      // The white window is [1.5, 2.5). Asserted as the window rather than one timestamp, because
      // which quarter-second inside it is brightest is ffmpeg's business and not this claim.
      expect(peak!.timeSec).toBeGreaterThanOrEqual(1.5);
      expect(peak!.timeSec).toBeLessThan(2.5);
      expect(peak!.drift).toBeGreaterThan(0.5);

      // ── THE GRID ARM — first / middle / last, the obvious thing, on the same curve ──
      const at = (t: number) => {
        const i = s.frames.findIndex((f) => Math.abs(f.timeSec - t) < 0.13);
        return i < 0 ? null : curve[i];
      };
      const grid = [at(0), at(3), curve[curve.length - 1]];
      for (const v of grid) {
        expect(v).not.toBeNull();
        expect(v!).toBeLessThan(0.02);
      }
      // Stated as the comparison, so the point survives a reader who skims: the grid's best frame
      // is below the noise floor while the adaptive pick is over half the scale.
      expect(peak!.drift - Math.max(...(grid as number[]))).toBeGreaterThan(
        0.5,
      );
    });
  });

  it("keeps the anchor and the last frame beside the peak, in time order", async () => {
    await withStrip(extractStrip(spike, { kind: "fps", fps: 4 }), async (s) => {
      const sample = selectFrames(s, await driftCurve(s), SOURCE_FPS);
      expect(sample.frames.map((f) => f.role)).toEqual([
        "anchor",
        "peak",
        "last",
      ]);
      expect(sample.frames[0].index).toBe(0);
      expect(sample.frames[2].index).toBe(s.frames.length - 1);
      // Ordered by time, which is not the order the roles are decided in.
      const times = sample.frames.map((f) => f.timeSec);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(sample.motionless).toBe(false);
    });
  });

  it("records coverage in three parts, so a pass can never claim every frame was clean", async () => {
    await withStrip(extractStrip(spike, { kind: "fps", fps: 4 }), async (s) => {
      const sample = selectFrames(s, await driftCurve(s), SOURCE_FPS);
      // The paid checks ran on three frames; the free pass looked at ~24; the clip has ~144. All
      // three are on the record, because a single ratio hides which half of the stage did what.
      expect(sample.coverage.checked).toBe(3);
      expect(sample.coverage.scanned).toBe(s.frames.length);
      expect(sample.coverage.total).toBeGreaterThan(sample.coverage.scanned);
      expect(sample.coverage.total).toBeGreaterThanOrEqual(140);
      expect(sample.coverage.checked).toBeLessThan(sample.coverage.total);
    });
  });

  it("says a motionless clip is motionless rather than aiming at the argmax of noise", async () => {
    await withStrip(
      extractStrip(uniform, { kind: "fps", fps: 4 }),
      async (s) => {
        const sample = selectFrames(s, await driftCurve(s), SOURCE_FPS);
        expect(sample.motionless).toBe(true);
        // No peak: below the floor the argmax is a random frame, and spending a paid check on it
        // would put an arbitrary picture on the record as though it were interesting.
        expect(sample.frames.map((f) => f.role)).toEqual(["anchor", "last"]);
      },
    );
  });

  it("returns the anchor alone when there is only one frame to have", async () => {
    await withStrip(
      extractStrip(uniform, { kind: "stamps", seconds: [1] }),
      async (s) => {
        const sample = selectFrames(s, await driftCurve(s), SOURCE_FPS);
        expect(sample.frames).toHaveLength(1);
        expect(sample.frames[0].role).toBe("anchor");
        expect(sample.coverage.checked).toBe(1);
      },
    );
  });
});
