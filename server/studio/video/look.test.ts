/**
 * look.test.ts — a post's look as one fixed colour filter (studio/video/look.ts), laid by the plan (plan.ts) on every
 * position after its conform and before its caption; absent or natural, the argv byte for byte.
 */
import { LOOK_PRESETS } from "../../../shared/postKit";
import { isVideoLook, lookFilter } from "./look";
import { planStitch } from "./plan";
import type { ClipProbe } from "./types";

const probe: ClipProbe = {
  width: 1920, height: 1080, fps: 30, pixFmt: "yuv420p", sampleAspectRatio: "1:1", durationSec: 2,
  videoCodec: "h264", hasAudio: false, audioCodec: null, sampleRate: null, channels: null,
};
const PORTRAIT = { width: 1080, height: 1920, fps: 30 };
const graph = (finishing?: Parameters<typeof planStitch>[0]["finishing"], overlay = false) =>
  planStitch({
    clips: [{ source: "/a.mp4", ...(overlay ? { overlay: { source: "/cap.png", y: 100 } } : {}) }, { source: "/b.mp4" }],
    probes: [probe, probe],
    outputPath: "/out.mp4",
    target: PORTRAIT,
    ...(finishing ? { finishing } : {}),
  });

describe("the table", () => {
  it("has exactly the post kit's looks; natural is no filter; every other is a fixed filter", () => {
    for (const look of LOOK_PRESETS) expect(isVideoLook(look)).toBe(true);
    expect(lookFilter("natural")).toBeNull();
    expect(LOOK_PRESETS.filter((l) => l !== "natural").map((l) => [l, lookFilter(l)])).toEqual([
      ["warm", "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05"],
      ["cool", "colorbalance=rs=-0.08:bs=0.08:rm=-0.05:bm=0.05"],
      ["vivid", "hue=s=1.3"],
      ["muted", "hue=s=0.7"],
      ["mono", "hue=s=0"],
    ]);
  });
  it("refuses a name outside the set", () => {
    expect(isVideoLook("lut=/etc/passwd")).toBe(false);
    expect(() => lookFilter("sepia" as never)).toThrow("Unknown look");
  });
});

describe("in the plan", () => {
  it("absent, or natural, is the argv byte for byte", () => {
    const before = graph({ cropToFill: true });
    expect(graph({ cropToFill: true, look: "natural" }).args).toEqual(before.args);
    expect(graph().filterGraph).not.toMatch(/hue=|colorbalance=/);
  });
  it("a look sits in every position's chain after the frame rate and before the pixel format", () => {
    const g = graph({ look: "mono" }).filterGraph;
    expect(g.match(/fps=30,hue=s=0,format=yuv420p/g)).toHaveLength(2);
  });
  it("and before the caption is laid over, so the words are never tinted", () => {
    const g = graph({ look: "warm" }, true).filterGraph;
    const look = g.indexOf("colorbalance=");
    const overlay = g.indexOf("overlay=0:100");
    expect(look).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(look);
    expect(g).toMatch(/\[0:v\][^;]*colorbalance=[^;]*\[vb0\];\[vb0\]\[\d+:v\]overlay=0:100/);
  });
});
