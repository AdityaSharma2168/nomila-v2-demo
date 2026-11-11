/**
 * marketabilityBeta1Freeze.ts — the frozen boundary between an evaluator's 44 judgements and the deterministic engine.
 *
 * The M.I.A. evaluator returns a judgement per sub-signal: a 0–100 score with a confidence, or MISSING. This module turns
 * that into engine input, and nothing else: it does not research, interpret, or decide. A missing judgement takes its
 * versioned prior; the engine's structurally-private rule then decides whether that prior contributes or is renormalized
 * away (see marketabilityBeta1.ts).
 *
 * It lives in production code because the evaluator service will use exactly this conversion — the calibration tooling
 * and the freeze test share it so there is one definition of "how a judgement becomes a signal", not three.
 *
 * H/M/L → 0.9/0.6/0.3 is EXPERIMENTAL and frozen with Beta.1: it is the mapping every validation result was produced
 * under, so changing it is a methodology change and bumps the version.
 */
import { join } from "node:path";
import type { NormalizedSignal, SourceClass } from "./intelligence/types";

/** Pinned so a regenerated golden bundle is byte-reproducible. The engine's score does not depend on it; provenance does. */
export const BETA1_FREEZE_AS_OF = "2026-09-14T00:00:00.000Z";

/** The freeze bundle: expected deterministic outputs for the 37 frozen evaluator artifacts. */
export const BETA1_GOLDENS_PATH = join(__dirname, "marketabilityBeta1.goldens.json");

/** Evaluator confidence vocabulary → the engine's 0–1 confidence. EXPERIMENTAL, frozen with Beta.1. */
export const BETA1_CONFIDENCE_MAP: Readonly<Record<string, number>> = { HIGH: 0.9, MEDIUM: 0.6, LOW: 0.3 };
export const BETA1_MISSING_CONFIDENCE = 0.3;

/** One sub-signal judgement from the evaluator. `status` is "scored" or anything else, which is treated as missing. */
export interface EvaluatorSignalJudgement {
  dimension: string;
  key: string;
  status: string;
  score: number | null;
  confidence: string | null;
  evidenceIds: string[];
}
export interface EvaluatorJudgements { signals: EvaluatorSignalJudgement[] }

/** Scope passed to the prior lookup for a missing sub-signal. */
export interface Beta1PriorScope { sport: string; segment: null; careerStatus: null; sourceMode: string; asOf: string }
export type Beta1PriorFn = (path: string, scope: Beta1PriorScope) => NormalizedSignal;

/**
 * Build the engine's dimension input from evaluator judgements. Every one of the 44 sub-signals is present in the result:
 * scored judgements carry the evaluator's value and confidence, missing ones carry their prior (imputed).
 *
 * `subWeights` is a PARAMETER, not an import, so the signal set has exactly one source per run. This function used to
 * reach into MARKETABILITY_BETA1_FROZEN_PARAMS while the rest of production scoring read the active params row — two
 * sources of truth that agreed only by coincidence. They would diverge the moment an active row differs from the
 * fixture, which is precisely what activating a new params version does, and the symptom would be this function
 * throwing on a signal the evaluator was never asked for. The frozen structure is still frozen; the freeze gate now
 * pins it by passing it in explicitly.
 *
 * `sourceOf` labels a scored judgement's provenance from what it cites (marketabilityCitationLineage.ts
 * `judgementSourceOf`). It defaults to `web_researched` — the label every frozen output was produced under — so the
 * goldens stay byte-identical. The score never reads `source`; the evidence class shown on My Intelligence does.
 */
export function buildBeta1Dimensions(
  judgements: EvaluatorJudgements,
  sport: string,
  prior: Beta1PriorFn,
  subWeights: Record<string, Record<string, number>>,
  asOf: string = BETA1_FREEZE_AS_OF,
  sourceOf: (j: EvaluatorSignalJudgement) => SourceClass = () => "web_researched",
): Record<string, Record<string, NormalizedSignal>> {
  const scope: Beta1PriorScope = { sport: sport.toLowerCase(), segment: null, careerStatus: null, sourceMode: "legacy", asOf };
  return Object.fromEntries(Object.keys(subWeights).map((dimension) => [
    dimension,
    Object.fromEntries(Object.keys(subWeights[dimension]).map((key) => {
      const path = `${dimension}.${key}`;
      const j = judgements.signals.find((s) => s.dimension === dimension && s.key === key);
      if (!j) throw new Error(`evaluator judgement missing for ${path}`);
      if (j.status !== "scored" || j.score == null) return [key, prior(path, scope)];
      return [key, {
        key: path,
        value: j.score,
        confidence: BETA1_CONFIDENCE_MAP[j.confidence ?? ""] ?? BETA1_MISSING_CONFIDENCE,
        source: sourceOf(j),
        evidenceIds: j.evidenceIds,
        modelVersion: "mia-evaluator",
        asOf,
        imputed: false,
      } satisfies NormalizedSignal];
    })),
  ]));
}
