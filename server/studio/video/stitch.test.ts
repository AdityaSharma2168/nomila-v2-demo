/**
 * stitch.test.ts — real ffmpeg, real files, real probes.
 *
 * Nothing is mocked. A stitch engine tested against a stubbed binary asserting command
 * strings proves only that we built the string we meant to; it cannot catch a graph that
 * ffmpeg rejects, a timebase mismatch, or a frame silently squeezed. So every assertion
 * here is measured off a file that ffmpeg actually wrote.
 *
 * Fixtures are generated from lavfi in beforeAll: hermetic, no assets in git, $0.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { renderCaptionBand } from "./captionRender";
import { stitch } from "./stitch";
import {
  BED_TONE_HZ,
  countFrames,
  makeFixtures,
  measureBandDb,
  measureContentBox,
  measureLevelDb,
  meanAbsDiffRows,
  probeContainerDurationSec,
  readFrameRgb,
  type Fixtures,
} from "./testFixtures";

const execFileP = promisify(execFile);

// Real encodes of ~a dozen short clips. Fast, but not jest's 5s fast.
jest.setTimeout(180_000);

const TARGET = { width: 640, height: 360, fps: 30 };
/** One frame at 30fps — the tightest honest tolerance on a container duration. */
const FRAME = 1 / 30;

/**
 * ⚠️ FFMPEG 5.1 (PROD'S, Debian bookworm) ENDS A CROSSFADE CHAIN ONE FRAME LONG. Measured by the ci-checks job
 * studio-ffmpeg-prod: every output with an xfade in it carried exactly one extra frame (105 → 106, 150 → 151,
 * 120 → 121), however many fades it had; cut-only outputs are exact. 6.x and later are exact. So the frame-exact
 * crossfade assertions allow that one frame on 5.1 only, and stay exact everywhere else; a second extra frame, or one
 * on a newer ffmpeg, is still red. (33 ms of tail on a prod crossfade stitch — known, not fixed here.)
 */
let XFADE_TAIL = 0;

let dir: string;
let fx: Fixtures;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-stitch-"));
  fx = await makeFixtures(dir);
  const { stdout } = await execFileP("ffmpeg", ["-hide_banner", "-version"]);
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(String(stdout));
  XFADE_TAIL = m && Number(m[1]) < 6 ? 1 : 0;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const out = (name: string) => join(dir, name);

describe("stitch — normalization and concat", () => {
  it("stitches four heterogeneous clips into one conformed file", async () => {
    // Three resolutions, four frame rates, two pixel formats, one anamorphic, two mute.
    // Unnormalized, the concat filter rejects this outright and the concat demuxer
    // writes a corrupt file while exiting 0.
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path },
        { source: fx.clipB.path },
        { source: fx.clipC.path },
        { source: fx.clipD.path },
      ],
      outputPath: out("four.mp4"),
      target: TARGET,
    });

    expect(manifest.expectedDurationSec).toBeCloseTo(5.5, 3);
    // 5.5s at 30fps is 165 frames and nothing else.
    expect(await countFrames(manifest.outputPath)).toBe(165);
    expect(manifest.output.width).toBe(640);
    expect(manifest.output.height).toBe(360);
    expect(manifest.output.sampleAspectRatio).toBe("1:1");
    expect(manifest.output.pixFmt).toBe("yuv420p");
    expect(manifest.output.fps).toBeCloseTo(30, 3);
    expect(manifest.output.hasAudio).toBe(true);
    expect(manifest.output.sizeBytes).toBeGreaterThan(0);
  });

  it("reports the normalization it actually applied, per clip", async () => {
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path },
        { source: fx.clipB.path },
        { source: fx.clipD.path },
      ],
      outputPath: out("flags.mp4"),
      target: TARGET,
    });

    // clipA is already 640x360@30 yuv420p — nothing to do but add silence-free audio.
    expect(manifest.clips[0].normalization).toMatchObject({
      scaled: false,
      sarCorrected: false,
      fpsChanged: false,
      pixFmtChanged: false,
      silenceSynthesized: false,
    });
    // clipB is 320x240@24 and mute.
    expect(manifest.clips[1].normalization).toMatchObject({
      scaled: true,
      padded: true,
      fpsChanged: true,
      silenceSynthesized: true,
    });
    // clipD is anamorphic and yuv422p.
    expect(manifest.clips[2].normalization).toMatchObject({
      sarCorrected: true,
      pixFmtChanged: true,
      silenceSynthesized: true,
    });
  });

  it("letterboxes an anamorphic clip instead of squeezing it", async () => {
    // clipD is 640x480 stored with SAR 2:1, i.e. 1280x480 (8:3) on screen. Into a 16:9
    // frame that must letterbox to full width with bars top and bottom. Conformed without
    // squaring the pixels first it pillarboxes to 480x360 instead — same output
    // dimensions, picture silently squeezed, invisible to any assertion on width/height.
    const manifest = await stitch({
      clips: [{ source: fx.clipD.path }],
      outputPath: out("anamorphic.mp4"),
      target: TARGET,
    });

    const box = await measureContentBox(manifest.outputPath, {
      startSec: 0.2,
      durationSec: 0.5,
    });
    expect(box.width).toBe(640);
    expect(box.height).toBeGreaterThanOrEqual(238);
    expect(box.height).toBeLessThanOrEqual(242);
  });

  it("gives a clip with no audio track a silent stretch instead of failing", async () => {
    // The concat filter binds by stream specifier: ':a' on a mute clip is a hard error.
    const manifest = await stitch({
      clips: [{ source: fx.clipA.path }, { source: fx.clipB.path }],
      outputPath: out("silence.mp4"),
      target: TARGET,
    });

    expect(manifest.clips[1].normalization.silenceSynthesized).toBe(true);
    expect(manifest.output.hasAudio).toBe(true);
    expect(manifest.output.durationSec).toBeCloseTo(3.5, 1);

    // The three assertions above are a probe-derived flag and a duration, and they all
    // survive the silence machinery being deleted: ffmpeg quietly binds a dangling
    // `[undefined:a]` label to whatever audio it can find, so clipB's stretch plays
    // clipA's tone and every number above still reads correct. Measure the stretch.
    // clipA's tone is about -24 dB; digital silence is about -91 dB.
    const silentStretch = await measureLevelDb(manifest.outputPath, {
      startSec: 2.2,
      durationSec: 1.0,
    });
    const toneStretch = await measureLevelDb(manifest.outputPath, {
      startSec: 0.5,
      durationSec: 1.0,
    });
    expect(silentStretch).toBeLessThan(-80);
    expect(toneStretch).toBeGreaterThan(-40);
  });

  it("writes a video-only file when nothing carries audio", async () => {
    const manifest = await stitch({
      clips: [{ source: fx.clipB.path }, { source: fx.clipD.path }],
      outputPath: out("mute.mp4"),
      target: TARGET,
    });

    expect(manifest.output.hasAudio).toBe(false);
    expect(await countFrames(manifest.outputPath)).toBe(75); // 2.5s at 30fps
  });
});

/**
 * What Instagram's Reels spec demands of the CONTAINER, checked on a real encode by ffprobe.
 *
 * `-v trace` makes the demuxer print every box it walks — `type:'edts' parent:'trak'` — which is
 * the mov demuxer's own reading of the file rather than a byte search that could match compressed
 * video. The top-level order comes from the same trace.
 */
async function traceBoxes(
  path: string,
): Promise<{ type: string; parent: string }[]> {
  const { stderr } = await execFileP(
    "ffprobe",
    ["-v", "trace", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return [...stderr.matchAll(/type:'(....)' parent:'(....)'/g)].map((m) => ({
    type: m[1],
    parent: m[2],
  }));
}

describe("stitch — born postable", () => {
  /**
   * ⭐ REVERT CHECK `no-edit-lists`. MUTATION: delete `"-use_editlist", "0",` from plan.ts. ffmpeg
   * then writes one `edts` box per track (2 here: video and audio) and this reds with
   * "Expected: [] / Received: [edts, edts]".
   *
   * Instagram: "MOV or MP4 (MPEG-4 Part 14), no edit lists, moov atom at the front". This is the
   * test that keeps every NEW stitch inside that sentence; a stitch made before it may not be,
   * and the publish path tells her to put that one together again.
   */
  it("INSTAGRAM: a stitched file carries NO edit list, and its moov is at the front", async () => {
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path },
        // A crossfade and a mute clip: both tracks are re-encoded, so both would carry an edts.
        {
          source: fx.clipB.path,
          transitionIn: { kind: "crossfade", durationSec: 0.4 },
        },
      ],
      outputPath: out("postable.mp4"),
      target: TARGET,
    });
    expect(manifest.output.hasAudio).toBe(true);

    const boxes = await traceBoxes(manifest.outputPath);
    // The instrument works: it saw both tracks. Without this, "no edts" could mean "saw nothing".
    expect(boxes.filter((b) => b.type === "trak")).toHaveLength(2);

    expect(
      boxes
        .filter((b) => b.type === "edts" || b.type === "elst")
        .map((b) => b.type),
    ).toEqual([]);

    // moov BEFORE mdat — the other half of the sentence, and the half +faststart buys.
    const top = boxes.filter((b) => b.parent === "root").map((b) => b.type);
    expect(top.indexOf("moov")).toBeGreaterThan(-1);
    expect(top.indexOf("moov")).toBeLessThan(top.indexOf("mdat"));
  });

  /**
   * ⭐ REVERT CHECK `no-edit-lists-keeps-sync`. MUTATION: drop `+negative_cts_offsets` from plan.ts,
   * leaving `-use_editlist 0` alone. The file STILL has no edit list — the test above stays green —
   * and the picture now starts 2 frames (0.0667 s) after the sound, because ffmpeg parks the
   * B-frame delay in the video track's start time. That is the version I wrote first. This reds.
   */
  it("INSTAGRAM: dropping the edit list does not pull the picture out of sync with the sound", async () => {
    const manifest = await stitch({
      clips: [{ source: fx.clipA.path }, { source: fx.clipC.path }],
      outputPath: out("postable-sync.mp4"),
      target: TARGET,
    });
    // Every frame is still there…
    expect(await countFrames(manifest.outputPath)).toBe(
      Math.round(manifest.expectedDurationSec * TARGET.fps),
    );
    // …and BOTH streams start at zero. Not "within a frame of each other": at zero, each of them.
    const { stdout } = await execFileP(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,start_time",
        "-of",
        "csv=p=0",
        manifest.outputPath,
      ],
      { timeout: 30_000 },
    );
    const starts = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((l) => l.split(",") as [string, string]),
    );
    expect(Number(starts.video)).toBe(0);
    expect(Number(starts.audio)).toBe(0);
    // ↑ THOSE TWO ARE THE SYNC CLAIM, and they are exact on every ffmpeg this has run on.
    //
    // ↓ This is only "the file is not mysteriously long", and its size is the MUXER'S BOOKKEEPING,
    // which differs by version — I first bounded it at one frame, calibrated to the one machine I
    // had, and CI went red on it with sync intact:
    //
    //   ffmpeg 9.0.1 (macOS)   +0.0213 s   the AAC priming (1024 samples at 48 kHz), played not skipped
    //   CI's ffmpeg (Linux)    +0.0632 s   the same, plus the track's length counted in DTS — which,
    //                                      once composition offsets are negative, run x264's two-frame
    //                                      reorder delay past the last PTS
    //
    // So the bound is what the MECHANISM can produce: two frames of reorder delay plus the priming,
    // i.e. under three frames. Anything past that is a real extra — and a bed running on behind the
    // picture is thousands of seconds, not hundredths.
    const container = await probeContainerDurationSec(manifest.outputPath);
    expect(container - manifest.expectedDurationSec).toBeLessThan(FRAME * 3);
    expect(container - manifest.expectedDurationSec).toBeGreaterThanOrEqual(0);
  });
});

describe("stitch — trim and transitions", () => {
  it("trims each clip to its in and out points", async () => {
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path, trimStartSec: 0.5, trimEndSec: 1.5 },
        { source: fx.clipC.path },
      ],
      outputPath: out("trim.mp4"),
      target: TARGET,
    });

    expect(manifest.expectedDurationSec).toBeCloseTo(2, 3);
    expect(await countFrames(manifest.outputPath)).toBe(60);
    expect(manifest.clips[0].trim).toEqual({ startSec: 0.5, endSec: 1.5 });
  });

  it("a crossfade shortens the timeline by its own duration", async () => {
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path },
        {
          source: fx.clipB.path,
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
        {
          source: fx.clipC.path,
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      outputPath: out("xfade.mp4"),
      target: TARGET,
    });

    // 2.0 + 1.5 + 1.0 = 4.5 raw; each fade overlaps 0.5 away.
    expect(manifest.expectedDurationSec).toBeCloseTo(3.5, 3);
    expect(await countFrames(manifest.outputPath)).toBe(105 + XFADE_TAIL);
  });

  it("joins a cut and a crossfade in one chain", async () => {
    // The case a narrow test misses: concat emits timebase 1/1000000 while a clip through
    // `fps=` carries 1/N, and xfade refuses mismatched timebases. Cut-only and
    // crossfade-only both pass without the settb pinning; only this combination fails.
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path },
        { source: fx.clipB.path },
        {
          source: fx.clipC.path,
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
        { source: fx.clipD.path },
      ],
      outputPath: out("mixed.mp4"),
      target: TARGET,
    });

    // 2.0 +1.5 (cut) = 3.5; +1.0 -0.5 (fade) = 4.0; +1.0 (cut) = 5.0
    expect(manifest.expectedDurationSec).toBeCloseTo(5, 3);
    expect(await countFrames(manifest.outputPath)).toBe(150 + XFADE_TAIL);
  });

  it("the manifest's expected duration matches the file it wrote", async () => {
    // expectedDurationSec comes off the same accumulator that produces the xfade offsets,
    // so this compares the plan against reality rather than against a second copy of the
    // same arithmetic.
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path, trimStartSec: 0.25 },
        {
          source: fx.clipC.path,
          transitionIn: { kind: "crossfade", durationSec: 0.4 },
        },
        { source: fx.clipB.path },
      ],
      outputPath: out("drift.mp4"),
      target: TARGET,
    });

    expect(
      Math.abs(manifest.output.durationSec - manifest.expectedDurationSec),
    ).toBeLessThan(FRAME * (1 + XFADE_TAIL));
  });
});

describe("stitch — audio bed", () => {
  // clipA (sine 440) runs 0-2s, then mute clipB runs 2-3.5s.
  const LOUD = { startSec: 0.5, durationSec: 1.0 };
  const SILENT = { startSec: 2.5, durationSec: 0.9 };

  async function render(
    name: string,
    bed: { level?: number; duck?: Record<string, never> | undefined },
  ) {
    return stitch({
      clips: [{ source: fx.clipA.path }, { source: fx.clipB.path }],
      audioBed: { source: fx.bed.path, level: bed.level, duck: bed.duck },
      outputPath: out(name),
      target: TARGET,
    });
  }

  it("honours the bed level the caller asked for", async () => {
    const loud = await render("bed-loud.mp4", { level: 0.6 });
    const quiet = await render("bed-quiet.mp4", { level: 0.2 });

    const loudDb = await measureBandDb(loud.outputPath, {
      freqHz: BED_TONE_HZ,
      ...SILENT,
    });
    const quietDb = await measureBandDb(quiet.outputPath, {
      freqHz: BED_TONE_HZ,
      ...SILENT,
    });

    // 20*log10(0.6/0.2) = 9.54 dB.
    expect(loudDb - quietDb).toBeGreaterThan(8);
    expect(loudDb - quietDb).toBeLessThan(11);
  });

  it("ducks the bed under programme audio", async () => {
    // Measured on the bed's own frequency band. The mixed signal cannot show this: the
    // window holding the loud programme is louder overall BECAUSE of the programme, which
    // swamps the bed's attenuation and reads backwards.
    const ducked = await render("bed-duck.mp4", { level: 0.6, duck: {} });
    const under = await measureBandDb(ducked.outputPath, {
      freqHz: BED_TONE_HZ,
      ...LOUD,
    });
    const clear = await measureBandDb(ducked.outputPath, {
      freqHz: BED_TONE_HZ,
      ...SILENT,
    });
    expect(clear - under).toBeGreaterThan(2);

    // Control: with no duck the bed holds the same level through both windows.
    const flat = await render("bed-flat.mp4", { level: 0.6, duck: undefined });
    const flatUnder = await measureBandDb(flat.outputPath, {
      freqHz: BED_TONE_HZ,
      ...LOUD,
    });
    const flatClear = await measureBandDb(flat.outputPath, {
      freqHz: BED_TONE_HZ,
      ...SILENT,
    });
    expect(Math.abs(flatClear - flatUnder)).toBeLessThan(1);
  });

  it("a long bed does not extend the timeline", async () => {
    // The bed is 12s against a 3.5s programme.
    const manifest = await render("bed-length.mp4", { level: 0.3 });

    // The CONTAINER's duration, not the manifest's: `output.durationSec` reports the video
    // stream, which stays 3.5s even when the looped bed runs on behind it. Mixed with
    // `duration=longest` this same call writes a 3.5s video beside an 8566s audio stream,
    // and only this number notices.
    const container = await probeContainerDurationSec(manifest.outputPath);
    expect(container).toBeLessThan(3.5 + FRAME * 2);
    expect(manifest.audioBed).toMatchObject({
      level: 0.3,
      ducked: false,
      looped: true,
    });
  });
});

describe("stitch — rejections", () => {
  it("rejects a crossfade longer than its clips before spawning ffmpeg", async () => {
    await expect(
      stitch({
        clips: [
          { source: fx.clipA.path },
          {
            source: fx.clipC.path,
            transitionIn: { kind: "crossfade", durationSec: 5 },
          },
        ],
        outputPath: out("never.mp4"),
        target: TARGET,
      }),
    ).rejects.toThrow(/does not fit/);
  });

  it("rejects a URL source with an actionable error", async () => {
    await expect(
      stitch({
        clips: [{ source: "https://storage.googleapis.com/bucket/clip.mp4" }],
        outputPath: out("never2.mp4"),
        target: TARGET,
      }),
    ).rejects.toThrow(/must be a local file path/);
  });

  it("rejects a source that is not there", async () => {
    await expect(
      stitch({
        clips: [{ source: join(dir, "absent.mp4") }],
        outputPath: out("never3.mp4"),
        target: TARGET,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("stitch — a caption burned onto a clip", () => {
  // The REAL renderer's band, at this suite's target: what is asserted below is the pair the
  // product actually runs — captionRender's pixels placed by plan.ts — not a stand-in image.
  let overlay: { source: string; y: number };
  let rows: { from: number; to: number };

  beforeAll(async () => {
    const band = await renderCaptionBand(
      { text: "Game day", position: "bottom", style: "boxed" },
      TARGET,
    );
    const source = out("caption.png");
    await writeFile(source, band.png);
    overlay = { source, y: band.y };
    rows = { from: band.y, to: band.y + band.height };
  });

  it("changes the picture INSIDE the band, for the span of ITS clip, and nowhere else", async () => {
    const timeline = [{ source: fx.clipA.path }, { source: fx.clipC.path }];
    const bare = await stitch({
      clips: timeline,
      outputPath: out("cap-bare.mp4"),
      target: TARGET,
    });
    const captioned = await stitch({
      clips: [{ ...timeline[0], overlay }, timeline[1]],
      outputPath: out("cap-on.mp4"),
      target: TARGET,
    });

    const diff = async (atSec: number, r: { from: number; to: number }) =>
      meanAbsDiffRows(
        await readFrameRgb(bare.outputPath, atSec, TARGET),
        await readFrameRgb(captioned.outputPath, atSec, TARGET),
        TARGET.width,
        r,
      );
    const above = { from: 0, to: rows.from };

    // Measured 2026-09-20: ~12 inside the band, ~0.8 everywhere it should be untouched. Two encodes
    // are never bit-identical once anything differs (x264 rate control), so "unchanged" is small,
    // not zero — the bounds leave a wide gap on both sides of it.
    for (const t of [0, 1, 1.9]) {
      expect(await diff(t, rows)).toBeGreaterThan(6); // clip A: captioned
      expect(await diff(t, above)).toBeLessThan(3);
    }
    // 2.5s is clip C, which has none: the band is as untouched as the rest.
    expect(await diff(2.5, rows)).toBeLessThan(3);

    // And it cost the timeline nothing: same length to the frame, same format.
    expect(await countFrames(captioned.outputPath)).toBe(
      await countFrames(bare.outputPath),
    );
    expect(captioned.output.pixFmt).toBe("yuv420p");
    expect(captioned.clips[0].overlay).toEqual(overlay);
  });

  it("survives a cut FOLLOWED BY a crossfade, with a bed, every clip captioned", async () => {
    // THE GUARD FOR A LINE THAT IS NOT THERE. xfade refuses inputs whose timebases differ
    // (plan.ts, constraint 1), and overlay sits between the conform chain's settb and the join. On
    // ffmpeg 9.0.1 overlay keeps the main input's timebase, so plan.ts does not re-pin it — this is
    // the test that goes red on a build where that stops being true. The narrow test, one captioned
    // clip and a cut, cannot see it.
    const manifest = await stitch({
      clips: [
        { source: fx.clipA.path, overlay },
        { source: fx.clipC.path, overlay },
        {
          source: fx.clipB.path,
          overlay,
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      audioBed: { source: fx.bed.path },
      outputPath: out("cap-mixed.mp4"),
      target: TARGET,
    });
    // 2.0 + 1.0 + 1.5 - 0.5 = 4.0s, and 4.0s at 30fps is 120 frames and nothing else.
    expect(manifest.expectedDurationSec).toBeCloseTo(4, 3);
    expect(await countFrames(manifest.outputPath)).toBe(120 + XFADE_TAIL);
    expect(manifest.output.hasAudio).toBe(true);
  });

  it("fades the caption WITH its clip across a crossfade, rather than holding it over the next", async () => {
    const clips = (withCaption: boolean) => [
      { source: fx.clipA.path, ...(withCaption ? { overlay } : {}) },
      {
        source: fx.clipB.path,
        transitionIn: { kind: "crossfade" as const, durationSec: 1 },
      },
    ];
    const bare = await stitch({
      clips: clips(false),
      outputPath: out("cap-xf-bare.mp4"),
      target: TARGET,
    });
    const captioned = await stitch({
      clips: clips(true),
      outputPath: out("cap-xf-on.mp4"),
      target: TARGET,
    });
    const band = async (atSec: number) =>
      meanAbsDiffRows(
        await readFrameRgb(bare.outputPath, atSec, TARGET),
        await readFrameRgb(captioned.outputPath, atSec, TARGET),
        TARGET.width,
        rows,
      );
    // A is 2.0s, B is 1.5s, the fade is 1.0s: it runs 1.0s–2.0s of a 2.5s output. Full before it,
    // partway through it, gone after it.
    const before = await band(0.5);
    const during = await band(1.5);
    const after = await band(2.3);
    expect(before).toBeGreaterThan(6);
    expect(during).toBeLessThan(before * 0.8);
    expect(during).toBeGreaterThan(after);
    expect(after).toBeLessThan(3);
  });
});

describe("stitch — where the bed starts", () => {
  // A bed whose PITCH says where in it you are: 0–2s 300 Hz, 2–4s 600 Hz, 4–6s 1200 Hz. The shared
  // fixture bed is one steady tone and cannot tell an offset from no offset.
  let steps: string;
  const loudest = async (path: string, atSec: number) => {
    const levels = await Promise.all(
      [300, 600, 1200].map(async (freqHz) => ({
        freqHz,
        db: await measureBandDb(path, {
          freqHz,
          bandwidthHz: 80,
          startSec: atSec,
          durationSec: 0.8,
        }),
      })),
    );
    return levels.sort((a, b) => b.db - a.db)[0].freqHz;
  };

  beforeAll(async () => {
    steps = out("bed-steps.m4a");
    await execFileP("ffmpeg", [
      "-y",
      "-nostdin",
      "-loglevel",
      "error",
      ...[300, 600, 1200].flatMap((f) => [
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${f}:duration=2`,
      ]),
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
      "-map",
      "[a]",
      "-c:a",
      "aac",
      steps,
    ]);
  });

  // clipB is 1.5s and MUTE, so the only sound in the output is the bed. Four of them is 6s: long
  // enough to run off the end of a bed started 3s in and see what it does next.
  const timeline = () =>
    Array.from({ length: 4 }, () => ({ source: fx.clipB.path }));

  it("plays from the top when she did not move it", async () => {
    const m = await stitch({
      clips: timeline(),
      audioBed: { source: steps, level: 1 },
      outputPath: out("bed-from-top.mp4"),
      target: TARGET,
    });
    expect(await loudest(m.outputPath, 0.1)).toBe(300);
    expect(await loudest(m.outputPath, 2.1)).toBe(600);
    expect(await loudest(m.outputPath, 4.1)).toBe(1200);
  });

  it("starts where she put it, then WRAPS TO THE BEGINNING — it does not loop the tail", async () => {
    const m = await stitch({
      clips: timeline(),
      audioBed: { source: steps, level: 1, startSec: 3 },
      outputPath: out("bed-from-3.mp4"),
      target: TARGET,
    });
    // 3s in is the 600 Hz step; 2s later the 1200; then the track ENDS — and the very next thing
    // heard must be its opening 300 Hz, not the 1200 again.
    //
    // This pins the BEHAVIOUR, on whatever ffmpeg runs it. It does NOT pin the form: on 9.0.1 an
    // input `-ss` gives this same answer inside the engine's graph (measured), so plan.test.ts
    // holds the form. If a build ever loops the tail instead, this is the test that says so.
    expect(await loudest(m.outputPath, 0.1)).toBe(600);
    expect(await loudest(m.outputPath, 2.1)).toBe(1200);
    expect(await loudest(m.outputPath, 4.1)).toBe(300);
    // And it cost the timeline nothing.
    expect(await countFrames(m.outputPath)).toBe(180);
    expect(m.audioBed?.startSec).toBe(3);
  });
});

describe("stitch — a muted clip", () => {
  // clipA carries a 440 Hz tone and clipC an 880 Hz one, so WHOSE sound is present is measurable.
  const toneDb = (path: string, freqHz: number, startSec: number) =>
    measureBandDb(path, {
      freqHz,
      bandwidthHz: 80,
      startSec,
      durationSec: 0.8,
    });

  it("drops THAT clip's sound and keeps its picture, its length and the other clip's sound", async () => {
    const clips = [{ source: fx.clipA.path }, { source: fx.clipC.path }];
    const loud = await stitch({
      clips,
      outputPath: out("mute-off.mp4"),
      target: TARGET,
    });
    const muted = await stitch({
      clips: [{ ...clips[0], muted: true }, clips[1]],
      outputPath: out("mute-on.mp4"),
      target: TARGET,
    });

    // clip A plays 0–2s. Its 440 Hz tone is there, then it is gone — by tens of dB, not a little.
    const before = await toneDb(loud.outputPath, 440, 0.6);
    const after = await toneDb(muted.outputPath, 440, 0.6);
    expect(before).toBeGreaterThan(-40);
    expect(after).toBeLessThan(before - 30);

    // clip C plays 2–3s and was NOT muted: its 880 Hz tone is exactly as it was.
    const otherBefore = await toneDb(loud.outputPath, 880, 2.1);
    const otherAfter = await toneDb(muted.outputPath, 880, 2.1);
    expect(otherAfter).toBeGreaterThan(-40);
    expect(Math.abs(otherAfter - otherBefore)).toBeLessThan(3);

    // Same length to the frame, and still a file WITH audio (clip C's).
    expect(await countFrames(muted.outputPath)).toBe(
      await countFrames(loud.outputPath),
    );
    expect(muted.output.hasAudio).toBe(true);
    expect(muted.clips[0].normalization.silenceSynthesized).toBe(true);
  });

  it("keeps the BED under a muted clip", async () => {
    const make = (mute: boolean, name: string) =>
      stitch({
        clips: [{ source: fx.clipA.path, ...(mute ? { muted: true } : {}) }],
        audioBed: { source: fx.bed.path, level: 1 },
        outputPath: out(name),
        target: TARGET,
      });
    const loud = await make(false, "mute-bed-off.mp4");
    const muted = await make(true, "mute-bed-on.mp4");

    // COMPARATIVE, not absolute: the bed is a 220 Hz tone at full level and its second harmonic
    // sits at 440 Hz, so "440 is silent" is false whenever the bed plays (measured: −42.5 dB of
    // it). What muting removes is the clip's OWN 440 — so compare the same stitch with and without.
    expect(await toneDb(muted.outputPath, 440, 0.6)).toBeLessThan(
      (await toneDb(loud.outputPath, 440, 0.6)) - 15,
    );
    // And the bed itself is exactly where it was.
    const bedLoud = await toneDb(loud.outputPath, BED_TONE_HZ, 0.6);
    const bedMuted = await toneDb(muted.outputPath, BED_TONE_HZ, 0.6);
    expect(bedMuted).toBeGreaterThan(-40);
    expect(Math.abs(bedMuted - bedLoud)).toBeLessThan(3);
  });
});
