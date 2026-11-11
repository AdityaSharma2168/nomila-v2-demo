/**
 * beatGrid.test.ts — the detector against tracks whose beat is known because we made them.
 *
 * Real ffmpeg, no stubs: the fixtures are lavfi expressions (clicks at a set tempo and phase, and a
 * kick-and-hi-hat loop whose hats run at twice the beat — the octave trap), so the truth is exact
 * and nothing binary is in git. $0, local CPU.
 */
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { beatAt, measureBeatGrid } from "./beatGrid";

jest.setTimeout(120_000);

const execFileP = promisify(execFile);
const DIR = mkdtempSync(join(tmpdir(), "beat-grid-test-"));
const at = (name: string) => join(DIR, name);

/** A click every beat from `firstSec`, 30 s long. */
const clicks = (bpm: number, firstSec: number) =>
  `aevalsrc='if(lt(mod(t-${firstSec}+10*60/${bpm}\\,60/${bpm})\\,0.02)\\,0.8*sin(2*PI*1500*t)\\,0)':s=44100:d=30`;

/** A kick on every beat and a noise hat on every half-beat, from 0.2 s, over a noise floor. */
const kickAndHats = (bpm: number) =>
  `aevalsrc='0.9*exp(-30*mod(t-0.2+60*60/${bpm}\\,60/${bpm}))*sin(2*PI*55*mod(t-0.2+60*60/${bpm}\\,60/${bpm}))*gte(t\\,0.2)` +
  `+0.25*(random(0)-0.5)*exp(-60*mod(t-0.2+60*60/${2 * bpm}\\,60/${2 * bpm}))*gte(t\\,0.2)+0.02*(random(1)-0.5)':s=44100:d=30`;

async function render(name: string, source: string) {
  await execFileP("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    source,
    at(name),
  ]);
}

/** Distance in seconds between two phases on a grid of this period. */
const phaseError = (a: number, b: number, bpm: number) => {
  const P = 60 / bpm;
  const d = (((a - b) % P) + P) % P;
  return Math.min(d, P - d);
};

beforeAll(async () => {
  await render("click90.wav", clicks(90, 0.137));
  await render("click120.wav", clicks(120, 0.3));
  await render("click128.wav", clicks(128, 0.05));
  await render("loop96.wav", kickAndHats(96));
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("the beat grid of a track we made", () => {
  /**
   * ⚠️ MUTATION: drop the onset-latency correction (or flip its sign) — the phase assertions here
   * red by name. Measured error with it: ≤ 6 ms; without it, 16–28 ms.
   */
  it.each([
    ["click90.wav", 90, 0.137],
    ["click120.wav", 120, 0.3],
    ["click128.wav", 128, 0.05],
  ])(
    "%s: the tempo within 0.5 BPM and beat 0 within 12 ms",
    async (file, bpm, first) => {
      const grid = await measureBeatGrid(at(file));
      expect(Math.abs(grid.bpm - bpm)).toBeLessThan(0.5);
      expect(phaseError(grid.firstBeatSec, first, bpm)).toBeLessThan(0.012);
      expect(grid.firstBeatSec).toBeGreaterThanOrEqual(0);
      expect(grid.firstBeatSec).toBeLessThan(60 / grid.bpm);
    },
  );

  it("hats at twice the beat are not the beat: a 96-BPM loop reads 96, on the kick", async () => {
    const grid = await measureBeatGrid(at("loop96.wav"));
    expect(Math.abs(grid.bpm - 96)).toBeLessThan(0.5);
    expect(phaseError(grid.firstBeatSec, 0.2, 96)).toBeLessThan(0.012);
  });

  it("beat k of a track started part-way in lands where the programme will hear it", () => {
    const grid = { bpm: 120, firstBeatSec: 0.3 };
    expect(beatAt(grid, 0)).toBeCloseTo(0.3, 9);
    expect(beatAt(grid, 4)).toBeCloseTo(2.3, 9);
    // Started at the first beat, beat 0 is at 0 on the programme.
    expect(beatAt(grid, 0, 0.3)).toBeCloseTo(0, 9);
    expect(beatAt(grid, 3, 0.3)).toBeCloseTo(1.5, 9);
  });

  it("refuses a URL — a track is measured from a local file, like everything the stitch reads", async () => {
    await expect(
      measureBeatGrid("https://example.com/a.m4a"),
    ).rejects.toThrow();
  });
});
