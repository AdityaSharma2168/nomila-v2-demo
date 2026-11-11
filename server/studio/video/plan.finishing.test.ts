/**
 * plan.finishing.test.ts — the finishing pass in the stitch plan (quality-scrappy piece 6, ADI-QS-GO): what the graph
 * gains when each finishing ask is made, that nothing moves when none is — and, on REAL ffmpeg, that the limiter holds
 * the true peak, the bed's level stays a relative offset once it is normalized, and a cropped source has no bars.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M6c — the limiter's auto-level left on (`level=false` dropped): "the limiter never raises the mix" reds.
 *   M6d — the bed's gain applied AFTER its level: "the bed is normalized before its level" reds.
 *   M6e — the crop replaced by the pad under cropToFill: "a 16:9 source fills a 9:16 frame with no bars" reds.
 */
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { BED_REFERENCE_LUFS, TRUE_PEAK_DBTP, bedGainDb, measureLoudness } from "./finishing";
import { ebur128Filter } from "./ebur128";
import { bedLevelGain, planStitch } from "./plan";
import { stitch } from "./stitch";
import type { ClipProbe, StitchClip } from "./types";

jest.setTimeout(180_000);
const execFileP = promisify(execFile);
const DIR = mkdtempSync(join(tmpdir(), "plan-finishing-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function probe(over: Partial<ClipProbe> = {}): ClipProbe {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    pixFmt: "yuv420p",
    sampleAspectRatio: "1:1",
    durationSec: 2,
    videoCodec: "h264",
    hasAudio: false,
    audioCodec: null,
    sampleRate: null,
    channels: null,
    ...over,
  };
}
const PORTRAIT = { width: 1080, height: 1920, fps: 30 };
const plan = (
  clips: StitchClip[],
  probes: ClipProbe[],
  extra: Partial<Parameters<typeof planStitch>[0]> = {},
) =>
  planStitch({
    clips,
    probes,
    outputPath: "/tmp/out.mp4",
    target: PORTRAIT,
    ...extra,
  });

describe("the graph", () => {
  const wide = probe({ width: 1920, height: 1080 });
  const bed = { source: "/bed.m4a" };

  it("an empty finishing ask is the plan it always was — argv byte for byte", () => {
    const before = plan([{ source: "/a.mp4" }], [wide], { audioBed: bed });
    const after = plan([{ source: "/a.mp4" }], [wide], {
      audioBed: bed,
      finishing: {},
    });
    expect(after.args).toEqual(before.args);
  });

  it("cropToFill: a 16:9 source is scaled to cover and cropped, centred — no pad", () => {
    const p = plan([{ source: "/a.mp4" }], [wide], {
      finishing: { cropToFill: true },
    });
    expect(p.filterGraph).toContain(
      "scale=1080:1920:force_original_aspect_ratio=increase",
    );
    expect(p.filterGraph).toContain("crop=1080:1920:(iw-ow)*0.5:(ih-oh)/2");
    expect(p.filterGraph).not.toContain("pad=");
    expect(p.clips[0].normalization).toMatchObject({
      padded: false,
      cropped: true,
    });
  });

  it("cropToFill with a subject hint keeps it in view; a same-shape source is never cropped", () => {
    const hinted = plan([{ source: "/a.mp4", focusX: 0.2 }], [wide], {
      finishing: { cropToFill: true },
    });
    expect(hinted.filterGraph).toContain(
      "crop=1080:1920:(iw-ow)*0.2:(ih-oh)/2",
    );
    const same = plan([{ source: "/a.mp4" }], [probe()], {
      finishing: { cropToFill: true },
    });
    expect(same.filterGraph).not.toContain("crop=");
    expect("cropped" in same.clips[0].normalization).toBe(false);
  });

  it("the bed is normalized before its level", () => {
    const p = plan([{ source: "/a.mp4" }], [probe({ hasAudio: true, audioCodec: "aac", sampleRate: 48_000, channels: 2 })], {
      audioBed: bed,
      finishing: { bedGainDb: -3.5 },
    });
    expect(p.filterGraph).toMatch(/volume=-3\.5dB,volume=0\.25\[bed\]/);
  });

  it("music only (nothing sounds): the level reads relative to Medium once the bed is normalized — and only then", () => {
    // Nothing to sit under: Medium is unity (the bed stays at the reference), Quiet and Loud keep their offsets.
    const musicOnly = (level?: number) => plan([{ source: "/a.mp4" }], [probe()], { audioBed: { ...bed, ...(level ? { level } : {}) }, finishing: { bedGainDb: -3.5 } });
    expect(musicOnly().filterGraph).toMatch(/volume=-3\.5dB,volume=1\[bed\]/);
    expect(musicOnly(0.15).filterGraph).toMatch(/volume=-3\.5dB,volume=0\.6\[bed\]/);
    // Loud is clamped at the reference: never past −14 music-only.
    expect(musicOnly(0.4).filterGraph).toMatch(/volume=-3\.5dB,volume=1\[bed\]/);
    // The manifest records the gain applied, not the level asked.
    expect(musicOnly().audioBed).toMatchObject({ level: 1, ducked: false });
    expect(musicOnly(0.15).audioBed).toMatchObject({ level: 0.6 });
    // A muted clip is a silent one.
    const muted = plan([{ source: "/a.mp4", muted: true }], [probe({ hasAudio: true, audioCodec: "aac", sampleRate: 48_000, channels: 2 })], { audioBed: bed, finishing: { bedGainDb: -3.5 } });
    expect(muted.filterGraph).toMatch(/volume=1\[bed\]/);
    // A bed nobody measured is never raised: its loudness is unknown.
    expect(plan([{ source: "/a.mp4" }], [probe()], { audioBed: bed }).filterGraph).toMatch(/,volume=0\.25\[bed\]/);
    expect(plan([{ source: "/a.mp4" }], [probe()], { audioBed: bed, finishing: { truePeakDbtp: -1 } }).filterGraph).toMatch(/,volume=0\.25\[bed\]/);
    expect(bedLevelGain(0.25, { normalized: true, underSound: true })).toBe(0.25);
    expect(bedLevelGain(0.25, { normalized: true, underSound: false })).toBe(1);
    expect(bedLevelGain(0.4, { normalized: true, underSound: false })).toBe(1);
    expect(bedLevelGain(0.4, { normalized: true, underSound: true })).toBe(0.4);
  });

  it("the true-peak limiter closes the mix when there is audio — and is absent when there is none", () => {
    const withBed = plan([{ source: "/a.mp4" }], [probe()], {
      audioBed: bed,
      finishing: { truePeakDbtp: -1 },
    });
    expect(withBed.filterGraph).toContain(
      "[aout]aresample=192000,alimiter=limit=0.891251:level=false,aresample=48000[afin]",
    );
    expect(withBed.args).toContain("[afin]");
    const silent = plan([{ source: "/a.mp4" }], [probe()], {
      finishing: { truePeakDbtp: -1 },
    });
    expect(silent.filterGraph).not.toContain("alimiter");
  });
});

describe("on real ffmpeg", () => {
  const ff = (args: string[]) =>
    execFileP("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], {
      timeout: 60_000,
    });
  /** Integrated loudness and true peak of a file, off ffmpeg's own EBU R128 meter. */
  async function meter(
    path: string,
  ): Promise<{ lufs: number; truePeak: number }> {
    const { stderr } = await execFileP(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-af",
        ebur128Filter({ peak: true }),
        "-f",
        "null",
        "-",
      ],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const lufs = Number(
      [...stderr.matchAll(/^\s+I:\s+(-?[\d.]+)\s+LUFS/gm)].at(-1)![1],
    );
    const truePeak = Number(
      [...stderr.matchAll(/^\s+Peak:\s+(-?[\d.]+)\s+dBFS/gm)].at(-1)![1],
    );
    return { lufs, truePeak };
  }
  let silentClip: string;
  let hotBed: string;
  let wideClip: string;
  beforeAll(async () => {
    silentClip = join(DIR, "silent-portrait.mp4");
    hotBed = join(DIR, "hot-bed.m4a");
    wideClip = join(DIR, "wide.mp4");
    await Promise.all([
      ff([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=540x960:rate=30:duration=6",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        silentClip,
      ]),
      // A bed mastered HOT: a square-ish wave driven into clipping, so its true peak is over full scale.
      ff([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=220:duration=12",
        "-af",
        "volume=24dB",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        hotBed,
      ]),
      ff([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x540:rate=30:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        wideClip,
      ]),
    ]);
  });

  it("the limiter holds the true peak at −1 dBTP, even on a clipped-hot bed at Loud — and never raises the mix", async () => {
    const out = join(DIR, "limited.mp4");
    const unlimited = join(DIR, "unlimited.mp4");
    const bed = { source: hotBed, level: 1 };
    const base = {
      clips: [{ source: silentClip }],
      target: { width: 540, height: 960, fps: 30 },
    };
    await stitch({ ...base, audioBed: bed, outputPath: unlimited });
    await stitch({
      ...base,
      audioBed: bed,
      outputPath: out,
      finishing: { truePeakDbtp: -1 },
    });
    const [before, after] = [await meter(unlimited), await meter(out)];
    expect(before.truePeak).toBeGreaterThan(-1); // the fixture really is hot
    expect(after.truePeak).toBeLessThanOrEqual(-0.9); // P6e: ≤ −1.0 dBTP within 0.1 of measurement
    expect(after.lufs).toBeLessThanOrEqual(before.lufs + 0.1); // limiting only ever takes away
  });

  it("with the bed normalized, under a clip with sound, Quiet / Medium / Loud stay their relative offsets (P6d, on a fixture)", async () => {
    // A clip WITH an audio track (digital silence, so it adds no loudness of its own): the bed sits under sound, where
    // the levels are applied as asked. Music only, they are read relative to Medium and clamped (the test below).
    const quietSound = join(DIR, "silent-audio-track.mp4");
    await ff(["-i", silentClip, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", quietSound]);
    const levels = { quiet: 0.15, medium: 0.25, loud: 0.4 } as const;
    const measured: Record<string, number> = {};
    for (const [name, level] of Object.entries(levels)) {
      const out = join(DIR, `level-${name}.mp4`);
      await stitch({
        clips: [{ source: quietSound }],
        target: { width: 540, height: 960, fps: 30 },
        audioBed: { source: hotBed, level },
        outputPath: out,
        // A gain that lands the bed near the reference; the offsets must survive it, and no limiter.
        finishing: { bedGainDb: -10 },
      });
      measured[name] = (await meter(out)).lufs;
    }
    expect(measured.medium - measured.quiet).toBeCloseTo(4.4, 0);
    expect(measured.loud - measured.medium).toBeCloseTo(4.1, 0);
  });

  it("music only: Medium and Loud land at −14 LUFS under −1 dBTP, Quiet under it — the bed measured and normalized as the runner does", async () => {
    // A music-like bed (pink noise under a tone, so the limiter has peaks to hold), mastered quiet.
    const musicBed = join(DIR, "music-bed.m4a");
    await ff([
      "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.08:duration=12:seed=7",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=12",
      "-filter_complex", "[1:a]volume=-18dB[t];[0:a][t]amix=inputs=2:normalize=0",
      "-c:a", "aac", "-b:a", "192k", musicBed,
    ]);
    const finishingFor = async (durationSec: number) => ({
      truePeakDbtp: TRUE_PEAK_DBTP,
      bedGainDb: bedGainDb(await measureLoudness(musicBed, { startSec: 0, durationSec }))!,
    });
    const musicOnly = async (name: string, level?: number) => {
      const out = join(DIR, `music-only-${name}.mp4`);
      const manifest = await stitch({
        clips: [{ source: silentClip }],
        target: { width: 540, height: 960, fps: 30 },
        audioBed: { source: musicBed, ...(level !== undefined ? { level } : {}) },
        outputPath: out,
        finishing: await finishingFor(6),
      });
      return { ...(await meter(out)), applied: manifest.audioBed!.level };
    };
    const m = await musicOnly("medium");
    expect(Math.abs(m.lufs - BED_REFERENCE_LUFS)).toBeLessThanOrEqual(1); // was about −26 at Medium
    expect(m.truePeak).toBeLessThanOrEqual(TRUE_PEAK_DBTP + 0.1);
    expect(m.applied).toBe(1);
    // Loud is clamped at the reference: the same −14, never past it, under the same ceiling.
    const loud = await musicOnly("loud", 0.4);
    expect(Math.abs(loud.lufs - BED_REFERENCE_LUFS)).toBeLessThanOrEqual(1);
    expect(Math.abs(loud.lufs - m.lufs)).toBeLessThanOrEqual(0.2);
    expect(loud.truePeak).toBeLessThanOrEqual(TRUE_PEAK_DBTP + 0.1);
    expect(loud.applied).toBe(1);
    // Quiet sits its offset under: 20·log10(0.15 / 0.25) ≈ −4.4 LU.
    const quiet = await musicOnly("quiet", 0.15);
    expect(quiet.lufs - m.lufs).toBeCloseTo(-4.4, 0);
    expect(quiet.applied).toBe(0.6);

    // Without the finishing measure the bed's loudness is unknown, so nothing is raised: still Medium under, as before.
    const unmeasured = join(DIR, "music-only-unmeasured.mp4");
    await stitch({ clips: [{ source: silentClip }], target: { width: 540, height: 960, fps: 30 }, audioBed: { source: musicBed }, outputPath: unmeasured });
    expect((await meter(unmeasured)).lufs).toBeLessThan(m.lufs - 6);
  });

  it("a 16:9 source fills a 9:16 frame with no bars", async () => {
    const out = join(DIR, "cropped.mp4");
    await stitch({
      clips: [{ source: wideClip }],
      target: { width: 540, height: 960, fps: 30 },
      outputPath: out,
      finishing: { cropToFill: true },
    });
    const { stderr } = await execFileP(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        out,
        "-vf",
        "crop=iw:48:0:0,blackdetect=d=0.1:pix_th=0.05",
        "-f",
        "null",
        "-",
      ],
      { timeout: 60_000 },
    );
    // The top strip is picture, not a letterbox bar.
    expect(stderr).not.toMatch(/black_start/);
  });
});
