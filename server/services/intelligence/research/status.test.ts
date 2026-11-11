/**
 * status.test.ts — PR E3, the research status read contract, pure derivation (design record §6, §5.6; arch §9.4).
 *
 *   - every Axis 1 lifecycle (not_requested / queued / running / settled) and the §5.6 precedence
 *   - confirmed_empty vs no_relevant vs failed (outcome) vs unavailable (producer) vs not_requested / in flight (lifecycle)
 *   - heldBy: identity_gate only from a pending entry with that reason
 *   - producer from configuration only, never from a run
 *   - Axis 2: null ≠ pending; boundary off ⇒ null; provenance read from the detail only
 *   - axis independence
 *   - the E2a extension point: v3 registered (per-query steps + signals); an unregistered version contributes nothing
 *
 * No database, no provider.
 */

jest.mock("../../../db", () => ({ db: {}, pool: {} }));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { RESEARCH_DOMAINS, type ResearchDomain } from "./registries";
import {
  ABANDONED_RUN_MS, currentStatusConfig, deriveResearchStatus, domainsOfQuery, producedDomains, RESEARCH_STATUS_CONTRACT, STEP_COVERAGE,
  type DeriveInput, type ResearchStateSnapshot, type ResearchStatusConfig,
} from "./status";

const AS_OF = new Date("2026-10-01T12:00:00.000Z");
const ago = (ms: number) => new Date(AS_OF.getTime() - ms).toISOString();
const later = (ms: number) => new Date(AS_OF.getTime() + ms).toISOString();
const OFF: ResearchStatusConfig = { executionEnabled: false, binding: "kimi", identityResolutionEnabled: false };
const DIRECT_ON: ResearchStatusConfig = { executionEnabled: true, binding: "direct", identityResolutionEnabled: true };

const state = (s: Partial<ResearchStateSnapshot> = {}): ResearchStateSnapshot => ({ domains: {}, pending: [], refreshFailures: {}, ...s });
const derive = (i: Partial<DeriveInput> = {}) => deriveResearchStatus({ athleteId: "a-1", asOf: AS_OF, state: null, identity: null, activeRun: null, steps: [], runningResearchRuns: [], config: DIRECT_ON, ...i });
const lifecycles = (r: ReturnType<typeof derive>) => Object.fromEntries(RESEARCH_DOMAINS.map((d) => [d, r.domains[d].lifecycle]));
const v2 = (domains: ResearchDomain[], full = false) => ({ id: "wf-1", version: 2, input: { domains, full } });

describe("Axis 1 — lifecycle (§5.6)", () => {
  test("no state row, no run: every domain not_requested, outcome null, status missing", () => {
    const r = derive();
    expect(r.contract).toBe(RESEARCH_STATUS_CONTRACT);
    for (const d of RESEARCH_DOMAINS) expect(r.domains[d]).toEqual({ domain: d, lifecycle: "not_requested", outcome: null, status: "missing", lastResearchedAt: null, staleAfter: null, failures: null, heldBy: null, producer: "available" });
  });

  test("settled when an outcome exists; a stored null outcome (the missing-row entry persist writes) is not settled", () => {
    const r = derive({ state: state({ domains: { press: { status: "complete", outcome: "refreshed", lastResearchedAt: ago(1000), staleAfter: later(1000) }, achievements: { status: "missing", outcome: null } } }) });
    expect(r.domains.press).toMatchObject({ lifecycle: "settled", outcome: "refreshed", status: "complete", lastResearchedAt: ago(1000), staleAfter: later(1000) });
    expect(r.domains.achievements).toMatchObject({ lifecycle: "not_requested", outcome: null, status: "missing" });
  });

  test("queued from pending; heldBy is identity_gate only for that reason", () => {
    const r = derive({ state: state({ pending: [{ domain: "achievements", reason: "identity_gate" }, { domain: "press", reason: "connect:instagram" }, { domain: "not_a_domain", reason: "identity_gate" }] }) });
    expect(r.domains.achievements).toMatchObject({ lifecycle: "queued", heldBy: "identity_gate" });
    expect(r.domains.press).toMatchObject({ lifecycle: "queued", heldBy: null });
    expect(r.domains.brand_mentions).toMatchObject({ lifecycle: "not_requested", heldBy: null });
  });

  test("queued from the active v2 run: step not opened, or ready (a retry in back-off), or running with a lapsed lease", () => {
    for (const steps of [[], [{ step: "refresh", attempt: 1, status: "ready", leaseUntil: null }], [{ step: "refresh", attempt: 1, status: "failed", leaseUntil: null }, { step: "refresh", attempt: 2, status: "ready", leaseUntil: null }], [{ step: "refresh", attempt: 1, status: "running", leaseUntil: ago(1) }]]) {
      const r = derive({ activeRun: v2(["affiliations"]), steps });
      expect(r.domains.affiliations.lifecycle).toBe("queued");
      expect(r.domains.profile.lifecycle).toBe("queued");          // profile rides with affiliations (mergePlan), as refresh.ts runs it
      expect(r.domains.press.lifecycle).toBe("not_requested");
    }
  });

  test("running from the active v2 run's step (latest attempt, live lease); a finished step contributes nothing", () => {
    const r = derive({ activeRun: v2(["press", "signals"]), steps: [{ step: "refresh", attempt: 1, status: "failed", leaseUntil: null }, { step: "refresh", attempt: 2, status: "running", leaseUntil: later(60_000) }] });
    expect(r.domains.press.lifecycle).toBe("running");
    expect(r.domains.signals.lifecycle).toBe("running");
    expect(r.domains.identity.lifecycle).toBe("not_requested");
    const done = derive({ activeRun: v2(["press"]), steps: [{ step: "refresh", attempt: 1, status: "done", leaseUntil: null }] });
    expect(done.domains.press.lifecycle).toBe("not_requested");
  });

  test("a full v2 run covers the full plan", () => {
    const r = derive({ activeRun: { id: "wf-1", version: 2, input: { full: true } }, steps: [{ step: "refresh", attempt: 1, status: "running", leaseUntil: later(60_000) }] });
    for (const d of RESEARCH_DOMAINS) expect(r.domains[d].lifecycle).toBe("running");
  });

  test("running from research_runs status=running: a domain row, a `refresh` row by its plan, a `full` row; an abandoned row is not in flight", () => {
    const r = derive({ runningResearchRuns: [
      { id: "r1", domain: "achievements", startedAt: ago(60_000), planDomains: null },
      { id: "r2", domain: "refresh", startedAt: ago(60_000), planDomains: ["press", "narrative"] },
      { id: "r3", domain: "brand_mentions", startedAt: ago(ABANDONED_RUN_MS + 1), planDomains: null },
    ] });
    expect(r.domains.achievements.lifecycle).toBe("running");
    expect(r.domains.press.lifecycle).toBe("running");
    expect(r.domains.narrative.lifecycle).toBe("running");
    expect(r.domains.brand_mentions.lifecycle).toBe("not_requested");
    const full = derive({ runningResearchRuns: [{ id: "r4", domain: "full", startedAt: ago(1000), planDomains: null }] });
    for (const d of RESEARCH_DOMAINS) expect(full.domains[d].lifecycle).toBe("running");
    const refreshNoPlan = derive({ runningResearchRuns: [{ id: "r5", domain: "refresh", startedAt: ago(1000), planDomains: null }] });
    for (const d of RESEARCH_DOMAINS) expect(refreshNoPlan.domains[d].lifecycle).toBe("not_requested");
  });

  test("precedence running > queued > settled > not_requested; the outcome of the previous run stays visible", () => {
    const r = derive({
      state: state({ domains: { press: { status: "complete", outcome: "refreshed" }, achievements: { status: "complete", outcome: "refreshed" }, narrative: { status: "complete", outcome: "no_relevant" } }, pending: [{ domain: "press", reason: "manual" }, { domain: "achievements", reason: "manual" }] }),
      runningResearchRuns: [{ id: "r1", domain: "press", startedAt: ago(1000), planDomains: null }],
    });
    expect(r.domains.press).toMatchObject({ lifecycle: "running", outcome: "refreshed" });
    expect(r.domains.achievements).toMatchObject({ lifecycle: "queued", outcome: "refreshed" });
    expect(r.domains.narrative).toMatchObject({ lifecycle: "settled", outcome: "no_relevant" });
    expect(r.domains.identity.lifecycle).toBe("not_requested");
  });

  test("E2a extension point: v3 is registered; an unregistered definition version contributes nothing from its steps", () => {
    expect(Object.keys(STEP_COVERAGE)).toEqual(["2", "3"]);
    const r = derive({ activeRun: { id: "wf-9", version: 9, input: { queries: ["Q1"] } }, steps: [{ step: "q1", attempt: 1, status: "running", leaseUntil: later(60_000) }] });
    for (const d of RESEARCH_DOMAINS) expect(r.domains[d].lifecycle).toBe("not_requested");
    expect(domainsOfQuery("Q1")).toEqual(["identity", "profile", "affiliations"]);
    expect(domainsOfQuery("Q6")).toEqual(["profile", "press"]);
  });

  test("v3 (PR E2a): one coverage entry per planned query step covering domainsOfQuery(qN), plus signals; held steps read finished", () => {
    // q1 done, q2 running (live lease), q3 not yet opened; signals planned; Q4–Q6 not planned
    const run = { id: "wf-3", version: 3, input: { queries: ["Q1", "Q2", "Q3"], signals: true, governIdentity: true } };
    const r = derive({ activeRun: run, steps: [{ step: "q1", attempt: 1, status: "done", leaseUntil: null }, { step: "q2", attempt: 1, status: "running", leaseUntil: later(60_000) }] });
    expect(r.domains.achievements.lifecycle).toBe("running");                                   // q2
    expect(r.domains.press.lifecycle).toBe("queued");                                           // q3 not opened
    expect(r.domains.narrative.lifecycle).toBe("queued");
    expect(r.domains.signals.lifecycle).toBe("queued");                                         // signals step not opened
    expect(r.domains.identity.lifecycle).toBe("not_requested");                                 // q1 finished, nothing settled here
    expect(r.domains.brand_mentions.lifecycle).toBe("not_requested");                           // Q4 not planned
    // an identity-gate hold: the step completes (finished) and the domain reads queued from pending with heldBy
    const held = derive({ activeRun: { ...run, input: { queries: ["Q1", "Q2"], signals: false, governIdentity: true } }, steps: [{ step: "q1", attempt: 1, status: "done", leaseUntil: null }, { step: "q2", attempt: 1, status: "done", leaseUntil: null }], state: state({ pending: [{ domain: "achievements", reason: "identity_gate" }] }) });
    expect(held.domains.achievements).toMatchObject({ lifecycle: "queued", heldBy: "identity_gate" });
    // a run input v3 refuses contributes nothing (a read never throws)
    expect(STEP_COVERAGE[3]({ id: "wf-x", version: 3, input: { trigger: "nightly" } }, [], AS_OF)).toEqual([]);
  });
});

describe("Axis 1 — outcome, status, failures, producer kept apart", () => {
  test("confirmed_empty vs no_relevant vs failed vs unavailable vs not_requested vs in flight: six distinct readings", () => {
    const r = derive({
      config: { ...OFF, executionEnabled: true, binding: "kimi" },
      state: state({
        domains: { achievements: { status: "missing", outcome: "confirmed_empty", lastResearchedAt: ago(1000) }, press: { status: "missing", outcome: "no_relevant" }, brand_mentions: { status: "missing", outcome: "failed" } },
        refreshFailures: { brand_mentions: { count: 3, deferredUntil: later(7 * 86_400_000) } },
        pending: [{ domain: "narrative", reason: "manual" }],
      }),
    });
    expect(r.domains.achievements).toMatchObject({ lifecycle: "settled", outcome: "confirmed_empty", failures: null, producer: "available" });
    expect(r.domains.press).toMatchObject({ lifecycle: "settled", outcome: "no_relevant", failures: null });
    expect(r.domains.brand_mentions).toMatchObject({ lifecycle: "settled", outcome: "failed", failures: { count: 3, deferredUntil: later(7 * 86_400_000) } });
    expect(r.domains.narrative).toMatchObject({ lifecycle: "queued", outcome: null });
    expect(r.domains.identity).toMatchObject({ lifecycle: "not_requested", outcome: null });
    // unavailable is a producer fact, never an outcome: the same stored state under a configuration with no producer
    const off = derive({ config: OFF, state: state({ domains: { achievements: { status: "missing", outcome: "confirmed_empty" } } }) });
    expect(off.domains.achievements).toMatchObject({ lifecycle: "settled", outcome: "confirmed_empty", producer: "unavailable" });
    expect(off.domains.identity).toMatchObject({ lifecycle: "not_requested", outcome: null, producer: "unavailable" });
  });

  test("not_planned and unknown stored values never surface as outcome/status", () => {
    const r = derive({ state: state({ domains: { press: { status: "bogus", outcome: "not_planned" } } }) });
    expect(r.domains.press).toMatchObject({ outcome: null, status: "missing", lifecycle: "not_requested" });
  });

  test("status: stored value; complete past staleAfter reads stale (the planner's read-time rule)", () => {
    const r = derive({ state: state({ domains: { press: { status: "complete", outcome: "refreshed", staleAfter: ago(1) }, achievements: { status: "disputed", outcome: "refreshed" }, narrative: { status: "partial", outcome: "refreshed" } } }) });
    expect(r.domains.press.status).toBe("stale");
    expect(r.domains.achievements.status).toBe("disputed");
    expect(r.domains.narrative.status).toBe("partial");
  });

  test("producer comes from configuration only", () => {
    expect([...producedDomains(OFF)]).toEqual([]);
    expect([...producedDomains({ ...OFF, executionEnabled: true, binding: "kimi" })].sort()).toEqual([...RESEARCH_DOMAINS].sort());
    expect([...producedDomains({ ...OFF, executionEnabled: true, binding: "direct" })].sort()).toEqual([...RESEARCH_DOMAINS].sort());   // signals via D13
    expect([...producedDomains({ ...OFF, executionEnabled: true, binding: null })]).toEqual([]);                                      // unknown binding fails closed
    expect([...producedDomains({ ...OFF, executionEnabled: false, binding: "direct" })]).toEqual([]);                                 // binding without the gate
    // never from a run: a running domain under a no-producer configuration is still unavailable, and vice versa
    const r = derive({ config: OFF, runningResearchRuns: [{ id: "r1", domain: "press", startedAt: ago(1000), planDomains: null }] });
    expect(r.domains.press).toMatchObject({ lifecycle: "running", producer: "unavailable" });
  });

  test("currentStatusConfig reads the flags; an unknown binding fails closed", () => {
    const env = process.env;
    try {
      process.env = { ...env, RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
      expect(currentStatusConfig()).toEqual({ executionEnabled: true, binding: "direct", identityResolutionEnabled: true });
      process.env = { ...env, RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "nope" };
      expect(currentStatusConfig()).toEqual({ executionEnabled: true, binding: null, identityResolutionEnabled: false });
      process.env = { ...env }; for (const k of ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER"]) delete process.env[k];
      expect(currentStatusConfig()).toEqual({ executionEnabled: false, binding: "kimi", identityResolutionEnabled: false });
    } finally { process.env = env; }
  });
});

describe("Axis 2 — identity resolution", () => {
  const NULL_IDENTITY = { value: null, basis: null, reason: null, confidence: null, determinedAt: null, researchRunId: null };

  test("null ≠ pending: no row / NULL column reads null; pending reads pending with no determination in force", () => {
    expect(derive({ identity: null }).identity).toEqual(NULL_IDENTITY);
    expect(derive({ identity: { value: null, detail: null } }).identity).toEqual(NULL_IDENTITY);
    const p = derive({ identity: { value: "pending", detail: { at: ago(1000), trigger: "signup", by: null, anchorHash: "h", previous: null } } }).identity;
    expect(p).toEqual({ ...NULL_IDENTITY, value: "pending" });
    expect(p.value).not.toBeNull();
  });

  test("the boundary off (identityResolutionEnabled false) reports null even when a value is stored (§5.7)", () => {
    expect(derive({ config: { ...DIRECT_ON, identityResolutionEnabled: false }, identity: { value: "resolved", detail: { at: ago(1), basis: "q1", researchRunId: "rr", confidence: 0.9 } as any } }).identity).toEqual(NULL_IDENTITY);
  });

  test("provenance comes from the detail: q1 resolved / ambiguous / failed, athlete_confirmed, athlete_rejected", () => {
    const q1 = (value: "resolved" | "ambiguous" | "failed", reason?: string) => derive({ identity: { value, detail: { at: ago(10), basis: "q1", researchRunId: "rr-q1", workflowRunId: "wf", queryId: "Q1", anchorMatch: "matched", confidence: 0.82, namesakes: 0, namesakeEvidenceIds: [], anchorHash: "h", previous: null, ...(reason ? { reason } : {}) } as any } }).identity;
    expect(q1("resolved")).toEqual({ value: "resolved", basis: "q1", reason: null, confidence: 0.82, determinedAt: ago(10), researchRunId: "rr-q1" });
    expect(q1("ambiguous", "namesakes_unseparated")).toMatchObject({ value: "ambiguous", basis: "q1", reason: "namesakes_unseparated" });
    expect(q1("failed", "no_public_match")).toMatchObject({ value: "failed", basis: "q1", reason: "no_public_match" });
    expect(derive({ identity: { value: "resolved", detail: { at: ago(5), basis: "athlete_confirmed", assertedId: "as", evidenceIds: [], q1ResearchRunId: "rr-q1", by: "u", previous: null } } }).identity)
      .toEqual({ value: "resolved", basis: "athlete_confirmed", reason: null, confidence: null, determinedAt: ago(5), researchRunId: "rr-q1" });
    expect(derive({ identity: { value: "ambiguous", detail: { at: ago(5), basis: "athlete_rejected", assertedId: "as", by: "u", previous: null } } }).identity)
      .toEqual({ value: "ambiguous", basis: "athlete_rejected", reason: null, confidence: null, determinedAt: ago(5), researchRunId: null });
  });
});

describe("the two axes are independent", () => {
  test("identity ambiguous + achievements not_requested; identity resolved never settles or queues a domain", () => {
    const r = derive({ identity: { value: "ambiguous", detail: { at: ago(1), basis: "q1", researchRunId: "rr", reason: "uncertain" } as any } });
    expect(r.identity.value).toBe("ambiguous");
    expect(r.domains.achievements.lifecycle).toBe("not_requested");
    expect(r.domains.identity.lifecycle).toBe("not_requested");        // the identity DOMAIN is not the identity AXIS
  });

  test("Axis 1 is identical whatever Axis 2 holds, and Axis 2 is identical whatever Axis 1 holds", () => {
    const s = state({ domains: { identity: { status: "complete", outcome: "refreshed" }, press: { status: "missing", outcome: "failed" } }, pending: [{ domain: "achievements", reason: "identity_gate" }] });
    const idents = [null, { value: null, detail: null }, { value: "pending" as const, detail: { at: ago(1) } as any }, { value: "resolved" as const, detail: { at: ago(1), basis: "q1", researchRunId: "rr" } as any }, { value: "failed" as const, detail: { at: ago(1), basis: "q1", researchRunId: "rr", reason: "no_public_match" } as any }];
    const domainViews = idents.map((identity) => derive({ state: s, identity }).domains);
    for (const v of domainViews) expect(v).toEqual(domainViews[0]);
    const ident = { value: "pending" as const, detail: { at: ago(1) } as any };
    expect(derive({ identity: ident }).identity).toEqual(derive({ identity: ident, state: s, runningResearchRuns: [{ id: "r", domain: "full", startedAt: ago(1), planDomains: null }] }).identity);
    expect(lifecycles(derive({ state: s }))).toMatchObject({ identity: "settled", press: "settled", achievements: "queued" });
  });
});
