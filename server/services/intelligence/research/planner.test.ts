/**
 * planner.test.ts — the nightly planner on a real (PGlite) Postgres.
 *
 *   pure   evaluateNight: E1/E4 proposals, seed_only never planned, first full run, TTL/rescan/dispute/pending
 *          selection, priority, admission against executed + reserved, signals lane, failure back-off
 *   A.     dry-run makes ZERO mutations to athlete_research_state / workflow_runs / research_runs /
 *          research_budget_days and writes exactly one research_planner_runs row
 *   H.     each single-flag-true state is inert: dry_run, requestRefresh writes nothing (the connect callback's
 *          path), the monthly re-enrich runs its legacy body; both flags true engage everything
 *   enqueue: transitions applied, one research_refresh v2 run per admitted athlete with the day key, pending
 *          consumed, a second pass the same night enqueues nothing new
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../lib/pgAdvisoryLock", () => ({ LOCK_RESEARCH_PLANNER: 2n, LOCK_INBOX_SYNC: 1n, withAdvisoryLock: async (_k: bigint, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }) }));
jest.mock("../../../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn(async () => ({ snapshotId: "s", score: { displayScore: 0, tier: "t" } })) }));
jest.mock("../../../skills/researchRefresh", () => ({ runResearchRefresh: jest.fn(), REAL_REFRESH_PROVIDERS: {} }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athletes, athleteResearchState, researchBudgetDays, researchPlannerRuns, researchRuns, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { researchAthlete } from "../../../skills/researchAthlete";
import { runResearchRefresh } from "../../../skills/researchRefresh";
import { configureRunner, resetRunnerConfig } from "../../../workflow/runner";
import "../../../workflow/definitions/researchRefresh";   // registers research_refresh v1 + v2
import { DEFAULT_RESEARCH_POLICY, type ResearchPolicy } from "./policy";
import { evaluateNight, runResearchPlanner, type AthleteInfo, type StateRowLike } from "./planner";
import type { NightlyLedger } from "./ledger";
import { requestRefresh } from "./triggers";
import { reEnrichAllAthletes } from "../../../skills/reEnrichAthletes";
import { __resetResearchPolicyCache } from "./config";

const AT = new Date("2026-09-15T05:10:00.000Z");
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();
const ledger = (over: Partial<NightlyLedger> = {}): NightlyLedger => ({ day: "2026-09-15", llmExecutedToday: 0, signalsToday: 0, otherToday: 0, usdExecutedToday: 0, runsToday: 0, signalRunsToday: 0, llmReserved: 0, usdReserved: 0, queuedAthleteIds: new Set(), athletesRunToday: new Set(), ...over });
const policyWith = (planner: Partial<ResearchPolicy["planner"]>): ResearchPolicy => ({ ...DEFAULT_RESEARCH_POLICY, planner: { ...DEFAULT_RESEARCH_POLICY.planner, ...planner } });
const row = (athleteId: string, over: Partial<StateRowLike> = {}): StateRowLike => ({ athleteId, researchStatus: "seed_only", identityConfidence: 0, identityResolvedAt: null, domains: {}, disputedDomains: [], pending: [], refreshFailures: {}, updatedAt: iso(AT), virtual: false, ...over });
const info = (athleteId: string, over: Partial<AthleteInfo> = {}): AthleteInfo => ({ athleteId, status: "enriched", hasIdentitySignal: true, realUser: false, ...over });
const completeDomains = (lastResearchedAt: Date, ttlDays: Record<string, number | null>) => Object.fromEntries(["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"].map((d) => {
  const fam = ({ profile: "affiliations", identity: "identity", affiliations: "affiliations", achievements: "achievements", press: "press", brand_mentions: "brand_mentions", narrative: "narrative", social_handles: "social_handles", signals: "signals" } as Record<string, string>)[d];
  const ttl = ttlDays[fam];
  return [d, { status: "complete", lastRunId: "r0", lastResearchedAt: iso(lastResearchedAt), staleAfter: ttl == null ? null : iso(new Date(lastResearchedAt.getTime() + ttl * DAY)), blockingDispute: false }];
}));

describe("evaluateNight (pure)", () => {
  const policy = DEFAULT_RESEARCH_POLICY;
  const evalWith = (rows: StateRowLike[], infos: AthleteInfo[], over: { ledger?: Partial<NightlyLedger>; policy?: ResearchPolicy; active?: string[] } = {}) =>
    evaluateNight({ rows, athletes: new Map(infos.map((i) => [i.athleteId, i])), policy: over.policy ?? policy, ledger: ledger(over.ledger), asOf: AT, activeAthletes: new Set(over.active ?? []) });

  it("seed_only without an identity signal is never planned; with one it becomes identity_resolved (E1) and gets the first full run", () => {
    const ev = evalWith([row("a"), row("b")], [info("a", { hasIdentitySignal: false }), info("b")]);
    expect(ev.candidates.map((c) => c.athleteId)).toEqual(["b"]);
    expect(ev.candidates[0]).toMatchObject({ full: true, trigger: "identity_confirmed" });
    expect(ev.transitions).toEqual({ "seed_only>identity_resolved": 1 });
    expect(ev.proposed[0].after).toMatchObject({ researchStatus: "identity_resolved", identityConfidence: 1 });
  });

  it("E4: an expired complete domain becomes stale and research_complete becomes research_stale; a partial athlete never becomes stale", () => {
    const old = new Date(AT.getTime() - 40 * DAY);
    const complete = row("c", { researchStatus: "research_complete", identityResolvedAt: iso(old), domains: completeDomains(old, policy.ttlDays) });
    const partial = row("p", { researchStatus: "research_partial", identityResolvedAt: iso(old), domains: { ...completeDomains(old, policy.ttlDays), identity: { status: "missing", lastRunId: null, lastResearchedAt: null, staleAfter: null } } });
    const ev = evalWith([complete, partial], [info("c"), info("p")]);
    expect(ev.transitions["research_complete>research_stale"]).toBe(1);
    expect(ev.transitions["research_partial>research_stale"]).toBeUndefined();
    const c = ev.candidates.find((x) => x.athleteId === "c")!;
    expect(c.domains).toEqual(expect.arrayContaining(["press", "signals"]));   // 30-day TTLs expired
    expect(c.domains).not.toContain("achievements");                            // never expires; rescan at 90 d
    expect(c.trigger).toBe("ttl");
  });

  it("rescan for a never-expiring domain, dispute re-check cadence and cap, failure back-off exclusion", () => {
    const old = new Date(AT.getTime() - 100 * DAY);
    const domains = completeDomains(new Date(AT.getTime() - 1 * DAY), policy.ttlDays);
    domains.achievements = { ...domains.achievements, lastResearchedAt: iso(old) };
    domains.brand_mentions = { ...domains.brand_mentions, status: "disputed", lastResearchedAt: iso(new Date(AT.getTime() - 31 * DAY)) };
    domains.social_handles = { ...domains.social_handles, status: "stale" };
    const r = row("r", { researchStatus: "research_complete", identityResolvedAt: iso(old), domains, refreshFailures: { social_handles: { count: 3, deferredUntil: iso(new Date(AT.getTime() + 3 * DAY)) }, brand_mentions: { count: 0, disputeRechecks: 1 } } });
    const ev = evalWith([r], [info("r")]);
    const c = ev.candidates[0];
    expect(c.domains).toContain("achievements");
    expect(c.domains).toContain("brand_mentions"); expect(c.dueToDispute).toEqual(["brand_mentions"]);
    expect(c.domains).not.toContain("social_handles");   // deferred by failure back-off
    // dispute re-checks exhausted ⇒ not planned
    const r2 = { ...r, refreshFailures: { ...r.refreshFailures, brand_mentions: { count: 0, disputeRechecks: 3 } } };
    expect(evalWith([r2], [info("r")]).candidates[0].domains).not.toContain("brand_mentions");
  });

  it("pending manual/event requests outrank TTL; real users outrank raw; budget admission subtracts executed + reserved; the signals lane is separate", () => {
    const old = new Date(AT.getTime() - 40 * DAY);
    const mk = (id: string, over: Partial<StateRowLike> = {}) => row(id, { researchStatus: "research_stale", identityResolvedAt: iso(old), domains: completeDomains(old, policy.ttlDays), ...over });
    const rows = [mk("ttl_raw"), mk("ttl_real"), mk("manual", { pending: [{ domain: "press", trigger: "manual", reason: "admin", requestedAt: iso(AT) }] }), mk("event", { pending: [{ domain: "identity", trigger: "event", reason: "connect:instagram", requestedAt: iso(AT) }] })];
    const infos = [info("ttl_raw"), info("ttl_real", { realUser: true }), info("manual"), info("event")];
    const ev = evalWith(rows, infos, { policy: policyWith({ maxRunsPerNight: 10, maxLlmCallsPerNight: 20 }), ledger: { llmExecutedToday: 6, llmReserved: 6 } });
    expect(ev.candidates.map((c) => c.athleteId)).toEqual(["manual", "event", "ttl_real", "ttl_raw"]);
    // 20 − 6 executed − 6 reserved = 8 LLM calls left. manual (press + signals: 1 query + 1 extraction + 2 allowance = 4) is admitted;
    // event also needs identity (2 queries ⇒ 5) and no longer fits, so it is deferred for budget while ttl_real (4) still fits.
    expect(ev.candidates.find((c) => c.athleteId === "event")!.reserveCalls).toBe(5);
    expect(ev.admitted.map((c) => c.athleteId)).toEqual(["manual", "ttl_real"]);
    expect(ev.deferred.budget.map((c) => c.athleteId)).toEqual(["event", "ttl_raw"]);
    expect(ev.admitted[0].reserveCalls).toBe(4);
    // a signals-only plan draws on the signals lane, not the LLM budget
    const sig = row("sig", { researchStatus: "research_stale", identityResolvedAt: iso(old), domains: { ...completeDomains(new Date(AT.getTime() - 1 * DAY), policy.ttlDays), signals: { status: "stale", lastRunId: "r0", lastResearchedAt: iso(old), staleAfter: iso(new Date(old.getTime() + 30 * DAY)) } } });
    const ev2 = evalWith([sig], [info("sig")], { ledger: { llmExecutedToday: 150 } });
    expect(ev2.admitted[0]).toMatchObject({ athleteId: "sig", signalsOnly: true, llmCalls: 0 });
  });

  it("an athlete with an active or queued refresh run, or a run already today, is skipped", () => {
    const old = new Date(AT.getTime() - 40 * DAY);
    const mk = (id: string) => row(id, { researchStatus: "research_stale", identityResolvedAt: iso(old), domains: completeDomains(old, policy.ttlDays) });
    const ev = evalWith([mk("active"), mk("queued"), mk("today"), mk("free")], [info("active"), info("queued"), info("today"), info("free")], { active: ["active"], ledger: { queuedAthleteIds: new Set(["queued"]), athletesRunToday: new Set(["today"]) } });
    expect(ev.admitted.map((c) => c.athleteId)).toEqual(["free"]);
    expect(ev.deferred.active_run.map((c) => c.athleteId).sort()).toEqual(["active", "queued"]);
    expect(ev.deferred.athlete_daily_cap.map((c) => c.athleteId)).toEqual(["today"]);
  });
});

// ─── against the database ─────────────────────────────────────────────────────
describe("runResearchPlanner", () => {
  let connected: string, expired: string, rawNoState: string;
  const snapshot = async () => JSON.stringify({
    state: (await db.select().from(athleteResearchState)).sort((a, b) => a.athlete_id.localeCompare(b.athlete_id)),
    wf: await db.select().from(workflowRuns), runs: await db.select().from(researchRuns), days: await db.select().from(researchBudgetDays),
  });
  const setFlags = (refresh: string | undefined, substrate: string | undefined) => {
    if (refresh === undefined) delete process.env.RESEARCH_REFRESH_ENABLED; else process.env.RESEARCH_REFRESH_ENABLED = refresh;
    if (substrate === undefined) delete process.env.RESEARCH_SUBSTRATE_WRITE; else process.env.RESEARCH_SUBSTRATE_WRITE = substrate;
    __resetResearchPolicyCache();
  };

  beforeAll(async () => {
    await initTestDb();
    resetRunnerConfig(); configureRunner({ retry: { randomize: false } });
    connected = await seedAthlete("Planner Connected");
    await db.update(athletes).set({ status: "enriched", sport: "soccer" } as any).where(eq(athletes.id, connected));
    await seedConnection({ athleteId: connected, platform: "instagram", email: "conn" });
    expired = await seedAthlete("Planner Expired");
    await db.update(athletes).set({ status: "active", sport: "soccer", auth_id: "auth-x" } as any).where(eq(athletes.id, expired));
    const old = new Date(AT.getTime() - 40 * DAY);
    await db.insert(athleteResearchState).values({ athlete_id: expired, research_status: "research_complete", identity_confidence: "1.00", identity_resolved_at: old, domains: completeDomains(old, DEFAULT_RESEARCH_POLICY.ttlDays) as any, last_researched_at: old, next_due_at: new Date(old.getTime() + 30 * DAY), updated_at: old });
    rawNoState = await seedAthlete("Planner Raw");
    await db.update(athletes).set({ status: "raw", sport: "soccer" } as any).where(eq(athletes.id, rawNoState));
  });
  afterAll(closeTestDb);
  afterEach(() => setFlags(undefined, undefined));

  it("A. dry-run (flags off) evaluates and records the plan but mutates nothing", async () => {
    setFlags("false", "false");
    const before = await snapshot();
    const s = await runResearchPlanner({ asOf: AT });
    expect(s.mode).toBe("dry_run"); expect(s.status).toBe("ok");
    expect(s.wouldMaterialize).toBe(2);                                                    // connected + raw have no state row
    expect(s.transitions).toMatchObject({ materialize: 2, "seed_only>identity_resolved": 1, "research_complete>research_stale": 1, applied: false });
    expect(s.admitted).toBe(2);                                                            // connected: first full run; expired: stale press/signals
    expect(s.enqueued).toBe(0);
    expect(await snapshot()).toBe(before);
    const rows = await db.select().from(researchPlannerRuns);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ mode: "dry_run", status: "ok", admitted: 2, would_materialize: 2 });
  });

  it("H. each single-flag-true state is inert: dry_run, no requestRefresh write, the monthly re-enrich runs its legacy body", async () => {
    for (const [refresh, substrate] of [["true", "false"], ["false", "true"]] as const) {
      setFlags(refresh, substrate);
      const before = await snapshot();
      const s = await runResearchPlanner({ asOf: AT });
      expect(s.mode).toBe("dry_run"); expect(s.enqueued).toBe(0);
      expect(await snapshot()).toBe(before);
      // the connect callback's request path writes nothing
      expect(await requestRefresh(connected, ["identity", "social_handles"], "event", "connect:instagram", AT)).toBeNull();
      expect(await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, connected))).toHaveLength(0);
      expect(await snapshot()).toBe(before);
      // the legacy sweep still runs (mocked researchAthlete is called for the enriched/active roster)
      (researchAthlete as jest.Mock).mockClear();
      const r = await reEnrichAllAthletes({ concurrency: 2 });
      expect(r.skipped).toBeUndefined(); expect((researchAthlete as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    }
  });

  it("enqueue mode (both flags): transitions applied, one v2 run per admitted athlete keyed by day, pending consumed, nothing executes; a second pass adds nothing", async () => {
    setFlags("true", "true");
    // a queued manual request for the expired athlete
    expect(await requestRefresh(expired, ["brand_mentions"], "manual", "admin re-research", AT)).toEqual({ queued: 1 });
    // the monthly sweep is superseded
    (researchAthlete as jest.Mock).mockClear();
    expect((await reEnrichAllAthletes()).skipped).toBe(true); expect((researchAthlete as jest.Mock).mock.calls.length).toBe(0);
    const s = await runResearchPlanner({ asOf: AT });
    expect(s.mode).toBe("enqueue"); expect(s.status).toBe("ok");
    expect(s.applied).toMatchObject({ skipped: 0 }); expect(s.applied!.applied).toBeGreaterThanOrEqual(2);
    expect(s.enqueued).toBe(2);
    const states = await db.select().from(athleteResearchState);
    expect(states.find((x) => x.athlete_id === connected)).toMatchObject({ research_status: "identity_resolved" });
    expect(states.find((x) => x.athlete_id === rawNoState)).toMatchObject({ research_status: "seed_only" });
    expect(states.find((x) => x.athlete_id === expired)).toMatchObject({ research_status: "research_stale", pending: [] });
    expect(states.find((x) => x.athlete_id === expired)!.last_planned_at!.toISOString()).toBe(iso(AT));
    const runs = await db.select().from(workflowRuns);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.idempotency_key).sort()).toEqual([`research_refresh:${connected}:2026-09-15`, `research_refresh:${expired}:2026-09-15`].sort());
    expect(runs.every((r) => r.definition_version === 2 && r.created_by === "schedule" && r.status === "running")).toBe(true);
    const expiredRun = runs.find((r) => r.athlete_id === expired)!;
    expect((expiredRun.input as any)).toMatchObject({ trigger: "manual", full: false });
    expect((expiredRun.input as any).domains).toEqual(expect.arrayContaining(["brand_mentions", "press", "signals"]));
    // nothing executed: steps are ready, no provider call, no research run row
    const steps = await db.select().from(workflowSteps);
    expect(steps.every((st) => st.status === "ready")).toBe(true);
    expect((runResearchRefresh as jest.Mock).mock.calls.length).toBe(0);
    expect(await db.select().from(researchRuns)).toHaveLength(0);
    // second pass the same night: the queued athletes are skipped, nothing new
    const s2 = await runResearchPlanner({ asOf: new Date(AT.getTime() + 60_000) });
    expect(s2.enqueued).toBe(0); expect(s2.admitted).toBe(0); expect(s2.deferred.active_run).toBe(2);
    expect(await db.select().from(workflowRuns)).toHaveLength(2);
  });
});
