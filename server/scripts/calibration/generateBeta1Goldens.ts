/**
 * generateBeta1Goldens.ts — regenerates the Beta.1 freeze bundle from the frozen 37-athlete evaluator artifacts.
 *
 * This locks the DETERMINISTIC calculation, not the evaluator's stochastic research. The chain it freezes is:
 *
 *   frozen parsed.json (44 judgements) → computeMarketabilityBeta1 with the frozen params at a pinned asOf → exact outputs
 *
 * The bundle records what is frozen so one file answers "what exactly?": methodology version, params version, evaluator
 * spec version, the canonical evaluator prompt digest, the pinned asOf, and per athlete the SHA-256 of the input artifact
 * alongside the expected MIA, composite, confidence and eight dimension scores.
 *
 * Run this ONLY when a methodology version bump is deliberate. A red freeze test is not a reason to regenerate — it is the
 * guard working. See marketabilityBeta1Freeze.test.ts.
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/generateBeta1Goldens.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMarketabilityBeta1, MARKETABILITY_BETA1_VERSION, type MarketabilityBeta1Input } from "../../services/marketabilityBeta1";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../services/marketabilityBeta1FrozenParams";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1 } from "../../services/marketabilityBeta1Lookups";
import { createBeta1Normalizer } from "../../services/marketabilityBeta1Normalization";
import { BLIND_EVAL_SPEC_V02_VERSION, BLIND_EVAL_SPEC_V02_CANONICAL_SHA256 } from "../../services/marketabilityBeta1EvaluatorSpec";
import type { NormalizedSignal } from "../../services/intelligence/types";
import type { ParsedArtifact } from "./blindEval/runBlindEval";
import { BETA1_FREEZE_AS_OF, BETA1_GOLDENS_PATH, buildBeta1Dimensions } from "../../services/marketabilityBeta1Freeze";

const COHORT_PATH = join(__dirname, "cohort.dev37.json");
const ARTIFACT_DIR = join(__dirname, "runs", "blind-eval-v2", "gemini");
const cohort = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as { version: string; athletes: Array<{ key: string; fullName: string; sport: string }> };
const normalizer = createBeta1Normalizer({ cohorts: BETA1_COHORTS_V0, priors: BETA1_PRIORS_V1, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, freshnessDays: { connected_verified: 2, platform_public: 7, web_researched: 30, inferred: 30, imputed: 3650 } });

const athletes = cohort.athletes.map((a) => {
  const file = join(ARTIFACT_DIR, `${a.key}.dev37.parsed.json`);
  // Hash the CONTENT, not the file bytes. These artifacts check out CRLF on Windows and LF on Linux CI, so a byte
  // digest differs by platform while the judgement set is identical. Normalising line endings makes the digest answer
  // the question we care about — did the evidence change?
  const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const parsed = JSON.parse(raw) as ParsedArtifact;
  const sport = a.sport.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  const dimensions = buildBeta1Dimensions(parsed, sport, (path, scope) => normalizer.prior(path as never, scope as never) as NormalizedSignal, MARKETABILITY_BETA1_FROZEN_PARAMS.config.subWeights as Record<string, Record<string, number>>) as MarketabilityBeta1Input["dimensions"];
  const result = computeMarketabilityBeta1({ asOf: BETA1_FREEZE_AS_OF, dimensions }, MARKETABILITY_BETA1_FROZEN_PARAMS);
  return {
    key: a.key,
    name: a.fullName,
    sport,
    artifactSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    mia: result.score,
    composite: result.composite,
    confidence: result.confidence,
    dimensions: Object.fromEntries(result.dimensions.map((d) => [d.dimension, d.score])),
  };
});

const bundle = {
  note: "Beta.1 freeze bundle. Regenerate ONLY on a deliberate methodology version bump — see generateBeta1Goldens.ts.",
  methodologyVersion: MARKETABILITY_BETA1_VERSION,
  paramsVersion: MARKETABILITY_BETA1_FROZEN_PARAMS.version,
  paramsSchemaVersion: MARKETABILITY_BETA1_FROZEN_PARAMS.schemaVersion,
  structurallyPrivate: MARKETABILITY_BETA1_FROZEN_PARAMS.config.structurallyPrivate ?? [],
  evaluatorSpecVersion: BLIND_EVAL_SPEC_V02_VERSION,
  canonicalEvaluatorSha256: BLIND_EVAL_SPEC_V02_CANONICAL_SHA256,
  asOf: BETA1_FREEZE_AS_OF,
  cohort: cohort.version,
  evaluatorRun: "gemini-3.5-flash via Vertex; Google Search grounding; default thinking; one call per athlete; name + sport only",
  athletes,
};

writeFileSync(BETA1_GOLDENS_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote ${athletes.length} goldens → ${BETA1_GOLDENS_PATH}`);
console.log(`methodology ${bundle.methodologyVersion} · params ${bundle.paramsVersion} · spec ${bundle.evaluatorSpecVersion} · asOf ${bundle.asOf}`);
