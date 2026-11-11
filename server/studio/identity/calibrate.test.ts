/**
 * calibrate.test — the arithmetic of the pre-registered measurement (PR 17, R-4/R-5).
 *
 * REVERT CHECK, red by name:
 *   "a threshold is asserted before the stranger control passes" → make controlOf pass on an
 *   empty stranger set, or on a stranger at/inside band_max.
 */
jest.mock("../qa/face", () => ({ faceCrop: jest.fn() }));
jest.mock("../qa/embed", () => ({
  embedImageBytes: jest.fn(),
  embeddingDistance: jest.fn(),
  cosine: jest.fn(),
}));

import { faceCrop } from "../qa/face";
import { embedImageBytes } from "../qa/embed";
import {
  bandOf,
  controlOf,
  measureFaces,
  pairwiseDistances,
  quoteMeasure,
  strangerDistances,
  type FaceMeasure,
} from "./calibrate";

const mockFace = faceCrop as jest.MockedFunction<typeof faceCrop>;
const mockEmbed = embedImageBytes as jest.MockedFunction<
  typeof embedImageBytes
>;

const f = (id: string, vector: number[] | null = [1, 0]): FaceMeasure => ({
  assetId: id,
  vector,
  faceSizeFrac: 0.2,
  miss: vector ? null : "no_face",
});
/** A distance that is just the absolute difference of the first coordinate — enough to reason about. */
const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]);

describe("her-vs-her", () => {
  it("pairs every face that produced a vector, once, and skips the misses", () => {
    const pairs = pairwiseDistances(
      [f("a", [0]), f("b", [0.3]), f("c", null), f("d", [0.5])],
      dist,
    );
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(["a-b", "a-d", "b-d"]);
    expect(pairs.map((p) => p.d)).toEqual([0.3, 0.5, 0.2]);
  });

  it("the band is the extremes, with the pair count on it", () => {
    expect(bandOf([{ d: 0.3 }, { d: 0.5 }, { d: 0.2 }])).toEqual({
      min: 0.2,
      max: 0.5,
      pairs: 3,
    });
  });

  it("no pairs → no band; a band is never invented from no data", () => {
    expect(bandOf([])).toBeNull();
  });
});

describe("the stranger control", () => {
  const band = { min: 0.2, max: 0.5, pairs: 3 };

  it("passes only when EVERY stranger distance is strictly above band_max", () => {
    const r = controlOf(band, [{ d: 0.51 }, { d: 0.7 }]);
    expect(r).toEqual({
      passed: true,
      measured: 2,
      inside: 0,
      minStranger: 0.51,
    });
  });

  it("a threshold is asserted before the stranger control passes — one stranger inside fails it", () => {
    const r = controlOf(band, [{ d: 0.7 }, { d: 0.5 }, { d: 0.36 }]);
    expect(r.passed).toBe(false);
    expect(r.inside).toBe(2);
    expect(r.minStranger).toBe(0.36);
  });

  it("a threshold is asserted before the stranger control passes — no strangers measured is NOT a pass", () => {
    expect(controlOf(band, []).passed).toBe(false);
    expect(controlOf(null, [{ d: 0.9 }]).passed).toBe(false);
  });

  it("stranger distances are every stranger vs every pack face, misses skipped", () => {
    const d = strangerDistances(
      [f("p1", [0]), f("p2", null)],
      [f("s1", [0.6]), f("s2", null)],
      dist,
    );
    expect(d).toEqual([{ strangerAssetId: "s1", packAssetId: "p1", d: 0.6 }]);
  });
});

describe("measureFaces — vectors in memory, sizes out", () => {
  it("one face box per photo, one embed per face found; the size rides out as a number", async () => {
    mockFace
      .mockResolvedValueOnce({
        crop: {
          bytes: Buffer.from("x"),
          rect: { left: 0, top: 0, width: 0.3, height: 0.2 },
          confidence: 0.9,
          obscured: false,
          sizeFrac: 0.31234,
          small: false,
        },
        miss: null,
        error: null,
        latencyMs: 1,
        usage: null,
      })
      .mockResolvedValueOnce({
        crop: null,
        miss: "no_face",
        error: null,
        latencyMs: 1,
        usage: null,
      });
    mockEmbed.mockResolvedValueOnce([0.1, 0.2]);
    const r = await measureFaces(
      [
        { assetId: "a", bytes: Buffer.from("a"), mimeType: "image/jpeg" },
        { assetId: "b", bytes: Buffer.from("b"), mimeType: "image/jpeg" },
      ],
      "t",
    );
    expect(r.visionCalls).toBe(2);
    expect(r.embedCalls).toBe(1);
    expect(r.faces).toEqual([
      { assetId: "a", vector: [0.1, 0.2], faceSizeFrac: 0.3123, miss: null },
      { assetId: "b", vector: null, faceSizeFrac: null, miss: "no_face" },
    ]);
  });
});

describe("the quote", () => {
  it("is photos × (a flash face box + an embed) at qa/cost.ts's default rates", () => {
    const q = quoteMeasure(12);
    // 12 × (1300 × 0.3e-6 + 60 × 2.5e-6) = 12 × 0.00054 = 0.00648 ; 12 × 0.0001 = 0.0012
    expect(q.faceBoxUsd).toBeCloseTo(0.0065, 4);
    expect(q.embedUsd).toBeCloseTo(0.0012, 4);
    expect(q.usd).toBeCloseTo(0.0077, 4);
  });
});
