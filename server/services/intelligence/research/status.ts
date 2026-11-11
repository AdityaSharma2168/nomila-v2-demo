/**
 * research/status.ts — the research status READ contract (PR E3; design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §6 and §5.6; arch research-acquisition-architecture.md §9.4).
 *
 * Read-only. Two INDEPENDENT axes, never merged:
 *   Axis 1 (per research domain) — what happened when the domain was researched:
 *     lifecycle  not_requested | queued | running | settled      DERIVED here, never stored (§5.6)
 *     outcome    refreshed | confirmed_empty | no_relevant | failed   (domains[d].outcome; null = never settled)
 *     status     missing | partial | complete | stale | disputed     (domains[d].status; `stale` also read-time)
 *     lastResearchedAt, staleAfter, failures (refresh_failures), heldBy (the pending entry's reason)
 *     producer   available | unavailable                          FROM CONFIGURATION, never from a run
 *   Axis 2 (athlete level) — WHO the research concerns: identity_resolution via readIdentityState (E1).
 *     null = no determination recorded. It is NOT pending. It is never derived from research_status,
 *     identity_confidence or identity_resolved_at (account-ownership signals), nor from any Axis 1 value.
 *
 * Kept distinct: not_requested (lifecycle) · in flight (queued / running) · confirmed_empty / no_relevant (outcome) ·
 * failed (outcome) · unavailable (producer). None of them is folded into another.
 *
 * Lifecycle precedence (§5.6): running > queued > settled > not_requested.
 *   running   a research_runs row `status='running'` covering d, started within ABANDONED_RUN_MS (a stuck row older
 *             than that is not in flight — arch §9.4 gap 6), OR the athlete's active research_refresh workflow run has
 *             a step covering d whose latest attempt is `running` with a live lease.
 *   queued    d is in `pending` (incl. identity_gate holds), OR the active run plans d and the covering step is not yet
 *             opened, is `ready` (incl. a retry waiting out its back-off), or is `running` with a lapsed lease (the
 *             runner's expireLeases re-readies or fails it).
 *   settled   domains[d].outcome is non-null.
 * Step coverage is per definition version (STEP_COVERAGE): v2 (one `refresh` step over mergePlan(input.domains)) and,
 * since PR E2a, v3 (one step per planned query q1…q6 covering domainsOfQuery(qN), plus `signals`). A run of an
 * unregistered version contributes nothing from its steps (its research_runs rows still count).
 * v1 (the admin legacy researchAthlete path) is not a substrate producer and is not registered.
 *
 * No route, no Concept 0.4 wiring (handoff). Backend vocabulary only. Issues SELECTs only.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db";
import { athleteResearchState, researchRuns, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { identityResolutionEnabled, researchPlannerExecutionEnabled, researchRefreshProviderBinding, type ResearchProviderBinding } from "./config";
import { readIdentityState, type IdentityDetail, type IdentityValue } from "./identityResolution";
import { DOMAIN_PLANS, FULL_PLAN_DOMAINS, mergePlan, SPEC_V1_DOMAIN_QUERIES } from "./plans";
import { DOMAIN_STATUSES, RESEARCH_DOMAINS, type DomainOutcome, type DomainStatus, type ResearchDomain } from "./registries";
import type { QueryId } from "./spec/researchSpecV1";
import { resolveV3Plan, type V3RunInput } from "./v3Stage";

export const RESEARCH_STATUS_CONTRACT = "research-status/1";

// ── the contract (§6) ─────────────────────────────────────────────────────────

export type DomainLifecycle = "not_requested" | "queued" | "running" | "settled";
export type SettledOutcome = Exclude<DomainOutcome, "not_planned">;
export type DomainProducer = "available" | "unavailable";

/** Axis 1 — per research domain: what happened when the domain was researched. */
export interface DomainResearchStatus {
  domain: ResearchDomain;
  lifecycle: DomainLifecycle;
  /** null = never settled. */
  outcome: SettledOutcome | null;
  status: DomainStatus;
  lastResearchedAt: string | null;
  staleAfter: string | null;
  failures: { count: number; deferredUntil: string | null } | null;
  /** The pending entry's reason when it is the identity gate: a cause, not a lifecycle value. */
  heldBy: "identity_gate" | null;
  /** From configuration, never from a run. */
  producer: DomainProducer;
}

export type IdentityBasis = "q1" | "athlete_confirmed" | "athlete_rejected";

/** Axis 2 — athlete level: who the research concerns. Read beside Axis 1, never folded into it. */
export interface IdentityResolutionStatus {
  /** null = no determination recorded (NOT pending). */
  value: IdentityValue;
  basis: IdentityBasis | null;
  reason: string | null;
  /** From identity_resolution_detail ONLY (never the legacy identity_confidence column). */
  confidence: number | null;
  /** When the in-force determination was made; null while pending (no determination is in force). */
  determinedAt: string | null;
  researchRunId: string | null;
}

export interface ResearchStatus {
  contract: typeof RESEARCH_STATUS_CONTRACT;
  athleteId: string;
  asOf: string;
  identity: IdentityResolutionStatus;
  domains: Record<ResearchDomain, DomainResearchStatus>;
}

// ── inputs to the pure derivation ─────────────────────────────────────────────

export interface StoredDomainEntry { status?: string | null; lastResearchedAt?: string | null; staleAfter?: string | null; outcome?: string | null }
export interface StoredFailureEntry { count?: number; deferredUntil?: string | null }
export interface StoredPendingEntry { domain?: string; reason?: string | null }

/** The athlete_research_state fields Axis 1 reads; null when the athlete has no row. */
export interface ResearchStateSnapshot {
  domains: Record<string, StoredDomainEntry | undefined>;
  pending: StoredPendingEntry[];
  refreshFailures: Record<string, StoredFailureEntry | undefined>;
}

/** The athlete's active (running | waiting) research_refresh workflow run. */
export interface ActiveRefreshRun { id: string; version: number; input: unknown }
/** One workflow_steps row of that run (every attempt; the latest attempt per step name is the one that counts). */
export interface RefreshStepRow { step: string; attempt: number; status: string; leaseUntil: string | null }
/** One research_runs row with status 'running'. */
export interface RunningResearchRun { id: string; domain: string; startedAt: string; planDomains: string[] | null }

/** Configuration only. Never a run. */
export interface ResearchStatusConfig {
  /** researchPlannerExecutionEnabled(): the planner/refresh producer may run. */
  executionEnabled: boolean;
  /** RESEARCH_REFRESH_PROVIDER; null when it is not a known binding (fails closed: no producer). */
  binding: ResearchProviderBinding | null;
  /** identityResolutionEnabled(): THE identity boundary (§5.7). False ⇒ Axis 2 reports null. */
  identityResolutionEnabled: boolean;
}

export interface DeriveInput {
  athleteId: string;
  asOf: Date;
  state: ResearchStateSnapshot | null;
  identity: { value: IdentityValue; detail: IdentityDetail | null } | null;
  activeRun: ActiveRefreshRun | null;
  steps: RefreshStepRow[];
  runningResearchRuns: RunningResearchRun[];
  config: ResearchStatusConfig;
}

// ── producer (configuration) ──────────────────────────────────────────────────

/**
 * Domains a configured producer can answer:
 *   - the planner/refresh process, when the one execution gate is open, under its binding:
 *       kimi (v2)   DOMAIN_PLANS: a query, the signals lane, or narrative re-extraction (every domain);
 *       direct (v3) research-spec/1 (SPEC_V1_DOMAIN_QUERIES non-empty) plus the signals lane carried into v3 (D13);
 * An unknown binding produces nothing.
 */
export function producedDomains(config: ResearchStatusConfig): Set<ResearchDomain> {
  const out = new Set<ResearchDomain>();
  if (config.executionEnabled && config.binding === "kimi") {
    for (const d of RESEARCH_DOMAINS) { const p = DOMAIN_PLANS[d]; if (p.queries.length || p.signals || p.narrativeOnly) out.add(d); }
  }
  if (config.executionEnabled && config.binding === "direct") {
    for (const d of RESEARCH_DOMAINS) if (SPEC_V1_DOMAIN_QUERIES[d].length) out.add(d);
    out.add("signals");
  }
  return out;
}

// ── step coverage (the E2a extension point) ───────────────────────────────────

/** What one workflow step of the active run says about the domains it covers. */
export interface StepCoverage { domains: ResearchDomain[]; state: "queued" | "running" | "finished" }

/** Latest attempt per step name. */
function latestAttempts(steps: RefreshStepRow[]): Map<string, RefreshStepRow> {
  const out = new Map<string, RefreshStepRow>();
  for (const s of steps) { const prev = out.get(s.step); if (!prev || s.attempt > prev.attempt) out.set(s.step, s); }
  return out;
}

/** A step row's in-flight state. Absent = not yet opened (queued). A `running` row whose lease lapsed waits to be re-claimed. */
export function stepState(row: RefreshStepRow | undefined, asOf: Date): StepCoverage["state"] {
  if (!row) return "queued";
  if (row.status === "ready") return "queued";
  if (row.status === "running") return row.leaseUntil && new Date(row.leaseUntil).getTime() < asOf.getTime() ? "queued" : "running";
  return "finished";   // done | failed | skipped | waiting (no await_human step in research_refresh)
}

const asDomains = (xs: unknown): ResearchDomain[] => (Array.isArray(xs) ? xs : []).filter((d): d is ResearchDomain => (RESEARCH_DOMAINS as readonly string[]).includes(d as string));

/**
 * Per definition version: the run's steps → the domains each covers and its state. A version that is not listed
 * contributes nothing from its steps. Version 3 was registered by PR E2a (§5.6 holds per query).
 */
export const STEP_COVERAGE: Readonly<Record<number, (run: ActiveRefreshRun, steps: RefreshStepRow[], asOf: Date) => StepCoverage[]>> = {
  /** v2: ONE `refresh` step over mergePlan(input.domains) (or the full plan), exactly as refresh.ts plans it. */
  2: (run, steps, asOf) => {
    const input = (run.input ?? {}) as { domains?: unknown; full?: unknown };
    const domains = mergePlan(input.full === true ? FULL_PLAN_DOMAINS : asDomains(input.domains)).domains;
    return [{ domains, state: stepState(latestAttempts(steps).get("refresh"), asOf) }];
  },
  /**
   * v3 (PR E2a): one step per PLANNED query (`q1` … `q6`, runInput.queries as resolveV3Plan normalizes it), covering
   * domainsOfQuery(qN), plus the `signals` step when the plan runs the signals lane. A gate-held or not-planned step
   * completes (`skipped`), so it reads finished; its held domains read queued from `pending` (heldBy identity_gate).
   * A run input resolveV3Plan refuses contributes nothing (a read never throws).
   */
  3: (run, steps, asOf) => {
    let plan: { queries: QueryId[]; signals: boolean };
    try { plan = resolveV3Plan(run.input as V3RunInput); } catch { return []; }
    const latest = latestAttempts(steps);
    return [
      ...plan.queries.map((q) => ({ domains: domainsOfQuery(q), state: stepState(latest.get(q.toLowerCase()), asOf) })),
      ...(plan.signals ? [{ domains: ["signals"] as ResearchDomain[], state: stepState(latest.get("signals"), asOf) }] : []),
    ];
  },
};

/** The domains a research-spec/1 query lands evidence in (the inverse of SPEC_V1_DOMAIN_QUERIES). For E2a's v3 coverage. */
export function domainsOfQuery(q: QueryId): ResearchDomain[] {
  return RESEARCH_DOMAINS.filter((d) => SPEC_V1_DOMAIN_QUERIES[d].includes(q));
}

/** A `running` research_runs row older than this is abandoned, not in flight (the planner's ABANDONED_RUN_MS). */
export const ABANDONED_RUN_MS = 30 * 60_000;

/** The domains a running research_runs row covers: its own domain; `refresh` → its summary.plan.domains; `full` → its plan, else every domain. */
export function researchRunDomains(r: RunningResearchRun): ResearchDomain[] {
  if (r.domain === "refresh") return asDomains(r.planDomains);
  if (r.domain === "full") return r.planDomains ? asDomains(r.planDomains) : [...RESEARCH_DOMAINS];
  return asDomains([r.domain]);
}

// ── the pure derivation ───────────────────────────────────────────────────────

const SETTLED: readonly string[] = ["refreshed", "confirmed_empty", "no_relevant", "failed"];
const BASES: readonly string[] = ["q1", "athlete_confirmed", "athlete_rejected"];

function identityAxis(i: DeriveInput): IdentityResolutionStatus {
  const none: IdentityResolutionStatus = { value: null, basis: null, reason: null, confidence: null, determinedAt: null, researchRunId: null };
  if (!i.config.identityResolutionEnabled || !i.identity || i.identity.value == null) return none;   // §5.7: boundary off ⇒ null
  const value = i.identity.value;
  const d = (i.identity.detail ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  if (value === "pending") return { ...none, value };
  return {
    value,
    basis: BASES.includes(d.basis as string) ? (d.basis as IdentityBasis) : null,
    reason: str(d.reason),
    confidence: typeof d.confidence === "number" ? d.confidence : null,
    determinedAt: str(d.at),
    researchRunId: str(d.researchRunId) ?? str(d.q1ResearchRunId),
  };
}

export function deriveResearchStatus(i: DeriveInput): ResearchStatus {
  const t = i.asOf.getTime();
  const running = new Set<ResearchDomain>();
  const queued = new Set<ResearchDomain>();
  const heldBy = new Set<ResearchDomain>();

  for (const r of i.runningResearchRuns) {
    if (t - new Date(r.startedAt).getTime() > ABANDONED_RUN_MS) continue;
    for (const d of researchRunDomains(r)) running.add(d);
  }
  if (i.activeRun) {
    const coverage = STEP_COVERAGE[i.activeRun.version]?.(i.activeRun, i.steps, i.asOf) ?? [];
    for (const c of coverage) for (const d of c.domains) {
      if (c.state === "running") running.add(d);
      else if (c.state === "queued") queued.add(d);
    }
  }
  for (const p of i.state?.pending ?? []) {
    const [d] = asDomains([p.domain]);
    if (!d) continue;
    queued.add(d);
    if (p.reason === "identity_gate") heldBy.add(d);
  }

  const produced = producedDomains(i.config);
  const domains = {} as Record<ResearchDomain, DomainResearchStatus>;
  for (const d of RESEARCH_DOMAINS) {
    const e = i.state?.domains[d];
    const outcome = e?.outcome && SETTLED.includes(e.outcome) ? (e.outcome as SettledOutcome) : null;
    let status: DomainStatus = e?.status && (DOMAIN_STATUSES as readonly string[]).includes(e.status) ? (e.status as DomainStatus) : "missing";
    if (status === "complete" && e?.staleAfter && new Date(e.staleAfter).getTime() <= t) status = "stale";   // the planner's read-time rule
    const f = i.state?.refreshFailures[d];
    domains[d] = {
      domain: d,
      lifecycle: running.has(d) ? "running" : queued.has(d) ? "queued" : outcome ? "settled" : "not_requested",
      outcome, status,
      lastResearchedAt: e?.lastResearchedAt ?? null,
      staleAfter: e?.staleAfter ?? null,
      failures: f ? { count: f.count ?? 0, deferredUntil: f.deferredUntil ?? null } : null,
      heldBy: heldBy.has(d) ? "identity_gate" : null,
      producer: produced.has(d) ? "available" : "unavailable",
    };
  }
  return { contract: RESEARCH_STATUS_CONTRACT, athleteId: i.athleteId, asOf: i.asOf.toISOString(), identity: identityAxis(i), domains };
}

// ── the reader (SELECTs only) ─────────────────────────────────────────────────

const safe = (f: () => boolean): boolean => { try { return f(); } catch { return false; } };

/** The current configuration. An unknown RESEARCH_REFRESH_PROVIDER fails closed (no producer, identity boundary off). */
export function currentStatusConfig(): ResearchStatusConfig {
  let binding: ResearchProviderBinding | null = null;
  try { binding = researchRefreshProviderBinding(); } catch { binding = null; }
  return {
    executionEnabled: safe(researchPlannerExecutionEnabled),
    binding,
    identityResolutionEnabled: safe(identityResolutionEnabled),
  };
}

export async function readResearchStatus(athleteId: string, opts: { asOf?: Date; config?: ResearchStatusConfig } = {}): Promise<ResearchStatus> {
  const asOf = opts.asOf ?? new Date();
  const [row] = await db.select({ domains: athleteResearchState.domains, pending: athleteResearchState.pending, refreshFailures: athleteResearchState.refresh_failures })
    .from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)).limit(1);
  const identity = await readIdentityState(athleteId);
  const [run] = await db.select({ id: workflowRuns.id, version: workflowRuns.definition_version, input: workflowRuns.input }).from(workflowRuns)
    .where(and(eq(workflowRuns.athlete_id, athleteId), eq(workflowRuns.process, "research_refresh"), inArray(workflowRuns.status, ["running", "waiting"])))
    .orderBy(desc(workflowRuns.started_at)).limit(1);
  const steps = run
    ? (await db.select({ step: workflowSteps.step, attempt: workflowSteps.attempt, status: workflowSteps.status, leaseUntil: workflowSteps.lease_until }).from(workflowSteps).where(eq(workflowSteps.run_id, run.id)))
        .map((s) => ({ ...s, leaseUntil: s.leaseUntil?.toISOString() ?? null }))
    : [];
  const rr = await db.select({ id: researchRuns.id, domain: researchRuns.domain, startedAt: researchRuns.started_at, summary: researchRuns.summary }).from(researchRuns)
    .where(and(eq(researchRuns.athlete_id, athleteId), eq(researchRuns.status, "running")));
  return deriveResearchStatus({
    athleteId, asOf,
    state: row ? { domains: (row.domains ?? {}) as ResearchStateSnapshot["domains"], pending: (row.pending ?? []) as StoredPendingEntry[], refreshFailures: (row.refreshFailures ?? {}) as ResearchStateSnapshot["refreshFailures"] } : null,
    identity,
    activeRun: run ? { id: run.id, version: run.version, input: run.input } : null,
    steps,
    runningResearchRuns: rr.map((r) => ({ id: r.id, domain: r.domain, startedAt: r.startedAt.toISOString(), planDomains: ((r.summary as any)?.plan?.domains ?? null) as string[] | null })),
    config: opts.config ?? currentStatusConfig(),
  });
}
