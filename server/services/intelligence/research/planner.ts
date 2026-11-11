/**
 * research/planner.ts — the nightly domain refresh planner (Step 2b design §4).
 *
 *   evaluateNight()        PURE. Proposes E0/E1/E4 transitions, selects due domains per athlete, orders by
 *                          priority and admits plans against the nightly ledger (actuals + reservations).
 *   applyStateTransitions  ENQUEUE MODE ONLY. Guarded updates (updated_at unchanged), inserts on conflict do nothing.
 *   runResearchPlanner()   The pass: advisory lock → ledger → evaluate → (enqueue mode) apply + startRun →
 *                          research_planner_runs row. In dry_run that row is the ONLY write.
 *
 * Mode is decided by the ONE execution gate: enqueue only when researchPlannerExecutionEnabled()
 * (RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE) and not dryRun. Either flag false ⇒ dry_run.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { verificationStatesFor } from "../identity/state";
import { db } from "../../../db";
import { createLogger } from "../../../logger";
import { athletes, athleteResearchState, connectedAccounts, researchPlannerRuns, researchRuns, workflowRuns } from "../../../../shared/schema";
import { LOCK_RESEARCH_PLANNER, withAdvisoryLock } from "../../../lib/pgAdvisoryLock";
import { getResearchPolicy, researchPlannerExecutionEnabled, researchRefreshProviderBinding, type ResearchPolicy } from "./config";
import { anchorHash, readIdentityStates, type IdentityValue } from "./identityResolution";
import { nightlyLedger, type NightlyLedger } from "./ledger";
import { currentIdentityAnchor, reenterIdentityResolution } from "./lifecycle";
import { estimatePlanUsd, mergePlan, planV3, v3PlanBudget } from "./plans";
import { deriveResearchState } from "./state";
import { redactMessage } from "./persist";
import { BLOCKING_DOMAINS, PLANNABLE_DOMAINS, plannableDomainsFor, type DomainStatus, type PlannerMode, type ResearchDomain, type ResearchState } from "./registries";
import type { PendingRequest } from "./triggers";
import type { RefreshRunInput, RefreshTrigger } from "./refresh";
import type { V3RunInput } from "./v3Stage";

const logger = createLogger("research-planner");
const DAY = 86_400_000;
const ABANDONED_RUN_MS = 30 * 60_000;

// ── types ──────────────────────────────────────────────────────────────────────
export interface DomainEntry { status?: DomainStatus | string; lastRunId?: string | null; lastResearchedAt?: string | null; staleAfter?: string | null; outcome?: string | null; blockingDispute?: boolean }
export interface FailureEntry { count: number; lastOutcome?: string; deferredUntil?: string | null; disputeRechecks?: number }
export interface StateRowLike {
  athleteId: string;
  researchStatus: ResearchState;
  identityConfidence: number;
  identityResolvedAt: string | null;
  domains: Record<string, DomainEntry>;
  disputedDomains: ResearchDomain[];
  pending: PendingRequest[];
  refreshFailures: Record<string, FailureEntry>;
  updatedAt: string | null;
  /** No state row exists yet (E0 would create it). */
  virtual: boolean;
}
export interface AthleteInfo { athleteId: string; status: string | null; hasIdentitySignal: boolean; realUser: boolean }
export interface Transition { before: StateRowLike; after: StateRowLike; kinds: string[] }
export interface PlanCandidate {
  athleteId: string; domains: ResearchDomain[]; full: boolean; trigger: RefreshTrigger; reasons: string[]; dueToDispute: ResearchDomain[];
  signalsOnly: boolean; llmCalls: number; reserveCalls: number; estUsd: number;
  priority: { pendingRank: number; realUser: number; blockingGap: number; overdueMs: number };
  /** PR E2b, direct binding only: the research_refresh version the plan runs on (3), and the identity re-entry (T7) it carries. */
  version?: 3;
  reenter?: "anchor_changed" | "ttl";
}
export interface Evaluation { proposed: Transition[]; wouldMaterialize: number; candidates: PlanCandidate[]; admitted: PlanCandidate[]; deferred: Record<string, PlanCandidate[]>; transitions: Record<string, number>; remaining: { runs: number; llm: number; usd: number; signalRuns: number }; identity?: Record<string, number> }

/**
 * PR E2b (design record §5.3, §1.2 T7, D11, D18): the direct binding's identity-aware admission. Present => the planner
 * plans research_refresh v3; absent (binding kimi) => v2, byte for byte as before.
 *   NULL                 never planned (enters only through T1: lifecycle or admin).
 *   pending              Q1 only (`identity`), unless its failure back-off defers it; held domains stay in `pending`.
 *   ambiguous | failed   nothing, unless the anchor changed or the identity TTL is due -> T7 at enqueue, then Q1 only.
 *   resolved             the due domains over PLANNABLE_DOMAINS_DIRECT (profile plannable, D11) + every pending entry,
 *                        so domains the gate held are re-planned once identity resolves (D18).
 */
export interface IdentityPlanInfo { value: IdentityValue; determinedAt: string | null; anchorChanged: boolean }
export interface V3PlannerInput { identity: Map<string, IdentityPlanInfo> }
const NO_DETERMINATION: IdentityPlanInfo = { value: null, determinedAt: null, anchorChanged: false };

interface DueSelection { domains: ResearchDomain[]; reasons: string[]; dueToDispute: ResearchDomain[]; trigger: RefreshTrigger; full: boolean; overdueMs: number }
/** Due domains of one athlete over `plannable` (TTL / rescan / dispute recheck / pending), or the first full run. */
function selectDue(s: StateRowLike, plannable: ResearchDomain[], firstFull: boolean, P: ResearchPolicy["planner"], asOf: Date): DueSelection {
  const domains: ResearchDomain[] = []; const reasons: string[] = []; const dueToDispute: ResearchDomain[] = [];
  let trigger: RefreshTrigger = "ttl"; let overdueMs = 0;
  if (firstFull) { reasons.push("first full run"); return { domains: [...plannable], reasons, dueToDispute, trigger: "identity_confirmed", full: true, overdueMs }; }
  for (const d of plannable) {
    const e = s.domains[d] ?? {}; const st = (e.status ?? "missing") as string;
    const deferredUntil = s.refreshFailures[d]?.deferredUntil;
    if (deferredUntil && new Date(deferredUntil).getTime() > asOf.getTime()) continue;
    if (st === "missing" || st === "stale") { domains.push(d); reasons.push(`${d}:${st}`); if (e.staleAfter) overdueMs = Math.max(overdueMs, asOf.getTime() - new Date(e.staleAfter).getTime()); continue; }
    const rescan = P.rescanDays[d];
    if (rescan != null && e.lastResearchedAt && new Date(e.lastResearchedAt).getTime() + rescan * DAY <= asOf.getTime()) { domains.push(d); reasons.push(`${d}:rescan`); overdueMs = Math.max(overdueMs, asOf.getTime() - (new Date(e.lastResearchedAt).getTime() + rescan * DAY)); continue; }
    if (st === "disputed" && e.lastResearchedAt && new Date(e.lastResearchedAt).getTime() + P.disputeRecheckDays * DAY <= asOf.getTime() && (s.refreshFailures[d]?.disputeRechecks ?? 0) < P.maxDisputeRechecks) { domains.push(d); dueToDispute.push(d); reasons.push(`${d}:dispute_recheck`); }
  }
  for (const p of s.pending) {
    if (!plannable.includes(p.domain)) continue;
    if (!domains.includes(p.domain)) domains.push(p.domain);
    reasons.push(`${p.domain}:${p.trigger}:${p.reason}`);
    if (p.trigger === "manual") trigger = "manual"; else if (trigger !== "manual") trigger = "event";
  }
  return { domains, reasons, dueToDispute, trigger, full: false, overdueMs };
}

// ── evaluate (pure) ────────────────────────────────────────────────────────────
export function evaluateNight(input: { rows: StateRowLike[]; athletes: Map<string, AthleteInfo>; policy: ResearchPolicy; ledger: NightlyLedger; asOf: Date; activeAthletes: Set<string>; v3?: V3PlannerInput }): Evaluation {
  const { policy, ledger, asOf } = input;
  const P = policy.planner;
  const transitions: Record<string, number> = {};
  const proposed: Transition[] = [];
  const evaluated: StateRowLike[] = [];
  let wouldMaterialize = 0;

  for (const row of input.rows) {
    const info = input.athletes.get(row.athleteId);
    if (!info) continue;
    if (row.virtual) wouldMaterialize++;
    const after: StateRowLike = { ...row, domains: Object.fromEntries(Object.entries(row.domains).map(([d, e]) => [d, { ...e }])) };
    const kinds: string[] = [];
    if (row.virtual) kinds.push("materialize");
    // E1
    if (after.researchStatus === "seed_only" && info.hasIdentitySignal) { after.researchStatus = "identity_resolved"; after.identityConfidence = 1; after.identityResolvedAt = asOf.toISOString(); kinds.push("seed_only>identity_resolved"); }
    // E4 input: expired complete domains become stale (pure, from stored staleAfter)
    const statuses: Partial<Record<ResearchDomain, DomainStatus>> = {};
    const blockingDisputes: ResearchDomain[] = [];
    for (const d of Object.keys(after.domains) as ResearchDomain[]) {
      const e = after.domains[d];
      if (e.status === "complete" && e.staleAfter && new Date(e.staleAfter).getTime() <= asOf.getTime()) e.status = "stale";
      statuses[d] = (e.status as DomainStatus) ?? "missing";
      if (e.blockingDispute) blockingDisputes.push(d);
    }
    if (Object.keys(after.domains).length) {
      const derived = deriveResearchState({ identityResolved: !!after.identityResolvedAt || info.hasIdentitySignal, domains: statuses, blockingDisputes });
      if (derived.status !== after.researchStatus) { kinds.push(`${after.researchStatus}>${derived.status}`); after.researchStatus = derived.status; }
      after.disputedDomains = derived.disputedDomains;
    }
    if (kinds.length) { proposed.push({ before: row, after, kinds }); for (const k of kinds) transitions[k] = (transitions[k] ?? 0) + 1; }
    evaluated.push(after);
  }

  // ── candidates ──
  const candidates: PlanCandidate[] = [];
  const deferred: Record<string, PlanCandidate[]> = {};
  const defer = (reason: string, c: PlanCandidate) => (deferred[reason] ??= []).push(c);
  const v3 = input.v3;
  const identityCounts: Record<string, number> = {};
  const countIdentity = (k: string) => { identityCounts[k] = (identityCounts[k] ?? 0) + 1; };
  for (const s of evaluated) {
    if (!v3 && s.researchStatus === "seed_only") continue;                                   // never planned (spec §4)
    const info = input.athletes.get(s.athleteId)!;
    const skipReason = input.activeAthletes.has(s.athleteId) || ledger.queuedAthleteIds.has(s.athleteId) ? "active_run" : ledger.athletesRunToday.has(s.athleteId) && P.maxRunsPerAthletePerDay <= 1 ? "athlete_daily_cap" : null;
    const researched = Object.values(s.domains).some((e) => !!e.lastResearchedAt);
    let sel: DueSelection;
    let reenter: PlanCandidate["reenter"];
    if (!v3) sel = selectDue(s, PLANNABLE_DOMAINS, s.researchStatus === "identity_resolved" && !researched, P, asOf);
    else {
      // The identity column (never research_status, the account signal) decides admission under the direct binding.
      const idn = v3.identity.get(s.athleteId) ?? NO_DETERMINATION;
      if (idn.value === null) { countIdentity("not_entered"); continue; }                     // NULL is never planned
      if (idn.value === "resolved") sel = selectDue(s, plannableDomainsFor("direct"), !researched, P, asOf);
      else {
        let why: string; let trigger: RefreshTrigger = "event";
        if (idn.value === "pending") {
          const du = s.refreshFailures.identity?.deferredUntil;
          if (du && new Date(du).getTime() > asOf.getTime()) { countIdentity("pending_deferred"); continue; }
          why = "identity:pending";
        } else {
          const ttl = policy.ttlDays.identity;
          const ttlDue = ttl != null && !!idn.determinedAt && new Date(idn.determinedAt).getTime() + ttl * DAY <= asOf.getTime();
          reenter = idn.anchorChanged ? "anchor_changed" : ttlDue ? "ttl" : undefined;
          if (!reenter) { countIdentity(`${idn.value}_held`); continue; }                       // no automatic re-run (D6)
          why = `identity:${idn.value}:${reenter}`;
          if (reenter === "ttl") trigger = "ttl";
        }
        // Q1 only: identity-dependent domains (held in `pending`) wait until the determination is `resolved`.
        sel = { domains: ["identity"], reasons: [why], dueToDispute: [], trigger, full: false, overdueMs: 0 };
        countIdentity(reenter ? `reenter_${reenter}` : "pending_q1");
      }
    }
    const { domains, reasons, dueToDispute, trigger, full, overdueMs } = sel;
    if (!domains.length) continue;
    let planned: ResearchDomain[]; let llmCalls: number; let signalsOnly: boolean; let reserveCalls: number; let estUsd: number;
    if (v3) {
      const p = planV3(domains);
      const b = v3PlanBudget(p, policy);
      planned = p.domains; llmCalls = b.llmCalls; signalsOnly = b.signalsOnly; reserveCalls = b.reserveCalls; estUsd = b.estUsd;
    } else {
      const merged = mergePlan(domains);
      planned = merged.domains; llmCalls = merged.llmCalls; signalsOnly = merged.llmCalls === 0 && merged.signals;
      reserveCalls = Math.min(merged.llmCalls + (merged.llmCalls ? P.retryAllowancePerRun : 0), P.maxCallsPerRun); estUsd = estimatePlanUsd(merged, policy.costModel);
    }
    const c: PlanCandidate = {
      athleteId: s.athleteId, domains: planned, full, trigger, reasons, dueToDispute, signalsOnly,
      llmCalls, reserveCalls, estUsd,
      priority: { pendingRank: trigger === "manual" ? 0 : trigger === "event" ? 1 : 2, realUser: info.realUser ? 0 : 1, blockingGap: planned.some((d) => BLOCKING_DOMAINS.includes(d) && ["missing", "partial"].includes(String(s.domains[d]?.status ?? "missing"))) ? 0 : 1, overdueMs },
      ...(v3 ? { version: 3 as const, ...(reenter ? { reenter } : {}) } : {}),
    };
    if (skipReason) { defer(skipReason, c); continue; }
    candidates.push(c);
  }
  candidates.sort((a, b) => a.priority.pendingRank - b.priority.pendingRank || a.priority.realUser - b.priority.realUser || a.priority.blockingGap - b.priority.blockingGap || b.priority.overdueMs - a.priority.overdueMs || a.estUsd - b.estUsd);

  // ── admission against the ledger (actuals + reservations), §5.1 ──
  const remaining = { runs: P.maxRunsPerNight - ledger.runsToday - ledger.queuedAthleteIds.size, llm: P.maxLlmCallsPerNight - ledger.llmExecutedToday - ledger.llmReserved, usd: P.maxUsdPerNight - ledger.usdExecutedToday - ledger.usdReserved, signalRuns: P.maxSignalRunsPerNight - ledger.signalRunsToday };
  const admitted: PlanCandidate[] = [];
  for (const c of candidates) {
    if (c.estUsd > P.maxUsdPerRun) { defer("run_over_cap", c); continue; }
    if (c.signalsOnly) {
      if (remaining.signalRuns < 1 || remaining.runs < 1) { defer("budget", c); continue; }
      remaining.signalRuns--; remaining.runs--; admitted.push(c); continue;
    }
    if (remaining.runs < 1 || c.reserveCalls > remaining.llm || c.estUsd > remaining.usd) { defer("budget", c); continue; }
    remaining.runs--; remaining.llm -= c.reserveCalls; remaining.usd -= c.estUsd; admitted.push(c);
  }
  return { proposed, wouldMaterialize, candidates, admitted, deferred, transitions, remaining, ...(v3 ? { identity: identityCounts } : {}) };
}

// ── loaders ────────────────────────────────────────────────────────────────────
export async function loadPlannerInput(asOf: Date, athleteId?: string) {
  const roster = await db.select({ id: athletes.id, status: athletes.status, claimed: athletes.claimed_at, auth: athletes.auth_id }).from(athletes)
    // Legacy intelligence switch-off (12 Oct 2026): the nightly pass never plans an agent-front athlete (the agent
    // researches her). A named athlete (the admin / script path) is still planned on request.
    .where(athleteId ? eq(athletes.id, athleteId) : and(inArray(athletes.status, ["raw", "enriched", "claimed", "active"]), eq(athletes.agent_onboarding_required, false),
      // researched on the agent route at sign-up (agentFrontAthlete.ts, same rule): the agent owns her research while
      // that run is active, and afterwards while the agent app front is on (AGENT_ONBOARDING); after a rollback, not
      sql`NOT EXISTS (SELECT 1 FROM workflow_runs w WHERE w.athlete_id = ${athletes.id} AND w.process = 'signup_research' AND w.status ${process.env.AGENT_ONBOARDING === "true" ? sql`<> 'canceled'` : sql`IN ('running', 'waiting')`})`));
  const ids = roster.map((r) => r.id);
  // Phase A Step 3a: identity through the one source (verificationStatesFor) — the same booleans as before plus a self-membership.
  const states = await verificationStatesFor(ids);
  const info = new Map<string, AthleteInfo>();
  for (const r of roster) { const st = states.get(r.id); const connected = st?.connected ?? false; const identity = st?.hasIdentitySignal ?? (!!r.claimed || !!r.auth); info.set(r.id, { athleteId: r.id, status: r.status, hasIdentitySignal: identity, realUser: connected || r.status === "active" || r.status === "claimed" }); }
  const stateRows = ids.length ? await db.select().from(athleteResearchState).where(inArray(athleteResearchState.athlete_id, ids)) : [];
  const byId = new Map(stateRows.map((s) => [s.athlete_id, s]));
  const rows: StateRowLike[] = roster.map((r) => {
    const s = byId.get(r.id);
    return s ? { athleteId: r.id, researchStatus: s.research_status as ResearchState, identityConfidence: Number(s.identity_confidence), identityResolvedAt: s.identity_resolved_at?.toISOString() ?? null, domains: (s.domains ?? {}) as Record<string, DomainEntry>, disputedDomains: (s.disputed_domains ?? []) as ResearchDomain[], pending: (s.pending ?? []) as PendingRequest[], refreshFailures: (s.refresh_failures ?? {}) as Record<string, FailureEntry>, updatedAt: s.updated_at.toISOString(), virtual: false }
             : { athleteId: r.id, researchStatus: "seed_only", identityConfidence: 0, identityResolvedAt: null, domains: {}, disputedDomains: [], pending: [], refreshFailures: {}, updatedAt: null, virtual: true };
  });
  const active = ids.length ? await db.select({ athleteId: workflowRuns.athlete_id }).from(workflowRuns).where(and(eq(workflowRuns.process, "research_refresh"), inArray(workflowRuns.status, ["running", "waiting"]), inArray(workflowRuns.athlete_id, ids))) : [];
  const v3 = researchRefreshProviderBinding() === "direct" ? await loadV3PlannerInput(ids) : undefined;
  return { rows, athletes: info, activeAthletes: new Set(active.map((a) => a.athleteId!)), ledger: await nightlyLedger(asOf), ...(v3 ? { v3 } : {}) };
}

/**
 * PR E2b: the identity input of the direct binding's planner (read-only). The anchor is compared only for ambiguous /
 * failed determinations that recorded one: a different anchorHash now is an anchor change (a name/sport edit or a new
 * known handle; a new affiliation is not, as the anchor carries no team), which re-enters through T7 at enqueue.
 */
export async function loadV3PlannerInput(athleteIds: string[]): Promise<V3PlannerInput> {
  const states = await readIdentityStates(athleteIds);
  const identity = new Map<string, IdentityPlanInfo>();
  for (const [athleteId, st] of states) {
    const d = (st.detail ?? {}) as { at?: string; anchorHash?: string };
    let anchorChanged = false;
    if ((st.value === "ambiguous" || st.value === "failed") && d.anchorHash) {
      const anchor = await currentIdentityAnchor(athleteId);
      anchorChanged = !!anchor && anchorHash(anchor) !== d.anchorHash;
    }
    identity.set(athleteId, { value: st.value, determinedAt: d.at ?? null, anchorChanged });
  }
  return { identity };
}

// ── apply (enqueue mode only) ──────────────────────────────────────────────────
export async function applyStateTransitions(proposed: Transition[], asOf: Date): Promise<{ applied: number; skipped: number }> {
  let applied = 0, skipped = 0;
  for (const t of proposed) {
    const a = t.after;
    if (t.before.virtual) {
      const r = await db.insert(athleteResearchState).values({ athlete_id: a.athleteId, research_status: a.researchStatus, identity_confidence: String(a.identityConfidence.toFixed(2)), identity_resolved_at: a.identityResolvedAt ? new Date(a.identityResolvedAt) : null, updated_at: asOf }).onConflictDoNothing().returning({ id: athleteResearchState.athlete_id });
      r.length ? applied++ : skipped++;
      continue;
    }
    // Guarded: a row changed underneath (a persist committed meanwhile) is skipped, never overwritten.
    const r = await db.update(athleteResearchState).set({ research_status: a.researchStatus, identity_confidence: String(a.identityConfidence.toFixed(2)), identity_resolved_at: a.identityResolvedAt ? new Date(a.identityResolvedAt) : null, domains: a.domains as any, disputed_domains: a.disputedDomains as any, updated_at: asOf })
      .where(and(eq(athleteResearchState.athlete_id, a.athleteId), eq(athleteResearchState.updated_at, new Date(t.before.updatedAt!)))).returning({ id: athleteResearchState.athlete_id });
    r.length ? applied++ : skipped++;
  }
  return { applied, skipped };
}

// ── the pass ───────────────────────────────────────────────────────────────────
export interface PlannerSummary { plannerRunId: string | null; mode: PlannerMode; status: "ok" | "failed" | "skipped"; evaluated: number; wouldMaterialize: number; transitions: Record<string, number | boolean>; candidates: number; admitted: number; deferred: Record<string, number>; enqueued: number; applied?: { applied: number; skipped: number }; budget: unknown; plans: unknown[] }

export async function runResearchPlanner(opts: { dryRun?: boolean; asOf?: Date; budgetMs?: number; athleteId?: string } = {}): Promise<PlannerSummary> {
  const asOf = opts.asOf ?? new Date();
  const mode: PlannerMode = !opts.dryRun && researchPlannerExecutionEnabled() ? "enqueue" : "dry_run";
  const t0 = Date.now();
  const outcome = await withAdvisoryLock(LOCK_RESEARCH_PLANNER, async () => pass(asOf, mode, opts.budgetMs ?? 540_000, t0, opts.athleteId));
  if (outcome.ran) return outcome.result!;
  const [row] = await db.insert(researchPlannerRuns).values({ status: "skipped", mode, as_of: asOf, policy_version: "n/a", finished_at: new Date() }).returning({ id: researchPlannerRuns.id });
  return { plannerRunId: row.id, mode, status: "skipped", evaluated: 0, wouldMaterialize: 0, transitions: {}, candidates: 0, admitted: 0, deferred: {}, enqueued: 0, budget: {}, plans: [] };
}

async function pass(asOf: Date, mode: PlannerMode, budgetMs: number, t0: number, athleteId?: string): Promise<PlannerSummary> {
  const policy = await getResearchPolicy();
  const [row] = await db.insert(researchPlannerRuns).values({ status: "running", mode, as_of: asOf, policy_version: policy.version ?? "defaults" }).returning({ id: researchPlannerRuns.id });
  try {
    if (mode === "enqueue") {
      // Runs abandoned by a crashed worker keep their reservations as real spend but must not stay `running`.
      await db.update(researchRuns).set({ status: "failed", finished_at: new Date(), error: { reason: "abandoned", message: "running past its lease at planner time", subCalls: [] } as any })
        .where(and(eq(researchRuns.status, "running"), sql`${researchRuns.started_at} < ${new Date(asOf.getTime() - ABANDONED_RUN_MS)}`));
    }
    const input = await loadPlannerInput(asOf, athleteId);
    const ev = evaluateNight({ ...input, policy, asOf });
    const P = policy.planner;
    let applied: { applied: number; skipped: number } | undefined;
    let enqueued = 0;
    const plans: any[] = ev.admitted.slice(0, 200).map((c) => ({ athleteId: c.athleteId, domains: c.domains, full: c.full, trigger: c.trigger, reserveCalls: c.reserveCalls, estUsd: c.estUsd, reasons: c.reasons.slice(0, 12) }));
    if (mode === "enqueue") {
      applied = await applyStateTransitions(ev.proposed, asOf);
      const { startRun } = await import("../../../workflow/runner");
      const day = asOf.toISOString().slice(0, 10);
      // The daily research cap is a hard stop (agent/onboarding/dailyCap.ts researchCapRefusal; the runner refuses too):
      // read once before any state transition, so a refused night enqueues nothing and re-enters nobody.
      const { researchCapRefusal } = await import("../../../agent/onboarding/dailyCap");
      let capRefused = !!(await researchCapRefusal());
      for (const [n, c] of ev.admitted.entries()) {
        if (capRefused) { (ev.deferred.daily_research_cap ??= []).push(c); continue; }
        if (Date.now() - t0 > budgetMs) { (ev.deferred.time_budget ??= []).push(c); continue; }
        let r: Awaited<ReturnType<typeof startRun>>;
        const reason = c.reasons.slice(0, 6).join("; ").slice(0, 200);
        try {
          if (c.version === 3) {
            // T7 (anchor change / identity TTL) only once the plan is admitted, by compare-and-set; a lost or refused
            // re-entry (she confirmed meanwhile, the anchor moved back) starts nothing.
            if (c.reenter) {
              const re = await reenterIdentityResolution(c.athleteId, { trigger: c.reenter, asOf });
              plans[n].reentry = re.written ? re.transition : re.reason;
              if (!re.written) { (ev.deferred.identity_reentry_refused ??= []).push(c); continue; }
            }
            const input: V3RunInput & { reserveCalls: number; estUsd: number; policyVersion: string } = { domains: c.domains, trigger: c.trigger, reason, governIdentity: true, plannerRunId: row.id, dueToDispute: c.dueToDispute, reserveCalls: c.reserveCalls, estUsd: c.estUsd, policyVersion: policy.version ?? "defaults" };
            r = await startRun({ process: "research_refresh", version: 3, athleteId: c.athleteId, createdBy: "schedule", idempotencyKey: `research_refresh:${c.athleteId}:${day}`, input, kick: false });
          } else {
            const input: RefreshRunInput = { domains: c.domains, full: c.full, trigger: c.trigger, reason, plannerRunId: row.id, reserveCalls: c.reserveCalls, estUsd: c.estUsd, policyVersion: policy.version ?? "defaults", dueToDispute: c.dueToDispute };
            r = await startRun({ process: "research_refresh", version: 2, athleteId: c.athleteId, createdBy: "schedule", idempotencyKey: `research_refresh:${c.athleteId}:${day}`, input, kick: false });
          }
        } catch (err: any) {
          // The cap was spent mid-pass (the runner's hard stop): this one and the rest wait for tomorrow.
          if (err?.code !== "daily_research_cap") throw err;
          capRefused = true; (ev.deferred.daily_research_cap ??= []).push(c); continue;
        }
        plans[n].workflowRunId = r.run.id; plans[n].created = r.created;
        if (r.created) enqueued++;
        // consume the pending requests this plan admitted; mark the athlete planned
        const [s] = await db.select({ pending: athleteResearchState.pending }).from(athleteResearchState).where(eq(athleteResearchState.athlete_id, c.athleteId)).limit(1);
        const left = ((s?.pending ?? []) as PendingRequest[]).filter((p) => !c.domains.includes(p.domain));
        await db.update(athleteResearchState).set({ pending: left as any, last_planned_at: asOf, updated_at: new Date() }).where(eq(athleteResearchState.athlete_id, c.athleteId));
      }
    }
    const deferredCounts = Object.fromEntries(Object.entries(ev.deferred).map(([k, v]) => [k, v.length]));
    const budget = { limit: { runs: P.maxRunsPerNight, llmCalls: P.maxLlmCallsPerNight, usd: P.maxUsdPerNight, signalRuns: P.maxSignalRunsPerNight }, executedToday: { llmCalls: input.ledger.llmExecutedToday, signalCalls: input.ledger.signalsToday, otherCalls: input.ledger.otherToday, usd: input.ledger.usdExecutedToday, runs: input.ledger.runsToday }, reserved: { llmCalls: input.ledger.llmReserved, usd: input.ledger.usdReserved, queued: input.ledger.queuedAthleteIds.size }, planned: { runs: ev.admitted.length, llmCalls: ev.admitted.reduce((a, c) => a + c.reserveCalls, 0), usd: Math.round(ev.admitted.reduce((a, c) => a + c.estUsd, 0) * 10_000) / 10_000 }, remainingAfter: ev.remaining };
    const transitions = { ...ev.transitions, ...Object.fromEntries(Object.entries(ev.identity ?? {}).map(([k, v]) => [`identity:${k}`, v])), applied: mode === "enqueue" };
    await db.update(researchPlannerRuns).set({ status: "ok", finished_at: new Date(), evaluated: input.rows.length, would_materialize: ev.wouldMaterialize, transitions: transitions as any, candidates: ev.candidates.length + Object.values(ev.deferred).reduce((a, v) => a + v.length, 0), admitted: ev.admitted.length, deferred: deferredCounts as any, budget: budget as any, plans: plans as any }).where(eq(researchPlannerRuns.id, row.id));
    const summary: PlannerSummary = { plannerRunId: row.id, mode, status: "ok", evaluated: input.rows.length, wouldMaterialize: ev.wouldMaterialize, transitions, candidates: ev.candidates.length, admitted: ev.admitted.length, deferred: deferredCounts, enqueued, applied, budget, plans };
    logger.info({ ...summary, plans: undefined }, "research planner pass");
    return summary;
  } catch (err: any) {
    const message = redactMessage(err?.message ?? err, []);
    await db.update(researchPlannerRuns).set({ status: "failed", finished_at: new Date(), error: { reason: "error", message } as any }).where(eq(researchPlannerRuns.id, row.id)).catch(() => {});
    logger.error({ plannerRunId: row.id, error: message }, "research planner pass failed");
    return { plannerRunId: row.id, mode, status: "failed", evaluated: 0, wouldMaterialize: 0, transitions: {}, candidates: 0, admitted: 0, deferred: {}, enqueued: 0, budget: {}, plans: [] };
  }
}

