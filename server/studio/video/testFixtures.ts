/**
 * testFixtures.ts — hermetic, $0 test material.
 *
 * Every clip is generated from ffmpeg's own lavfi sources, so the suite needs no binary
 * assets in git, no network and no model spend, and the inputs are byte-reproducible.
 *
 * The set is deliberately nasty: three resolutions, four frame rates, two pixel formats,
 * an anamorphic clip with SAR 2:1, and two clips with NO audio track. Those are the exact
 * conditions that make an unnormalized concat either fail outright or — worse — succeed
 * and write a corrupt file. Fixtures that all shared encode params would prove nothing.
 *
 * clipD is solid white on purpose: against the black padding it lets a test MEASURE which
 * way a frame was letterboxed, which is the only way to catch a silently squeezed
 * anamorphic conform from the output file.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";

const execFileP = promisify(execFile);

export type Fixture = { path: string; durationSec: number; hasAudio: boolean };
export type Fixtures = {
  /** 640x360, 30fps, yuv420p, sine 440Hz, 2.0s — landscape, with audio. */
  clipA: Fixture;
  /** 320x240, 24fps, yuv420p, 1.5s — 4:3, NO audio track. */
  clipB: Fixture;
  /** 240x426, 25fps, yuv420p, sine 880Hz, 1.0s — portrait, with audio. */
  clipC: Fixture;
  /** 640x480 storage with SAR 2:1 (=1280x480 on screen), 30fps, yuv422p, 1.0s, solid white, NO audio. */
  clipD: Fixture;
  /** sine 220Hz, 12s — longer than any timeline built from the clips, so looping is exercised too. */
  bed: Fixture;
};

/** The bed's tone. Tests bandpass this to measure the bed in isolation from the programme. */
export const BED_TONE_HZ = 220;
/** clipA's tone. Deliberately an octave above the bed so the two never share a band. */
export const CLIP_A_TONE_HZ = 440;

async function ff(args: string[]): Promise<void> {
  await execFileP("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function makeFixtures(dir: string): Promise<Fixtures> {
  const clipA = join(dir, "a-landscape-30fps.mp4");
  const clipB = join(dir, "b-4x3-24fps-noaudio.mp4");
  const clipC = join(dir, "c-portrait-25fps.mp4");
  const clipD = join(dir, "d-anamorphic-sar2-noaudio.mp4");
  const bed = join(dir, "bed-220hz.m4a");

  await Promise.all([
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${CLIP_A_TONE_HZ}:duration=2`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      clipA,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=24:duration=1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      clipB,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=240x426:rate=25:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      clipC,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      "color=c=white:size=640x480:rate=30:duration=1",
      "-vf",
      "setsar=2/1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv422p",
      clipD,
    ]),
    ff([
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${BED_TONE_HZ}:duration=12`,
      "-c:a",
      "aac",
      bed,
    ]),
  ]);

  return {
    clipA: { path: clipA, durationSec: 2.0, hasAudio: true },
    clipB: { path: clipB, durationSec: 1.5, hasAudio: false },
    clipC: { path: clipC, durationSec: 1.0, hasAudio: true },
    clipD: { path: clipD, durationSec: 1.0, hasAudio: false },
    bed: { path: bed, durationSec: 12.0, hasAudio: true },
  };
}

/**
 * Mean level (dBFS) of one frequency band over a time window.
 *
 * Measuring the mixed audio cannot show ducking — the window that contains the loud
 * programme is louder overall precisely BECAUSE the programme is in it, which swamps the
 * bed's attenuation and reads backwards. Since the fixtures are pure tones an octave
 * apart, band-passing the bed's frequency isolates the bed and makes the duck measurable.
 */
export async function measureBandDb(
  path: string,
  opts: {
    freqHz: number;
    bandwidthHz?: number;
    startSec: number;
    durationSec: number;
  },
): Promise<number> {
  const { stderr } = await execFileP(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(opts.startSec),
      "-t",
      String(opts.durationSec),
      "-i",
      path,
      "-map",
      "0:a",
      "-af",
      `bandpass=f=${opts.freqHz}:width_type=h:w=${opts.bandwidthHz ?? 40},volumedetect`,
      "-f",
      "null",
      "-",
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: any) => ({ stderr: String(err?.stderr ?? "") }));

  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`no mean_volume in ffmpeg output for ${path}`);
  return Number(match[1]);
}

/**
 * The bounding box of non-black content, via cropdetect. Reveals WHICH way a frame was
 * padded: full-width with bars top and bottom (letterbox) versus full-height with bars
 * left and right (pillarbox). An anamorphic clip conformed without squaring its pixels
 * comes out pillarboxed and squeezed, and this is how a test sees that from the file.
 */
export async function measureContentBox(
  path: string,
  opts: { startSec: number; durationSec: number },
): Promise<{ width: number; height: number; x: number; y: number }> {
  const { stderr } = await execFileP(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(opts.startSec),
      "-t",
      String(opts.durationSec),
      "-i",
      path,
      "-vf",
      "cropdetect=limit=16:round=2:skip=0",
      "-f",
      "null",
      "-",
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: any) => ({ stderr: String(err?.stderr ?? "") }));

  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(-?\d+):(-?\d+)/g)];
  if (matches.length === 0)
    throw new Error(`cropdetect found no crop box in ${path}`);
  const last = matches[matches.length - 1];
  return {
    width: Number(last[1]),
    height: Number(last[2]),
    x: Number(last[3]),
    y: Number(last[4]),
  };
}

/**
 * Exact frame count, by decoding. The container's nb_frames is often absent or a guess;
 * frame count is the sharpest assertion available on a stitch (5.5s at 30fps is 165
 * frames and nothing else), so it is worth decoding tiny fixtures to get it honestly.
 */
export async function countFrames(path: string): Promise<number> {
  const { stdout } = await execFileP(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      path,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return Number(stdout.trim());
}

/** Broadband level (dBFS) over a window. Digital silence reads about -91 dB; a fixture tone about -24. */
export async function measureLevelDb(
  path: string,
  opts: { startSec: number; durationSec: number },
): Promise<number> {
  const { stderr } = await execFileP(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(opts.startSec),
      "-t",
      String(opts.durationSec),
      "-i",
      path,
      "-map",
      "0:a",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: any) => ({ stderr: String(err?.stderr ?? "") }));

  if (/mean_volume:\s*-inf dB/.test(stderr)) return -Infinity;
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
  if (!match) throw new Error(`no mean_volume in ffmpeg output for ${path}`);
  return Number(match[1]);
}

/**
 * The CONTAINER's duration — the length of the longest stream, which is what a player
 * reports. Deliberately distinct from the manifest's `output.durationSec`, which is the
 * VIDEO stream's duration (the right number for timeline arithmetic, and blind to a
 * runaway audio tail: a bed mixed with `duration=longest` produced a 3.5s video stream
 * beside an 8566s audio stream, and only this number can see that).
 */
export async function probeContainerDurationSec(path: string): Promise<number> {
  const { stdout } = await execFileP(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return Number(stdout.trim());
}

/**
 * One decoded frame as packed RGB, and the mean absolute difference between two of them over a
 * band of rows.
 *
 * For asserting WHERE a picture changed. Two encodes of the same timeline are never bit-identical
 * once anything in them differs (x264's rate control moves), so "unchanged" is a small number and
 * "changed" is a large one — the tests state both, measured, rather than expecting zero.
 */
export async function readFrameRgb(
  path: string,
  atSec: number,
  size: { width: number; height: number },
): Promise<Buffer> {
  const { stdout } = await execFileP(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(atSec),
      "-i",
      path,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
  );
  const want = size.width * size.height * 3;
  if (stdout.length !== want) {
    throw new Error(
      `expected one ${size.width}x${size.height} frame (${want} bytes) from ${path}, got ${stdout.length}`,
    );
  }
  return stdout;
}

export function meanAbsDiffRows(
  a: Buffer,
  b: Buffer,
  width: number,
  rows: { from: number; to: number },
): number {
  let sum = 0;
  let n = 0;
  for (let i = rows.from * width * 3; i < rows.to * width * 3; i++) {
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}
