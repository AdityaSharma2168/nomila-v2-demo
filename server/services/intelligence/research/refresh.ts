/**
 * research/refresh.ts — ONE planner-driven domain refresh run (Step 2b design §4.4).
 *
 *   1. refuse (no provider call) unless the ONE execution gate is true
 *   2. at-least-once safety: an ok/partial research run for this workflow run is returned, an
 *      abandoned `running` one is closed failed
 *   3. open the research_runs row BEFORE any provider call (the nightly ledger counts on it)
 *   4. grounded queries of the merged plan, each attempt behind reserveLlmCall() (retries included);
 *      Trends/GDELT on the signals lane; narrative-only re-extracts the stored latest payloads
 *   5. one cited extraction restricted to the plan, also behind a reservation, asking for per-domain outcomes
 *   6. persistResearchRun (transactional, sanitized) with the plan → outcomes → monotonic freshness
 *
 * Never writes the legacy blob. Never throws for provider trouble (the outcome vocabulary carries it);
 * throws only on programming errors so the runner can retry.
 *
 * Provider independence (boundary.test.ts): the four provider calls are INJECTED (`RefreshProviders`);
 * the real bindings live in server/skills/researchRefresh.ts. Nothing here imports a provider module.
 */

import { and, desc, eq, like } from "drizzle-orm";
import { db } from "../../../db";
import { createLogger } from "../../../logger";
import { athletes, connectedAccounts, researchRuns, researchSourcePayloads } from "../../../../shared/schema";
import { collectResearchSecrets } from "../../../lib/research/secrets";
import { assertionsFor, hintsFor } from "./researchInputs";
import { searchInputsFor } from "../context/searchInputs";
import { getResearchPolicy, researchPlannerExecutionEnabled } from "./config";
import { recordNonLlmCall, reserveLlmCall } from "./ledger";
import { persistResearchRun, redactMessage } from "./persist";
import { FULL_PLAN_DOMAINS, mergePlan, queryText, type MergedPlan } from "./plans";
import type { DomainQueryStatus } from "./outcomes";
import type { DomainOutcome, ResearchDomain, ResearchTrigger } from "./registries";
import type { ExtractionEnvelope, IdentityHints, SearchEnvelope, SignalEnvelope } from "./providers";

const logger = createLogger("research-planner");

export type RefreshTrigger = Extract<ResearchTrigger, "ttl" | "identity_confirmed" | "event" | "manual">;

/** The workflow run's input (references only). */
export interface RefreshRunInput { domains?: ResearchDomain[]; full?: boolean; trigger?: RefreshTrigger; reason?: string | null; plannerRunId?: string | null; reserveCalls?: number; estUsd?: number; policyVersion?: string; dueToDispute?: ResearchDomain[] }

export interface RefreshInput { athleteId: string; workflowRunId?: string | null; domains: ResearchDomain[]; full?: boolean; trigger: RefreshTrigger; reason?: string | null; dueToDispute?: ResearchDomain[]; asOf?: Date }

/** The provider calls a refresh needs, injected by the skills layer (server/skills/researchRefresh.ts binds the real adapters). */
export interface RefreshProviders {
  /** Grounded web search. MUST await `reserve()` before every attempt (retries included) and make no call on false. */
  search: (query: string, opts: { envelopeId: string; queryName: string; retryMax: number; reserve: () => Promise<boolean> }) => Promise<{ envelope: SearchEnvelope; attempts: number; refused: boolean; completed: boolean }>;
  /** Cited extraction restricted to the plan; MUST await `reserve()` before the call. */
  extract: (envelopes: SearchEnvelope[], hints: IdentityHints, envelopeId: string, opts: { domains: string[]; allowedKinds: string[]; reserve: () => Promise<boolean> }) => Promise<ExtractionEnvelope>;
  /** Signals lane (no LLM): the fetch + envelope mapping. */
  trends: (name: string, sport: string | null, fetchedAt: string) => Promise<SignalEnvelope>;
  gdelt: (name: string, fetchedAt: string) => Promise<SignalEnvelope>;
}
export interface RefreshResult { ok: boolean; researchRunId: string | null; status: "ok" | "partial" | "failed" | "refused"; error?: string; outcomes?: Record<string, DomainOutcome>; reused?: boolean }

/** E1's identity signal: an active connection, or a claimed/authenticated athlete row. */
export async function hasIdentitySignal(athleteId: string): Promise<boolean> {
  const [a] = await db.select({ claimed: athletes.claimed_at, auth: athletes.auth_id }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (a && (a.claimed || a.auth)) return true;
  const conns = await db.select({ id: connectedAccounts.id }).from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"))).limit(1);
  return conns.length > 0;
}

export async function knownHandlesFor(athleteId: string, socials: unknown): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  const s = (socials ?? {}) as Record<string, unknown>;
  for (const k of ["instagram", "tiktok", "youtube", "x", "twitter"]) if (typeof s[k] === "string" && s[k]) out[k === "twitter" ? "x" : k] = String(s[k]).replace(/^@/, "");
  const conns = await db.select({ platform: connectedAccounts.platform, username: connectedAccounts.platform_username }).from(connectedAccounts).where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active")));
  for (const c of conns) if (c.username && ["instagram", "tiktok", "youtube", "x"].includes(c.platform)) out[c.platform] = c.username.replace(/^@/, "");
  return out;
}

export const buildSearchName = (a: { full_name: string; school: string | null; sport: string | null }) => (a.school ? `${a.full_name} ${a.school} ${a.sport ?? ""}` : `${a.full_name} ${a.sport ?? ""}`).trim();

/** Narrative-only refresh: rebuild SearchEnvelopes from the athlete's most recent stored search payloads (no search). */
async function storedSearchEnvelopes(athleteId: string): Promise<SearchEnvelope[]> {
  const rows = await db.select().from(researchSourcePayloads).where(and(eq(researchSourcePayloads.athlete_id, athleteId), like(researchSourcePayloads.endpoint_family, "search:%"))).orderBy(desc(researchSourcePayloads.fetched_at)).limit(20);
  if (!rows.length) return [];
  const latestRun = rows[0].run_id;
  return rows.filter((r) => r.run_id === latestRun).map((r, n) => {
    const p = (r.payload ?? {}) as any;
    const id = `p${n}`;
    const chunks = (Array.isArray(p.chunks) ? p.chunks : []).map((c: any, i: number) => ({ ...c, id: `${id}:c${i}` }));
    const supports = (Array.isArray(p.supports) ? p.supports : []).map((s: any, i: number) => ({ ...s, id: `${id}:s${i}`, chunkIds: (s.chunkIds ?? []).map((cid: string) => `${id}:c${String(cid).split(":c")[1] ?? "0"}`) }));
    return { id, provider: r.provider, model: r.model ?? undefined, queryName: r.endpoint_family.replace(/^search:/, ""), query: "(stored payload)", fetchedAt: r.fetched_at.toISOString(), answerText: String(p.answerText ?? ""), chunks, supports, raw: null, request: { path: "stored", params: { payloadId: r.id } }, errors: [] } as SearchEnvelope;
  });
}

export async function refreshAthlete(i: RefreshInput, providers: RefreshProviders): Promise<RefreshResult> {
  if (!researchPlannerExecutionEnabled()) return { ok: false, researchRunId: null, status: "refused", error: "execution_disabled" };
  const asOf = i.asOf ?? new Date();
  const secrets = collectResearchSecrets();

  // ── 2. at-least-once safety ──
  if (i.workflowRunId) {
    const existing = await db.select({ id: researchRuns.id, status: researchRuns.status, summary: researchRuns.summary }).from(researchRuns).where(eq(researchRuns.workflow_run_id, i.workflowRunId));
    const done = existing.find((r) => r.status === "ok" || r.status === "partial");
    if (done) return { ok: true, researchRunId: done.id, status: done.status as "ok" | "partial", outcomes: outcomesOf(done.summary), reused: true };
    for (const r of existing) if (r.status === "running") await db.update(researchRuns).set({ status: "failed", finished_at: new Date(), error: { reason: "abandoned", message: "a previous attempt of this workflow run did not close its research run", subCalls: [] } as any }).where(eq(researchRuns.id, r.id));
  }

  const [a] = await db.select({ id: athletes.id, full_name: athletes.full_name, school: athletes.school, sport: athletes.sport, socials: athletes.socials, claimed_at: athletes.claimed_at, auth_id: athletes.auth_id }).from(athletes).where(eq(athletes.id, i.athleteId)).limit(1);
  if (!a) throw new Error(`Athlete ${i.athleteId} not found`);
  const policy = await getResearchPolicy();
  const plan: MergedPlan = i.full ? mergePlan(FULL_PLAN_DOMAINS) : mergePlan(i.domains);
  if (!plan.domains.length) return { ok: false, researchRunId: null, status: "refused", error: "empty_plan" };

  // ── 3. open the run row first ──
  const [run] = await db.insert(researchRuns).values({ athlete_id: i.athleteId, domain: i.full ? "full" : "refresh", trigger: i.trigger, status: "running", started_at: asOf, as_of: asOf, workflow_run_id: i.workflowRunId ?? null, summary: { plan: { domains: plan.domains, queries: plan.queries, signals: plan.signals, narrativeOnly: plan.narrativeOnly }, reason: i.reason ?? null } as any }).returning({ id: researchRuns.id });
  const runId = run.id;
  const reserve = () => reserveLlmCall(runId, { policy, asOf });
  // The projection anchor + knownHandlesFor + hintsFor.
  const inputs = await searchInputsFor(a.id, { anchor: buildSearchName(a), handles: await knownHandlesFor(a.id, a.socials) });
  const searchName = inputs.anchor;
  const legacyHints = await hintsFor(a as any, inputs.handles);
  const hasAssertedAffiliations = legacyHints.hasAssertedAffiliations;
  const hints = legacyHints.hints;

  try {
    // ── 4. queries ──
    const search: SearchEnvelope[] = [];
    const queryDone: Record<string, { completed: boolean; chunks: number }> = {};
    for (const [idx, q] of plan.queries.entries()) {
      const r = await providers.search(queryText(q, searchName), { envelopeId: `g${idx}`, queryName: q, retryMax: policy.planner.geminiRetryMax, reserve });
      search.push(r.envelope);
      queryDone[q] = { completed: r.completed, chunks: r.envelope.chunks.length };
      if (r.refused) break;   // the nightly or per-run cap is reached: no further LLM calls this run
    }
    if (plan.narrativeOnly) { const stored = await storedSearchEnvelopes(i.athleteId); search.push(...stored); queryDone["(stored)"] = { completed: stored.length > 0, chunks: stored.reduce((n, e) => n + e.chunks.length, 0) }; }

    const signals: SignalEnvelope[] = [];
    let signalsCompleted = false;
    if (plan.signals) {
      const fetchedAt = new Date().toISOString();
      const [t, g] = await Promise.all([
        (await recordNonLlmCall(runId, "signals", { policy, asOf })) ? providers.trends(a.full_name, a.sport, fetchedAt).catch((e: any) => { logger.warn({ athleteId: a.id, error: redactMessage(e?.message ?? e, secrets) }, "trends failed"); return null; }) : Promise.resolve(null),
        (await recordNonLlmCall(runId, "signals", { policy, asOf })) ? providers.gdelt(a.full_name, fetchedAt).catch((e: any) => { logger.warn({ athleteId: a.id, error: redactMessage(e?.message ?? e, secrets) }, "gdelt failed"); return null; }) : Promise.resolve(null),
      ]);
      for (const s of [t, g]) if (s) signals.push(s);
      signalsCompleted = !!t && !!g;
    }

    // ── 5. extraction (restricted to the plan; asks for per-domain outcomes) ──
    const llmDomains = plan.domains.filter((d) => d !== "signals");
    const extraction = plan.queries.length || plan.narrativeOnly ? await providers.extract(search, hints, "x0", { domains: llmDomains, allowedKinds: plan.kinds, reserve }) : null;

    // ── per-domain query completion (§3.1): every query of the domain completed with chunks ──
    const queryStatus: Partial<Record<ResearchDomain, DomainQueryStatus>> = {};
    for (const d of plan.domains) {
      if (d === "signals") { queryStatus[d] = { completed: signalsCompleted, chunksReviewed: signals.length }; continue; }
      const names = d === "narrative" && plan.narrativeOnly ? ["(stored)"] : (d === "narrative" ? plan.queries : (mergePlan([d]).queries as string[]));
      const rs = names.map((n) => queryDone[n]);
      queryStatus[d] = { completed: rs.length > 0 && rs.every((r) => r?.completed), chunksReviewed: rs.reduce((n, r) => n + (r?.chunks ?? 0), 0) };
    }

    // ── 6. persist ──
    const identity = await hasIdentitySignal(a.id);
    const result = await persistResearchRun({
      runId, workflowRunId: i.workflowRunId ?? null, athleteId: a.id, trigger: i.trigger, domain: i.full ? "full" : "refresh",
      hints, search, extraction, signals, assertions: await assertionsFor(a.id), hasAssertedAffiliations,
      identityResolved: identity, identityConfidence: identity ? 1 : undefined, secrets, asOf, retrievedAt: asOf,
      plan: { domains: plan.domains, queryStatus, dueToDispute: i.dueToDispute ?? [] },
    });
    if (!result) return { ok: false, researchRunId: runId, status: "failed", error: "persist failed (see research_runs.error)" };
    return { ok: true, researchRunId: runId, status: result.status, outcomes: Object.fromEntries(Object.entries(result.domains).map(([d, v]) => [d, v.outcome])) };
  } catch (err: any) {
    // Programming errors only (provider trouble is carried by the envelopes). Close the run, never leak a secret.
    const message = redactMessage(err?.message ?? err, secrets);
    await db.update(researchRuns).set({ status: "failed", finished_at: new Date(), error: { reason: "error", message, subCalls: [] } as any }).where(eq(researchRuns.id, runId)).catch(() => {});
    logger.error({ athleteId: a.id, runId, error: message }, "research refresh failed");
    return { ok: false, researchRunId: runId, status: "failed", error: message };
  }
}

const outcomesOf = (summary: unknown): Record<string, DomainOutcome> => Object.fromEntries(Object.entries(((summary as any)?.domains ?? {}) as Record<string, { outcome: DomainOutcome }>).map(([d, v]) => [d, v.outcome]));

