/**
 * qa/anatomy — the count, and the one case it exists for.
 *
 * 1.5a and 1.5b are the matched pair: same source, byte-identical mask, opposite outcomes. An
 * anatomy check that cannot separate those two is measuring nothing, because nothing geometric can.
 */
import { checkAnatomy } from "./anatomy";
import type { ComparisonPair } from "./types";

jest.mock("./vision", () => {
  const actual = jest.requireActual("./vision");
  return {
    ...actual,
    askVision: jest.fn(),
    probeScale: jest.fn(async (b: Buffer) => ({
      bytes: b,
      width: 100,
      height: 100,
    })),
  };
});

import { askVision } from "./vision";
const mockAsk = askVision as jest.MockedFunction<typeof askVision>;

const pair = (): ComparisonPair => ({
  sourceAssetId: "src",
  sourceBytes: Buffer.from("s"),
  sourceMimeType: "image/png",
  outputAssetId: "out",
  outputBytes: Buffer.from("o"),
  outputMimeType: "image/png",
  chainDepth: 1,
  instruction: "make the jacket pink",
});

const answer = (v: Record<string, unknown>) =>
  ({
    value: v,
    error: null,
    latencyMs: 5,
    usage: { inputTokens: 700, outputTokens: 90 },
  }) as never;

beforeEach(() => jest.clearAllMocks());

describe("1.5a vs 1.5b — the matched pair", () => {
  it("fails the third hand", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 3,
        arms: 2,
        legs: 2,
        plausible: false,
        confidence: 0.9,
        anomalies: ["a third hand near the waist"],
      }),
    );
    const r = await checkAnatomy(pair());
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/3 hands/);
  });

  it("passes the control, which differs only in what the model returned", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 2,
        arms: 2,
        legs: 2,
        plausible: true,
        confidence: 0.95,
        anomalies: [],
      }),
    );
    const r = await checkAnatomy(pair());
    expect(r.status).toBe("pass");
  });
});

describe("the count is trusted over the judgement", () => {
  it("fails three hands even when the model says it is plausible", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 3,
        arms: 2,
        legs: 2,
        plausible: true,
        confidence: 0.8,
        anomalies: [],
      }),
    );
    const r = await checkAnatomy(pair());
    expect(r.status).toBe("fail");
  });

  it("fails on `plausible: false` even when the counts look ordinary", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 2,
        arms: 2,
        legs: 2,
        plausible: false,
        confidence: 0.7,
        anomalies: ["fingers fused on the left hand"],
      }),
    );
    const r = await checkAnatomy(pair());
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/fused/);
  });
});

describe("more than one person", () => {
  it("scales the hand allowance with the number of figures", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 2,
        hands: 4,
        arms: 4,
        legs: 4,
        plausible: true,
        confidence: 0.9,
        anomalies: [],
      }),
    );
    expect((await checkAnatomy(pair())).status).toBe("pass");
  });

  it("still fails five hands across two figures", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 2,
        hands: 5,
        arms: 4,
        legs: 4,
        plausible: true,
        confidence: 0.9,
        anomalies: [],
      }),
    );
    expect((await checkAnatomy(pair())).status).toBe("fail");
  });
});

describe("occlusion is not a defect", () => {
  it("passes one visible hand — the other is out of frame, not missing", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 1,
        arms: 2,
        legs: 2,
        plausible: true,
        confidence: 0.9,
        anomalies: [],
      }),
    );
    expect((await checkAnatomy(pair())).status).toBe("pass");
  });

  it("passes a frame with no visible hands at all", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 0,
        arms: 0,
        legs: 2,
        plausible: true,
        confidence: 0.85,
        anomalies: [],
      }),
    );
    expect((await checkAnatomy(pair())).status).toBe("pass");
  });
});

describe("failure is `unknown`", () => {
  it("does not report a pass when the answer did not parse", async () => {
    mockAsk.mockResolvedValue({
      value: null,
      error: "unparseable answer",
      latencyMs: 5,
      usage: null,
    } as never);
    const r = await checkAnatomy(pair());
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("pass");
  });

  it("sends only the output — anatomy does not depend on the source", async () => {
    mockAsk.mockResolvedValue(
      answer({
        people: 1,
        hands: 2,
        arms: 2,
        legs: 2,
        plausible: true,
        confidence: 0.9,
        anomalies: [],
      }),
    );
    await checkAnatomy(pair());
    expect(mockAsk.mock.calls[0][0].images).toHaveLength(1);
    expect(mockAsk.mock.calls[0][0].images[0].role).toBe("OUTPUT");
  });
});
