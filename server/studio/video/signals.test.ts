/**
 * signals.test.ts — the $0 quality signals (media-intake plan fix 2): the parsers on ffmpeg's own words, the runner's
 * one-pass-fails-alone rule, and one real run on a synthetic clip (CI has ffmpeg, as the shots suite relies on).
 *
 * ⚠️ MUTATION: make one failed pass throw out of measureSignals — "a filter this ffmpeg lacks empties one signal" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { execFile } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import {
  blackFrom, blurFrom, loudnessFrom, measureSignals, measureSignalsBytes, probeFacts, spansFrom, SLOW_MOTION_FPS,
  type ToolRunner,
} from "./signals";

jest.setTimeout(120_000);

describe("the parsers, on ffmpeg's own words", () => {
  it("ebur128's summary → integrated loudness", () => {
    const log = "[Parsed_ebur128_0 @ 0x1] t: 1 …\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -22.1 LUFS\n    Threshold: -32.4 LUFS\n";
    expect(loudnessFrom(log)).toBe(-22.1);
    expect(loudnessFrom("no summary here")).toBeNull();
  });

  it("silencedetect pairs, and a stretch still open at the end runs to the clip's end", () => {
    const log = "[silencedetect @ 0x1] silence_start: 1.999977\n[silencedetect @ 0x1] silence_end: 5 | silence_duration: 3.000023\n[silencedetect @ 0x1] silence_start: 7.5\n";
    expect(spansFrom(log, "silence", 9)).toEqual([[2, 5], [7.5, 9]]);
    expect(spansFrom(log, "silence", null)).toEqual([[2, 5]]);
  });

  it("freezedetect's lavfi keys", () => {
    const log = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 3\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 5\n";
    expect(spansFrom(log, "freeze", 10)).toEqual([[3, 5]]);
  });

  it("blackdetect lines", () => {
    expect(blackFrom("[blackdetect @ 0x1] black_start:3 black_end:4.966667 black_duration:1.966667")).toEqual([[3, 4.967]]);
  });

  it("blurdetect's mean, and 'nan' (no frames scored) is no number", () => {
    expect(blurFrom("[Parsed_blurdetect_1 @ 0x1] blur mean: 3.14159")).toBe(3.142);
    expect(blurFrom("[Parsed_blurdetect_1 @ 0x1] blur mean: nan")).toBeNull();
  });

  it("ffprobe facts: fps, variable frame rate, slow motion, bitrate, audio", () => {
    const probe = (avg: string, r: string, audio = true) => JSON.stringify({
      streams: [{ codec_type: "video", codec_name: "hevc", width: 1080, height: 1920, avg_frame_rate: avg, r_frame_rate: r }, ...(audio ? [{ codec_type: "audio" }] : [])],
      format: { bit_rate: "8123456", duration: "12.5" },
    });
    expect(probeFacts(probe("30/1", "30/1"))).toEqual({
      fps: 30, vfr: false, slow_motion: false, width: 1080, height: 1920, codec: "hevc", bitrate_kbps: 8123, has_audio: true,
    });
    expect(probeFacts(probe("2900/100", "30/1")).vfr).toBe(true);
    expect(probeFacts(probe(`${SLOW_MOTION_FPS * 2}/1`, `${SLOW_MOTION_FPS * 2}/1`, false))).toMatchObject({ slow_motion: true, has_audio: false });
  });
});

/** The one filter a pass runs (after -vf or -af). */
const filterOf = (args: string[]): string => {
  const i = args.findIndex((a) => a === "-vf" || a === "-af");
  return i >= 0 ? args[i + 1] : "";
};

describe("the runner: each pass on its own", () => {
  const probeJson = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: 720, height: 1280, avg_frame_rate: "30/1", r_frame_rate: "30/1" }, { codec_type: "audio" }],
    format: { bit_rate: "2000000", duration: "6" },
  });

  it("a filter this ffmpeg lacks empties one signal and keeps the rest", async () => {
    const run: ToolRunner = async (tool, args) => {
      if (tool === "ffprobe") return { stdout: probeJson, stderr: "" };
      const f = filterOf(args);
      if (String(f).includes("blurdetect")) throw new Error("No such filter: 'blurdetect'");
      if (String(f).includes("ebur128")) return { stdout: "", stderr: "Summary:\n  Integrated loudness:\n    I:  -14.0 LUFS" };
      if (String(f).includes("blackdetect")) return { stdout: "", stderr: "black_start:1 black_end:2 black_duration:1" };
      return { stdout: "", stderr: "" };
    };
    const s = await measureSignals("/tmp/clip.mp4", run, new Date("2026-10-12T00:00:00Z"));
    expect(s).toMatchObject({
      version: 1, fps: 30, width: 720, height: 1280, has_audio: true, loudness_lufs: -14,
      blur_mean: null, black: [[1, 2]], silence: [], freezes: [], at: "2026-10-12T00:00:00.000Z",
    });
  });

  it("no audio track: the audio passes are not run, and their signals are null", async () => {
    const calls: string[] = [];
    const run: ToolRunner = async (tool, args) => {
      calls.push(tool === "ffprobe" ? "probe" : filterOf(args));
      if (tool === "ffprobe") return { stdout: JSON.stringify({ streams: [{ codec_type: "video", avg_frame_rate: "24/1", r_frame_rate: "24/1" }], format: {} }), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const s = await measureSignals("/tmp/clip.mp4", run);
    expect(s.loudness_lufs).toBeNull();
    expect(s.silence).toBeNull();
    expect(calls.some((c) => c.includes("ebur128") || c.includes("silencedetect"))).toBe(false);
  });

  it("a probe that fails leaves the stream facts null and never throws", async () => {
    const s = await measureSignals("/tmp/clip.mp4", async () => { throw new Error("ffprobe missing"); });
    expect(s).toMatchObject({ fps: null, width: null, loudness_lufs: null, blur_mean: null });
  });
});

describe("a real clip (synthetic): 3 s of picture then 2 s black; 2 s of tone then silence", () => {
  const DIR = mkdtempSync(join(tmpdir(), "signals-"));
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("measures what is there", async () => {
    const path = join(DIR, "sig.mp4");
    await promisify(execFile)("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=3",
      "-f", "lavfi", "-i", "color=black:size=360x640:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[3:a]atrim=duration=3[s];[2:a][s]concat=n=2:v=0:a=1[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
    ], { timeout: 60_000 });
    const s = await measureSignalsBytes(readFileSync(path));
    expect(s.fps).toBe(30);
    expect(s.width).toBe(360);
    expect(s.has_audio).toBe(true);
    expect(typeof s.loudness_lufs).toBe("number");
    expect(s.black?.[0]?.[0]).toBeCloseTo(3, 0);
    expect(s.silence?.[0]?.[0]).toBeCloseTo(2, 0);
  });
});
