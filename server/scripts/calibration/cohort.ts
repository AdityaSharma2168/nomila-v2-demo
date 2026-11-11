/**
 * scripts/calibration/cohort.ts — load the development cohort and the evaluation-only gold sheet.
 *
 * The hard guard of the benchmark: an athlete can be researched ONLY if it is in a named cohort file (dev20 / dev37).
 * Free names are refused, so the 21-athlete unseen holdout can never be touched by this tooling.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkAthlete, GoldIdentity } from "../../services/intelligence/research/benchmark/types";

export const CALIBRATION_DIR = __dirname;
export const RUNS_DIR = join(CALIBRATION_DIR, "runs");

export interface CohortFile { version: string; note: string; athletes: BenchmarkAthlete[] }
export interface GoldFile { version: string; note: string; athletes: GoldIdentity[] }
export interface TargetsFile { version: string; note: string; targets: Record<string, number> }

export const COHORT_NAMES = ["dev20", "dev37"] as const;
export type CohortName = (typeof COHORT_NAMES)[number];
/** dev20 = the research pilot cohort (12 Sep 2026); dev37 = the Beta.1 calibration cohort (dev20 + 17, 13 Sep 2026). The holdout is in neither. */
export function loadCohort(name: CohortName = "dev20"): CohortFile {
  if (!COHORT_NAMES.includes(name)) throw new Error(`unknown cohort "${name}" (valid: ${COHORT_NAMES.join(", ")})`);
  return JSON.parse(readFileSync(join(CALIBRATION_DIR, `cohort.${name}.json`), "utf8"));
}
export function loadGold(): Map<string, GoldIdentity> {
  const g: GoldFile = JSON.parse(readFileSync(join(CALIBRATION_DIR, "cohort.dev20.gold.json"), "utf8"));
  return new Map(g.athletes.map((a) => [a.key, a]));
}

/** EVALUATION ONLY: frozen calibration targets. Never imported by providerBenchmark.ts (the request builder); the report reads it. */
export function loadTargets(): Map<string, number> {
  const t: TargetsFile = JSON.parse(readFileSync(join(CALIBRATION_DIR, "cohort.dev20.targets.json"), "utf8"));
  return new Map(Object.entries(t.targets));
}

export class HoldoutGuardError extends Error { constructor(key: string, valid: string[]) { super(`"${key}" is not in the development cohort (holdout guard). Valid keys: ${valid.join(", ")}`); this.name = "HoldoutGuardError"; } }

/** Resolve requested keys against the cohort; refuses anything unknown. No keys ⇒ the whole cohort. */
export function selectAthletes(cohort: CohortFile, keys: string[]): BenchmarkAthlete[] {
  const byKey = new Map(cohort.athletes.map((a) => [a.key, a]));
  if (!keys.length) return [...cohort.athletes];
  return keys.map((k) => { const a = byKey.get(k); if (!a) throw new HoldoutGuardError(k, [...byKey.keys()]); return a; });
}
