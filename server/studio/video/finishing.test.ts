/**
 * finishing.test.ts — the finishing pass's pure rules and its one measurement (quality-scrappy piece 6, ADI-QS-GO):
 * the beat snap, the bed's gain to the reference, which beds carry a grid, and the loudness read off a real file.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M6a — the snap lengthens a clip onto the NEXT beat instead of shortening onto the last: "a cut only ever moves
 *         earlier" reds.
 *   M6b — the snap moves a crossfade: "a crossfade join is not a cut, and is left alone" reds.
 *   M6i — the window ignored (whole-track loudness): "the window that plays is what is measured" reds.
 */
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import {
  BED_REFERENCE_LUFS,
  MAX_BEAT_SHIFT_SEC,
  MAX_BED_GAIN_DB,
  MIN_CLIP_SEC,
  bedGainDb,
  gridForBed,
  measureLoudness,
  snapCutsToBeat,
  type SnapClip,
} from "./finishing";

jest.setTimeout(60_000);
const DIR = mkdtempSync(join(tmpdir(), "finishing-test-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** 120 BPM — a beat every 0.5 s — with the first at 0.1 s. Beats: 0.1, 0.6, 1.1, 1.6, 2.1, 2.6 … */
const GRID = { bpm: 120, firstBeatSec: 0.1 };
const clip = (sourceSec: number, over: Partial<SnapClip> = {}): SnapClip => ({
  sourceSec,
  still: false,
  ...over,
});

describe("snapCutsToBeat", () => {
  it("a cut 0.2 s past a beat moves back onto it — the outgoing clip is trimmed", () => {
    // Join at 2.3 → the latest beat at or before it is 2.1.
    expect(snapCutsToBeat([clip(2.3), clip(3)], GRID)).toEqual({
      trimEndSec: [2.1, undefined],
      moved: 1,
    });
  });

  it("a cut only ever moves earlier — never lengthens a clip onto the next beat", () => {
    // Join at 2.55 → latest beat 2.1 is 0.45 back (in reach); 2.6 is 0.05 ahead and is NOT taken.
    const r = snapCutsToBeat([clip(2.55), clip(3)], GRID);
    expect(r.trimEndSec[0]).toBe(2.1);
    for (const t of r.trimEndSec)
      if (t !== undefined) expect(t).toBeLessThanOrEqual(2.55);
  });

  it("out of reach, or it would leave the clip too short: the cut stays", () => {
    expect(MAX_BEAT_SHIFT_SEC).toBe(0.5);
    // A join exactly on a beat has nothing to move.
    expect(snapCutsToBeat([clip(2.1), clip(3)], GRID).moved).toBe(0);
    // A 0.55 s clip whose join (0.55) is 0.45 past the beat at 0.1: shortening would leave 0.1 s < MIN_CLIP_SEC.
    expect(MIN_CLIP_SEC).toBe(0.5);
    expect(snapCutsToBeat([clip(0.55), clip(3)], GRID).moved).toBe(0);
  });

  it("a crossfade join is not a cut, and is left alone", () => {
    expect(
      snapCutsToBeat([clip(2.3), clip(3, { crossfadeSec: 0.5 })], GRID).moved,
    ).toBe(0);
  });

  it("a still's hold is not the snap's to move (the client's On the beat already cut it)", () => {
    expect(
      snapCutsToBeat([clip(2.3, { still: true }), clip(3)], GRID).moved,
    ).toBe(0);
  });

  it("the clock runs on from where each join landed — a moved join moves every later one", () => {
    // Joins: 2.3 → 2.1 (moved). Then the second clip ends at 2.1 + 2.3 = 4.4 → latest beat 4.1, moved again.
    expect(snapCutsToBeat([clip(2.3), clip(2.3), clip(3)], GRID)).toEqual({
      trimEndSec: [2.1, 2.0, undefined],
      moved: 2,
    });
  });

  it("the bed's start offset shifts the grid into programme time; a trim start is kept", () => {
    // Track starts 0.3 s in: programme beats at -0.2, 0.3, 0.8 … 2.3. A 2.4 s clip trimmed from 1 s joins at 2.4.
    const r = snapCutsToBeat(
      [clip(10, { trimStartSec: 1, trimEndSec: 3.4 }), clip(3)],
      GRID,
      0.3,
    );
    expect(r).toEqual({ trimEndSec: [3.3, undefined], moved: 1 });
  });

  it("the last position has no cut after it and is never trimmed", () => {
    expect(snapCutsToBeat([clip(2.3)], GRID)).toEqual({
      trimEndSec: [undefined],
      moved: 0,
    });
  });
});

describe("the bed's gain, and its grid", () => {
  it("brings a bed to the reference, clamped; no measurement leaves it as it is", () => {
    expect(BED_REFERENCE_LUFS).toBe(-14);
    expect(bedGainDb(-8.4)).toBe(-5.6);
    expect(bedGainDb(-15.5)).toBe(1.5);
    expect(bedGainDb(-60)).toBe(MAX_BED_GAIN_DB);
    expect(bedGainDb(null)).toBeNull();
  });

  it("a curated track and a measured bed carry a grid; her own video, and no bed, do not", () => {
    expect(gridForBed("walking-around")).toEqual({
      bpm: 84,
      firstBeatSec: 0.696,
    });
    expect(gridForBed("walking-away")).toMatchObject({
      bpm: expect.any(Number),
    });
    expect(gridForBed(undefined)).toBeNull();
  });
});

describe("measureLoudness, on a real file", () => {
  const ff = (args: string[]) =>
    promisify(execFile)("ffmpeg", [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      ...args,
    ]);

  it("reads loudness that tracks level: the same tone 12 dB down measures 12 LU quieter", async () => {
    const loud = join(DIR, "tone-0.m4a");
    const quiet = join(DIR, "tone-12.m4a");
    await ff([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-c:a",
      "aac",
      loud,
    ]);
    await ff([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-af",
      "volume=-12dB",
      "-c:a",
      "aac",
      quiet,
    ]);
    const [a, b] = [await measureLoudness(loud), await measureLoudness(quiet)];
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a! - b!).toBeCloseTo(12, 0);
  });

  it("the window that plays is what is measured — a quiet intro is not averaged away by a loud track (P6b′)", async () => {
    const bed = join(DIR, "quiet-intro.m4a");
    await ff([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=24",
      "-filter_complex",
      "[0:a]volume=-24dB[q];[q][1:a]concat=n=2:v=0:a=1[a]",
      "-map",
      "[a]",
      "-c:a",
      "aac",
      bed,
    ]);
    const whole = await measureLoudness(bed);
    const intro = await measureLoudness(bed, { startSec: 0, durationSec: 6 });
    expect(whole! - intro!).toBeGreaterThan(15);
  });

  it("silence, and a file with no sound, measure as nothing — never a huge gain", async () => {
    const silent = join(DIR, "silent.m4a");
    await ff([
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t",
      "3",
      "-c:a",
      "aac",
      silent,
    ]);
    expect(await measureLoudness(silent)).toBeNull();
    const mute = join(DIR, "mute.mp4");
    await ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x284:rate=24:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      mute,
    ]);
    expect(await measureLoudness(mute)).toBeNull();
  });
});
