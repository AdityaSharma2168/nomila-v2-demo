/**
 * ebur128.test — the loudness meter's spelling works on prod's ffmpeg 5.1, and nothing in server/ asks 5.1 for an
 * option it does not have.
 *
 * ⚠️ WHY A SOURCE SCAN: CI's Ubuntu ffmpeg is 6.x, prod's Debian bookworm ffmpeg 5.1. `ebur128=framelog=quiet` passed
 * every CI run and failed every prod measurement, silently (ebur128.ts). The ffmpeg-5.1 CI job (ci-checks.yml) runs the
 * real suites on 5.1; this scan is the cheap guard that also runs on any ffmpeg, or none.
 *
 * ⚠️ MUTATION: put `framelog=quiet` back into signals.ts or finishing.ts — "no server source asks for an option" reds.
 */
// signals.ts writes through db; nothing here writes, so no database at all.
jest.mock("../../db", () => ({ db: {} }));

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { FFMPEG_51_UNSUPPORTED, ebur128Filter, stderrTail } from "./ebur128";
import { loudnessFrom, measureSignals, type ToolRunner } from "./signals";

const SERVER = join(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "public") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("ebur128Filter", () => {
  it("is summary-only through framelog=verbose, which ffmpeg 5.1 and 6.x both accept", () => {
    expect(ebur128Filter()).toBe("ebur128=framelog=verbose");
    expect(ebur128Filter({ peak: true })).toBe("ebur128=peak=true:framelog=verbose");
    for (const f of [ebur128Filter(), ebur128Filter({ peak: true })]) {
      for (const bad of FFMPEG_51_UNSUPPORTED) expect(f).not.toMatch(bad.pattern);
    }
  });
});

describe("no server source asks ffmpeg 5.1 for an option it lacks", () => {
  it.each(FFMPEG_51_UNSUPPORTED.map((u) => [u.why, u.pattern] as const))("%s", (_why, pattern) => {
    const self = join(__dirname, "ebur128.ts");
    const selfTest = join(__dirname, "ebur128.test.ts");
    const hits = sources(SERVER)
      .filter((p) => p !== self && p !== selfTest)
      .filter((p) => pattern.test(readFileSync(p, "utf8")))
      .map((p) => relative(SERVER, p).split(sep).join("/"));
    expect(hits).toEqual([]);
  });
});

describe("ffmpeg 5.1's summary is read the same", () => {
  // libavfilter/f_ebur128.c, release/5.1, uninit(): the summary at AV_LOG_INFO, one format for 5.1 and 6.x.
  const SUMMARY_51 =
    "[Parsed_ebur128_0 @ 0x55d0] Summary:\n\n" +
    "  Integrated loudness:\n    I:         -22.1 LUFS\n    Threshold: -32.4 LUFS\n\n" +
    "  Loudness range:\n    LRA:         0.0 LU\n    Threshold:   0.0 LUFS\n    LRA low:     0.0 LUFS\n    LRA high:    0.0 LUFS\n";

  it("loudnessFrom reads the integrated figure", () => {
    expect(loudnessFrom(SUMMARY_51)).toBe(-22.1);
  });

  it("stderrTail keeps the end of a long log, and is empty for nothing", () => {
    expect(stderrTail("x".repeat(1000) + "END", 10)).toBe("xxxxxxxEND");
    expect(stderrTail(undefined)).toBe("");
    expect(stderrTail(Buffer.from("abc"))).toBe("abc");
  });
});

describe("a loudness measurement that fails is SAID, not swallowed", () => {
  const probeJson = JSON.stringify({
    streams: [{ codec_type: "video", avg_frame_rate: "30/1", r_frame_rate: "30/1" }, { codec_type: "audio" }],
    format: { duration: "4" },
  });
  const runner = (ebur: () => { stdout: string; stderr: string }): ToolRunner => async (tool, args) => {
    if (tool === "ffprobe") return { stdout: probeJson, stderr: "" };
    if (args.some((a) => a.startsWith("ebur128"))) return ebur();
    return { stdout: "", stderr: "" };
  };

  it("ffmpeg 5.1's refusal of an option: loudness_lufs null and named in `failed`", async () => {
    const s = await measureSignals("/tmp/clip.mp4", runner(() => {
      throw Object.assign(new Error("Command failed: ffmpeg"), { stderr: '[Parsed_ebur128_0] Unable to parse option value "quiet"' });
    }), new Date(), "clip-1");
    expect(s.loudness_lufs).toBeNull();
    expect(s.failed).toEqual(["loudness_lufs"]);
  });

  it("a pass that runs but prints no summary is a failure too", async () => {
    const s = await measureSignals("/tmp/clip.mp4", runner(() => ({ stdout: "", stderr: "nothing useful" })), new Date(), "clip-2");
    expect(s.loudness_lufs).toBeNull();
    expect(s.failed).toEqual(["loudness_lufs"]);
  });

  it("a measured clip carries no `failed` at all", async () => {
    const s = await measureSignals("/tmp/clip.mp4", runner(() => ({ stdout: "", stderr: "Summary:\n  Integrated loudness:\n    I:  -14.0 LUFS" })));
    expect(s.loudness_lufs).toBe(-14);
    expect(s).not.toHaveProperty("failed");
  });
});
