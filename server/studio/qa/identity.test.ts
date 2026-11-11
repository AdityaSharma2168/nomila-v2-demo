/**
 * qa/identity — the band arithmetic, and the rule that a missing face is never a pass.
 *
 * The two network boundaries (face detection, embedding) are mocked per suite, per the repo's test
 * convention. What is under test is the part that decides what goes on the record: where a distance
 * falls, what happens when a face is absent, and that no path can return `fail` — because the
 * corpus contains no identity failure to have calibrated one against.
 */
import {
  checkIdentity,
  observeGenerateIdentity,
  position,
  SAME_PERSON_BAND,
} from "./identity";
import type { ComparedAgainst } from "./identitySet";
import type { ComparisonPair } from "./types";

jest.mock("./face", () => ({ faceCrop: jest.fn() }));
jest.mock("./embed", () => ({
  embedImageBytes: jest.fn(),
  embeddingDistance: jest.fn(),
  cosine: jest.fn(),
}));

import { faceCrop, type FaceMiss } from "./face";
import { embedImageBytes, embeddingDistance } from "./embed";

const mockFace = faceCrop as jest.MockedFunction<typeof faceCrop>;
const mockEmbed = embedImageBytes as jest.MockedFunction<
  typeof embedImageBytes
>;
const mockDist = embeddingDistance as jest.MockedFunction<
  typeof embeddingDistance
>;

const pair = (): ComparisonPair => ({
  sourceAssetId: "src-asset",
  sourceBytes: Buffer.from("s"),
  sourceMimeType: "image/png",
  outputAssetId: "out-asset",
  outputBytes: Buffer.from("o"),
  outputMimeType: "image/png",
  chainDepth: 1,
  instruction: "make the jersey red",
});

type Cropped = Awaited<ReturnType<typeof faceCrop>>;

const foundFace = (
  over: Partial<{ confidence: number; sizeFrac: number; small: boolean }> = {},
): Cropped & { crop: NonNullable<Cropped["crop"]> } => ({
  crop: {
    bytes: Buffer.from("face"),
    rect: { left: 0.4, top: 0.1, width: 0.2, height: 0.15 },
    confidence: over.confidence ?? 0.98,
    obscured: false,
    sizeFrac: over.sizeFrac ?? 0.2,
    small: over.small ?? false,
  },
  miss: null,
  error: null,
  latencyMs: 10,
  usage: { inputTokens: 500, outputTokens: 40 },
});

const noFace = (
  error: string | null = null,
  miss: FaceMiss = error ? "vision_error" : "no_face",
): Cropped => ({
  crop: null,
  miss,
  error,
  latencyMs: 10,
  usage: { inputTokens: 500, outputTokens: 20 },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("band position", () => {
  it.each([
    ["below", SAME_PERSON_BAND.min - 0.05, "pass"],
    ["within", (SAME_PERSON_BAND.min + SAME_PERSON_BAND.max) / 2, "pass"],
    ["above", SAME_PERSON_BAND.max + 0.05, "flag"],
  ])(
    "a distance %s the band is recorded and gives %s",
    async (band, d, status) => {
      mockFace.mockResolvedValue(foundFace());
      mockDist.mockReturnValue(d as number);

      const r = await checkIdentity(pair());
      expect(r.detail!.band).toBe(band);
      expect(r.status).toBe(status);
      expect(r.detail!.distance).toBeCloseTo(d as number, 4);
    },
  );

  it("puts the band edges INSIDE the band, not outside", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(SAME_PERSON_BAND.min);
    expect((await checkIdentity(pair())).detail!.band).toBe("within");
    mockDist.mockReturnValue(SAME_PERSON_BAND.max);
    expect((await checkIdentity(pair())).detail!.band).toBe("within");
  });
});

describe("a handed band (PR 17) is the band used — and the default is the global const", () => {
  it("places the distance against the band it is handed, and records that band", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(0.45);
    const hers = { min: 0.1, max: 0.4, pairs: 66 };
    const r = await checkIdentity(pair(), hers);
    expect(r.detail!.band).toBe("above");
    expect(r.status).toBe("flag");
    expect(r.detail!.bandRange).toEqual(hers);
    expect(r.summary).toMatch(/0\.1–0\.4, n=66/);
    // The same distance against the global const is within.
    const g = await checkIdentity(pair());
    expect(g.detail!.band).toBe("within");
    expect(g.detail!.bandRange).toEqual({
      min: SAME_PERSON_BAND.min,
      max: SAME_PERSON_BAND.max,
      pairs: SAME_PERSON_BAND.pairs,
    });
  });

  it("position() is pure over the band it is given", () => {
    expect(position(0.3, { min: 0.1, max: 0.2, pairs: 1 })).toBe("above");
    expect(position(0.3)).toBe("within");
  });
});

describe("a missing face is `unknown`, never a pass", () => {
  it("reports unknown when the output has no face", async () => {
    mockFace.mockResolvedValueOnce(foundFace()).mockResolvedValueOnce(noFace());
    const r = await checkIdentity(pair());
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("pass");
    expect(r.detail).toBeNull();
    expect(r.summary).toMatch(/the output/);
  });

  it("reports unknown when the source has no face", async () => {
    mockFace.mockResolvedValueOnce(noFace()).mockResolvedValueOnce(foundFace());
    const r = await checkIdentity(pair());
    expect(r.status).toBe("unknown");
    expect(r.summary).toMatch(/the source/);
  });

  it("says `neither image` when both are missing", async () => {
    mockFace.mockResolvedValue(noFace("nothing found"));
    const r = await checkIdentity(pair());
    expect(r.status).toBe("unknown");
    expect(r.summary).toMatch(/neither image/);
    expect(r.error).toBe("nothing found");
  });

  it("reports unknown when a face is found but the embedding fails", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockEmbed.mockResolvedValue(null);
    const r = await checkIdentity(pair());
    expect(r.status).toBe("unknown");
    expect(r.error).toBe("embedding unavailable");
  });

  it("never calls the embedding API when a face is missing", async () => {
    mockFace.mockResolvedValue(noFace());
    await checkIdentity(pair());
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});

describe("what goes on the record", () => {
  it("records the chain root and depth it was given, not the output's parent", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(0.2);
    const p = { ...pair(), sourceAssetId: "ROOT", chainDepth: 4 };
    const r = await checkIdentity(p);
    expect(r.detail!.comparedSourceAssetId).toBe("ROOT");
    expect(r.detail!.chainDepth).toBe(4);
  });

  it("copies the band onto the record so a stored verdict reads without this file", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(0.2);
    const r = await checkIdentity(pair());
    expect(r.detail!.bandRange).toEqual({
      min: SAME_PERSON_BAND.min,
      max: SAME_PERSON_BAND.max,
      pairs: SAME_PERSON_BAND.pairs,
    });
    expect(r.detail!.method).toBe("face-crop/multimodalembedding@001");
  });

  it("says so out loud when a face is too small to measure well", async () => {
    mockFace.mockResolvedValue(foundFace({ small: true, sizeFrac: 0.03 }));
    mockDist.mockReturnValue(0.2);
    const r = await checkIdentity(pair());
    expect(r.summary).toMatch(/small/i);
    expect(r.detail!.outputFace.small).toBe(true);
  });

  it("counts both vision calls and both embeddings in the spend", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(0.2);
    const r = await checkIdentity(pair());
    expect(r.spend.visionCalls).toBe(2);
    expect(r.spend.embedCalls).toBe(2);
    expect(r.spend.inputTokens).toBe(1000);
    expect(r.spend.usd).toBeGreaterThan(0);
    expect(r.spend.basis).toBe("estimated");
  });
});

describe("no path asserts a failure", () => {
  it("never returns `fail`, at any distance", async () => {
    mockFace.mockResolvedValue(foundFace());
    for (const d of [0, 0.1, 0.5, 0.9, 1.5]) {
      mockDist.mockReturnValue(d);
      expect((await checkIdentity(pair())).status).not.toBe("fail");
    }
  });

  it("says plainly that nothing is gated, even when it flags", async () => {
    mockFace.mockResolvedValue(foundFace());
    mockDist.mockReturnValue(SAME_PERSON_BAND.max + 0.2);
    const r = await checkIdentity(pair());
    expect(r.status).toBe("flag");
    expect(r.summary).toMatch(/no threshold is asserted/i);
  });
});

describe("observeGenerateIdentity — a GENERATE's face, scored and never judged (R0.b)", () => {
  // Each image's "embedding" is the number written in its bytes, so every distance is checkable by hand.
  const img = (n: number | "noface") => Buffer.from(String(n));
  const target = (
    assetId: string,
    comparedAgainst: ComparedAgainst,
    bytes: Buffer | null,
  ) => ({
    assetId,
    gcsPath: `synthetic/${assetId}.jpg`,
    comparedAgainst,
    bytes,
    mimeType: "image/jpeg",
  });
  const render = (n: number | "noface" = 0.5) => ({
    bytes: img(n),
    mimeType: "image/png",
  });

  beforeEach(() => {
    mockFace.mockImplementation(async (bytes: Buffer) =>
      bytes.toString() === "noface"
        ? noFace()
        : { ...foundFace(), crop: { ...foundFace().crop, bytes } },
    );
    mockEmbed.mockImplementation(async (bytes: Buffer) => [
      Number(bytes.toString()),
    ]);
    mockDist.mockImplementation((a: number[], b: number[]) =>
      Math.abs(a[0] - b[0]),
    );
  });

  it("scores the render against every reference and every held-out photo, and means each group", async () => {
    const o = await observeGenerateIdentity(render(0.5), [
      target("ref-1", "references", img(0.8)),
      target("ref-2", "references", img(0.6)),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(
      o.comparisons.map((c) => [c.assetId, c.comparedAgainst, c.distance]),
    ).toEqual([
      ["ref-1", "references", 0.3],
      ["ref-2", "references", 0.1],
      ["held-1", "identity-set", 0.4],
    ]);
    expect(o.referencesMean).toBe(0.2);
    expect(o.identitySetMean).toBe(0.4);
  });

  it("carries the dead-ruler caveat ON the record, and no status anything could summarize", async () => {
    const o = await observeGenerateIdentity(render(), [
      target("ref-1", "references", img(0.8)),
    ]);
    expect(o.caveat).toMatch(/failed its stranger control/);
    expect(o.caveat).toMatch(/never a verdict/i);
    expect(o.method).toBe("face-crop/multimodalembedding@001");
    expect(o).not.toHaveProperty("status");
  });

  it("a render with no face: every distance is null, and no embedding is paid for", async () => {
    const o = await observeGenerateIdentity(render("noface"), [
      target("ref-1", "references", img(0.8)),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(o.outputFace).toBeNull();
    expect(o.comparisons.map((c) => c.distance)).toEqual([null, null]);
    expect([o.referencesMean, o.identitySetMean]).toEqual([null, null]);
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(o.spend.embedCalls).toBe(0);
  });

  it("a photo that could not be fetched, or shows no face, is recorded as attempted and left out of the mean", async () => {
    const o = await observeGenerateIdentity(render(0.5), [
      target("unfetched", "references", null),
      target("faceless", "references", img("noface")),
      target("ref-3", "references", img(0.7)),
    ]);
    expect(o.comparisons).toEqual([
      expect.objectContaining({
        assetId: "unfetched",
        distance: null,
        face: null,
      }),
      expect.objectContaining({
        assetId: "faceless",
        distance: null,
        face: null,
      }),
      expect.objectContaining({ assetId: "ref-3", distance: 0.2 }),
    ]);
    expect(o.referencesMean).toBe(0.2);
    expect(o.identitySetMean).toBeNull();
    // Nothing to look at is not a face box to pay for.
    expect(mockFace).toHaveBeenCalledTimes(3);
  });

  it("counts every face box and every embedding it made", async () => {
    const o = await observeGenerateIdentity(render(), [
      target("ref-1", "references", img(0.8)),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(o.spend.visionCalls).toBe(3);
    expect(o.spend.embedCalls).toBe(3);
    expect(o.spend.usd).toBeGreaterThan(0);
    expect(o.spend.basis).toBe("estimated");
  });
});

describe("the observation says WHY a comparison has no distance, and names the photo (R0.b's follow-up)", () => {
  // On Adi's R0.b acceptance one reference came back `distance: null` beside two that scored, and nothing on
  // the record could say which of four things happened. Each image's bytes name what the mocks do with it:
  // a number is a face whose "embedding" is that number; the words are the misses.
  const img = (s: number | string) => Buffer.from(String(s));
  const target = (
    assetId: string,
    comparedAgainst: ComparedAgainst,
    bytes: Buffer | null,
  ) => ({
    assetId,
    gcsPath: `synthetic/${assetId}.jpg`,
    comparedAgainst,
    bytes,
    mimeType: "image/jpeg",
  });
  const render = (s: number | string = 0.5, assetId?: string) => ({
    bytes: img(s),
    mimeType: "image/png",
    ...(assetId ? { assetId } : {}),
  });

  beforeEach(() => {
    mockFace.mockImplementation(async (bytes: Buffer) => {
      switch (bytes.toString()) {
        case "noface":
          return noFace();
        case "visionerr":
          return noFace("qa vision call failed");
        case "badbox":
          return noFace("unusable box", "unusable_box");
        default:
          return { ...foundFace(), crop: { ...foundFace().crop, bytes } };
      }
    });
    mockEmbed.mockImplementation(async (bytes: Buffer) =>
      bytes.toString() === "embedfail" ? null : [Number(bytes.toString())],
    );
    mockDist.mockImplementation((a: number[], b: number[]) =>
      Math.abs(a[0] - b[0]),
    );
  });

  it("names each photo's own miss — unfetched, no_face, vision_error, unusable_box — and scores the rest", async () => {
    const o = await observeGenerateIdentity(render(0.5), [
      target("gone", "references", null),
      target("faceless", "references", img("noface")),
      target("errored", "references", img("visionerr")),
      target("boxless", "identity-set", img("badbox")),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(o.comparisons.map((c) => [c.assetId, c.distance, c.reason])).toEqual(
      [
        ["gone", null, "unfetched"],
        ["faceless", null, "no_face"],
        ["errored", null, "vision_error"],
        ["boxless", null, "unusable_box"],
        ["held-1", 0.4, null],
      ],
    );
    expect(o.outputReason).toBeNull();
  });

  it("one photograph's embedding failing: that comparison alone is embed_failed, the others still score, and its mean and count leave it out", async () => {
    const o = await observeGenerateIdentity(render(0.5), [
      target("ref-1", "references", img(0.8)),
      target("ref-2", "references", img("embedfail")),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(o.comparisons.map((c) => [c.assetId, c.distance, c.reason])).toEqual(
      [
        ["ref-1", 0.3, null],
        ["ref-2", null, "embed_failed"],
        ["held-1", 0.4, null],
      ],
    );
    // Its face WAS found — the record says the failure came after the crop, not before it.
    expect(o.comparisons[1].face).not.toBeNull();
    expect([o.referencesMean, o.referencesCount]).toEqual([0.3, 1]);
    expect([o.identitySetMean, o.identitySetCount]).toEqual([0.4, 1]);
    expect(o.outputReason).toBeNull();
  });

  it("the render's own miss is outputReason, and every comparison it cost carries it", async () => {
    for (const [bytes, miss] of [
      ["noface", "no_face"],
      ["visionerr", "vision_error"],
      ["badbox", "unusable_box"],
    ] as const) {
      const o = await observeGenerateIdentity(render(bytes), [
        target("ref-1", "references", img(0.8)),
        target("gone", "identity-set", null),
      ]);
      expect({
        bytes,
        outputReason: o.outputReason,
        outputFace: o.outputFace,
      }).toEqual({
        bytes,
        outputReason: miss,
        outputFace: null,
      });
      // The photo that was fine carries the render's miss; the one never fetched keeps its own.
      expect(o.comparisons.map((c) => c.reason)).toEqual([miss, "unfetched"]);
    }
  });

  it("the render's embedding failing: outputReason embed_failed, and every comparison with it", async () => {
    const o = await observeGenerateIdentity(render("embedfail"), [
      target("ref-1", "references", img(0.8)),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(o.outputFace).not.toBeNull();
    expect(o.outputReason).toBe("embed_failed");
    expect(o.comparisons.map((c) => [c.distance, c.reason])).toEqual([
      [null, "embed_failed"],
      [null, "embed_failed"],
    ]);
    expect([o.referencesCount, o.identitySetCount]).toEqual([0, 0]);
  });

  it("counts beside each mean — how many distances each mean is over", async () => {
    const o = await observeGenerateIdentity(render(0.5), [
      target("ref-1", "references", img(0.8)),
      target("ref-2", "references", img(0.6)),
      target("gone", "references", null),
      target("held-1", "identity-set", img(0.1)),
      target("faceless", "identity-set", img("noface")),
    ]);
    expect(o.referencesMean).toBe(0.2);
    expect(o.referencesCount).toBe(2);
    expect(o.identitySetMean).toBe(0.4);
    expect(o.identitySetCount).toBe(1);
    // Three references were attempted and two scored: the record holds both numbers.
    expect(
      o.comparisons.filter((c) => c.comparedAgainst === "references"),
    ).toHaveLength(3);
  });

  it("hands every face box and every embedding the photo's id, so their log lines name the photo", async () => {
    await observeGenerateIdentity(render(0.5, "render-1"), [
      target("ref-1", "references", img(0.8)),
      target("held-1", "identity-set", img(0.1)),
    ]);
    expect(mockFace.mock.calls.map(([, , label, id]) => [label, id])).toEqual([
      ["generate", "render-1"],
      ["references", "ref-1"],
      ["identity-set", "held-1"],
    ]);
    expect(mockEmbed.mock.calls.map(([, id]) => id)).toEqual([
      "render-1",
      "ref-1",
      "held-1",
    ]);
  });
});
