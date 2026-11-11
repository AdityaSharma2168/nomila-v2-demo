/**
 * marketabilityBeta1Params.ts — loading (and dev seeding) of the versioned Beta.1 parameter bundle from model_params
 * (Phase A Step 4, Slice D). Existing families only, no family added for bundle assembly:
 *
 *   marketability  → the frozen engine row `marketability-config/1` (dimension weights, sub-weights, 0–850 mapping) PLUS
 *                    `config.normalization` = { lookups: marketability-lookups/1, policy: marketability-normalization-policy/1 }
 *   cohorts        → cohorts-config/1 (percentile tables; D3: built from the 37-athlete development cohort only)
 *   priors         → priors-config/1 (the §8 missing-data prior hierarchy)
 *   signals        → the social substrate's row (freshnessDays by source class; defaults when no row is active)
 *
 * Every value is versioned data. The v0 drafts below are explicit placeholders for the FIRST end-to-end scoring pass —
 * neutral priors, empty cohort tables, the D1 v0 lookups — never tuned per athlete; calibration replaces them by version.
 */

import { getActiveParams, insertDraftParams, activateParams } from "./intelligence/params";
import { getSubstrateParams } from "./intelligence/social/config";
import { validateMarketabilityBeta1Params, type MarketabilityBeta1Params } from "./marketabilityBeta1";
import { COHORTS_SCHEMA_VERSION, PRIORS_SCHEMA_VERSION, validateNormalizationBundle, type CohortsConfig, type LookupsConfig, type NormalizationBundle, type NormalizationPolicy, type PriorsConfig } from "./marketabilityBeta1Normalization";
import { BETA1_COHORTS_V0, BETA1_FRESHNESS_V0_DERIVED, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1 } from "./marketabilityBeta1Lookups";

export const MARKETABILITY_CONFIG_SCHEMA_VERSION = "marketability-config/1" as const;

export class Beta1ParamsError extends Error {
  constructor(public readonly family: "marketability" | "cohorts" | "priors" | "signals", message: string) { super(`beta1 params (${family}): ${message}`); this.name = "Beta1ParamsError"; }
}

export interface LoadedBeta1Params {
  params: MarketabilityBeta1Params;
  bundle: NormalizationBundle;
  versions: { marketability: string; lookups: string; policy: string; cohorts: string; priors: string; freshness: string };
}

type MarketabilityRowConfig = MarketabilityBeta1Params["config"] & { normalization?: { lookups: LookupsConfig; policy: NormalizationPolicy } };

/** Load the ACTIVE bundle. Throws Beta1ParamsError naming the first missing family or shape; never silently substitutes a default. */
export async function loadBeta1Params(): Promise<LoadedBeta1Params> {
  const m = await getActiveParams("marketability");
  if (!m) throw new Beta1ParamsError("marketability", "no active row");
  if (m.schema_version !== MARKETABILITY_CONFIG_SCHEMA_VERSION) throw new Beta1ParamsError("marketability", `schema ${m.schema_version} is not ${MARKETABILITY_CONFIG_SCHEMA_VERSION}`);
  const cfg = m.config as unknown as MarketabilityRowConfig;
  if (!cfg.normalization?.lookups || !cfg.normalization?.policy) throw new Beta1ParamsError("marketability", "config.normalization.{lookups,policy} is missing");
  const { normalization, ...rest } = cfg;
  const params: MarketabilityBeta1Params = { version: m.version, schemaVersion: m.schema_version, config: rest as MarketabilityBeta1Params["config"] };
  validateMarketabilityBeta1Params(params);

  const c = await getActiveParams("cohorts");
  if (!c) throw new Beta1ParamsError("cohorts", "no active row");
  const p = await getActiveParams("priors");
  if (!p) throw new Beta1ParamsError("priors", "no active row");
  const cohorts = c.config as unknown as CohortsConfig;
  const priors = p.config as unknown as PriorsConfig;
  const substrate = await getSubstrateParams();

  // The substrate row covers the observed source classes; `inferred`/`imputed` rows (derived features) take the v0 Beta.1 windows only when the substrate does not define them.
  const freshnessDays = { ...BETA1_FRESHNESS_V0_DERIVED, ...substrate.freshnessDays };
  const bundle: NormalizationBundle = { version: `${m.version}`, cohorts, priors, lookups: normalization.lookups, policy: normalization.policy, freshnessDays };
  validateNormalizationBundle(bundle);
  return { params, bundle, versions: { marketability: m.version, lookups: normalization.lookups.version, policy: normalization.policy.version, cohorts: c.version, priors: p.version, freshness: "signals-substrate" } };
}

export { BETA1_COHORTS_V0, BETA1_FRESHNESS_V0_DERIVED, BETA1_LOOKUPS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V0, BETA1_PRIORS_V1 } from "./marketabilityBeta1Lookups";

export interface SeedBeta1Input { engine: MarketabilityBeta1Params; lookups?: LookupsConfig; policy?: NormalizationPolicy; priors?: PriorsConfig; cohorts?: CohortsConfig; activate?: boolean; createdBy?: string | null }

/** Insert the draft rows (idempotent on family+version) and optionally activate them. Dev tooling; production never calls this. */
export async function seedBeta1Params(i: SeedBeta1Input): Promise<{ marketability: string; cohorts: string; priors: string; activated: boolean }> {
  validateMarketabilityBeta1Params(i.engine);
  const lookups = i.lookups ?? BETA1_LOOKUPS_V1, policy = i.policy ?? BETA1_POLICY_V0, priors = i.priors ?? BETA1_PRIORS_V1, cohorts = i.cohorts ?? BETA1_COHORTS_V0;
  const engineVersion = `${i.engine.version}+${lookups.version}+${policy.version}`;
  await insertDraftParams({ family: "marketability", version: engineVersion, schemaVersion: MARKETABILITY_CONFIG_SCHEMA_VERSION, config: { ...i.engine.config, normalization: { lookups, policy } } as Record<string, unknown>, note: `Beta.1 engine ${i.engine.version} (frozen weights) + normalization ${lookups.version}/${policy.version}`, createdBy: i.createdBy ?? null });
  await insertDraftParams({ family: "cohorts", version: cohorts.version, schemaVersion: COHORTS_SCHEMA_VERSION, config: cohorts as unknown as Record<string, unknown>, note: "Beta.1 cohort percentile tables", createdBy: i.createdBy ?? null });
  await insertDraftParams({ family: "priors", version: priors.version, schemaVersion: PRIORS_SCHEMA_VERSION, config: priors as unknown as Record<string, unknown>, note: "Beta.1 missing-data priors", createdBy: i.createdBy ?? null });
  if (i.activate) { await activateParams("marketability", engineVersion); await activateParams("cohorts", cohorts.version); await activateParams("priors", priors.version); }
  return { marketability: engineVersion, cohorts: cohorts.version, priors: priors.version, activated: !!i.activate };
}
