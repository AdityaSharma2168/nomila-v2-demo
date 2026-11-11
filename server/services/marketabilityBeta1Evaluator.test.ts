/**
 * marketabilityBeta1Evaluator.test.ts — what the evaluator client must never get wrong.
 *
 * The provider call itself is not tested here (it is a network call under a frozen condition; the 37-athlete cohort
 * is its evidence). What IS tested is everything between the response and the scorer, because that is where a bad
 * answer becomes a plausible-looking score:
 *
 *   1. A signal the evaluator did not answer is MISSING, never absent. An absent key would renormalize its dimension
 *      silently — the exact failure the structurally-private policy had to be made explicit to avoid.
 *   2. An unusable response REFUSES rather than degrades. A composite built from nothing looks like an assessment.
 *   3. Validation failures are a different class from transport failures, because one is worth retrying and the other
 *      costs ~$0.21 to learn the same thing again.
 */
import {
  EvaluatorParseError,
  EvaluatorRefusedError,
  EvaluatorValidationError,
  extractJson,
  judgementsDigest,
  normalizeJudgements,
  parseEvaluatorResponse,
} from "./marketabilityBeta1Evaluator";

const SUB_WEIGHTS = {
  social_presence: { follower_scale: 0.4, engagement_quality: 0.6 },
  athletic_performance: { competitive_level: 1.0 },
};

const scored = (score: number, confidence = "HIGH") => ({ status: "scored", score, confidence, evidence_ids: ["e1"], rationale: "because" });
const body = (overrides: any = {}) => ({
  athlete: { identity_confidence: "HIGH" },
  dimensions: {
    social_presence: { follower_scale: scored(72), engagement_quality: scored(55, "MEDIUM") },
    athletic_performance: { competitive_level: scored(80) },
  },
  marketability_summary: "Three words here",
  ...overrides,
});

describe("extracting the response", () => {
  it("reads a fenced JSON block", () => {
    expect(extractJson('prose\n```json\n{"a":1}\n```\nmore').json).toEqual({ a: 1 });
  });

  it("reads a bare object when the model did not fence it", () => {
    expect(extractJson('Here it is: {"a":1} — done').json).toEqual({ a: 1 });
  });

  it("reports rather than throws when there is no JSON at all", () => {
    const { json, error } = extractJson("I could not complete this task.");
    expect(json).toBeNull();
    expect(error).toBe("no JSON object found");
  });

  it("distinguishes malformed JSON from missing JSON", () => {
    expect(extractJson('{"a": }').error).toBe("JSON did not parse");
  });
});

describe("a signal the evaluator did not answer is missing, not absent", () => {
  it("returns exactly the signal set the active params define", () => {
    const out = normalizeJudgements(body(), SUB_WEIGHTS);
    expect(out.judgements.map((j) => `${j.dimension}.${j.key}`)).toEqual([
      "social_presence.follower_scale",
      "social_presence.engagement_quality",
      "athletic_performance.competitive_level",
    ]);
  });

  it("fills in an omitted signal as missing and flags that nothing came back for it", () => {
    const json = body();
    delete (json.dimensions as any).athletic_performance;
    const j = normalizeJudgements(json, SUB_WEIGHTS).judgements.find((x) => x.key === "competitive_level")!;
    expect(j).toMatchObject({ status: "missing", score: null, confidence: null, present: false });
  });

  it("treats a node the evaluator itself marked missing as missing, carrying no score", () => {
    const json = body();
    (json.dimensions as any).social_presence.follower_scale = { status: "missing", score: 40, rationale: "no reliable data" };
    const j = normalizeJudgements(json, SUB_WEIGHTS).judgements.find((x) => x.key === "follower_scale")!;
    // present: the evaluator DID answer. status: it answered "I cannot score this". A score alongside that answer is
    // discarded rather than used — believing it would reward exactly the guessing the rubric forbids.
    expect(j).toMatchObject({ status: "missing", score: null, present: true });
  });

  it("clamps an out-of-range score instead of trusting or discarding it", () => {
    const json = body();
    (json.dimensions as any).social_presence.follower_scale = scored(140);
    expect(normalizeJudgements(json, SUB_WEIGHTS).judgements[0].score).toBe(100);
  });

  it("drops a confidence value that is not one of the three levels", () => {
    const json = body();
    (json.dimensions as any).social_presence.follower_scale = scored(70, "VERY HIGH");
    expect(normalizeJudgements(json, SUB_WEIGHTS).judgements[0].confidence).toBeNull();
  });
});

describe("an unusable response refuses rather than degrades", () => {
  it("parses a good response into judgements", () => {
    const out = parseEvaluatorResponse(JSON.stringify(body()), SUB_WEIGHTS);
    expect(out.judgements.filter((j) => j.status === "scored")).toHaveLength(3);
    expect(out.identityConfidence).toBe("HIGH");
  });

  it("refuses a response with no JSON", () => {
    expect(() => parseEvaluatorResponse("sorry", SUB_WEIGHTS)).toThrow(/no JSON object found/);
  });

  it("refuses a response where not one signal came back scored", () => {
    // Structurally valid, semantically empty. Scoring it would renormalize a composite out of pure missingness and
    // produce a number that looks exactly like an assessment.
    const empty = { dimensions: { social_presence: { follower_scale: { status: "missing" } } } };
    expect(() => parseEvaluatorResponse(JSON.stringify(empty), SUB_WEIGHTS)).toThrow(/no signal came back scored/);
  });

  it("classifies malformed JSON as RETRYABLE — a formatting accident, not a verdict", () => {
    // The case that cost a real athlete an assessment: a complete 26KB response (finishReason STOP, not truncated,
    // properly closed fence) containing `"rationale": His narrat…` — one missing opening quote. The evaluator is
    // stochastic, so the next sample is very likely well-formed. Retrying is cheap; losing the assessment is not.
    try {
      parseEvaluatorResponse('{"dimensions": {"social_presence": {"follower_scale": {"status": "scored", "score": 70, "rationale": Unquoted}}}}', SUB_WEIGHTS);
      throw new Error("expected a parse failure");
    } catch (e) {
      expect(e).toBeInstanceOf(EvaluatorParseError);
      expect((e as EvaluatorParseError).retryable).toBe(true);
    }
  });

  it("classifies ABSENT JSON as retryable too, accepting a bounded wasted retry", () => {
    // Prose with no JSON could be a formatting failure or a genuine refusal, and we cannot tell them apart from
    // here. The asymmetry decides it: a wasted retry costs ~$0.21 and is capped, while misclassifying a recoverable
    // failure as permanent loses the assessment entirely.
    try {
      parseEvaluatorResponse("I was unable to complete this assessment.", SUB_WEIGHTS);
      throw new Error("expected a parse failure");
    } catch (e) {
      expect(e).toBeInstanceOf(EvaluatorParseError);
      expect((e as EvaluatorParseError).retryable).toBe(true);
    }
  });

  it("classifies a parsed-but-empty response as NOT retryable — the evaluator declined", () => {
    // It read the question and scored nothing. Asking again buys the same refusal at full price.
    const empty = { dimensions: { social_presence: { follower_scale: { status: "missing" } } } };
    try {
      parseEvaluatorResponse(JSON.stringify(empty), SUB_WEIGHTS);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(EvaluatorRefusedError);
      expect((e as EvaluatorRefusedError).retryable).toBe(false);
    }
  });

  it("both remain EvaluatorValidationError, so callers that do not care still work", () => {
    // The base is abstract — the two subclasses are the only things ever thrown — so this is an instanceof check
    // rather than a toThrow(Class) one. It exists so a caller that only needs "unusable response" keeps working.
    for (const bad of ["sorry", JSON.stringify({ dimensions: { social_presence: { follower_scale: { status: "missing" } } } })]) {
      try { parseEvaluatorResponse(bad, SUB_WEIGHTS); throw new Error("expected a throw"); }
      catch (e) { expect(e).toBeInstanceOf(EvaluatorValidationError); }
    }
  });
});

describe("the judgement digest identifies the judgements, not their order", () => {
  it("is stable across key ordering", () => {
    const a = normalizeJudgements(body(), SUB_WEIGHTS).judgements;
    const b = [...a].reverse();
    expect(judgementsDigest(a)).toBe(judgementsDigest(b));
  });

  it("changes when a score changes", () => {
    const a = normalizeJudgements(body(), SUB_WEIGHTS).judgements;
    const moved = body();
    (moved.dimensions as any).social_presence.follower_scale = scored(73);
    expect(judgementsDigest(normalizeJudgements(moved, SUB_WEIGHTS).judgements)).not.toBe(judgementsDigest(a));
  });

  it("changes when a signal flips to missing, even though the others are untouched", () => {
    const a = normalizeJudgements(body(), SUB_WEIGHTS).judgements;
    const gone = body();
    delete (gone.dimensions as any).social_presence.engagement_quality;
    expect(judgementsDigest(normalizeJudgements(gone, SUB_WEIGHTS).judgements)).not.toBe(judgementsDigest(a));
  });
});
