/**
 * drift.test — frame-to-frame face distance across a clip (PR 17, R-6), with the two boundaries
 * (face box, embed) and ffmpeg mocked at the module edge.
 *
 * REVERT CHECKS, red by name:
 *   "is-it-her shown for an athlete whose control failed" → observeDrift computes toAnchorsMean /
 *     isHer with no anchors handed (the caller hands them only on control_passed)
 *   "drift shown as pass/fail"                            → qa/routes.test, on the wire
 */
jest.mock("./face", () => ({ faceCrop: jest.fn() }));
jest.mock("./embed", () => ({
  embedImageBytes: jest.fn(),
  embeddingDistance: (a: number[], b: number[]) => Math.abs(a[0] - b[0]),
  cosine: jest.fn(),
}));
const extractStripMock = jest.fn();
jest.mock("../video/frames", () => ({
  extractStrip: (...a: unknown[]) => extractStripMock(...a),
}));

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faceCrop } from "./face";
import { embedImageBytes } from "./embed";
import {
  beatStamps,
  median,
  observeDrift,
  thin,
  DRIFT_MAX_FRAMES,
} from "./drift";
import type { FrameStrip } from "../video/frames";

const mockFace = faceCrop as jest.MockedFunction<typeof faceCrop>;
const mockEmbed = embedImageBytes as jest.MockedFunction<
  typeof embedImageBytes
>;

const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
const frameFile = (t: number) => {
  const p = join(dir, `f${t}.jpg`);
  writeFileSync(p, Buffer.from(`frame@${t}`));
  return { path: p, timeSec: t };
};
const stripOf = (times: number[]): FrameStrip => ({
  dir,
  frames: times.map(frameFile),
  durationSec: Math.max(...times) + 0.25,
  plan: { kind: "fps", fps: 4 },
  dispose: async () => {},
});

const found = (sizeFrac = 0.2) => ({
  crop: {
    bytes: Buffer.from("face"),
    rect: { left: 0, top: 0, width: 0.2, height: 0.2 },
    confidence: 0.9,
    obscured: false,
    sizeFrac,
    small: sizeFrac < 0.06,
  },
  miss: null,
  error: null,
  latencyMs: 1,
  usage: { inputTokens: 100, outputTokens: 10 },
});
const none = () => ({
  crop: null,
  miss: "no_face" as const,
  error: null,
  latencyMs: 1,
  usage: { inputTokens: 100, outputTokens: 5 },
});

beforeEach(() => {
  jest.clearAllMocks();
  extractStripMock.mockReset();
});

describe("beat stamps", () => {
  it("takes start_s and end_s, clips to the clip, dedupes, sorts", () => {
    expect(
      beatStamps(
        [
          { start_s: 0, end_s: 2 },
          { start_s: 2, end_s: 4.5 },
          { start_s: 4.5, end_s: 9 },
        ],
        6,
      ),
    ).toEqual([0, 2, 4.5, 5.95]);
  });
  it("ignores junk and answers [] with no beats", () => {
    expect(beatStamps(null, 6)).toEqual([]);
    expect(beatStamps([{ start_s: "x" }, {}], 6)).toEqual([]);
  });
  it("never more than DRIFT_MAX_FRAMES, keeping both ends", () => {
    const beats = Array.from({ length: 20 }, (_, i) => ({
      start_s: i,
      end_s: i + 1,
    }));
    const s = beatStamps(beats, 30);
    expect(s.length).toBeLessThanOrEqual(DRIFT_MAX_FRAMES);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(20);
  });
  it("thin keeps first and last", () => {
    expect(thin([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(thin([1, 2], 4)).toEqual([1, 2]);
  });
  it("median of an even count is the middle pair's mean", () => {
    expect(median([0.4, 0.1, 0.3, 0.2])).toBe(0.25);
    expect(median([])).toBeNull();
  });
});

describe("observeDrift", () => {
  it("with beats: one stamps pass, one face box + one embed per frame, a step series with its median and max", async () => {
    const own = stripOf([0, 2, 4, 6]);
    const dispose = jest.fn(async () => {});
    extractStripMock.mockResolvedValue({ ...own, dispose });
    mockFace.mockResolvedValue(found());
    mockEmbed
      .mockResolvedValueOnce([0.0])
      .mockResolvedValueOnce([0.1])
      .mockResolvedValueOnce([0.5])
      .mockResolvedValueOnce([0.6]);

    const obs = await observeDrift({
      assetId: "clip",
      clipPath: "/tmp/x.mp4",
      durationSec: 6.5,
      beats: [
        { start_s: 0, end_s: 2 },
        { start_s: 2, end_s: 4 },
        { start_s: 4, end_s: 6 },
      ],
      strip: stripOf([0, 0.25, 0.5]),
    });
    expect(extractStripMock).toHaveBeenCalledWith("/tmp/x.mp4", {
      kind: "stamps",
      seconds: [0, 2, 4, 6],
    });
    expect(dispose).toHaveBeenCalled();
    expect(obs?.framesFrom).toBe("beats");
    expect(obs?.frames.map((f) => f.stepFromPrev)).toEqual([
      null,
      0.1,
      0.4,
      0.1,
    ]);
    expect(obs?.medianStep).toBe(0.1);
    expect(obs?.maxStep).toBe(0.4);
    expect(obs?.maxStepAtSec).toBe(4);
    expect(obs?.maxOverMedian).toBe(4);
    expect(obs?.spend.visionCalls).toBe(4);
    expect(obs?.spend.embedCalls).toBe(4);
    expect(obs?.caption).toBe("Observation only, not a check");
    expect(obs?.isHer).toBeUndefined();
    expect(obs?.frames.every((f) => !("toAnchorsMean" in f))).toBe(true);
    expect(mockFace).toHaveBeenCalledTimes(4);
  });

  it("without beats: reuses the strip it was handed — NO ffmpeg pass — thinned to ≤ 8", async () => {
    mockFace.mockResolvedValue(found());
    mockEmbed.mockResolvedValue([0.2]);
    const obs = await observeDrift({
      assetId: "clip",
      clipPath: "/tmp/x.mp4",
      durationSec: 6,
      beats: undefined,
      strip: stripOf(Array.from({ length: 24 }, (_, i) => i * 0.25)),
    });
    expect(extractStripMock).not.toHaveBeenCalled();
    expect(obs?.framesFrom).toBe("strip");
    expect(obs?.frames).toHaveLength(8);
    expect(obs?.frames[0].timeSec).toBe(0);
    expect(obs?.frames[7].timeSec).toBe(5.75);
  });

  it("a frame with no face breaks the chain: null step there, next step measured from the last face", async () => {
    mockFace
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce(none())
      .mockResolvedValueOnce(found());
    mockEmbed.mockResolvedValueOnce([0.0]).mockResolvedValueOnce([0.3]);
    const obs = await observeDrift({
      assetId: "c",
      clipPath: "/tmp/x.mp4",
      durationSec: 3,
      beats: null,
      strip: stripOf([0, 1, 2]),
    });
    expect(obs?.frames.map((f) => f.stepFromPrev)).toEqual([null, null, 0.3]);
    expect(obs?.frames[1].face).toBeNull();
    expect(obs?.spend.embedCalls).toBe(2);
  });

  it("fewer than two frames → null, nothing paid", async () => {
    const obs = await observeDrift({
      assetId: "c",
      clipPath: "/tmp/x.mp4",
      durationSec: 1,
      beats: null,
      strip: stripOf([0]),
    });
    expect(obs).toBeNull();
    expect(mockFace).not.toHaveBeenCalled();
  });

  it("is-it-her shown for an athlete whose control failed — ABSENT unless anchors are handed", async () => {
    mockFace.mockResolvedValue(found());
    mockEmbed.mockResolvedValue([0.2]);
    const without = await observeDrift({
      assetId: "c",
      clipPath: "/tmp/x.mp4",
      durationSec: 2,
      beats: null,
      strip: stripOf([0, 1]),
      anchors: [],
    });
    expect(without?.isHer).toBeUndefined();
    expect(JSON.stringify(without)).not.toContain("toAnchorsMean");

    mockEmbed.mockReset();
    mockEmbed
      .mockResolvedValueOnce([0.0])
      .mockResolvedValueOnce([0.2])
      .mockResolvedValueOnce([0.3])
      .mockResolvedValueOnce([0.5]);
    const withAnchors = await observeDrift({
      assetId: "c",
      clipPath: "/tmp/x.mp4",
      durationSec: 2,
      beats: null,
      strip: stripOf([0, 1]),
      anchors: [
        { assetId: "a1", bytes: Buffer.from("a"), mimeType: "image/jpeg" },
        { assetId: "a2", bytes: Buffer.from("b"), mimeType: "image/jpeg" },
      ],
    });
    expect(withAnchors?.isHer).toEqual({
      anchors: 2,
      caveat: expect.stringMatching(/stranger control passed/),
    });
    // frame vectors 0.3 and 0.5 vs anchors 0.0 and 0.2 → means 0.2 and 0.4
    expect(withAnchors?.frames.map((f) => f.toAnchorsMean)).toEqual([0.2, 0.4]);
    expect(withAnchors?.spend.visionCalls).toBe(4);
  });
});
