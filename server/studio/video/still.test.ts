/**
 * still.test.ts — a photo held for N seconds, through REAL sharp and REAL ffmpeg.
 *
 * Why no stubs: every defect this file exists for is a property of the tools, measured on them —
 * a looped JPEG encoding full-range, a laptop ffmpeg rotating by EXIF on its own, an unfitted photo
 * costing thirty-five seconds. A stubbed encoder would test a description of them. Fixtures are made
 * here with sharp and lavfi: hermetic, $0, no binary assets in git. CI apt-installs ffmpeg for
 * exactly this kind of suite (ci-checks.yml, beside video/stitch.test.ts).
 */
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";
import { planStitch } from "./plan";
import { probeMedia } from "./probe";
import { STITCH_TARGETS } from "./spec";
import { stitch } from "./stitch";
import {
  encodeStill,
  FRAMING_PRIOR,
  planStillMove,
  prepareStillFrame,
  stillEncodeArgs,
} from "./still";

jest.setTimeout(180_000);

const execFileP = promisify(execFile);
const PORTRAIT = STITCH_TARGETS.portrait;
const DIR = mkdtempSync(join(tmpdir(), "still-test-"));
const at = (name: string) => join(DIR, name);

/** ffprobe's own words for the first video stream — the fields probeMedia does not surface. */
async function colour(path: string) {
  const { stdout } = await execFileP("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=pix_fmt,color_range,color_space,nb_frames",
    "-of",
    "json",
    path,
  ]);
  return JSON.parse(stdout).streams[0] as {
    pix_fmt: string;
    color_range?: string;
    color_space?: string;
    nb_frames?: string;
  };
}

/** One decoded pixel of a video's frame at `sec`, as RGB. */
async function pixel(path: string, x: number, y: number, sec = 0.5) {
  const { stdout } = await execFileP(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(sec),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );
  return [...(stdout as Buffer)];
}

beforeAll(async () => {
  // Landscape, so a portrait target has to pad it.
  await sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .jpeg()
    .toFile(at("landscape.jpg"));
  // 400x300 in the BUFFER, red block at the buffer's top-left, flagged orientation 6: every viewer
  // shows it as a 300x400 portrait with the red block at the TOP RIGHT.
  const red = await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 30, g: 30, b: 200 },
    },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(at("sideways.jpg"));
  await sharp({
    create: {
      width: 4000,
      height: 6000,
      channels: 3,
      background: { r: 90, g: 90, b: 90 },
    },
  })
    .jpeg()
    .toFile(at("huge.jpg"));
  await sharp({
    create: {
      width: 300,
      height: 400,
      channels: 3,
      background: { r: 90, g: 90, b: 90 },
    },
  })
    .jpeg()
    .toFile(at("small.jpg"));
  // A clip with SOUND and NO colour tags — what a range mismatch hides behind (measured: a full-range
  // still after an untagged clip turned the whole stitch full-range).
  await execFileP("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=720x1280:rate=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    at("untagged.mp4"),
  ]);
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("the encode", () => {
  it("holds for the seconds asked, at the target's size and rate, limited-range BT.709, with no audio", () => {
    const args = stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 2.5, PORTRAIT);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("-loop")).toBe("1");
    expect(after("-framerate")).toBe("30");
    expect(after("-t")).toBe("2.5");
    expect(after("-r")).toBe("30");
    expect(after("-vf")).toMatch(
      /^scale=1080:1920:force_original_aspect_ratio=decrease:/,
    );
    expect(after("-vf")).toMatch(/out_color_matrix=bt709:out_range=tv/);
    expect(after("-vf")).toMatch(
      /pad=1080:1920:.*color=black,setsar=1,format=yuv420p$/,
    );
    expect(after("-color_range")).toBe("tv");
    expect(after("-colorspace")).toBe("bt709");
    expect(args).toContain("-an");
    expect(args[args.length - 1]).toBe("/w/s.mp4");
  });

  it("refuses a URL for either end — the workspace holds the files, as the engine requires", () => {
    expect(() =>
      stillEncodeArgs("https://x/f.jpg", "/w/s.mp4", 2, PORTRAIT),
    ).toThrow(/local/);
    expect(() =>
      stillEncodeArgs("/w/f.jpg", "https://x/s.mp4", 2, PORTRAIT),
    ).toThrow(/local/);
  });
});

describe("the frame", () => {
  it("fits a huge photo inside the target before ffmpeg sees it, and never enlarges a small one", async () => {
    expect(
      await prepareStillFrame(at("huge.jpg"), at("huge-frame.jpg"), PORTRAIT),
    ).toEqual({
      width: 1080,
      height: 1620,
    });
    expect(
      await prepareStillFrame(at("small.jpg"), at("small-frame.jpg"), PORTRAIT),
    ).toEqual({
      width: 300,
      height: 400,
    });
  });

  it("a photo flagged sideways comes out upright", async () => {
    const out = await encodeStill(
      at("sideways.jpg"),
      DIR,
      0,
      2,
      PORTRAIT,
      60_000,
    );
    // Upright it is 300x400 → fitted to 1080x1440 inside 1080x1920 (240 px bars above and below),
    // with the red block at the top RIGHT. On its side it would be 1080x810, red at the top LEFT.
    const [r, g, b] = await pixel(out.path, 1040, 300);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    const [, , blue] = await pixel(out.path, 40, 300);
    expect(blue).toBeGreaterThan(150);
  });
});

describe("the clip it becomes", () => {
  it("arrives in the engine's own profile — the conform chain has nothing left to do", async () => {
    const out = await encodeStill(
      at("landscape.jpg"),
      DIR,
      1,
      2.5,
      PORTRAIT,
      60_000,
    );
    const probe = await probeMedia(out.path);
    expect(probe).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      pixFmt: "yuv420p",
      sampleAspectRatio: "1:1",
      hasAudio: false,
    });
    expect(probe.durationSec).toBeCloseTo(2.5, 2);
    expect((await colour(out.path)).nb_frames).toBe("75");
    const plan = planStitch({
      clips: [{ source: out.path }],
      probes: [probe],
      outputPath: at("unused.mp4"),
      target: PORTRAIT,
    });
    expect(plan.clips[0].normalization).toEqual({
      scaled: false,
      padded: false,
      sarCorrected: false,
      fpsChanged: false,
      pixFmtChanged: false,
      silenceSynthesized: false,
    });
    expect(out.bytes).toBeGreaterThan(0);
  });

  it("a still arrives in the clips' range and colour matrix", async () => {
    const out = await encodeStill(
      at("landscape.jpg"),
      DIR,
      2,
      2,
      PORTRAIT,
      60_000,
    );
    expect(await colour(out.path)).toMatchObject({
      pix_fmt: "yuv420p",
      color_range: "tv",
      color_space: "bt709",
    });
  });

  it("a still does not turn the whole stitch full-range, and joins a sounding clip on a fade", async () => {
    const still = await encodeStill(
      at("landscape.jpg"),
      DIR,
      3,
      2,
      PORTRAIT,
      60_000,
    );
    const manifest = await stitch({
      clips: [
        { source: at("untagged.mp4") },
        {
          source: still.path,
          transitionIn: { kind: "crossfade", durationSec: 0.5 },
        },
      ],
      outputPath: at("mixed.mp4"),
      target: PORTRAIT,
    });
    const out = await colour(at("mixed.mp4"));
    expect(out.pix_fmt).toBe("yuv420p");
    expect(out.color_range).not.toBe("pc");
    // 2 + 2 − 0.5, from the same accumulator as the fade offsets, and what the file really is.
    expect(manifest.expectedDurationSec).toBeCloseTo(3.5, 6);
    expect(manifest.output.durationSec).toBeCloseTo(3.5, 1);
    // The still has no sound of its own, so the engine laid silence under it beside a clip that
    // sounds — no silent track had to be encoded into the still.
    expect(manifest.output.hasAudio).toBe(true);
    expect(manifest.clips[1].normalization.silenceSynthesized).toBe(true);
  });
});

describe("a slow push-in — the photo moves over its hold, still $0 (C3, D2)", () => {
  /** One decoded frame of a clip, raw RGB — the whole picture, for a whole-frame comparison. */
  async function frame(path: string, n: number): Promise<Buffer> {
    const { stdout } = await execFileP(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        `select=eq(n\\,${n}),format=rgb24`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout as Buffer;
  }

  it("the argv: oversampled fit, rgb24 into zoompan with the zoom climbing to 1.08 by the last frame, one scale out to limited-range BT.709", () => {
    const args = stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 4, PORTRAIT, "dolly");
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("-loop")).toBe("1");
    expect(after("-t")).toBe("4");
    const vf = after("-vf");
    expect(vf).toMatch(
      /^scale=2160:3840:force_original_aspect_ratio=decrease,pad=2160:3840:/,
    );
    expect(vf).toContain("format=rgb24,zoompan=z='1+0.08*on/120':");
    expect(vf).toContain(":d=1:s=1080x1920:fps=30,");
    expect(vf).toMatch(
      /scale=1080:1920:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p$/,
    );
    expect(after("-color_range")).toBe("tv");
    expect(args).toContain("-an");
    // Without a motion the argv is the still's, byte for byte.
    expect(stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 4, PORTRAIT)).toEqual(
      stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 4, PORTRAIT, undefined),
    );
    expect(
      stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 4, PORTRAIT)[
        args.indexOf("-vf") + 1
      ],
    ).not.toContain("zoompan");
  });

  /**
   * ⚠️ MUTATION: ignore `motion` in stillEncodeArgs (always the still chain) — "the first and last
   * frames differ under a push-in" reds by name; the dead-still control stays green, which is why
   * it is here.
   */
  it("the first and last frames differ under a push-in, and are identical on a dead still; the profile is the still's", async () => {
    const pan = await encodeStill(
      at("landscape.jpg"),
      DIR,
      21,
      2,
      PORTRAIT,
      90_000,
      "dolly",
    );
    const still = await encodeStill(
      at("landscape.jpg"),
      DIR,
      22,
      2,
      PORTRAIT,
      90_000,
    );
    for (const clip of [pan, still]) {
      const probed = await probeMedia(clip.path);
      expect([
        probed.width,
        probed.height,
        probed.fps,
        probed.hasAudio,
      ]).toEqual([1080, 1920, 30, false]);
      expect(Math.round(probed.durationSec * 10) / 10).toBe(2);
      const c = await colour(clip.path);
      expect([c.pix_fmt, c.color_range, c.color_space]).toEqual([
        "yuv420p",
        "tv",
        "bt709",
      ]);
    }
    const last = 59;
    expect(
      (await frame(still.path, 0)).equals(await frame(still.path, last)),
    ).toBe(true);
    expect((await frame(pan.path, 0)).equals(await frame(pan.path, last))).toBe(
      false,
    );
    // The push-in is centred and GROWS. The landscape photo sits 1080x720 in the 1080x1920 frame at
    // zoom 1 (rows 600–1320, black bars above and below); at the last frame's zoom (≈1.076) its top
    // edge has climbed to row ≈573. So row 585 is bar at frame 0 and orange photo at the end.
    const [r0] = await pixel(pan.path, 540, 585, 0.0);
    const [rEnd, gEnd] = await pixel(pan.path, 540, 585, 1.9);
    expect(r0).toBeLessThan(40);
    expect(rEnd).toBeGreaterThan(150);
    expect(gEnd).toBeGreaterThan(80);
  });

  it("a pushed-in still arrives in the engine's own profile — the conform chain has nothing left to do, as for a dead still", async () => {
    const pan = await encodeStill(
      at("landscape.jpg"),
      DIR,
      23,
      2,
      PORTRAIT,
      90_000,
      "dolly",
    );
    const probe = await probeMedia(pan.path);
    expect(probe).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      pixFmt: "yuv420p",
      sampleAspectRatio: "1:1",
      hasAudio: false,
    });
    expect((await colour(pan.path)).nb_frames).toBe("60");
    const plan = planStitch({
      clips: [{ source: pan.path }],
      probes: [probe],
      outputPath: at("unused-pan.mp4"),
      target: PORTRAIT,
    });
    expect(plan.clips[0].normalization).toEqual({
      scaled: false,
      padded: false,
      sarCorrected: false,
      fpsChanged: false,
      pixFmtChanged: false,
      silenceSynthesized: false,
    });
  });
});

describe("a move toward a point — zoom, sweep, punch (PR 5, A1)", () => {
  /** One decoded frame, raw RGB, full size. */
  async function frameAt(path: string, n: number): Promise<Buffer> {
    const { stdout } = await execFileP(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        `select=eq(n\\,${n}),format=rgb24`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout as Buffer;
  }

  /** Where the red marker is in a 1080×1920 frame, and how wide it is. */
  function red(buf: Buffer) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0, p = 0; i < buf.length; i += 3, p++) {
      if (buf[i] > 180 && buf[i + 1] < 90 && buf[i + 2] < 90) {
        const x = p % 1080;
        n++;
        sx += x;
        sy += Math.floor(p / 1080);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    return { n, x: sx / n, y: sy / n, width: maxX - minX + 1 };
  }

  const toCentre = (m: { x: number; y: number }) =>
    Math.hypot(m.x - 540, m.y - 960);

  beforeAll(async () => {
    // A 3:4 portrait photo, grey, with a red marker centred at (0.3, 0.3) — (450, 600).
    const marker = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: { r: 230, g: 20, b: 20 },
      },
    })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: 1500,
        height: 2000,
        channels: 3,
        background: { r: 110, g: 110, b: 110 },
      },
    })
      .composite([{ input: marker, left: 390, top: 540 }])
      .jpeg({ quality: 95 })
      .toFile(at("marker.jpg"));
    // A wide shot: blue on the left half, orange on the right.
    const orange = await sharp({
      create: {
        width: 1500,
        height: 2000,
        channels: 3,
        background: { r: 230, g: 130, b: 30 },
      },
    })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: { r: 30, g: 60, b: 200 },
      },
    })
      .composite([{ input: orange, left: 1500, top: 0 }])
      .jpeg({ quality: 95 })
      .toFile(at("halves.jpg"));
  });

  it("the plan: the largest frame-shaped window, placed on the point; a sweep crosses at most two windows toward the point's side", () => {
    const zoom = planStillMove(
      { width: 1500, height: 2000 },
      PORTRAIT,
      "zoom",
      { x: 0.3, y: 0.3 },
    );
    expect(zoom).toMatchObject({
      extract: { left: 0, top: 0, width: 1125, height: 2000 },
      frame: { width: 2160, height: 3840 },
      toward: { x: 0.4, y: 0.3 },
      zoomTo: 1.25,
    });
    expect(
      planStillMove({ width: 1500, height: 2000 }, PORTRAIT, "punch", {
        x: 0.3,
        y: 0.3,
      }).zoomTo,
    ).toBe(1.3);
    const right = planStillMove(
      { width: 3000, height: 2000 },
      PORTRAIT,
      "sweep",
      { x: 0.8, y: 0.5 },
    );
    expect(right).toMatchObject({
      extract: { left: 750, top: 0, width: 2250, height: 2000 },
      frame: { width: 4320, height: 3840 },
      sweep: { axis: "x", forward: true },
    });
    const left = planStillMove(
      { width: 3000, height: 2000 },
      PORTRAIT,
      "sweep",
      { x: 0.2, y: 0.5 },
    );
    expect(left.extract.left).toBe(0);
    expect(left.sweep).toEqual({ axis: "x", forward: false });
    // Already the frame's shape: the window shrinks to make room, and still crosses sideways.
    const flush = planStillMove(
      { width: 1080, height: 1920 },
      PORTRAIT,
      "sweep",
      { x: 0.5, y: 0.5 },
    );
    expect(flush.sweep.axis).toBe("x");
    expect(flush.extract.width).toBe(1080);
    expect(flush.frame.width).toBeGreaterThan(2160);
  });

  it("the argv refuses a focused motion without its plan, and a plan beside the wrong motion", () => {
    const move = planStillMove(
      { width: 1500, height: 2000 },
      PORTRAIT,
      "zoom",
      {
        x: 0.5,
        y: 0.5,
      },
    );
    expect(() =>
      stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 2, PORTRAIT, "zoom"),
    ).toThrow("wrong plan");
    expect(() =>
      stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 2, PORTRAIT, "dolly", move),
    ).toThrow("wrong plan");
    const vf = (a: string[]) => a[a.indexOf("-vf") + 1];
    const z = vf(
      stillEncodeArgs("/w/f.jpg", "/w/s.mp4", 2, PORTRAIT, "zoom", move),
    );
    expect(z).toMatch(/^format=rgb24,zoompan=z='1\+0\.25\*/);
    expect(z).toMatch(
      /scale=1080:1920:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p$/,
    );
  });

  /**
   * ⚠️ MUTATION "target ignored": planStillMove plans every move on the middle ({0.5, 0.5}) — this
   * test reds by name (the marker ends at the wrong place, and further from the centre).
   */
  it("zoom to a point: the marker grows 1.25× and ends where the plan put it, nearer the centre", async () => {
    const clip = await encodeStill(
      at("marker.jpg"),
      DIR,
      31,
      2,
      PORTRAIT,
      90_000,
      "zoom",
      { x: 0.3, y: 0.3 },
    );
    const first = red(await frameAt(clip.path, 0));
    const last = red(await frameAt(clip.path, 59));
    // Start: the window is the photo's left 1125 px, so the marker sits at (432, 576) and 115 wide.
    expect(Math.abs(first.x - 432)).toBeLessThan(8);
    expect(Math.abs(first.y - 576)).toBeLessThan(8);
    expect(last.width / first.width).toBeGreaterThan(1.23);
    expect(last.width / first.width).toBeLessThan(1.27);
    // End: a 900×1600 window centred on the point, pushed off the top edge → (540, 720).
    expect(Math.abs(last.x - 540)).toBeLessThan(12);
    expect(Math.abs(last.y - 720)).toBeLessThan(12);
    expect(toCentre(last)).toBeLessThan(toCentre(first) - 100);
  });

  it("the zoom never steps backwards: frame by frame the marker only grows and only closes on its end", async () => {
    const clip = await encodeStill(
      at("marker.jpg"),
      DIR,
      32,
      2,
      PORTRAIT,
      90_000,
      "zoom",
      { x: 0.3, y: 0.3 },
    );
    let prev: ReturnType<typeof red> | null = null;
    for (let n = 0; n < 60; n += 4) {
      const m = red(await frameAt(clip.path, n));
      if (prev) {
        expect(m.width).toBeGreaterThanOrEqual(prev.width - 1);
        expect(Math.hypot(m.x - 540, m.y - 720)).toBeLessThanOrEqual(
          Math.hypot(prev.x - 540, prev.y - 720) + 1,
        );
      }
      prev = m;
    }
  });

  it("a punch lands in a fifth of a second and holds: ≥ 95 % of its zoom by frame 7, 1.3× by the end", async () => {
    const clip = await encodeStill(
      at("marker.jpg"),
      DIR,
      33,
      2,
      PORTRAIT,
      90_000,
      "punch",
      { x: 0.3, y: 0.3 },
    );
    const w0 = red(await frameAt(clip.path, 0)).width;
    const w7 = red(await frameAt(clip.path, 7)).width;
    const wEnd = red(await frameAt(clip.path, 59)).width;
    expect(wEnd / w0).toBeGreaterThan(1.27);
    expect((w7 - w0) / (wEnd - w0)).toBeGreaterThanOrEqual(0.95);
  });

  it("a sweep crosses a wide shot toward the point's side — blue to orange one way, orange to blue the other", async () => {
    const toRight = await encodeStill(
      at("halves.jpg"),
      DIR,
      34,
      2,
      PORTRAIT,
      90_000,
      "sweep",
      { x: 0.8, y: 0.5 },
    );
    const [b0, , bb0] = await pixel(toRight.path, 100, 960, 0);
    const [rEnd, , bEnd] = await pixel(toRight.path, 100, 960, 1.95);
    expect(bb0).toBeGreaterThan(150);
    expect(b0).toBeLessThan(80);
    expect(rEnd).toBeGreaterThan(180);
    expect(bEnd).toBeLessThan(80);
    const toLeft = await encodeStill(
      at("halves.jpg"),
      DIR,
      35,
      2,
      PORTRAIT,
      90_000,
      "sweep",
      { x: 0.2, y: 0.5 },
    );
    const [r0L] = await pixel(toLeft.path, 1000, 960, 0);
    const [, , bEndL] = await pixel(toLeft.path, 1000, 960, 1.95);
    expect(r0L).toBeGreaterThan(180);
    expect(bEndL).toBeGreaterThan(150);
  });

  /**
   * ⚠️ MUTATION "prior ignored": an untapped zoom plans on the middle ({0.5, 0.5}) instead of
   * FRAMING_PRIOR — this reds by name (the marker at the prior ends off its predicted place).
   * The prior replaced libvips' attention crop, which found her in 0 of 8 of her photos (A4 prep).
   */
  it("with no point of hers, a zoom heads for the upper middle — a marker at (0.5, 0.28) ends near the centre", async () => {
    expect(FRAMING_PRIOR).toEqual({ x: 0.5, y: 0.28 });
    const marker = await sharp({
      create: {
        width: 120,
        height: 120,
        channels: 3,
        background: { r: 230, g: 20, b: 20 },
      },
    })
      .png()
      .toBuffer();
    // 3:4, grey, the marker centred at (750, 560) = (0.5, 0.28).
    await sharp({
      create: {
        width: 1500,
        height: 2000,
        channels: 3,
        background: { r: 110, g: 110, b: 110 },
      },
    })
      .composite([{ input: marker, left: 690, top: 500 }])
      .jpeg({ quality: 95 })
      .toFile(at("prior.jpg"));
    const clip = await encodeStill(
      at("prior.jpg"),
      DIR,
      37,
      2,
      PORTRAIT,
      90_000,
      "zoom",
    );
    const last = red(await frameAt(clip.path, 59));
    // Start window: 1125×2000 centred on x=750 (left 188). End: 900×1600 centred on (750, 560),
    // pushed off the top → top 0 → the marker at (540, 672).
    expect(Math.abs(last.x - 540)).toBeLessThan(12);
    expect(Math.abs(last.y - 672)).toBeLessThan(12);
  });

  it("a point on a sideways photo is a point on the photo as SHE sees it — the red block top right, zoomed toward", async () => {
    // sideways.jpg displays as 300×400 with the red block at the TOP RIGHT (upright ≈ (0.87, 0.1)).
    const clip = await encodeStill(
      at("sideways.jpg"),
      DIR,
      36,
      2,
      PORTRAIT,
      90_000,
      "zoom",
      { x: 0.87, y: 0.1 },
    );
    const first = red(await frameAt(clip.path, 0));
    const last = red(await frameAt(clip.path, 59));
    expect(first.n).toBeGreaterThan(1000);
    expect(first.x).toBeGreaterThan(540);
    expect(first.y).toBeLessThan(960);
    expect(last.width).toBeGreaterThan(first.width);
    expect(toCentre(last)).toBeLessThan(toCentre(first));
  });

  it("a moving still arrives in the engine's own profile — nothing left for the conform chain", async () => {
    for (const [i, motion] of (["zoom", "sweep", "punch"] as const).entries()) {
      const clip = await encodeStill(
        at("halves.jpg"),
        DIR,
        40 + i,
        2,
        PORTRAIT,
        90_000,
        motion,
      );
      const probe = await probeMedia(clip.path);
      expect((await colour(clip.path)).nb_frames).toBe("60");
      const c = await colour(clip.path);
      expect([c.pix_fmt, c.color_range, c.color_space]).toEqual([
        "yuv420p",
        "tv",
        "bt709",
      ]);
      const plan = planStitch({
        clips: [{ source: clip.path }],
        probes: [probe],
        outputPath: at(`unused-${motion}.mp4`),
        target: PORTRAIT,
      });
      expect(plan.clips[0].normalization).toEqual({
        scaled: false,
        padded: false,
        sarCorrected: false,
        fpsChanged: false,
        pixFmtChanged: false,
        silenceSynthesized: false,
      });
    }
  });
});

describe("holds of whole frames cut on exact frames — what an edit on the beat relies on (PR 5, A2)", () => {
  /** Each frame's average colour, as [r, g, b] — the stitched output shrunk to one pixel a frame. */
  async function frameColours(path: string): Promise<number[][]> {
    const { stdout } = await execFileP(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        "scale=1:1:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    const buf = stdout as Buffer;
    const out: number[][] = [];
    for (let i = 0; i + 2 < buf.length; i += 3)
      out.push([buf[i], buf[i + 1], buf[i + 2]]);
    return out;
  }

  it("64, 42 and 71 frames, sent as frames / 30 the way the Board sends them, change colour at exactly frames 64 and 106", async () => {
    const colours = [
      { r: 220, g: 20, b: 20 },
      { r: 20, g: 200, b: 20 },
      { r: 20, g: 20, b: 220 },
    ];
    const frames = [64, 42, 71];
    const clips = [];
    for (const [i, c] of colours.entries()) {
      await sharp({
        create: { width: 1080, height: 1920, channels: 3, background: c },
      })
        .jpeg()
        .toFile(at(`beat-${i}.jpg`));
      // The encode writes it to six decimals (fmt), and ffmpeg rounds `-t` to the nearest frame.
      const hold = frames[i] / 30;
      clips.push({
        source: (
          await encodeStill(
            at(`beat-${i}.jpg`),
            DIR,
            50 + i,
            hold,
            PORTRAIT,
            60_000,
          )
        ).path,
      });
    }
    await stitch({ clips, outputPath: at("on-beat.mp4"), target: PORTRAIT });
    const seen = await frameColours(at("on-beat.mp4"));
    const dominant = (px: number[]) => px.indexOf(Math.max(...px));
    const changes = seen
      .map((px, n) =>
        n > 0 && dominant(px) !== dominant(seen[n - 1]) ? n : -1,
      )
      .filter((n) => n >= 0);
    expect(changes).toEqual([64, 106]);
    expect(seen).toHaveLength(177);
  });
});

describe("one look across the set — each photo corrected from its own pixels, then the set's look (PR 5, A3)", () => {
  /** A 3:4 scene: grey wall, a white card, a skin patch, a dark patch, and a pitch along the bottom. */
  async function scene(name: string, cast: [number, number, number]) {
    const patch = (r: number, g: number, b: number, w: number, h: number) =>
      sharp({
        create: { width: w, height: h, channels: 3, background: { r, g, b } },
      })
        .png()
        .toBuffer();
    const base = await sharp({
      create: {
        width: 1200,
        height: 1600,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .composite([
        { input: await patch(60, 140, 50, 1200, 640), left: 0, top: 960 },
        { input: await patch(240, 240, 240, 300, 300), left: 100, top: 150 },
        { input: await patch(220, 170, 140, 300, 400), left: 700, top: 200 },
        { input: await patch(30, 30, 30, 200, 200), left: 450, top: 600 },
      ])
      .png()
      .toBuffer();
    await sharp(base)
      .linear(cast, [0, 0, 0])
      .jpeg({ quality: 95 })
      .toFile(at(name));
  }

  /** The mean colour of the photo's area in frame 0 (the 3:4 photo sits in rows 240–1680). */
  async function photoMean(path: string): Promise<number[]> {
    const { stdout } = await execFileP(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        "crop=1080:1440:0:240,scale=1:1:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
      ],
      { encoding: "buffer" },
    );
    return [...(stdout as Buffer)];
  }

  const worst = (a: number[], b: number[]) =>
    Math.max(...a.map((v, i) => Math.abs(v - b[i])));

  beforeAll(async () => {
    await scene("wb-warm.jpg", [1.15, 1, 0.82]);
    await scene("wb-cool.jpg", [0.85, 1, 1.18]);
    await scene("wb-true.jpg", [1, 1, 1]);
  });

  /**
   * ⚠️ MUTATION "grade skipped": applyGrade hands the frame back untouched — this reds by name
   * (the two casts stay ~40/255 apart).
   */
  it("the same scene shot warm and shot cool comes out within 6/255 on every channel under 'natural'", async () => {
    const enc = (f: string, pos: number, look?: "natural") =>
      encodeStill(
        at(f),
        DIR,
        pos,
        1,
        PORTRAIT,
        60_000,
        undefined,
        undefined,
        look,
      );
    const rawWarm = await photoMean((await enc("wb-warm.jpg", 60)).path);
    const rawCool = await photoMean((await enc("wb-cool.jpg", 61)).path);
    expect(worst(rawWarm, rawCool)).toBeGreaterThan(30);
    const warm = await photoMean(
      (await enc("wb-warm.jpg", 62, "natural")).path,
    );
    const cool = await photoMean(
      (await enc("wb-cool.jpg", 63, "natural")).path,
    );
    expect(worst(warm, cool)).toBeLessThanOrEqual(6);
  });

  it("a pitch is not a cast: an honest photo with a green pitch keeps its channel balance within 3/255 under 'natural' (exposure may move; colour does not)", async () => {
    const as = await photoMean(
      (await encodeStill(at("wb-true.jpg"), DIR, 64, 1, PORTRAIT, 60_000)).path,
    );
    const graded = await photoMean(
      (
        await encodeStill(
          at("wb-true.jpg"),
          DIR,
          65,
          1,
          PORTRAIT,
          60_000,
          undefined,
          undefined,
          "natural",
        )
      ).path,
    );
    // Measured: every channel pulled down 12 together — the exposure step toward mid-grey — and
    // the balance between them unmoved. A pitch read as a cast would push R and B up against G.
    const balance = (m: number[]) => [m[0] - m[1], m[2] - m[1]];
    expect(worst(balance(as), balance(graded))).toBeLessThanOrEqual(3);
  });

  it("the looks are what they say: warm is redder than cool, black and white has no colour — on a moving still too", async () => {
    const mean = async (
      look: "warm" | "cool" | "mono",
      pos: number,
      motion?: "zoom",
    ) =>
      photoMean(
        (
          await encodeStill(
            at("wb-true.jpg"),
            DIR,
            pos,
            1,
            PORTRAIT,
            60_000,
            motion,
            { x: 0.5, y: 0.5 },
            look,
          )
        ).path,
      );
    const warm = await mean("warm", 66);
    const cool = await mean("cool", 67);
    expect(warm[0] - warm[2]).toBeGreaterThan(cool[0] - cool[2] + 10);
    const mono = await mean("mono", 68, "zoom");
    // THE CONTROL: a photo that is grey to begin with, through the same zoom and the same ffmpeg.
    // The BT.709 limited-range round trip leaves a few /255 between channels on its own — 4 on
    // 9.0.1, 7 on Debian's 5.1.9 — so black and white is held to the control, not to a number.
    await sharp(at("wb-true.jpg"))
      .greyscale()
      .toColourspace("srgb")
      .jpeg({ quality: 95 })
      .toFile(at("wb-grey.jpg"));
    const control = await photoMean(
      (
        await encodeStill(
          at("wb-grey.jpg"),
          DIR,
          69,
          1,
          PORTRAIT,
          60_000,
          "zoom",
          { x: 0.5, y: 0.5 },
        )
      ).path,
    );
    const spread = (m: number[]) => Math.max(...m) - Math.min(...m);
    expect(spread(mono)).toBeLessThanOrEqual(spread(control) + 2);
    // And the colour scene ungraded is nowhere near it.
    expect(
      spread(
        await photoMean(
          (
            await encodeStill(
              at("wb-true.jpg"),
              DIR,
              70,
              1,
              PORTRAIT,
              60_000,
              "zoom",
              { x: 0.5, y: 0.5 },
            )
          ).path,
        ),
      ),
    ).toBeGreaterThan(spread(control) + 20);
  });
});
