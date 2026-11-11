/**
 * research/config.ts — the research substrate flag and its policy (design §6–§7, §4.3).
 *
 * Two independent switches (research-acquisition architecture D3; the third, (c) the legacy Kimi dual-write
 * RESEARCH_LEGACY_DUAL_WRITE, was off in every environment and has been removed with the dual-write):
 *   (a) substrate persistence — RESEARCH_SUBSTRATE_WRITE (default off) gates every write into the research
 *       tables (persistResearchRun). It turns nothing else on.
 *   (b) planner/refresh execution — researchPlannerExecutionEnabled() below, plus the provider binding the
 *       research_refresh process uses (RESEARCH_REFRESH_PROVIDER, default "kimi" = the v2 binding).
 *
 * Policy (TTLs, source-type tiers, caps) comes from the ACTIVE `research_policy` /
 * `research_freshness` model_params rows when they exist, else from the defaults below. Drafts
 * are never consulted.
 */

import { getActiveParams } from "../params";
import { createLogger } from "../../../logger";
import type { FreshnessFamily } from "./registries";

const logger = createLogger("research-substrate");
export const RESEARCH_POLICY_SCHEMA_VERSION = "research-policy-config/2";
/** Both schema versions are read; /1 rows (Step 2a) simply leave the Step 2b `planner` / `costModel` blocks at their defaults. */
export const RESEARCH_POLICY_SCHEMA_VERSIONS = ["research-policy-config/1", "research-policy-config/2"] as const;
export const RESEARCH_FRESHNESS_SCHEMA_VERSION = "research-freshness-config/1";

export { DEFAULT_RESEARCH_POLICY, DEFAULT_PLANNER_POLICY, DEFAULT_GEMINI_CALL_TIMEOUT_MS, DEFAULT_COST_MODEL, classifySourceType, resolveSourceType, type ResearchPolicy, type PlannerPolicy, type CostModel } from "./policy";
import { DEFAULT_RESEARCH_POLICY, type ResearchPolicy } from "./policy";

/** D3 (a) — substrate persistence: may persistResearchRun write. Never implies execution. */
export function researchSubstrateWriteEnabled(): boolean {
  return process.env.RESEARCH_SUBSTRATE_WRITE === "true";
}

/** D3 (b) — which provider binding the research_refresh process uses: "kimi" = the v2 binding (grounded + Kimi), "direct" = v3. */
export const RESEARCH_PROVIDER_BINDINGS = ["kimi", "direct"] as const;
export type ResearchProviderBinding = (typeof RESEARCH_PROVIDER_BINDINGS)[number];

/** RESEARCH_REFRESH_PROVIDER, default "kimi" (today's binding). An unknown value fails closed. */
export function researchRefreshProviderBinding(): ResearchProviderBinding {
  const v = (process.env.RESEARCH_REFRESH_PROVIDER ?? "").trim();
  if (v === "") return "kimi";
  if ((RESEARCH_PROVIDER_BINDINGS as readonly string[]).includes(v)) return v as ResearchProviderBinding;
  throw new Error(`RESEARCH_REFRESH_PROVIDER="${v}" is not a known provider binding (expected one of: ${RESEARCH_PROVIDER_BINDINGS.join(", ")})`);
}

/**
 * RESEARCH_TARGETED_READ_MAX — research v3's targeted source read: how many of the run's athlete_media sources the read step
 * may read (one model call each, every call through the budget reservation). Default 3; 0 disables the step. A value that is
 * not a non-negative integer falls back to the default.
 */
export const DEFAULT_TARGETED_READ_MAX = 3;
export function researchTargetedReadMax(): number {
  const raw = (process.env.RESEARCH_TARGETED_READ_MAX ?? "").trim();
  if (raw === "") return DEFAULT_TARGETED_READ_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_TARGETED_READ_MAX;
}

/**
 * RESEARCH_TARGETED_READ_MAX_ATTEMPTS — the hard ceiling of model calls the read step may spend while backfilling failed reads
 * toward RESEARCH_TARGETED_READ_MAX successful ones (it is also the read step's own budget allowance; the daily limit still
 * applies to every call). Default 5. A value that is not a positive integer falls back to the default.
 */
export const DEFAULT_TARGETED_READ_MAX_ATTEMPTS = 5;
export function researchTargetedReadMaxAttempts(): number {
  const raw = (process.env.RESEARCH_TARGETED_READ_MAX_ATTEMPTS ?? "").trim();
  if (raw === "") return DEFAULT_TARGETED_READ_MAX_ATTEMPTS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TARGETED_READ_MAX_ATTEMPTS;
}

/**
 * How a model athlete_media item is matched to a grounding chunk this run retrieved (sourceReadV1 matchHintToChunk), over
 * normalised title tokens: same registrable domain AND (Jaccard ≥ domainTitleJaccard OR containment ≥ domainTitleContainment),
 * or strong title overlap alone (Jaccard ≥ strongTitleJaccard OR containment ≥ strongTitleContainment). Containment counts
 * only when the smaller title has ≥ minContainmentTokens tokens. `maxResolutions` bounds the grounding redirects one read step
 * resolves before matching (Q3's chunks and chunks on a domain the model's items name first); `maxVideoChecks` bounds its
 * YouTube oEmbed lookups (a video chunk past the bound is not used).
 */
export const GROUNDED_READ_MATCH = {
  domainTitleJaccard: 0.5,
  domainTitleContainment: 0.7,
  strongTitleJaccard: 0.6,
  strongTitleContainment: 0.8,
  minContainmentTokens: 3,
  maxResolutions: 15,
  maxVideoChecks: 8,
} as const;

/** The raw Step 2b flag. Never read on its own by 2b code: the execution gate below is the only predicate. */
export function researchRefreshEnabled(): boolean {
  return process.env.RESEARCH_REFRESH_ENABLED === "true";
}

/**
 * D3 (b) — THE ONE EXECUTION GATE (Step 2b design §4.1, review round 2).
 *   researchPlannerExecutionEnabled = RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE
 * RESEARCH_REFRESH_ENABLED is the switch; persistence is a precondition (a refresh that cannot persist is spend
 * with no result). Persistence alone never opens this gate.
 * Gates: the planner's enqueue mode, applyStateTransitions, workflow enqueue, pending consumption /
 * last_planned_at, the refresh step's provider calls, requestRefresh writes (connect, admin), the dev
 * monthly re-enrich suppression, admin v1 → planner routing, and the script's --apply.
 * Invariant: if either flag is false, planner execution is non-mutating and legacy behaviour remains active.
 */
export function researchPlannerExecutionEnabled(): boolean {
  return researchRefreshEnabled() && researchSubstrateWriteEnabled();
}

/**
 * THE identity-resolution boundary (PR E design record §5.7). PR E (lifecycle start, the v3 Q1 gate, the identity
 * column writer) and PR H (the identity invariant on identity-dependent M.I.A. triggers) read ONLY this predicate.
 *   identityResolutionEnabled = researchPlannerExecutionEnabled() && RESEARCH_REFRESH_PROVIDER === "direct"
 * No env var of its own: it is on exactly when the one execution gate is open AND the direct (v3) binding is chosen.
 * Default OFF (both yaml files deploy RESEARCH_REFRESH_ENABLED=false, RESEARCH_SUBSTRATE_WRITE=false, provider kimi).
 * With it false: no lifecycle start, no identity_resolution write (applyIdentityTransition refuses before writing),
 * the planner stays on v2, and Beta.1 M.I.A. behaviour is unchanged.
 */
export function identityResolutionEnabled(): boolean {
  return researchPlannerExecutionEnabled() && researchRefreshProviderBinding() === "direct";
}

let cached: { at: number; policy: ResearchPolicy } | null = null;
const TTL_MS = 60_000;

/** Effective policy: active research_policy + active research_freshness rows over the defaults, cached a minute. */
export async function getResearchPolicy(): Promise<ResearchPolicy> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.policy;
  let policy: ResearchPolicy = { ...DEFAULT_RESEARCH_POLICY, ttlDays: { ...DEFAULT_RESEARCH_POLICY.ttlDays }, sourceTypeDomains: { ...DEFAULT_RESEARCH_POLICY.sourceTypeDomains }, planner: { ...DEFAULT_RESEARCH_POLICY.planner, rescanDays: { ...DEFAULT_RESEARCH_POLICY.planner.rescanDays } }, costModel: { ...DEFAULT_RESEARCH_POLICY.costModel }, version: "defaults" };
  try {
    const p = await getActiveParams("research_policy");
    if (p && (RESEARCH_POLICY_SCHEMA_VERSIONS as readonly string[]).includes(p.schema_version)) {
      const c = p.config as Partial<ResearchPolicy>;
      policy = { ...policy, ...c, ttlDays: { ...policy.ttlDays, ...(c.ttlDays ?? {}) }, sourceTypeDomains: { ...policy.sourceTypeDomains, ...(c.sourceTypeDomains ?? {}) }, domains: { ...policy.domains, ...(c.domains ?? {}) },
        planner: { ...policy.planner, ...(c.planner ?? {}), rescanDays: { ...policy.planner.rescanDays, ...(c.planner?.rescanDays ?? {}) } }, costModel: { ...policy.costModel, ...(c.costModel ?? {}) }, version: p.version };
    } else if (p) logger.warn({ version: p.version, schema: p.schema_version }, "active research_policy has an unexpected schema_version — using defaults");
    const f = await getActiveParams("research_freshness");
    if (f && f.schema_version === RESEARCH_FRESHNESS_SCHEMA_VERSION) {
      const fams = (f.config as any)?.families ?? {};
      const map: Partial<Record<FreshnessFamily, string>> = { identity: "identity", affiliations: "competition_level", achievements: "achievements", press: "press_mentions", brand_mentions: "brand_mentions", narrative: "narrative", social_handles: "social_handles", signals: "search_interest" };   // social_handles: its own family since research_freshness v0.2-alpha (D6)
      for (const [fam, key] of Object.entries(map)) { const v = fams[key!]; if (v && "currentDays" in v) (policy.ttlDays as any)[fam] = v.currentDays; }
    }
  } catch (err: any) {
    logger.warn({ error: err.message?.slice(0, 120) }, "could not read research params — using defaults");
  }
  cached = { at: Date.now(), policy };
  return policy;
}

/** Tests only. */
export function __resetResearchPolicyCache(): void { cached = null; }
