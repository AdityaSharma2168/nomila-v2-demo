/**
 * marketabilityBeta1Freeze.test.ts — the Beta.1 freeze gate.
 *
 * M.I.A. Beta.1 methodology is frozen. This test makes that enforceable rather than documented, and each guard fails in
 * its own vocabulary so a red run tells you WHICH layer moved:
 *
 *   1. RUBRIC   — the canonical evaluator text still hashes to its pinned digest
 *   2. POLICY   — the methodology/params versions and the structurally-private list still match the bundle
 *   3. EVIDENCE — every frozen evaluator artifact still hashes to the digest recorded in the bundle
 *   4. SCORING  — recomputing through the real engine reproduces the exact frozen outputs
 *
 * The order matters: rubric → policy → evidence → scoring, so the first failure names the cause rather than a symptom.
 *
 * A red run is the guard working. Do NOT regenerate the bundle or paste in a new digest to make it pass — that silently
 * redefines frozen methodology. Regenerate only when a version bump is deliberate:
 *   npx tsx --require dotenv/config server/scripts/calibration/generateBeta1Goldens.ts
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeMarketabilityBeta1, MARKETABILITY_BETA1_VERSION, type MarketabilityBeta1Input } from "./marketabilityBeta1";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "./marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1 } from "./marketabilityBeta1Lookups";
import { createBeta1Normalizer } from "./marketabilityBeta1Normalization";
import { BLIND_EVAL_SPEC_V02_VERSION, BLIND_EVAL_SPEC_V02_CANONICAL_SHA256, CANONICAL_EVALUATOR_TEXT } from "./marketabilityBeta1EvaluatorSpec";
import { BETA1_FREEZE_AS_OF, BETA1_GOLDENS_PATH, buildBeta1Dimensions, type EvaluatorJudgements, type Beta1PriorScope } from "./marketabilityBeta1Freeze";
import type { NormalizedSignal } from "./intelligence/types";

const ARTIFACT_DIR = join(__dirname, "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini");
const bundle = JSON.parse(readFileSync(BETA1_GOLDENS_PATH, "utf8")) as {
  methodologyVersion: string; paramsVersion: string; structurallyPrivate: string[];
  evaluatorSpecVersion: string; canonicalEvaluatorSha256: string; asOf: string;
  athletes: Array<{ key: string; name: string; sport: string; artifactSha256: string; mia: number; composite: number; confidence: number; dimensions: Record<string, number> }>;
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b as never).digest("hex");

describe("Beta.1 freeze — rubric", () => {
  it("the canonical evaluator text still hashes to its pinned digest", () => {
    expect(sha256(Buffer.from(CANONICAL_EVALUATOR_TEXT, "utf8"))).toBe(BLIND_EVAL_SPEC_V02_CANONICAL_SHA256);
  });

  it("the evaluator spec version and digest match the freeze bundle", () => {
    expect(BLIND_EVAL_SPEC_V02_VERSION).toBe(bundle.evaluatorSpecVersion);
    expect(BLIND_EVAL_SPEC_V02_CANONICAL_SHA256).toBe(bundle.canonicalEvaluatorSha256);
  });
});

describe("Beta.1 freeze — policy", () => {
  it("methodology and params versions match the bundle", () => {
    expect(MARKETABILITY_BETA1_VERSION).toBe(bundle.methodologyVersion);
    expect(MARKETABILITY_BETA1_FROZEN_PARAMS.version).toBe(bundle.paramsVersion);
  });

  it("the structurally-private list is exactly the three private Engagement Quality sub-signals", () => {
    expect([...(MARKETABILITY_BETA1_FROZEN_PARAMS.config.structurallyPrivate ?? [])].sort()).toEqual([...bundle.structurallyPrivate].sort());
    expect([...bundle.structurallyPrivate].sort()).toEqual([
      "engagement_quality.shares_saves_quality",
      "engagement_quality.story_efficiency",
      "engagement_quality.video_retention",
    ]);
  });

  it("the frozen weights and mapping are unchanged", () => {
    const c = MARKETABILITY_BETA1_FROZEN_PARAMS.config;
    expect(Object.values(c.dimensionWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    for (const [dimension, sub] of Object.entries(c.subWeights)) {
      expect({ dimension, sum: Object.values(sub).reduce((a, b) => a + b, 0) }).toEqual({ dimension, sum: expect.closeTo(1, 10) });
    }
    expect(Object.values(c.subWeights).reduce((n, s) => n + Object.keys(s).length, 0)).toBe(44);
    expect(c.mapping).toEqual({ kind: "power", max: 850, exponent: 0.8, alpha: true });
  });
});

describe("Beta.1 freeze — evidence and scoring", () => {
  const normalizer = createBeta1Normalizer({ cohorts: BETA1_COHORTS_V0, priors: BETA1_PRIORS_V1, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, freshnessDays: { connected_verified: 2, platform_public: 7, web_researched: 30, inferred: 30, imputed: 3650 } });
  const prior = (path: string, scope: Beta1PriorScope) => normalizer.prior(path as never, scope as never) as NormalizedSignal;

  it("the bundle covers all 37 development-cohort athletes", () => {
    expect(bundle.athletes).toHaveLength(37);
    expect(bundle.asOf).toBe(BETA1_FREEZE_AS_OF);
  });

  it.each(bundle.athletes.map((a) => [a.name, a] as const))(
    "%s — artifact digest unchanged and the engine reproduces the frozen output exactly",
    (_name, golden) => {
      const file = join(ARTIFACT_DIR, `${golden.key}.dev37.parsed.json`);
      expect(existsSync(file)).toBe(true);
      // Line endings normalised before hashing: CRLF on a Windows checkout, LF on Linux CI. A raw byte digest would
      // fail in CI on identical evidence. The digest asks "did the judgement set change", not "did the checkout differ".
      const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");

      // EVIDENCE: a changed artifact is input drift, a different conversation from a scorer regression.
      expect(sha256(raw)).toBe(golden.artifactSha256);

      // SCORING: the real production engine, the frozen params, the pinned asOf.
      const judgements = JSON.parse(raw) as EvaluatorJudgements;
      const dimensions = buildBeta1Dimensions(judgements, golden.sport, prior, MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>) as MarketabilityBeta1Input["dimensions"];
      const result = computeMarketabilityBeta1({ asOf: BETA1_FREEZE_AS_OF, dimensions }, MARKETABILITY_BETA1_FROZEN_PARAMS);

      expect(result.score).toBe(golden.mia);
      expect(result.composite).toBe(golden.composite);
      expect(result.confidence).toBe(golden.confidence);
      expect(Object.fromEntries(result.dimensions.map((d) => [d.dimension, d.score]))).toEqual(golden.dimensions);
    },
  );
});

describe("the source label (A2)", () => {
  const judgements: EvaluatorJudgements = { signals: [
    { dimension: "d", key: "a", status: "scored", score: 60, confidence: "HIGH", evidenceIds: ["n1"] },
    { dimension: "d", key: "b", status: "scored", score: 40, confidence: "LOW", evidenceIds: [] },
  ] };
  const noPrior = () => { throw new Error("no prior expected"); };
  it("defaults to web_researched — the label every frozen output was produced under", () => {
    const out = buildBeta1Dimensions(judgements, "x", noPrior, { d: { a: 1, b: 1 } });
    expect([out.d.a.source, out.d.b.source]).toEqual(["web_researched", "web_researched"]);
  });
  it("takes the label sourceOf derives from each judgement; nothing else moves", () => {
    const out = buildBeta1Dimensions(judgements, "x", noPrior, { d: { a: 1, b: 1 } }, BETA1_FREEZE_AS_OF, (j) => (j.evidenceIds.length ? "connected_verified" : "inferred"));
    expect(out.d.a).toMatchObject({ source: "connected_verified", value: 60, confidence: 0.9, evidenceIds: ["n1"] });
    expect(out.d.b).toMatchObject({ source: "inferred", value: 40, confidence: 0.3 });
  });
});
