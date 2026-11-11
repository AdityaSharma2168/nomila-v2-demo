/**
 * research/plans.ts — domain → query plan (Step 2b design §3). Pure.
 *
 * The five legacy queries of researchAthlete.ts buildQueries are reused VERBATIM (copied, not
 * imported: the legacy file is untouched, D4) so dev evidence is comparable with today's runs.
 * Q4 "Media Assets" is not a research domain and is never planned. Domains due on the same night
 * merge into one plan: the union of their queries runs once and one cited extraction covers the
 * union of envelopes; `profile` always rides with `affiliations`.
 */

import type { ResearchProviderBinding } from "./config";
import type { CostModel, PlannerPolicy } from "./policy";
import { getFactDefinition, isRegisteredKey } from "./factRegistry";
import { domainOfEvidence, RESEARCH_DOMAINS, SECTION_DOMAIN, type EvidenceKind, type ResearchDomain } from "./registries";
import { ITEM_MAPPINGS, RESEARCH_FINDING_KIND } from "./spec/itemMapping";
import { QUERIES, QUERY_IDS, sectionById, type QueryId } from "./spec/researchSpecV1";

export type QueryName = "Profile + Social" | "Commercial + Brand" | "Performance + Press" | "Social Handles";

/** Legacy query text, verbatim (researchAthlete.ts buildQueries). */
export function queryText(name: QueryName, searchName: string): string {
  switch (name) {
    case "Profile + Social":
      return `${searchName}: full name, hometown, state, class year, position, conference, ` +
             `team roster bio, personal background, current and past teams (school, club, professional, national team)`;
    case "Commercial + Brand":
      return `${searchName}: NIL deals, brand partnerships, sponsorships, endorsements, ` +
             `NIL valuation 2024-2026, On3 NIL valuation, Opendorse, Athlete's Thread, ` +
             `product collaborations, ambassador programs`;
    case "Performance + Press":
      return `${searchName}: career achievements, All-American, All-conference, player of the year, ` +
             `season statistics, records, awards, academic honors, press coverage, ` +
             `ESPN, Sports Illustrated, The Athletic, local newspaper coverage`;
    case "Social Handles":
      return `${searchName} @username Instagram TikTok Twitter X handle ` +
             `site:instagram.com OR site:twitter.com OR site:tiktok.com OR site:x.com ` +
             `social media profile link`;
  }
}

export interface DomainPlanDef { queries: QueryName[]; kinds: EvidenceKind[]; signals?: boolean; narrativeOnly?: boolean }

export const DOMAIN_PLANS: Record<ResearchDomain, DomainPlanDef> = {
  identity:       { queries: ["Profile + Social"],    kinds: ["identity_signal", "profile_attribute"] },
  profile:        { queries: ["Profile + Social"],    kinds: ["profile_attribute"] },
  affiliations:   { queries: ["Profile + Social"],    kinds: ["affiliation", "profile_attribute"] },
  achievements:   { queries: ["Performance + Press"], kinds: ["achievement"] },
  press:          { queries: ["Performance + Press"], kinds: ["press_mention", "media_asset"] },
  brand_mentions: { queries: ["Commercial + Brand"],  kinds: ["brand_mention", "nil_mention"] },
  narrative:      { queries: [],                      kinds: ["sentiment"], narrativeOnly: true },
  social_handles: { queries: ["Social Handles"],      kinds: ["social_handle"] },
  signals:        { queries: [],                      kinds: ["signal"], signals: true },
};

export interface MergedPlan {
  domains: ResearchDomain[];
  queries: QueryName[];
  kinds: EvidenceKind[];
  signals: boolean;
  /** narrative was planned without any search domain: re-run extraction over the stored latest payloads. */
  narrativeOnly: boolean;
  /** LLM attempts the plan needs when nothing is retried: one per query + one extraction when any query or narrative is planned. */
  llmCalls: number;
  signalCalls: number;
}

export function mergePlan(domains: ResearchDomain[]): MergedPlan {
  const set = new Set<ResearchDomain>(domains);
  if (set.has("affiliations")) set.add("profile");
  if (set.has("profile")) set.add("affiliations");
  const queries: QueryName[] = []; const kinds: EvidenceKind[] = [];
  let signals = false;
  for (const d of set) {
    const def = DOMAIN_PLANS[d];
    for (const q of def.queries) if (!queries.includes(q)) queries.push(q);
    for (const k of def.kinds) if (!kinds.includes(k)) kinds.push(k);
    if (def.signals) signals = true;
  }
  const narrativeOnly = set.has("narrative") && queries.length === 0;
  const extraction = queries.length > 0 || narrativeOnly ? 1 : 0;
  return { domains: [...set], queries, kinds, signals, narrativeOnly, llmCalls: queries.length + extraction, signalCalls: signals ? 2 : 0 };
}

export const FULL_PLAN_DOMAINS: ResearchDomain[] = ["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"];

/** Provisional USD estimate for a plan from the cost model (per-call prices only; token prices apply to actuals). */
export function estimatePlanUsd(plan: MergedPlan, costModel: CostModel): number {
  const g = costModel.gemini_grounded?.perCallUsd ?? 0;
  const k = costModel.kimi_extract?.perCallUsd ?? 0.02;   // token-priced; a small per-call placeholder for planning
  const extraction = plan.queries.length > 0 || plan.narrativeOnly ? 1 : 0;
  return Math.round((plan.queries.length * g + extraction * k) * 10_000) / 10_000;
}

/** Provisional USD for an executed call from the cost model and measured usage. */
export function estimateCallUsd(provider: string, usage: { promptTokens?: number; completionTokens?: number; calls?: number; searchQueries?: number } | undefined, costModel: CostModel): number {
  const m = costModel[provider];
  if (!m) return 0;
  const calls = usage?.calls ?? 1;
  const usd = (m.perCallUsd ?? 0) * calls + ((usage?.promptTokens ?? 0) / 1_000_000) * (m.perMTokInUsd ?? 0) + ((usage?.completionTokens ?? 0) / 1_000_000) * (m.perMTokOutUsd ?? 0)
    + (usage?.searchQueries ?? 0) * (m.perSearchQueryUsd ?? 0);
  return Math.round(usd * 10_000) / 10_000;
}

// ── research-spec/1 plan table (research-acquisition architecture #709 §9.2, adaptation 1) ──────────────────────────
/**
 * Research domain → the research-spec/1 queries (Q1–Q6) whose evidence lands in that domain. DERIVED, never hand-kept:
 * a query covers the home domain of each of its sections (SECTION_DOMAIN) and the domain of every item of those sections
 * as persist files it (ITEM_MAPPINGS kind → domainOfEvidence). That is how `profile` reaches Q1 as well as Q6: the S1/S2
 * biography items (hometown, position, class year, …) are profile_attribute evidence. `signals` has no query.
 *
 * Selected by the provider binding (planTableFor): "direct" (the future v3) only. NOT wired to execution yet (v3 is PR E);
 * the v2/"kimi" binding keeps DOMAIN_PLANS unchanged.
 */
export const SPEC_V1_DOMAIN_QUERIES: Readonly<Record<ResearchDomain, readonly QueryId[]>> = (() => {
  const out = Object.fromEntries(RESEARCH_DOMAINS.map((d) => [d, [] as QueryId[]])) as Record<ResearchDomain, QueryId[]>;
  for (const q of QUERIES) for (const sid of q.sections) {
    // research-spec/1.1: an `acceptOnly` item never makes its query a covering query of its domain (planning unchanged).
    const itemDomains = sectionById(sid).items.filter((it) => !it.acceptOnly).map((it) => domainOfEvidence(ITEM_MAPPINGS[it.id]?.kind ?? RESEARCH_FINDING_KIND, { section: sid }));
    for (const d of [SECTION_DOMAIN[sid], ...itemDomains]) if (d && !out[d].includes(q.id)) out[d].push(q.id);
  }
  return out;
})();

/** The domain → query table a provider binding plans with: "kimi" (v2) = the legacy DOMAIN_PLANS queries, unchanged; "direct" (v3) = research-spec/1. */
export type PlanTable =
  | { binding: "kimi"; queries: Readonly<Record<ResearchDomain, readonly QueryName[]>> }
  | { binding: "direct"; queries: Readonly<Record<ResearchDomain, readonly QueryId[]>> };
export function planTableFor(binding: ResearchProviderBinding): PlanTable {
  if (binding === "direct") return { binding, queries: SPEC_V1_DOMAIN_QUERIES };
  const queries = {} as Record<ResearchDomain, readonly QueryName[]>;
  for (const d of RESEARCH_DOMAINS) queries[d] = DOMAIN_PLANS[d].queries;
  return { binding, queries };
}

/**
 * Due domains → the union of their research-spec/1 queries, in spec order, so Q1 (the identity gate) is first whenever
 * it is present. Pure; no companion expansion (mergePlan's profile ↔ affiliations rule is the v2 planner's, not this table's).
 * Q5 is narrowed to unconnected platforms at run time by a deterministic post-filter (PR E2a, D12; research/v3Stage.ts),
 * never here: the request text stays the frozen research-spec/1 text.
 */
export function specV1QueriesFor(domains: readonly ResearchDomain[]): QueryId[] {
  const due = new Set(domains.flatMap((d) => SPEC_V1_DOMAIN_QUERIES[d] ?? []));
  return QUERY_IDS.filter((q) => due.has(q));
}

// ── research_refresh v3 (the direct binding): per-query plan, acceptance and settle (PR E2a; design record §3, §5) ──

/** A v3 run's plan: the due domains AS GIVEN (no profile ↔ affiliations companion, D11), their queries, the signals lane. */
export interface V3Plan { domains: ResearchDomain[]; queries: QueryId[]; signals: boolean }

/** Due domains → the v3 plan. Pure. Unlike mergePlan (v2, unchanged) it never adds a companion domain. */
export function planV3(domains: readonly ResearchDomain[]): V3Plan {
  const ds = RESEARCH_DOMAINS.filter((d) => domains.includes(d));
  return { domains: ds, queries: specV1QueriesFor(ds), signals: ds.includes("signals") };
}

/**
 * The ACCEPTANCE set of one query: every domain its items land in as persist files them — the plan table's coverage
 * plus the registry domain of every fact key its item mappings carry (e.g. Q1's national_team_programme item is a
 * national_team_participation fact, which the registry files under achievements). Claims outside it are dropped.
 */
export function v3AcceptanceDomains(q: QueryId): ResearchDomain[] {
  const out = new Set<ResearchDomain>(RESEARCH_DOMAINS.filter((d) => SPEC_V1_DOMAIN_QUERIES[d].includes(q)));
  const def = QUERIES.find((x) => x.id === q);
  for (const sid of def?.sections ?? []) for (const it of sectionById(sid).items) {
    const m = ITEM_MAPPINGS[it.id] as { kind?: string; factKey?: string; also?: Array<{ factKey: string }> } | undefined;
    if (it.acceptOnly) { const d = domainOfEvidence(m?.kind ?? RESEARCH_FINDING_KIND, { section: sid }); if (d) out.add(d); }   // accepted, never covering
    for (const k of [m?.factKey, ...(m?.also ?? []).map((a) => a.factKey)]) if (k && isRegisteredKey(k)) out.add(getFactDefinition(k).domain);
  }
  return RESEARCH_DOMAINS.filter((d) => out.has(d));
}

/**
 * The SETTLE set after query `q` has run: planned domains `q` covers whose covering queries (SPEC_V1_DOMAIN_QUERIES)
 * have ALL run in this run (`ran`, which includes `q`). Only these get an outcome on q's row. So profile (Q1 + Q6)
 * settles only when Q6 has also run: a Q1-only run accepts Q1's profile evidence but leaves profile's freshness as it was.
 */
export function v3SettleDomains(q: QueryId, planned: readonly ResearchDomain[], ran: ReadonlySet<QueryId>): ResearchDomain[] {
  return RESEARCH_DOMAINS.filter((d) => planned.includes(d) && SPEC_V1_DOMAIN_QUERIES[d].includes(q) && SPEC_V1_DOMAIN_QUERIES[d].every((x) => x === q || ran.has(x)));
}

/**
 * Adaptation 2 (budget): the LLM attempts a direct plan may need — one per query plus `geminiRetryMax` retries each
 * (the full six-query plan is 18 at the default retry count) — and what a run may reserve, which is capped ONLY by the
 * policy's `maxCallsPerRun` (no constant here). Values are unchanged; they wait for measured runs and verified pricing.
 */
export function directPlanAttempts(queries: readonly QueryId[], planner: Pick<PlannerPolicy, "geminiRetryMax" | "maxCallsPerRun">): { attempts: number; reserveCalls: number } {
  const attempts = queries.length * (1 + planner.geminiRetryMax);
  return { attempts, reserveCalls: Math.min(attempts, planner.maxCallsPerRun) };
}

/**
 * PR E2b: what a research_refresh v3 plan asks of the nightly ledger, by the SAME formula the v2 planner uses for its
 * candidates (one LLM call per query when nothing is retried; reserve = calls + the retry allowance, capped by
 * maxCallsPerRun) and the same per-call grounded price estimatePlanUsd charges a query. A v3 query is a grounded Gemini
 * call with no separate extraction, so no extraction is added. No limit or price value is introduced here (PR F).
 */
export function v3PlanBudget(plan: { queries: readonly QueryId[]; signals: boolean }, policy: { planner: Pick<PlannerPolicy, "retryAllowancePerRun" | "maxCallsPerRun">; costModel: CostModel }): { llmCalls: number; reserveCalls: number; estUsd: number; signalsOnly: boolean } {
  const llmCalls = plan.queries.length;
  const reserveCalls = Math.min(llmCalls + (llmCalls ? policy.planner.retryAllowancePerRun : 0), policy.planner.maxCallsPerRun);
  const estUsd = Math.round(llmCalls * (policy.costModel.gemini_grounded?.perCallUsd ?? 0) * 10_000) / 10_000;
  return { llmCalls, reserveCalls, estUsd, signalsOnly: llmCalls === 0 && plan.signals };
}
