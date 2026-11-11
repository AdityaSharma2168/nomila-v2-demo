/**
 * qa/verdict — the aggregation rule, which is where "unknown is not a pass" is actually enforced.
 */
import {
  combine,
  QA_SCHEMA_VERSION,
  runCreativeQa,
  runGenerateQa,
  summarize,
  withClipDetail,
  withFramingObservation,
  withIdentityObservation,
} from "./verdict";
import type { ClipDetail } from "./verdict";
import type { FramingObservation } from "./framing";
import type { ComparisonPair } from "./types";

jest.mock("./identity", () => ({ checkIdentity: jest.fn() }));
jest.mock("./marks", () => ({ checkMarks: jest.fn() }));
jest.mock("./anatomy", () => ({ checkAnatomy: jest.fn() }));
jest.mock("./adherence", () => ({ checkAdherence: jest.fn() }));
jest.mock("./text", () => ({ checkText: jest.fn() }));

import { checkIdentity } from "./identity";
import { checkMarks } from "./marks";
import { checkAnatomy } from "./anatomy";
import { checkAdherence } from "./adherence";
import { checkText } from "./text";

const spend = (usd: number) => ({
  usd,
  basis: "estimated" as const,
  visionCalls: 1,
  embedCalls: 0,
  inputTokens: 100,
  outputTokens: 10,
});

const result = (status: string, usd = 0.001) =>
  ({
    status,
    summary: `${status} summary`,
    detail: {},
    error: status === "unknown" ? "could not answer" : null,
    spend: spend(usd),
    latencyMs: 1000,
  }) as never;

const pair = (): ComparisonPair => ({
  sourceAssetId: "root",
  sourceBytes: Buffer.from("s"),
  sourceMimeType: "image/png",
  outputAssetId: "out",
  outputBytes: Buffer.from("o"),
  outputMimeType: "image/png",
  chainDepth: 3,
  instruction: "make the jersey red",
});

const setAll = (
  i: string,
  m: string,
  an: string,
  ad: string,
  /** The text check joined as a fifth gating check; every existing case keeps its meaning at pass. */
  t = "pass",
) => {
  (checkIdentity as jest.Mock).mockResolvedValue(result(i));
  (checkMarks as jest.Mock).mockResolvedValue(result(m));
  (checkAnatomy as jest.Mock).mockResolvedValue(result(an));
  (checkAdherence as jest.Mock).mockResolvedValue(result(ad));
  (checkText as jest.Mock).mockResolvedValue(result(t));
};

beforeEach(() => jest.clearAllMocks());

const statuses = (
  identity: string,
  marks: string,
  anatomy: string,
  adherence: string,
  text = "pass",
) => ({ identity, marks, anatomy, adherence, text }) as never;

describe("combine", () => {
  it("takes the worst of the GATING checks", () => {
    expect(combine(statuses("pass", "pass", "pass", "pass")).overall).toBe(
      "pass",
    );
    expect(combine(statuses("pass", "pass", "flag", "pass")).overall).toBe(
      "flag",
    );
    expect(combine(statuses("pass", "pass", "fail", "pass")).overall).toBe(
      "fail",
    );
    expect(combine(statuses("flag", "pass", "pass", "pass")).overall).toBe(
      "flag",
    );
  });

  it("does NOT let marks move the overall — it is advisory, by measurement", () => {
    // 16 false positives against 6 true negatives on the corpus. Recorded, never summarized.
    expect(combine(statuses("pass", "fail", "pass", "pass")).overall).toBe(
      "pass",
    );
    expect(combine(statuses("pass", "flag", "pass", "pass")).overall).toBe(
      "pass",
    );
  });

  it("still counts an advisory check's unknown", () => {
    expect(
      combine(statuses("pass", "unknown", "pass", "pass")).unknownChecks,
    ).toBe(1);
  });

  it("counts unknowns without letting them change the overall", () => {
    const allUnknown = combine(
      statuses("unknown", "unknown", "unknown", "unknown"),
    );
    expect(allUnknown.overall).toBe("pass");
    expect(allUnknown.unknownChecks).toBe(4);

    const mixed = combine(statuses("unknown", "pass", "fail", "unknown"));
    expect(mixed.overall).toBe("fail");
    expect(mixed.unknownChecks).toBe(2);
  });

  it("an unknown never masks a failure found by another gating check", () => {
    expect(
      combine(statuses("unknown", "unknown", "fail", "unknown")).overall,
    ).toBe("fail");
  });
});

describe("runCreativeQa", () => {
  it("reports pass with the unknown count alongside, never folded in", async () => {
    setAll("pass", "pass", "unknown", "pass");
    const v = await runCreativeQa(pair());
    expect(v.overall).toBe("pass");
    expect(v.unknownChecks).toBe(1);
    // The distinction the whole stage exists for: four looked, or three looked?
    expect(summarize(v)).toMatch(/PASS \(1 unknown\)/);
  });

  it("sums the spend across all five checks", async () => {
    setAll("pass", "pass", "pass", "pass");
    const v = await runCreativeQa(pair());
    expect(v.spend.usd).toBeCloseTo(0.005, 6);
    expect(v.spend.visionCalls).toBe(5);
  });

  it("runs the checks concurrently, not in sequence", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      jest.fn(async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        return result("pass");
      });
    (checkIdentity as jest.Mock).mockImplementation(slow("identity", 40));
    (checkMarks as jest.Mock).mockImplementation(slow("marks", 10));
    (checkAnatomy as jest.Mock).mockImplementation(slow("anatomy", 10));
    (checkAdherence as jest.Mock).mockImplementation(slow("adherence", 10));
    (checkText as jest.Mock).mockImplementation(slow("text", 10));

    await runCreativeQa(pair());
    // All five start before the slowest finishes — sequential execution cannot produce this.
    expect(order.slice(0, 5).every((s) => s.endsWith(":start"))).toBe(true);
  });

  it("carries the chain root and depth onto the record", async () => {
    setAll("pass", "pass", "pass", "pass");
    const v = await runCreativeQa(pair(), { chainTruncated: true });
    expect(v.comparison).toEqual({
      rootAssetId: "root",
      outputAssetId: "out",
      chainDepth: 3,
      chainTruncated: true,
    });
  });

  it("stamps a schema version so a stored verdict stays interpretable", async () => {
    setAll("pass", "pass", "pass", "pass");
    // 6 since video V9 added the CLIP subject. Pinned as a LITERAL rather than against the exported
    // constant on purpose: this assertion exists to make a shape change a deliberate act, and
    // comparing the constant to itself would pass through any bump at all.
    expect((await runCreativeQa(pair())).schemaVersion).toBe(6);
  });

  it("keeps each check's own summary and status on the record", async () => {
    setAll("pass", "fail", "unknown", "flag");
    const v = await runCreativeQa(pair());
    expect(v.checks.marks.status).toBe("fail");
    expect(v.checks.anatomy.error).toBe("could not answer");
    // adherence:flag drives the overall; marks:fail is recorded but advisory.
    expect(v.overall).toBe("flag");
    expect(summarize(v)).toContain("marks:fail");
    expect(summarize(v)).toContain("advisory");
  });
});

describe("marks is recorded in full while being excluded from the overall", () => {
  it("names itself as advisory on the record, with the reason", async () => {
    setAll("pass", "fail", "pass", "pass");
    const v = await runCreativeQa(pair());
    expect(v.overall).toBe("pass");
    expect(v.advisoryChecks).toEqual([
      {
        check: "marks",
        status: "fail",
        reason: expect.stringMatching(/false positives/),
      },
    ]);
    // Nothing is hidden: the full result is still there for anyone deciding about enforcement.
    expect(v.checks.marks.status).toBe("fail");
  });
});

describe("text is gating, unlike marks", () => {
  it("a name nobody asked for fails the whole verdict", async () => {
    setAll("pass", "pass", "pass", "pass", "fail");
    const v = await runCreativeQa(pair());
    expect(v.overall).toBe("fail");
    expect(v.advisoryChecks.map((a) => a.check)).not.toContain("text");
  });

  it("an edit is text-checked too — a full-frame edit can write on the kit", async () => {
    setAll("pass", "pass", "pass", "pass");
    await runCreativeQa(pair());
    expect(checkText).toHaveBeenCalledWith(
      expect.objectContaining({ outputAssetId: "out" }),
    );
  });
});

describe("runGenerateQa — the path QA never had", () => {
  const subject = () => ({
    outputAssetId: "gen",
    outputBytes: Buffer.from("o"),
    outputMimeType: "image/png",
    instruction: "a portrait of me on a pitch",
  });

  it("runs the two checks that need no source, and NOTHING else", async () => {
    setAll("pass", "pass", "pass", "pass");
    await runGenerateQa(subject());
    expect(checkText).toHaveBeenCalledTimes(1);
    expect(checkAnatomy).toHaveBeenCalledTimes(1);
    expect(checkIdentity).not.toHaveBeenCalled();
    expect(checkMarks).not.toHaveBeenCalled();
    expect(checkAdherence).not.toHaveBeenCalled();
  });

  it("records the three source-dependent checks as unknown, never as pass", async () => {
    setAll("pass", "pass", "pass", "pass");
    const v = await runGenerateQa(subject());
    expect(v.checks.identity.status).toBe("unknown");
    expect(v.checks.marks.status).toBe("unknown");
    expect(v.checks.adherence.status).toBe("unknown");
    expect(v.unknownChecks).toBe(3);
    // The sentence the whole module exists for: "did not look" is not "looked and found nothing".
    expect(v.checks.identity.summary).toMatch(/no source frame|not measured/i);
  });

  it("fails a generate that rendered someone else's name", async () => {
    setAll("pass", "pass", "pass", "pass", "fail");
    const v = await runGenerateQa(subject());
    expect(v.overall).toBe("fail");
  });

  it("marks the record as a generate, with no root and depth 0", async () => {
    setAll("pass", "pass", "pass", "pass");
    const v = await runGenerateQa(subject());
    expect(v.subject).toBe("generate");
    expect(v.comparison).toEqual({
      rootAssetId: null,
      outputAssetId: "gen",
      chainDepth: 0,
      chainTruncated: false,
    });
  });

  it("bills only what it ran", async () => {
    setAll("pass", "pass", "pass", "pass");
    const v = await runGenerateQa(subject());
    expect(v.spend.usd).toBeCloseTo(0.002, 6);
    expect(v.spend.visionCalls).toBe(2);
  });
});

describe("withIdentityObservation — R0.b's scores ride on the record and move no verdict", () => {
  const subject = () => ({
    outputAssetId: "gen",
    outputBytes: Buffer.from("o"),
    outputMimeType: "image/png",
    instruction: "a portrait of me",
  });
  const observation = (usd: number) =>
    ({
      method: "face-crop/multimodalembedding@001",
      caveat: "dead ruler",
      outputFace: { confidence: 0.9, sizeFrac: 0.2, small: false },
      comparisons: [],
      referencesMean: 0.9,
      identitySetMean: 0.9,
      spend: spend(usd),
      latencyMs: 10,
    }) as never;

  it.each([
    ["pass", "pass"],
    ["fail", "pass"],
    ["pass", "flag"],
  ])(
    "leaves overall, unknownChecks and every check exactly as they were (text %s, anatomy %s)",
    async (t, an) => {
      setAll("pass", "pass", an, "pass", t);
      const before = await runGenerateQa(subject());
      const after = withIdentityObservation(before, observation(0.005));

      expect(after.overall).toBe(before.overall);
      expect(after.unknownChecks).toBe(before.unknownChecks);
      expect(after.advisoryChecks).toEqual(before.advisoryChecks);
      expect(after.checks).toEqual(before.checks);
      // Identity stays unknown whatever the distances say — even ones a threshold would call a stranger.
      expect(after.checks.identity.status).toBe("unknown");
    },
  );

  it("puts the observation on the record, and its cost into the spend", async () => {
    setAll("pass", "pass", "pass", "pass");
    const before = await runGenerateQa(subject());
    const obs = observation(0.005);
    const after = withIdentityObservation(before, obs);
    expect(after.identityObservation).toBe(obs);
    expect(after.spend.usd).toBeCloseTo(before.spend.usd + 0.005, 6);
    expect(after.spend.visionCalls).toBe(before.spend.visionCalls + 1);
  });

  it("no observation: the verdict is returned untouched", async () => {
    setAll("pass", "pass", "pass", "pass");
    const before = await runGenerateQa(subject());
    expect(withIdentityObservation(before, null)).toBe(before);
    expect(before).not.toHaveProperty("identityObservation");
  });
});

describe("the framing observation hangs off the verdict and changes nothing in it", () => {
  const framing = (reframed: boolean | null): FramingObservation => ({
    placedAdds: ["water bottle"],
    fit: {
      scale: 0.8931,
      dxFrac: 0.0035,
      dyFrac: 0.0481,
      ncc: 0.702,
      nccAtIdentity: 0.31,
    },
    baseline: null,
    excess: null,
    reframed,
    reason: null,
    output: { width: 1792, height: 2400 },
    latencyMs: 5000,
  });

  it("leaves the verdict itself untouched — a reframe is not a failing check", async () => {
    setAll("pass", "pass", "pass", "pass");
    const before = await runCreativeQa(pair());
    const after = withFramingObservation(before, framing(true));
    expect(after.framingObservation).toEqual(framing(true));
    // ⚠️ THE POINT OF THE OBSERVATION: 1b's n is four cells on one frame, so nothing about a moved
    // frame may reach `overall`, the unknown count, the advisories or any check's status.
    expect(after.overall).toBe(before.overall);
    expect(after.unknownChecks).toBe(before.unknownChecks);
    expect(after.advisoryChecks).toEqual(before.advisoryChecks);
    expect(after.checks).toEqual(before.checks);
    // And it costs no money, so the spend is the same object it was.
    expect(after.spend).toEqual(before.spend);
  });

  it("no observation: the verdict is returned untouched", async () => {
    setAll("pass", "pass", "pass", "pass");
    const before = await runCreativeQa(pair());
    expect(withFramingObservation(before, null)).toBe(before);
    expect(before).not.toHaveProperty("framingObservation");
  });
});

describe("withClipDetail — a clip's frames ride on the record and move no verdict", () => {
  const subject = () => ({
    outputAssetId: "clip-frame-0",
    outputBytes: Buffer.from("o"),
    outputMimeType: "image/jpeg",
    instruction: "she looks into the camera",
  });

  const detail = (checked: number, total: number): ClipDetail => ({
    coverage: { checked, scanned: 24, total },
    motionless: false,
    frames: [],
  });

  it("leaves overall, unknownChecks, advisoryChecks and every check exactly as they were", async () => {
    setAll("pass", "pass", "fail", "pass", "pass");
    const before = await runGenerateQa(subject());
    const after = withClipDetail(before, detail(3, 145));

    expect(after.overall).toBe(before.overall);
    expect(after.unknownChecks).toBe(before.unknownChecks);
    expect(after.advisoryChecks).toEqual(before.advisoryChecks);
    expect(after.checks).toEqual(before.checks);
  });

  it("does NOT fold spend in, because the frame checks are what spend was summed from", async () => {
    // The one place this differs from withIdentityObservation, which DOES add its cost. An identity
    // observation is an extra pair of calls made beside the checks; a clip's per-frame checks ARE
    // the calls. Adding them again would report the stage at twice what it cost.
    setAll("pass", "pass", "pass", "pass", "pass");
    const before = await runGenerateQa(subject());
    const after = withClipDetail(before, detail(3, 145));
    expect(after.spend).toEqual(before.spend);
  });

  it("carries coverage, so a pass can never be read as 'every frame was clean'", async () => {
    setAll("pass", "pass", "pass", "pass", "pass");
    const before = await runGenerateQa(subject());
    const after = withClipDetail(before, detail(3, 145));
    expect(after.overall).toBe("pass");
    // The whole point of the field: the verdict passed, and it says out loud that it saw 3 of 145.
    expect(after.clip?.coverage).toEqual({
      checked: 3,
      scanned: 24,
      total: 145,
    });
    expect(after.clip!.coverage.checked).toBeLessThan(
      after.clip!.coverage.total,
    );
  });

  it("no detail: the verdict is returned untouched", async () => {
    setAll("pass", "pass", "pass", "pass", "pass");
    const before = await runGenerateQa(subject());
    expect(withClipDetail(before, null)).toBe(before);
    expect(before).not.toHaveProperty("clip");
  });

  it("the record says version 6, because a clip's shape did not exist before it", () => {
    // A stored version 5 record can never be a clip — the subject did not exist — so a reader that
    // meets `subject: "clip"` also knows it has `coverage` to read. The literal pin on
    // runCreativeQa above is the one that catches an accidental bump; this one records WHY 6.
    expect(QA_SCHEMA_VERSION).toBe(6);
  });
});
