/**
 * beatGrid.ts — where the beats fall in a track, measured once, so a stills edit can cut on them.
 *
 *   the track ──ffmpeg──▶ mono PCM ──spectral flux──▶ onset strength ──comb + phase search──▶ grid
 *
 * ─── WHY THIS IS HAND-WRITTEN, AND WHY IT IS SMALL ──────────────────────────────────────────────
 *
 * There is no beat detector on this machine or in the container: no aubio, no librosa (no numpy
 * either), and ffmpeg has no onset filter — checked 22 Sep 2026, on ffmpeg 9.0.1 and on Debian's
 * 5.1.9. A native dependency is a decision this PR does not get to make, so the detector is the
 * textbook one, in TypeScript: a short-time spectrum, its positive log-magnitude change per frame
 * (spectral flux), and a search for the constant tempo and phase whose grid lands on the most of it.
 *
 * CONSTANT TEMPO ON PURPOSE. The tracks it is for are the curated beds (beds.ts) — drum-machine
 * lo-fi, steady from bar one. A grid is therefore two numbers, and a stitch that holds a photo for
 * whole beats needs nothing else. A track that drifts would need a beat LIST; none of the beds does.
 *
 * ─── WHEN IT RUNS ───────────────────────────────────────────────────────────────────────────────
 *
 * Offline, once per bed, by hand — the result is written into beds.ts beside `durationSec`, which is
 * the per-track cache. Nothing on the request or the stitch path decodes a track to find its beat.
 * Local CPU only: no network, no provider, no model.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { assertLocalPath } from "./plan";

const execFileP = promisify(execFile);

/** Two numbers: the tempo, and where beat 0 falls in the track. */
export interface BeatGrid {
  bpm: number;
  /** Seconds into the track of the first beat — in [0, 60/bpm). */
  firstBeatSec: number;
}

/** Analysis rate. The beat lives well below 5.5 kHz; more samples only cost time. */
export const BEAT_SAMPLE_RATE = 11_025;
/** A 46 ms window, hopped every 5.8 ms — short enough that a click's onset is sharp. */
const WIN = 512;
const HOP = 64;
/** The tempos a beat may have. Wider than any bed, narrower than a hi-hat pattern read as a beat. */
export const MIN_BPM = 60;
export const MAX_BPM = 200;
/**
 * Above this, a grid is almost always the eighth notes; it is halved. A 150-BPM edit cut on every
 * beat is a strobe, not a rhythm.
 */
const FOLD_ABOVE_BPM = 140;

/**
 * A frame-centred flux spike comes a quarter-window BEFORE the click that caused it: the click is
 * counted while it climbs the hann window's steepest flank, ahead of the centre. Added back.
 */
const ONSET_LATENCY_SEC = WIN / 4 / BEAT_SAMPLE_RATE;

/** Decode any track ffmpeg can read to mono float PCM at the analysis rate. */
export async function decodeMono(path: string): Promise<Float32Array> {
  assertLocalPath(path, "beat source");
  const { stdout } = await execFileP(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(BEAT_SAMPLE_RATE),
      "-f",
      "f32le",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  const buf = stdout as unknown as Buffer;
  return new Float32Array(
    buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.length - (buf.length % 4),
    ),
  );
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/**
 * Onset strength per frame: positive log-magnitude spectral change, with its local mean removed so
 * a crescendo is not read as a beat. Frame f is centred on sample f·HOP.
 */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor(samples.length / HOP));
  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++)
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const flux = new Float64Array(frames);
  let prev = new Float64Array(WIN / 2);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - WIN / 2;
    for (let i = 0; i < WIN; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(WIN / 2);
    let sum = 0;
    for (let k = 1; k < WIN / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) sum += d;
    }
    flux[f] = sum;
    prev = mag;
  }
  // Subtract a ~0.2 s moving mean and keep what rises above it.
  const half = Math.round((0.1 * BEAT_SAMPLE_RATE) / HOP);
  const out = new Float64Array(frames);
  let acc = 0;
  let lo = 0;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) acc += flux[++hi];
    while (lo < f - half) acc -= flux[lo++];
    out[f] = Math.max(0, flux[f] - acc / (hi - lo + 1));
  }
  return out;
}

/** The envelope at a fractional frame, linearly interpolated; 0 off either end. */
const at = (env: Float64Array, x: number): number => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= env.length) return 0;
  const t = x - i;
  return env[i] * (1 - t) + env[i + 1] * t;
};

/** Mean onset strength on a grid of `period` frames starting at `phase` frames. */
function gridStrength(
  env: Float64Array,
  period: number,
  phase: number,
): number {
  let s = 0;
  let n = 0;
  for (let x = phase; x < env.length - 1; x += period) {
    s += at(env, x);
    n++;
  }
  return n ? s / n : 0;
}

/** The phase (in frames, within one period) whose grid is strongest, searched at 1 ms. */
function bestPhase(
  env: Float64Array,
  period: number,
): { phase: number; s: number } {
  const step = (0.001 * BEAT_SAMPLE_RATE) / HOP;
  let best = { phase: 0, s: -1 };
  for (let ph = 0; ph < period; ph += step) {
    const s = gridStrength(env, period, ph);
    if (s > best.s) best = { phase: ph, s };
  }
  return best;
}

/**
 * The grid, from an onset envelope.
 *
 *   1. A comb over the autocorrelation picks a tempo region (60–200 BPM, 0.25-BPM steps).
 *   2. Period and phase are refined TOGETHER over the whole track (±1.5 %, 0.02-BPM steps; phase at
 *      1 ms) — a tempo 0.1 BPM off drifts a whole beat across a two-minute track, so the phase can
 *      only be trusted beside a period fitted to all of it.
 *   3. Octave: if the off-beats are nearly as strong as the beats, the grid is too slow and doubles;
 *      above FOLD_ABOVE_BPM it halves onto the stronger of its two half-grids.
 */
export function gridFromEnvelope(env: Float64Array): BeatGrid {
  const fps = BEAT_SAMPLE_RATE / HOP;
  const bpmOf = (period: number) => (60 * fps) / period;
  const periodOf = (bpm: number) => (60 * fps) / bpm;
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);

  // 1. Comb: a tempo whose multiples of lag all correlate.
  const ac = (lag: number) => {
    let s = 0;
    const L = Math.floor(lag);
    const t = lag - L;
    for (let i = 0; i + L + 1 < env.length; i++) {
      s += env[i] * (env[i + L] * (1 - t) + env[i + L + 1] * t);
    }
    return s;
  };
  let coarse = 120;
  let coarseScore = -Infinity;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const lag = periodOf(bpm);
    const score = ac(lag) + 0.5 * ac(2 * lag) + 0.25 * ac(4 * lag);
    if (score > coarseScore) {
      coarseScore = score;
      coarse = bpm;
    }
  }

  // 2. Period and phase, fitted together.
  const refine = (bpm: number) => {
    let best = { bpm, phase: 0, s: -1 };
    for (let b = bpm * 0.985; b <= bpm * 1.015; b += 0.02) {
      const p = bestPhase(env, periodOf(b));
      if (p.s > best.s) best = { bpm: b, phase: p.phase, s: p.s };
    }
    return best;
  };
  let fit = refine(coarse);

  // 3. Octave.
  for (let guard = 0; guard < 3; guard++) {
    const P = periodOf(fit.bpm);
    const off = gridStrength(env, P, fit.phase + P / 2);
    if (fit.bpm * 2 <= FOLD_ABOVE_BPM && off - mean > 0.8 * (fit.s - mean)) {
      fit = refine(fit.bpm * 2);
      continue;
    }
    if (fit.bpm > FOLD_ABOVE_BPM) {
      const P2 = 2 * P;
      const a = gridStrength(env, P2, fit.phase);
      const b = gridStrength(env, P2, fit.phase + P);
      fit = {
        bpm: fit.bpm / 2,
        phase: a >= b ? fit.phase : fit.phase + P,
        s: Math.max(a, b),
      };
      continue;
    }
    break;
  }

  const period = periodOf(fit.bpm);
  const firstBeatFrames = ((fit.phase % period) + period) % period;
  const firstBeatSec =
    (((firstBeatFrames / fps + ONSET_LATENCY_SEC) % (60 / fit.bpm)) +
      60 / fit.bpm) %
    (60 / fit.bpm);
  return {
    bpm: Math.round(bpmOf(period) * 100) / 100,
    firstBeatSec: Math.round(firstBeatSec * 1000) / 1000,
  };
}

/** The whole measurement: a track on disk → its grid. */
export async function measureBeatGrid(path: string): Promise<BeatGrid> {
  return gridFromEnvelope(onsetEnvelope(await decodeMono(path)));
}

/** Seconds into the PROGRAMME of beat k, for a track started `startSec` in. Negative k is allowed. */
export const beatAt = (grid: BeatGrid, k: number, startSec = 0): number =>
  grid.firstBeatSec + (k * 60) / grid.bpm - startSec;
