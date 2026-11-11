/**
 * researchRefreshV3.test.ts — PR E2a: research_refresh v3 on the real runner and a real (PGlite) Postgres, with the
 * provider boundary mocked (geminiDirect, Trends, GDELT are jest.fn fakes; nothing reaches a network).
 *
 *   - the definition: opt-in (default stays v2), q1 … q6 + signals, sequential, the lease fits the 60 s per-call timeout
 *   - the Q1 gate per classifier outcome (design record §5.3): resolved → Q2–Q6 + signals run and persist; ambiguous /
 *     failed → held (identity_gate) in `pending`, zero calls, zero rows; T5 → nothing written to the determination,
 *     back-off recorded; CAS: a late Q1 never overwrites an athlete's confirmation, a lost CAS is a result
 *   - observed (governIdentity false): nothing written, Q2–Q6 still run, `wouldGate` recorded (D9)
 *   - per-query persistence: one row per query with query_id; ACCEPTANCE vs SETTLE (profile accepted from Q1, settled
 *     only by Q6); a timeout is counted and the run continues; run reuse per (workflow run, query); abandoned row closed
 *   - Q5 narrowing (D12); the signals step = v2's lane (same outcome and counters), gated
 *   - flags off / binding kimi → nothing new runs
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../../../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
// Grounding-redirect resolution makes one HTTP request in production; here it resolves nothing unless a test says so.
jest.mock("../../../lib/research/providers/groundingRedirect", () => ({ resolveGroundingRedirect: jest.fn(async () => null), isGroundingRedirect: () => false }));
// The YouTube oEmbed lookup (existence + title) makes one HTTP request in production; here every video exists (no title) unless a test says so.
jest.mock("../../../lib/research/providers/youtubeOEmbed", () => ({ youtubeVideoInfo: jest.fn(async () => ({ exists: true, title: null })) }));
jest.mock("../../../lib/research/providers/geminiGrounded", () => ({ groundedSearch: jest.fn(), GEMINI_PROVIDER_ID: "gemini_grounded" }));
jest.mock("../../../lib/research/providers/kimiExtract", () => ({ extractWithCitations: jest.fn() }));
jest.mock("../../../lib/trends", () => ({ fetchGoogleTrends: jest.fn() }));
jest.mock("../../../lib/gdelt", () => ({ fetchGdelt: jest.fn() }));
jest.mock("../../../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn() }));

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athleteResearchState, athletes, researchBudgetDays, researchEvidence, researchRuns, researchSourcePayloads, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { configureRunner, getRun, resetRunnerConfig, startRun } from "../../../workflow/runner";
import { getDefinition } from "../../../workflow/registry";
import { V3_READ_LEASE_MS, V3_STEP_LEASE_MS } from "../../../workflow/definitions/researchRefresh";
import type { DirectCallOpts, DirectCallResult } from "../../../lib/research/providers/geminiDirect";
import { REAL_REFRESH_PROVIDERS, runResearchRefreshV3Query, runResearchRefreshV3Read } from "../../../skills/researchRefresh";
import type { SourceReadInput, SourceReadOpts, SourceReadResult } from "../../../lib/research/providers/geminiSourceRead";
import { __resetResearchPolicyCache, DEFAULT_GEMINI_CALL_TIMEOUT_MS, DEFAULT_PLANNER_POLICY, DEFAULT_RESEARCH_POLICY } from "./config";
import { nightlyLedger, reserveLlmCall } from "./ledger";
import * as identityResolution from "./identityResolution";
import { applyIdentityTransition, readIdentityState } from "./identityResolution";
import { refreshAthlete } from "./refresh";
import { resolveV3Plan, type V3QueryOutput } from "./v3Stage";
import type { Finding } from "./spec/directEvidenceV2";
import type { QueryId, SectionId } from "./spec/researchSpecV1";

// ── the fake provider boundary ────────────────────────────────────────────────
type Anchor = "matched" | "uncertain" | "not_resolved" | null;
interface F { section: SectionId; item: string; value: Record<string, unknown>; statement: string }
/** A grounding chunk the (fake) search retrieved: production-shaped (a grounding redirect link, web.domain, web.title). */
interface G { url: string; domain: string; title: string }
interface Spec { anchor?: Anchor; confidence?: number | null; namesakes?: number; findings?: F[]; notFound?: string[]; completed?: boolean; attempts?: number; usd?: number; onCall?: () => Promise<void>; chunks?: G[] }
const URL0 = "https://example.edu/roster/jane-doe";
/** Attempts that actually reached the (fake) provider: only after a successful reservation. */
const providerCalls = { n: 0 };

async function fakeDirect(opts: DirectCallOpts, spec: Spec): Promise<DirectCallResult> {
  if (spec.onCall) await spec.onCall();
  const env = opts.envelopeId;
  const attemptsWanted = spec.attempts ?? 1;
  let attempts = 0, refused = false;
  // geminiDirect's contract: reserve() BEFORE every attempt; a false ⇒ no provider call, a `budget` error, stop.
  let refusalError: { step: string; message: string; class: string } | null = null;
  for (let n = 0; n < attemptsWanted; n++) {
    if (!(await opts.reserve())) { refused = true; refusalError = { step: `attempt-${n + 1}`, message: "LLM budget reservation refused — no call made", class: "budget" }; break; }
    attempts++; providerCalls.n++;
  }
  const completed = !refused && spec.completed !== false;
  const findings: Finding[] = (spec.findings ?? []).map((f) => ({ section: f.section, item: f.item, value: f.value, statement: f.statement, asOf: "2026-10-01", sources: [{ url: URL0, title: null, publishedAt: null, quote: f.statement }],
    lineage: { level: "native_supported", match: "index_support", boundChunkIds: [`${env}:c0`], boundSources: [{ url: URL0, domain: "example.edu", title: null }], detail: null, bindingMethod: "quote_exact" } }));
  const items: Record<string, { status: "found" | "not_found"; reason: null; findings: Finding[] }> = {};
  for (const f of findings) (items[f.item] ??= { status: "found", reason: null, findings: [] }).findings.push(f);
  for (const id of spec.notFound ?? []) items[id] = { status: "not_found", reason: null, findings: [] };
  const namesakes = Array.from({ length: spec.namesakes ?? 0 }, (_, i) => ({ description: `another Jane Doe #${i + 1}`, sourceUrl: null }));
  return {
    envelope: { id: env, provider: "gemini_direct", model: "gemini-test", queryName: opts.queryName, query: "(fake)", fetchedAt: "2026-10-01T00:00:00.000Z", answerText: findings.map((f) => f.statement).join(" "),
      chunks: [{ id: `${env}:c0`, url: URL0, domain: "example.edu", title: "Roster", text: findings.map((f) => f.statement).join(" "), textKind: "provider_answer_segments" },
        ...(spec.chunks ?? []).map((g, i) => ({ id: `${env}:c${i + 1}`, url: g.url, domain: g.domain, title: g.title, text: "", textKind: "provider_answer_segments" as const }))], supports: [], raw: null, request: { path: "fake" },
      usage: { calls: attempts, latencyMs: 5, promptTokens: 10, completionTokens: 5, ...(spec.usd != null ? { estimatedCostUsd: spec.usd } : {}) }, errors: completed ? [] : [refusalError ?? { step: "attempt-3", message: "provider call timed out after 60000 ms", class: "timeout" }] },
    parsed: null,
    parsedV2: completed ? { items, identity: { anchorMatch: spec.anchor === undefined ? "matched" : spec.anchor, confidence: spec.confidence === undefined ? 0.9 : spec.confidence, namesakes }, parseError: null, unknownItems: [] } : null,
    prose: "", markerFound: completed, attempts, refused, completed, nativeSources: completed ? 1 : 0, searchQueries: 1,
  };
}

const NAME: F = { section: "S1", item: "full_name", value: { full: "Jane Doe" }, statement: "Her full name is Jane Doe." };
const CLASS_YEAR: F = { section: "S2", item: "education_class_year", value: { class_year_label: "Junior", season: "2026" }, statement: "Jane Doe is a junior in the 2026 season." };
const Q1_RESOLVED: Spec = { anchor: "matched", findings: [NAME, CLASS_YEAR] };
const EMPTY: Spec = { anchor: "matched" };   // a valid, completed answer with nothing found

let scenario: Partial<Record<QueryId, Spec>> = {};
// The provider boundary, as mocked above (requireMock: this suite never imports a provider module itself).
const direct = (jest.requireMock("../../../lib/research/providers/geminiDirect") as { geminiDirect: jest.Mock }).geminiDirect;
const trends = (jest.requireMock("../../../lib/trends") as { fetchGoogleTrends: jest.Mock }).fetchGoogleTrends;
const gdelt = (jest.requireMock("../../../lib/gdelt") as { fetchGdelt: jest.Mock }).fetchGdelt;
const seenOpts: DirectCallOpts[] = [];

// ── flags ─────────────────────────────────────────────────────────────────────
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_KEYS = ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER"];
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of FLAG_KEYS) delete process.env[k]; Object.assign(process.env, f); };

// ── helpers ───────────────────────────────────────────────────────────────────
let athleteId: string;
const rowsOf = async (wf: string) => db.select().from(researchRuns).where(eq(researchRuns.workflow_run_id, wf));
const stateRow = async () => (await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)))[0];
const outputsOf = async (runId: string) => Object.fromEntries((await getRun(runId))!.steps.map((s: any) => [s.step, s.output])) as Record<string, V3QueryOutput>;
const enterPending = async () => {
  await db.insert(athleteResearchState).values({ athlete_id: athleteId }).onConflictDoNothing();
  const r = await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "enter", trigger: "signup", by: null, anchorHash: "h0" });
  expect(r).toMatchObject({ written: true, transition: "T1" });
};
const start = (input: Record<string, unknown>) => startRun({ process: "research_refresh", version: 3, athleteId, createdBy: "test", input });
const HELD = ["achievements", "press", "narrative", "brand_mentions", "social_handles", "profile", "signals"];

beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(async () => {
  flags(ON);
  __resetResearchPolicyCache();
  resetRunnerConfig(); configureRunner({ retry: { randomize: false } });
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  athleteId = await seedAthlete(`Jane Doe ${Math.random().toString(36).slice(2, 8)}`);
  scenario = { Q1: Q1_RESOLVED, Q2: EMPTY, Q3: EMPTY, Q4: EMPTY, Q5: EMPTY, Q6: EMPTY };
  seenOpts.length = 0; providerCalls.n = 0;
  direct.mockReset().mockImplementation(async (_request: string, opts: DirectCallOpts) => { seenOpts.push(opts); return fakeDirect(opts, scenario[opts.query!.id] ?? EMPTY); });
  trends.mockReset().mockResolvedValue({ interestScore: 42, relatedQueries: [], timeframe: "90d" });
  gdelt.mockReset().mockResolvedValue({ articleCount: 3, avgTone: 1.5, recentArticles: [] });
});
afterEach(() => { process.env = env; jest.restoreAllMocks(); });

// ── the definition ────────────────────────────────────────────────────────────
describe("research_refresh v3 — the definition", () => {
  test("opt-in: the default version stays 2; v3 = q1 … q6, signals, then the targeted read (appended), one per ordinal (sequential, D16)", () => {
    expect(getDefinition("research_refresh").version).toBe(2);
    const v3 = getDefinition("research_refresh", 3);
    expect(v3.steps.map((s) => s.name)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "signals", "read"]);
    expect(v3.steps.map((s) => s.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(v3.steps.map((s) => s.kind)).toEqual(["model", "model", "model", "model", "model", "model", "code", "model"]);
    expect(v3.steps.every((s) => s.retry?.maxAttempts === 2 && s.leaseMs === (s.name === "read" ? V3_READ_LEASE_MS : V3_STEP_LEASE_MS))).toBe(true);
  });

  test("the read step's lease fits its worst case: 5 single-attempt reads × 60 s + 15 redirect resolutions and 8 oEmbed checks × 5 s", () => {
    expect(5 * DEFAULT_PLANNER_POLICY.geminiCallTimeoutMs + (15 + 8) * 5_000).toBeLessThan(V3_READ_LEASE_MS);
  });

  test("the lease fits one query's worst case under the 60 s per-call timeout (3 attempts + back-off ≈ 184 s < 5 min)", () => {
    const P = DEFAULT_PLANNER_POLICY;
    const attempts = 1 + P.geminiRetryMax;
    const backoffMax = Array.from({ length: attempts - 1 }, (_, n) => Math.pow(2, n) * 1000 + 500).reduce((a, b) => a + b, 0);   // geminiDirect's sleep, jitter at its max
    expect(P.geminiCallTimeoutMs).toBe(60_000);
    expect(attempts * P.geminiCallTimeoutMs + backoffMax).toBe(184_000);
    expect(attempts * P.geminiCallTimeoutMs + backoffMax).toBeLessThan(V3_STEP_LEASE_MS);
  });
});

// ── the Q1 gate (enforced) ────────────────────────────────────────────────────
describe("the Q1 identity gate — enforced (governIdentity, direct binding, flags on)", () => {
  test("resolved (T2) → Q2–Q6 each persist one row with its query_id, then the signals row; the determination is written", async () => {
    await enterPending();
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(run.status).toBe("done");
    expect(direct).toHaveBeenCalledTimes(6);
    expect(trends).toHaveBeenCalledTimes(1); expect(gdelt).toHaveBeenCalledTimes(1);
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => r.query_id).sort()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", null]);
    expect(rows.filter((r) => r.query_id).every((r) => r.domain === "refresh" && r.trigger === "signup" && r.status !== "running")).toBe(true);
    expect(rows.find((r) => r.query_id === null)).toMatchObject({ domain: "signals", signal_calls: 2, llm_attempts: 0 });
    const s = await stateRow();
    expect(s.identity_resolution).toBe("resolved");
    const q1Row = rows.find((r) => r.query_id === "Q1")!;
    expect(s.identity_resolution_detail).toMatchObject({ basis: "q1", queryId: "Q1", researchRunId: q1Row.id, workflowRunId: run.id, anchorMatch: "matched", namesakes: 0 });
    expect((q1Row.summary as any).identity).toMatchObject({ block: { anchorMatch: "matched" }, determination: { outcome: "resolved" } });
    const out = await outputsOf(run.id);
    expect(out.q1.identity).toMatchObject({ determination: { outcome: "resolved" }, applied: { written: true, transition: "T2", from: "pending", to: "resolved" } });
    for (const q of ["q2", "q3", "q4", "q5", "q6"]) expect(out[q]).toMatchObject({ ran: true, gate: { enforced: true, value: "resolved" } });
    expect(out.signals).toMatchObject({ ran: true, outcomes: { signals: "refreshed" } });
    expect(s.pending).toEqual([]);
  });

  for (const [label, q1, value, reason] of [
    ["ambiguous (T3)", { anchor: "uncertain", findings: [NAME] } as Spec, "ambiguous", "uncertain"],
    ["failed (T4)", { anchor: "not_resolved", notFound: ["full_name"] } as Spec, "failed", "no_public_match"],
  ] as const) {
    test(`${label} → Q2–Q6 and signals complete skipped: identity_gate — zero calls, zero rows; their domains held in pending`, async () => {
      await enterPending();
      scenario.Q1 = q1;
      const { run } = await start({ governIdentity: true, trigger: "signup" });
      expect(run.status).toBe("done");
      expect(direct).toHaveBeenCalledTimes(1);
      expect(trends).not.toHaveBeenCalled(); expect(gdelt).not.toHaveBeenCalled();
      expect((await rowsOf(run.id)).map((r) => r.query_id)).toEqual(["Q1"]);
      const out = await outputsOf(run.id);
      for (const q of ["q2", "q3", "q4", "q5", "q6", "signals"]) expect(out[q]).toMatchObject({ skipped: "identity_gate", ran: false, researchRunId: null, gate: { enforced: true, value } });
      const s = await stateRow();
      expect(s.identity_resolution).toBe(value);
      expect(s.identity_resolution_detail).toMatchObject({ basis: "q1", reason });
      const pending = s.pending as Array<{ domain: string; reason: string }>;
      expect(pending.map((p) => p.domain).sort()).toEqual([...HELD].sort());
      expect(pending.every((p) => p.reason === "identity_gate")).toBe(true);
      // freshness and failure counts of the held domains are untouched
      for (const d of HELD) { expect((s.domains as any)[d]?.outcome ?? null).toBeNull(); expect((s.refresh_failures as any)[d]).toBeUndefined(); }
    });
  }

  test("no determination (T5: Q1 did not complete) → NOTHING written to the determination; Q1 failure backs off; Q2–Q6 held", async () => {
    await enterPending();
    const before = await readIdentityState(athleteId);
    scenario.Q1 = { completed: false, attempts: 3 };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(run.status).toBe("done");
    expect(direct).toHaveBeenCalledTimes(1);
    expect(await readIdentityState(athleteId)).toEqual(before);   // still pending, provenance byte-identical
    const out = await outputsOf(run.id);
    expect(out.q1.identity).toMatchObject({ determination: { outcome: "no_determination", reason: "not_completed" }, applied: { written: false, reason: "noop" } });
    const s = await stateRow();
    expect((s.refresh_failures as any).identity).toMatchObject({ count: 1, lastOutcome: "failed" });
    expect((s.refresh_failures as any).affiliations).toMatchObject({ count: 1, lastOutcome: "failed" });
    expect((s.domains as any).identity.outcome).toBe("failed");
    expect(out.q2).toMatchObject({ skipped: "identity_gate", gate: { value: "pending" } });
    const q1Row = (await rowsOf(run.id))[0];
    expect(q1Row).toMatchObject({ query_id: "Q1", llm_attempts: 3 });
  });

  test("CAS: an athlete confirmation landing while Q1 runs is never overwritten by the late Q1; the run proceeds on `resolved`", async () => {
    await enterPending();
    scenario.Q1 = { anchor: "uncertain", findings: [NAME], onCall: async () => {
      // while the provider call is in flight: an earlier Q1 left `ambiguous`, then she confirmed herself (T6)
      await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "q1", determination: { outcome: "ambiguous", anchorMatch: "uncertain", confidence: 0.4, namesakes: 1, reason: "uncertain" }, researchRunId: "rr-earlier", workflowRunId: null, requestAnchorHash: "h", currentAnchorHash: "h" });
      await applyIdentityTransition(athleteId, (await readIdentityState(athleteId))!, { kind: "athlete_confirmed", assertedId: "as-1", evidenceIds: ["ev-1"], q1ResearchRunId: "rr-earlier", by: "user-1" });
    } };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    const s = await stateRow();
    expect(s.identity_resolution).toBe("resolved");
    expect(s.identity_resolution_detail).toMatchObject({ basis: "athlete_confirmed", assertedId: "as-1" });
    const out = await outputsOf(run.id);
    expect(out.q1.identity!.applied).toMatchObject({ written: false, reason: "noop", detail: expect.stringMatching(/resolved_sticky|athlete_confirmed_kept/) });
    expect(direct).toHaveBeenCalledTimes(6);   // the gate reads `resolved` fresh: Q2–Q6 run
  });

  test("CAS: a lost compare-and-set is a recorded result, not an error (stale read → cas_lost)", async () => {
    await enterPending();
    // The DB moves to `failed` behind the gate's back: the gate's read still says pending, so its CAS from pending loses.
    scenario.Q1 = { ...Q1_RESOLVED, onCall: async () => { await db.update(athleteResearchState).set({ identity_resolution: "failed", identity_resolution_detail: { at: "x", basis: "q1", reason: "no_public_match" } as any }).where(eq(athleteResearchState.athlete_id, athleteId)); } };
    const stale = { value: "pending" as const, detail: { at: "2026-10-01T00:00:00.000Z", trigger: "signup", anchorHash: "h0", previous: null } as any };
    jest.spyOn(identityResolution, "readIdentityState").mockResolvedValueOnce(stale);
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    const out = await outputsOf(run.id);
    expect(out.q1.identity!.applied).toEqual({ written: false, reason: "cas_lost", expected: "pending", observed: "failed" });
    expect((await stateRow()).identity_resolution).toBe("failed");
    expect(out.q2).toMatchObject({ skipped: "identity_gate", gate: { value: "failed" } });
  });
});

// ── observed (D9) ─────────────────────────────────────────────────────────────
describe("the Q1 gate — observed (governIdentity false)", () => {
  test("nothing is written, nothing is held; Q2–Q6 still run; wouldGate recorded", async () => {
    await db.insert(athleteResearchState).values({ athlete_id: athleteId });
    scenario.Q1 = { anchor: "uncertain", findings: [NAME] };
    const { run } = await start({ trigger: "manual" });
    expect(run.status).toBe("done");
    expect(direct).toHaveBeenCalledTimes(6);
    const s = await stateRow();
    expect(s.identity_resolution).toBeNull();
    expect(s.identity_resolution_detail).toBeNull();
    expect(s.pending).toEqual([]);
    const out = await outputsOf(run.id);
    expect(out.q1.identity!.applied).toEqual({ written: false, reason: "observed" });
    expect(out.q2.gate).toEqual({ enforced: false, value: null, wouldGate: true });
  });
});

// ── per-query persistence ─────────────────────────────────────────────────────
describe("per-query persistence: acceptance vs settle", () => {
  test("Q1's profile evidence is ACCEPTED on Q1's row; profile SETTLES only on Q6's row (carrying Q1's acceptance)", async () => {
    await enterPending();
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    const rows = await rowsOf(run.id);
    const q1 = rows.find((r) => r.query_id === "Q1")!, q6 = rows.find((r) => r.query_id === "Q6")!;
    expect((q1.summary as any).plan).toMatchObject({ acceptance: expect.arrayContaining(["identity", "profile", "affiliations"]), settle: ["identity", "affiliations"] });
    expect(Object.keys((q1.summary as any).domains).sort()).toEqual(["affiliations", "identity"]);   // no profile outcome on Q1
    expect((q1.summary as any).accepted.profile).toMatchObject({ evidence: 1, facts: 1 });
    const ev = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, q1.id));
    expect(ev.some((e) => (e.claim as any).factKey === "class_year")).toBe(true);
    expect((q6.summary as any).plan.settle).toEqual(["profile", "press"]);
    expect((q6.summary as any).domains.profile).toMatchObject({ outcome: "refreshed", accepted: { evidence: 1, facts: 1 } });
    const s = await stateRow();
    expect((s.domains as any).profile).toMatchObject({ outcome: "refreshed", lastRunId: q6.id });
    expect((s.domains as any).identity).toMatchObject({ outcome: "refreshed", lastRunId: q1.id });
  });

  test("a Q1-only run (affiliations due) accepts Q1's profile evidence but leaves profile's freshness as it was (D11)", async () => {
    await enterPending();
    const { run } = await start({ governIdentity: true, domains: ["affiliations"], trigger: "event" });
    expect(direct).toHaveBeenCalledTimes(1);
    const out = await outputsOf(run.id);
    for (const q of ["q2", "q3", "q4", "q5", "q6", "signals"]) expect(out[q]).toMatchObject({ skipped: "not_planned" });
    const s = await stateRow();
    expect((s.domains as any).profile?.outcome ?? null).toBeNull();
    expect((s.domains as any).profile?.lastResearchedAt ?? null).toBeNull();
    expect((s.refresh_failures as any).profile).toBeUndefined();
    const facts = (await rowsOf(run.id))[0];
    expect((facts.summary as any).accepted.profile).toMatchObject({ evidence: 1 });
    // profile due → Q1 + Q6 (no affiliations companion): it settles with Q6
    const { run: r2 } = await startRun({ process: "research_refresh", version: 3, athleteId, createdBy: "test", input: { governIdentity: true, domains: ["profile"], trigger: "event" } });
    expect(resolveV3Plan({ domains: ["profile"] })).toMatchObject({ domains: ["profile"], queries: ["Q1", "Q6"], signals: false });
    const q6 = (await rowsOf(r2.id)).find((r) => r.query_id === "Q6")!;
    expect((q6.summary as any).domains).toHaveProperty("profile");
    expect(((await rowsOf(r2.id)).find((r) => r.query_id === "Q1")!.summary as any).domains).not.toHaveProperty("profile");
  });

  test("a timed-out query is counted (attempts reserved, domain failed, back-off) and the run continues; the policy timeout reaches the adapter", async () => {
    await enterPending();
    scenario.Q2 = { completed: false, attempts: 3 };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(run.status).toBe("done");
    const rows = await rowsOf(run.id);
    const q2 = rows.find((r) => r.query_id === "Q2")!;
    expect(q2).toMatchObject({ llm_attempts: 3 });
    expect(q2.status).not.toBe("running");
    expect((q2.summary as any).domains.achievements.outcome).toBe("failed");
    expect(rows.find((r) => r.query_id === "Q3")).toBeDefined();
    expect(((await stateRow()).refresh_failures as any).achievements).toMatchObject({ count: 1 });
    expect(seenOpts.every((o) => o.timeoutMs === DEFAULT_GEMINI_CALL_TIMEOUT_MS && o.retryMax === DEFAULT_PLANNER_POLICY.geminiRetryMax)).toBe(true);
  });

  test("run reuse per (workflow run, query): a retried step returns the persisted row with no provider call; Q1 re-applies idempotently", async () => {
    await enterPending();
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    const out = await outputsOf(run.id);
    const before = (await rowsOf(run.id)).length;
    direct.mockClear();
    const args = { athleteId, workflowRunId: run.id, plan: resolveV3Plan({ governIdentity: true, trigger: "signup" }) };
    const again2 = await runResearchRefreshV3Query({ ...args, prior: [out.q1] }, "Q2");
    expect(again2).toMatchObject({ reused: true, researchRunId: out.q2.researchRunId, status: out.q2.status, completed: true });
    const again1 = await runResearchRefreshV3Query({ ...args, prior: [] }, "Q1");
    expect(again1).toMatchObject({ reused: true, researchRunId: out.q1.researchRunId, identity: { determination: { outcome: "resolved" } } });
    expect(again1.identity!.applied).toMatchObject({ written: true, transition: "T10" });   // provenance refresh, value unchanged
    expect(direct).not.toHaveBeenCalled();
    expect((await rowsOf(run.id)).length).toBe(before);
    expect((await stateRow()).identity_resolution).toBe("resolved");
  });

  test("an abandoned `running` row of the same (workflow run, query) is closed failed before a new one opens", async () => {
    await enterPending();
    const [wf] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "research_refresh", definition_version: 3, active_scope: "manual-test", status: "running", input: {} as any }).returning({ id: workflowRuns.id });
    const [stale] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "signup", status: "running", workflow_run_id: wf.id, query_id: "Q2" }).returning({ id: researchRuns.id });
    await db.update(athleteResearchState).set({ identity_resolution: "resolved", identity_resolution_detail: { basis: "q1" } as any }).where(eq(athleteResearchState.athlete_id, athleteId));
    const o = await runResearchRefreshV3Query({ athleteId, workflowRunId: wf.id, plan: resolveV3Plan({ governIdentity: true }), prior: [] }, "Q2");
    expect(o.researchRunId).not.toBe(stale.id);
    const [old] = await db.select().from(researchRuns).where(eq(researchRuns.id, stale.id));
    expect(old).toMatchObject({ status: "failed", error: expect.objectContaining({ reason: "abandoned" }) });
  });
});

// ── Q5 narrowing ──────────────────────────────────────────────────────────────
describe("Q5 narrowing (D12): a deterministic post-filter on connected platforms", () => {
  const handle = (platform: string, h: string): F => ({ section: "S8", item: "official_accounts", value: { platform, handle: h, url: `https://${platform}.com/${h}` }, statement: `Jane Doe is @${h} on ${platform}.` });
  test("findings for an actively connected platform are dropped and recorded; unconnected ones are kept", async () => {
    await enterPending();
    await seedConnection({ athleteId, platform: "instagram" });
    await seedConnection({ athleteId, platform: "tiktok", status: "revoked" });   // not active: no authority
    scenario.Q5 = { anchor: "matched", findings: [handle("Instagram", "janedoe"), handle("TikTok", "janedoe.tt")] };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    const out = await outputsOf(run.id);
    expect(out.q5).toMatchObject({ ran: true, droppedConnected: { instagram: 1 } });
    const q5 = (await rowsOf(run.id)).find((r) => r.query_id === "Q5")!;
    expect((q5.summary as any).step.droppedConnected).toEqual({ instagram: 1 });
    const ev = await db.select().from(researchEvidence).where(eq(researchEvidence.run_id, q5.id));
    expect(ev.map((e) => (e.claim as any).platform)).toEqual(["TikTok"]);
  });
  test("every platform Q5 can answer is connected → Q5 is skipped: no call, no row", async () => {
    await enterPending();
    for (const p of ["instagram", "tiktok", "x", "youtube"]) await seedConnection({ athleteId, platform: p });
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(seenOpts.map((o) => o.query!.id)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q6"]);
    expect((await outputsOf(run.id)).q5).toMatchObject({ skipped: "all_platforms_connected", ran: false });
    expect((await rowsOf(run.id)).map((r) => r.query_id)).not.toContain("Q5");
  });
});

// ── the signals lane ──────────────────────────────────────────────────────────
describe("the signals step = v2's Trends/GDELT lane (D13)", () => {
  test("same fake fetches → the same signals outcome, status and lane counters as v2; v2's row summary is unchanged", async () => {
    await enterPending();
    await db.update(athleteResearchState).set({ identity_resolution: "resolved", identity_resolution_detail: { basis: "q1" } as any }).where(eq(athleteResearchState.athlete_id, athleteId));
    const v2 = await refreshAthlete({ athleteId, domains: ["signals"], trigger: "ttl" }, { ...REAL_REFRESH_PROVIDERS, search: jest.fn() as any, extract: jest.fn() as any });
    const [v2Row] = await db.select().from(researchRuns).where(eq(researchRuns.id, v2.researchRunId!));
    const { run } = await start({ governIdentity: true, domains: ["signals"], trigger: "ttl" });
    expect(direct).not.toHaveBeenCalled();
    const [v3Row] = await db.select().from(researchRuns).where(and(eq(researchRuns.workflow_run_id, run.id), isNull(researchRuns.query_id)));
    expect(v2.outcomes).toEqual({ signals: "refreshed" });
    expect((await outputsOf(run.id)).signals.outcomes).toEqual(v2.outcomes);
    for (const k of ["status", "signal_calls", "llm_attempts", "calls"] as const) expect(v3Row[k]).toEqual(v2Row[k]);
    expect((v3Row.summary as any).domains).toEqual((v2Row.summary as any).domains);
    expect(trends).toHaveBeenCalledTimes(2); expect(gdelt).toHaveBeenCalledTimes(2);
    // v2's stored summary carries none of the v3 keys (the acceptance/settle split is absent ⇒ today's behaviour)
    expect(Object.keys(v2Row.summary as any).sort()).toEqual(["asserted_only", "cited", "conflicting", "disputed", "domains", "droppedOutOfPlan", "evidence", "facts", "inferences", "native_retrieved", "native_supported", "payloads", "plan", "proposals", "refused", "researchStatus", "suspect", "uncited", "unsupported_skipped"]);
    expect((v2Row.summary as any).plan).toEqual({ domains: ["signals"] });
  });
});

// ── nothing new runs ──────────────────────────────────────────────────────────
describe("flags off / binding kimi → nothing new runs", () => {
  for (const [label, f] of [["all flags off", {}], ["flags on, binding kimi", { ...ON, RESEARCH_REFRESH_PROVIDER: "kimi" }], ["direct binding, execution gate off", { RESEARCH_REFRESH_PROVIDER: "direct", RESEARCH_SUBSTRATE_WRITE: "true" }]] as const) {
    test(`${label}: a v3 step refuses — zero provider calls, zero research rows, no determination or pending write`, async () => {
      await db.insert(athleteResearchState).values({ athlete_id: athleteId });
      flags(f);
      const { run } = await start({ governIdentity: true, trigger: "signup" });
      expect(run.status).not.toBe("done");
      const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.run_id, run.id));
      expect(steps.some((s) => s.status === "failed" && /runs only under RESEARCH_REFRESH_PROVIDER=direct|execution_disabled/.test(String(s.error)))).toBe(true);
      expect(direct).not.toHaveBeenCalled(); expect(trends).not.toHaveBeenCalled(); expect(gdelt).not.toHaveBeenCalled();
      expect(await rowsOf(run.id)).toEqual([]);
      const s = await stateRow();
      expect(s.identity_resolution).toBeNull();
      expect(s.pending).toEqual([]);
    });
  }
});

// ── budget: the per-run cap spans the logical run; the nightly ledger sees v3 ──
describe("budget — the per-run cap (maxCallsPerRun) aggregates across every query row of the workflow run", () => {
  test("rows each below the cap but together over it ⇒ later provider work in that run is REFUSED before the call, recorded as a budget refusal", async () => {
    await db.delete(researchBudgetDays);
    await enterPending();
    // default policy: maxCallsPerRun 8. Each query wants 3 attempts (1 + geminiRetryMax): Q1 3 + Q2 3 = 6, Q3 gets 2, then refused.
    for (const q of ["Q2", "Q3", "Q4", "Q5", "Q6"] as QueryId[]) scenario[q] = { anchor: "matched", attempts: 3 };
    scenario.Q1 = { ...Q1_RESOLVED, attempts: 3 };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(run.status).toBe("done");
    const rows = await rowsOf(run.id);
    const by = (q: string) => rows.find((r) => r.query_id === q)!;
    expect(rows.filter((r) => r.query_id).map((r) => [r.query_id, r.llm_attempts]).sort()).toEqual([["Q1", 3], ["Q2", 3], ["Q3", 2], ["Q4", 0], ["Q5", 0], ["Q6", 0]]);
    expect(rows.reduce((n, r) => n + r.llm_attempts, 0)).toBe(DEFAULT_PLANNER_POLICY.maxCallsPerRun);   // each row < 8; the run = 8
    expect(providerCalls.n).toBe(8);                                                                     // no provider call past the cap
    const out = await outputsOf(run.id);
    for (const q of ["q3", "q4", "q5", "q6"]) expect(out[q].record).toMatchObject({ refused: true, completed: false });
    expect(out.q4.record).toMatchObject({ attempts: 0 });
    // recorded as existing budget refusals are: the query's `budget refused` sub-call on its row (partial), its domain
    // outcome `failed`, a back-off count
    const q4 = by("Q4");
    expect(q4.status).toBe("partial");
    expect((q4.error as any).subCalls).toEqual(expect.arrayContaining([expect.objectContaining({ message: "budget refused" })]));
    expect((q4.summary as any).domains.brand_mentions.outcome).toBe("failed");
    expect(((await stateRow()).refresh_failures as any).brand_mentions).toMatchObject({ count: 1, lastOutcome: "failed" });
    // refused reservations released their day slots: the night counts exactly the 8 attempts made
    expect((await nightlyLedger(new Date())).llmExecutedToday).toBe(8);
  });

  test("v2 is unchanged: without a cap group the per-run cap counts its ONE row (another row of the same workflow run does not count)", async () => {
    const wf = (await db.insert(workflowRuns).values({ athlete_id: athleteId, process: "research_refresh", definition_version: 2, active_scope: "v2-cap-test", status: "running", input: {} as any }).returning({ id: workflowRuns.id }))[0].id;
    await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "ttl", status: "failed", workflow_run_id: wf, llm_attempts: 7 });
    const [mine] = await db.insert(researchRuns).values({ athlete_id: athleteId, domain: "refresh", trigger: "ttl", status: "running", workflow_run_id: wf }).returning({ id: researchRuns.id });
    const policy = { ...DEFAULT_RESEARCH_POLICY, planner: { ...DEFAULT_PLANNER_POLICY, maxLlmCallsPerNight: 100_000 } };
    let ok = 0;
    for (let i = 0; i < 10; i++) if (await reserveLlmCall(mine.id, { policy })) ok++;   // refresh.ts calls it exactly like this
    expect(ok).toBe(DEFAULT_PLANNER_POLICY.maxCallsPerRun);
    // the same rows under the v3 cap group: the sibling's 7 + this row's 8 already exceed 8 ⇒ refused
    expect(await reserveLlmCall(mine.id, { policy, capGroup: { workflowRunId: wf } })).toBe(false);
  });
});

describe("budget — the nightly ledger sees v3 (maxLlmCallsPerNight, maxUsdPerNight, runs, signals runs, queued)", () => {
  test("a night at the LLM cap refuses v3 work before the provider call; the day row never exceeds the cap", async () => {
    await enterPending();
    const cap = DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight;
    const day = new Date().toISOString().slice(0, 10);
    await db.delete(researchBudgetDays);
    await db.insert(researchBudgetDays).values({ day, llm_attempts: cap - 1 });   // one slot left tonight
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(providerCalls.n).toBe(1);                                             // Q1 took the last slot; nothing after
    const out = await outputsOf(run.id);
    expect(out.q1.record).toMatchObject({ attempts: 1, completed: true });
    for (const q of ["q2", "q3", "q4", "q5", "q6"]) expect(out[q].record).toMatchObject({ refused: true, attempts: 0 });
    const [d] = await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day));
    expect(d.llm_attempts).toBe(cap);
    expect((await nightlyLedger(new Date())).llmExecutedToday).toBe(cap);
    await db.delete(researchBudgetDays);
  });

  test("v3 Q1–Q6 and signals activity is counted as v2's is: attempts, cost, ONE run per workflow run, signals calls, signals-only runs, queued reservations", async () => {
    await db.delete(researchRuns); await db.delete(researchBudgetDays);
    await enterPending();
    for (const q of ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] as QueryId[]) scenario[q] = { ...(q === "Q1" ? Q1_RESOLVED : EMPTY), usd: 0.01 };
    const { run } = await start({ governIdentity: true, trigger: "event" });   // a full v3 run: six queries + signals
    const rows = await rowsOf(run.id);
    expect(rows).toHaveLength(7);
    let l = await nightlyLedger(new Date());
    expect(l.llmExecutedToday).toBe(6);
    expect(l.signalsToday).toBe(2);
    expect(l.usdExecutedToday).toBeCloseTo(0.06, 6);                           // maxUsdPerNight admission reads this
    expect(l.runsToday).toBe(1);                                               // seven rows, ONE run (maxRunsPerNight)
    expect(l.athletesRunToday.has(athleteId)).toBe(true);
    expect(l.signalRunsToday).toBe(0);                                         // it made LLM calls
    // a signals-only v3 run counts as a v2 signals-only run does
    const other = await seedAthlete("Signals Only"); athleteId = other;
    await db.insert(athleteResearchState).values({ athlete_id: other });
    const { run: sig } = await start({ domains: ["signals"], trigger: "ttl" });
    expect((await rowsOf(sig.id)).map((r) => r.domain)).toEqual(["signals"]);
    l = await nightlyLedger(new Date());
    expect(l.runsToday).toBe(2);
    expect(l.signalRunsToday).toBe(1);
    // a queued v3 run that has not opened a row reserves its planned calls, as a queued v2 run does
    const queuedAthlete = await seedAthlete("Queued V3");
    await db.insert(workflowRuns).values({ athlete_id: queuedAthlete, process: "research_refresh", definition_version: 3, active_scope: "research_refresh", status: "running", input: { governIdentity: true, reserveCalls: 5, estUsd: 0.2 } as any });
    l = await nightlyLedger(new Date());
    expect(l.queuedAthleteIds.has(queuedAthlete)).toBe(true);
    expect(l.llmReserved).toBe(5);
    expect(l.usdReserved).toBeCloseTo(0.2, 6);
  });
});

// ── identity sources: athlete_media discovery, outlet classification, the targeted source read ────────────────────
describe("identity sources — Q3 athlete_media, outlet classification and the capped targeted read", () => {
  const readMock = (jest.requireMock("../../../lib/research/providers/geminiSourceRead") as { geminiSourceRead: jest.Mock }).geminiSourceRead;
  const readSeen: Array<{ url: string; mode: string; request: string }> = [];
  let answers: Record<string, unknown> = {};
  /** The provider contract, faked: reserve BEFORE the call (a refusal = no call), one attempt, the read envelope's single chunk = the URL read. */
  async function fakeRead(input: SourceReadInput, opts: SourceReadOpts): Promise<SourceReadResult> {
    const chunk = { id: `${input.envelopeId}:c0`, url: input.url, domain: new URL(input.url).hostname.replace(/^www\./, ""), title: null, text: "", textKind: "provider_answer_segments" as const };
    const envelope = (completed: boolean, text: string, calls: number) => ({ id: input.envelopeId, provider: "gemini_direct", model: "gemini-test", queryName: "source_read", query: input.request, fetchedAt: "2026-10-01T00:00:00.000Z", answerText: "", chunks: [chunk], supports: [], raw: { text }, request: { path: "source-read", params: { readSpec: "source-read/1", url: input.url, mode: input.mode } }, usage: { calls, promptTokens: 100, completionTokens: 50 }, errors: completed ? [] : [{ step: "read", message: "not read", class: "not_read" }] });
    if (!(await opts.reserve())) return { envelope: envelope(false, "", 0), text: "", attempts: 0, refused: true, completed: false, error: "LLM budget reservation refused — no call made" };
    providerCalls.n++; readSeen.push({ url: input.url, mode: input.mode, request: input.request });
    const a = answers[input.url];
    if (!a) return { envelope: envelope(false, "", 1), text: "", attempts: 1, refused: false, completed: false, error: "URL context did not retrieve the page" };
    const text = JSON.stringify(a);
    return { envelope: envelope(true, text, 1), text, attempts: 1, refused: false, completed: true, error: null };
  }

  const YT = "https://www.youtube.com/watch?v=abcDEF12345";
  const NEWS = "https://news.example.com/interview-jane";
  const CLUB = "https://club.example.org/profile";
  const BLOG = "https://blog.example.net/mention";
  const media = (url: string, participation: string, extra: Record<string, unknown> = {}): F => ({ section: "S5", item: "athlete_media", value: { title: `Feature ${url.slice(-8)}`, outlet: "Example Outlet", url, medium: "article", participation, ...extra }, statement: `Jane Doe appears in ${url}.` });
  /** A production-shaped grounding redirect link (what search grounding hands back for every retrieved page). */
  const GR = (k: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ${k}`;
  const ABC = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
  /** What this run's discovery search retrieved. Candidate URLs come ONLY from here; the model's items are matched to these. */
  const GROUNDED: G[] = [
    { url: GR("news"), domain: "news.example.com", title: "Jane Doe interview: growing up in the park" },
    { url: GR("yt"), domain: "youtube.com", title: "Jane Doe sits down with Club TV - YouTube" },
    { url: GR("club"), domain: "club.example.org", title: "Player profile: Jane Doe | Club" },
    { url: GR("blog"), domain: "blog.example.net", title: "Weekend roundup mentions Jane Doe" },
    { url: GR("pod"), domain: "open.spotify.com", title: "The Example Podcast with Jane Doe" },
    { url: ABC, domain: "feature.example.org", title: "Feature: a conversation with Jane Doe" },
  ];
  /** Where each grounding redirect leads (the resolver mock); a link not listed does not resolve. */
  let resolvesTo: Record<string, string> = {};
  const BASE_RESOLVES: Record<string, string> = { [GR("news")]: NEWS, [GR("yt")]: YT, [GR("club")]: CLUB, [GR("blog")]: BLOG, [GR("pod")]: "https://open.spotify.com/episode/xyz" };
  const resolveMock = (jest.requireMock("../../../lib/research/providers/groundingRedirect") as { resolveGroundingRedirect: jest.Mock }).resolveGroundingRedirect;
  const videoInfoMock = (jest.requireMock("../../../lib/research/providers/youtubeOEmbed") as { youtubeVideoInfo: jest.Mock }).youtubeVideoInfo;
  const Q3_MEDIA: Spec = { anchor: "matched", chunks: GROUNDED, findings: [
    media(NEWS, "interview", { title: "Jane Doe interview: growing up in the park", outlet_type: "major_news", date: "2026-05-01" }),
    media("https://youtu.be/abcDEF12345", "own_words", { title: "Jane Doe sits down with Club TV", medium: "video", outlet_type: "official_team_or_school", date: "2026-03-01" }),
    media(CLUB, "profile", { title: "Player profile: Jane Doe", outlet_type: "official_team_or_school" }),
    media(BLOG, "mention", { title: "Weekend roundup mentions Jane Doe", outlet_type: "aggregator_or_blog", athlete_quote: "I love this game." }),
    media("https://open.spotify.com/episode/xyz", "interview", { title: "The Example Podcast with Jane Doe", medium: "podcast" }),   // audio only: never read
    media(ABC, "interview", { title: "Feature: a conversation with Jane Doe" }),                                                      // a redirect: read only once it resolves
  ] };
  const YT_ANSWER = { contract: "source-read/1", source: { url: YT, title: "Jane Doe sits down", outlet: "Club TV", outlet_type: "official_team_or_school", medium: "video", about_athlete: "yes", read: "true" },
    statements: [
      { text: "I play for my family.", verbatim: true, speaker: "athlete", topics: ["motivation"], timestamp: "1:05" },
      { text: "She said that she plays for her family.", verbatim: true, speaker: "athlete", topics: ["motivation"], timestamp: "1:10" },   // reported speech
    ],
    items: { playing_style: [{ value: { text: "a tireless two-way player", described_by: "coach" }, statement: "Her coach calls her a tireless two-way player." }] } };
  const NEWS_ANSWER = { source: { url: NEWS, outlet_type: "major_news", about_athlete: "yes", read: true },
    statements: [
      { text: "Growing up, the park was my second home.", verbatim: true, speaker: "athlete", topics: ["origin"] },
      { text: "She is ready to lead this group.", verbatim: true, speaker: "other", topics: ["leadership"] },                               // the coach's words
    ], items: {} };
  const CLUB_ANSWER = { source: { url: CLUB, about_athlete: "no", read: true }, statements: [{ text: "I am someone else.", verbatim: true, speaker: "athlete", topics: ["other"] }], items: {} };

  beforeEach(() => {
    readSeen.length = 0;
    answers = { [YT]: YT_ANSWER, [NEWS]: NEWS_ANSWER, [CLUB]: CLUB_ANSWER, [BLOG]: { source: { read: true, about_athlete: "yes" }, statements: [], items: {} } };
    readMock.mockReset().mockImplementation(fakeRead);
    resolvesTo = { ...BASE_RESOLVES };
    resolveMock.mockReset().mockImplementation(async (u: string) => resolvesTo[u] ?? null);
    videoInfoMock.mockReset().mockImplementation(async () => ({ exists: true, title: null }));
    scenario.Q3 = Q3_MEDIA;
  });
  afterAll(() => { resolveMock.mockReset().mockImplementation(async () => null); });
  const evidenceOf = (runId: string) => db.select().from(researchEvidence).where(eq(researchEvidence.run_id, runId));

  test("Q3 discovery: athlete_media lands as press_mention (podcast → crossover_appearance) with medium + participation; a listed domain keeps its class over the model's outlet type; a search quote is never a statement", async () => {
    scenario.Q3 = { anchor: "matched", findings: [...Q3_MEDIA.findings!, media("https://athletics.example.edu/feature", "profile", { outlet_type: "major_news" }), media("https://athletics.example.edu/other", "profile", { outlet_type: "bogus_type" })] };
    process.env.RESEARCH_TARGETED_READ_MAX = "0";
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    const q3 = (await rowsOf(run.id)).find((r) => r.query_id === "Q3")!;
    const ev = await evidenceOf(q3.id);
    const mediaRows = ev.filter((e) => (e.claim as any).item === "athlete_media");
    expect(mediaRows).toHaveLength(8);
    const byUrl = (u: string) => mediaRows.find((e) => (e.claim as any).url === u)!;
    expect(byUrl(NEWS)).toMatchObject({ kind: "press_mention", claim: expect.objectContaining({ topic: "athlete_media", medium: "article", participation: "interview", outletType: "major_news" }) });
    expect(byUrl("https://open.spotify.com/episode/xyz")).toMatchObject({ kind: "crossover_appearance", claim: expect.objectContaining({ medium: "podcast", participation: "interview" }) });
    // the fake's bound chunk is example.edu: the domain list classifies it official_team_or_school, so that class stands
    // whatever the model said (an unlisted domain taking the model's class is shown by the read test below)
    expect(byUrl(NEWS).source_type).toBe("official_team_or_school");
    expect(byUrl("https://athletics.example.edu/feature").source_type).toBe("official_team_or_school");
    expect(byUrl("https://athletics.example.edu/other").source_type).toBe("official_team_or_school");
    expect(byUrl(BLOG).claim).toMatchObject({ athleteQuoted: true });
    expect(JSON.stringify(byUrl(BLOG).claim)).not.toContain("I love this game");
    expect(ev.some((e) => e.kind === "athlete_statement")).toBe(false);
    expect((await outputsOf(run.id)).read).toMatchObject({ skipped: "read_disabled", ran: false });
    expect(readMock).not.toHaveBeenCalled();
  });

  test("the read step: top 3 by participation → authority → … (one call each, budgeted); statements → athlete_statement (source_read, the URL read); paraphrase and others' words → narrative_claim; not-about-her → nothing", async () => {
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(run.status).toBe("done");
    // YT (own words; youtube.com is a platform host, so the model's official_team_or_school decides) ranks above NEWS (interview, unlisted domain → the model's major_news)
    expect(readSeen.map((r) => [r.url, r.mode])).toEqual([[YT, "youtube"], [NEWS, "page"], [CLUB, "page"]]);
    for (const r of readSeen) for (const re of [/\bM\.?I\.?A\.?\b/, /\btier\s*\d/i, /\bweight/i]) expect(r.request).not.toMatch(re);
    const read = (await rowsOf(run.id)).find((r) => r.query_id === "READ")!;
    expect(read).toMatchObject({ domain: "refresh", llm_attempts: 3 });
    expect(["ok", "partial"]).toContain(read.status);
    const out = (await outputsOf(run.id)).read;
    expect(out).toMatchObject({ queryId: "READ", ran: true, completed: true, read: { spec: "source-read/1", max: 3, maxAttempts: 5, candidates: 5, skipped: { unreadable: 1, alreadyRead: 0, overCap: 1, ungrounded: 1, video_unavailable: 0 } } });
    // every read URL is the real page behind a grounding chunk this run retrieved; the redirect link is kept beside it
    expect(out!.read!.sources.map((s) => [s.url, s.discoveredUrl])).toEqual([[YT, GR("yt")], [NEWS, GR("news")], [CLUB, GR("club")]]);
    const ev = await evidenceOf(read.id);
    const statements = ev.filter((e) => e.kind === "athlete_statement");
    expect(statements.map((e) => (e.claim as any).text).sort()).toEqual(["Growing up, the park was my second home.", "I play for my family."]);
    for (const e of ev) expect(e.lineage_status).toBe("source_read");
    const yt = statements.find((e) => (e.claim as any).text === "I play for my family.")!;
    expect(yt).toMatchObject({ source_url: YT, source_domain: "youtube.com", source_type: "official_team_or_school" });   // platform host: the model's class decides
    expect(yt.claim).toMatchObject({ topics: ["motivation"], medium: "video", speaker: "athlete", timestampSeconds: 65, sourceTitle: "Jane Doe sits down", outlet: "Club TV", readSpec: "source-read/1" });
    const news = statements.find((e) => (e.claim as any).text.startsWith("Growing up"))!;
    expect(news).toMatchObject({ source_url: NEWS, source_type: "major_news" });                                          // unlisted domain: the model's valid class
    expect(news.claim).not.toHaveProperty("timestampSeconds");
    const paraphrases = ev.filter((e) => e.kind === "narrative_claim" && (e.claim as any).paraphrase === true);
    expect(paraphrases.map((e) => (e.claim as any).text).sort()).toEqual(["She is ready to lead this group.", "She said that she plays for her family."]);
    expect(ev.find((e) => (e.claim as any).topic === "playing_style")).toMatchObject({ kind: "narrative_claim", source_url: YT, claim: expect.objectContaining({ text: "a tireless two-way player", describedBy: "coach" }) });
    expect(ev.some((e) => e.source_url === CLUB)).toBe(false);                                // not about her: nothing stored
    const payloads = await db.select().from(researchSourcePayloads).where(eq(researchSourcePayloads.run_id, read.id));
    expect(payloads.filter((p) => (p.request as any)?.path === "source-read").map((p) => [(p.request as any).params.sourceKey, (p.request as any).params.completed, (p.request as any).params.readSpec]).sort())
      .toEqual([[CLUB, true, "source-read/1"], [NEWS, true, "source-read/1"], [YT, true, "source-read/1"]].sort());
    // re-running the step in the same workflow run reuses the READ row: no call
    readMock.mockClear();
    const again = await runResearchRefreshV3Read({ athleteId, workflowRunId: run.id, plan: resolveV3Plan({ queries: ["Q3"], trigger: "manual" }), prior: [] });
    expect(again).toMatchObject({ reused: true, researchRunId: read.id });
    expect(readMock).not.toHaveBeenCalled();
  });

  test("reuse by spec version: a later run never re-reads a source already read for source-read/1; the next best unread source is read instead", async () => {
    await start({ queries: ["Q3"], trigger: "manual" });
    readSeen.length = 0;
    const { run: second } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([BLOG]);
    expect((await outputsOf(second.id)).read).toMatchObject({ read: { skipped: { alreadyRead: 3 } } });
    // a source whose read did not complete (not retrieved) stays readable next time (and its slot is backfilled); reuse is per athlete
    athleteId = await seedAthlete("Unread Source");
    delete answers[YT];
    readSeen.length = 0;
    await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([YT, NEWS, CLUB, BLOG]);
    readSeen.length = 0;
    await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([YT]);
  });

  test("RESEARCH_TARGETED_READ_MAX caps the reads; the read is skipped when Q3 is not planned", async () => {
    process.env.RESEARCH_TARGETED_READ_MAX = "1";
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([YT]);
    expect((await outputsOf(run.id)).read).toMatchObject({ read: { max: 1, skipped: { overCap: 4 } } });   // the walk stopped after one success: four never reached
    readSeen.length = 0;
    const { run: r2 } = await start({ queries: ["Q1"], trigger: "manual" });
    expect((await outputsOf(r2.id)).read).toMatchObject({ skipped: "not_planned", ran: false });
    expect(readSeen).toEqual([]);
  });

  test("a search-grounding redirect URL is resolved to the real page before selection; the read and its source_url use the real URL", async () => {
    const REAL = "https://feature.example.org/sits-down-with-jane";
    resolvesTo[ABC] = REAL;
    answers[REAL] = { source: { url: REAL, outlet_type: "major_news", about_athlete: "yes", read: true },
      statements: [{ text: "I want to be a role model.", verbatim: true, speaker: "athlete", topics: ["motivation"] }], items: {} };
    process.env.RESEARCH_TARGETED_READ_MAX = "4";
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toContain(REAL);
    expect(readSeen.map((r) => r.url).some((u) => u.includes("vertexaisearch"))).toBe(false);
    const out = (await outputsOf(run.id)).read;
    expect(out!.read!.skipped.unreadable).toBe(1);                                   // only the audio-only podcast stays unreadable now
    const read = (await rowsOf(run.id)).find((r) => r.query_id === "READ")!;
    const st = (await evidenceOf(read.id)).find((e) => (e.claim as any).text === "I want to be a role model.")!;
    expect(st).toMatchObject({ kind: "athlete_statement", lineage_status: "source_read", source_url: REAL });
    // both identities kept: the read record and the read payload carry the discovered redirect link beside the real URL
    const src = out!.read!.sources.find((x) => x.url === REAL)!;
    expect(src.discoveredUrl).toContain("vertexaisearch.cloud.google.com/grounding-api-redirect/abc");
    const [payload] = await db.select().from(researchSourcePayloads).where(and(eq(researchSourcePayloads.run_id, read.id), sql`${researchSourcePayloads.request}->'params'->>'sourceKey' is not null`, sql`${researchSourcePayloads.request}->'params'->>'url' = ${REAL}`));
    expect((payload.request as any).params).toMatchObject({ discoveredUrl: expect.stringContaining("grounding-api-redirect/abc"), completed: true });
  });

  test("re-read rules after resolution: a discovered-but-unread redirect source becomes eligible once it resolves; once read successfully it is not read again", async () => {
    const REAL = "https://feature.example.org/sits-down-with-jane";
    answers[REAL] = { source: { url: REAL, about_athlete: "yes", read: true }, statements: [{ text: "I want to be a role model.", verbatim: true, speaker: "athlete", topics: ["motivation"] }], items: {} };
    process.env.RESEARCH_TARGETED_READ_MAX = "4";
    // 1) the resolver cannot resolve it yet: the redirect stays unreadable and is not read
    await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).not.toContain(REAL);
    // 2) the same source discovered again, now resolvable: eligible and read
    readSeen.length = 0;
    resolvesTo[ABC] = REAL;
    await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toContain(REAL);
    // 3) discovered again after a successful read: protected (alreadyRead), not read a second time
    readSeen.length = 0;
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).not.toContain(REAL);
    expect((await outputsOf(run.id)).read!.read!.skipped.alreadyRead).toBeGreaterThanOrEqual(1);
  });

  test("budget: the read has its own allowance (readCap), separate from maxCallsPerRun — after a full six-query run all 3 reads proceed", async () => {
    await db.delete(researchBudgetDays);
    await enterPending();
    const { run } = await start({ governIdentity: true, trigger: "signup" });   // six queries, one attempt each = 6 of maxCallsPerRun 8
    expect(run.status).toBe("done");
    expect(readSeen.map((r) => r.url)).toEqual([YT, NEWS, CLUB]);              // 3 reads on their own allowance (6 + 3 = 9 > 8)
    const rows = await rowsOf(run.id);
    expect(rows.filter((r) => r.query_id !== "READ").reduce((n, r) => n + r.llm_attempts, 0)).toBe(6);   // Q1–Q6 budget unchanged
    expect(rows.find((r) => r.query_id === "READ")).toMatchObject({ llm_attempts: 3 });
    expect((await outputsOf(run.id)).read!.read!.sources.map((s) => [s.url, s.refused])).toEqual([[YT, false], [NEWS, false], [CLUB, false]]);
    expect((await nightlyLedger(new Date())).llmExecutedToday).toBe(9);         // every read counted against the day
    await db.delete(researchBudgetDays);
  });

  test("budget: calls beyond the read's allowance (the attempts ceiling, 5) are refused BEFORE the call and recorded (a provider attempting an extra reservation per source)", async () => {
    await db.delete(researchBudgetDays);
    // each source asks for two reservations: YT takes 1–2, NEWS 3–4, CLUB's first takes 5 (= the ceiling), its second is refused ⇒ stop
    readMock.mockImplementation(async (input: SourceReadInput, opts: SourceReadOpts) => {
      if (!(await opts.reserve())) return { envelope: { id: input.envelopeId, provider: "gemini_direct", queryName: "source_read", query: "", fetchedAt: "2026-10-01T00:00:00.000Z", answerText: "", chunks: [], supports: [], raw: null, request: {}, errors: [] }, text: "", attempts: 0, refused: true, completed: false, error: "refused" };
      return fakeRead(input, opts);
    });
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([YT, NEWS]);
    const read = (await rowsOf(run.id)).find((r) => r.query_id === "READ")!;
    expect(read).toMatchObject({ llm_attempts: 5, status: "partial" });
    expect((await outputsOf(run.id)).read!.read!.sources.map((s) => [s.url, s.refused])).toEqual([[YT, false], [NEWS, false], [CLUB, true]]);
    await db.delete(researchBudgetDays);
  });

  test("budget: the daily limit (maxLlmCallsPerNight) still stops reads when exhausted", async () => {
    await enterPending();
    const cap = DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight;
    const day = new Date().toISOString().slice(0, 10);
    await db.delete(researchBudgetDays);
    await db.insert(researchBudgetDays).values({ day, llm_attempts: cap - 7 });   // six queries + one read left tonight
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect(readSeen.map((r) => r.url)).toEqual([YT]);
    expect((await outputsOf(run.id)).read!.read!.sources.map((s) => [s.url, s.refused])).toEqual([[YT, false], [NEWS, true]]);
    const [d] = await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day));
    expect(d.llm_attempts).toBe(cap);
    await db.delete(researchBudgetDays);
  });

  test("platform host, model silent: her own only when the channel matches a handle Nomila holds for her; otherwise unknown (stored rows)", async () => {
    process.env.RESEARCH_TARGETED_READ_MAX = "1";
    const silent = { ...YT_ANSWER, source: { ...YT_ANSWER.source, outlet: "Jane Doe Hoops", outlet_type: undefined } };
    scenario.Q3 = { anchor: "matched", chunks: GROUNDED, findings: [media("https://youtu.be/abcDEF12345", "own_words", { title: "Jane Doe sits down with Club TV", medium: "video", outlet: "Jane Doe Hoops" })] };
    answers[YT] = silent;
    const typeOf = async (runId: string) => (await evidenceOf((await rowsOf(runId)).find((r) => r.query_id === "READ")!.id)).find((e) => e.kind === "athlete_statement")!.source_type;
    const { run: noMatch } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(await typeOf(noMatch.id)).toBe("unknown");
    athleteId = await seedAthlete("Handle Owner");
    await db.update(athletes).set({ socials: { youtube: "@janedoehoops" } as any }).where(eq(athletes.id, athleteId));
    const { run: match } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(await typeOf(match.id)).toBe("athlete_authored_public");
  });

  // ── grounding-derived URLs only (model-written URLs are untrusted hints) ──
  const allEvidenceOf = async (wf: string) => (await Promise.all((await rowsOf(wf)).map((r) => evidenceOf(r.id)))).flat();

  test("a real interview described with a FABRICATED YouTube id: the reader gets the genuine video grounding retrieved; the invented URL is never read nor stored as a source", async () => {
    const FAKE = "https://www.youtube.com/watch?v=FAKEfake001";
    const GENUINE = "https://www.youtube.com/watch?v=REALreal001";
    scenario.Q3 = { anchor: "matched", chunks: [...GROUNDED, { url: GR("tv"), domain: "youtube.com", title: "Jane Doe | National TV Interview - YouTube" }],
      findings: [media(FAKE, "interview", { title: "Jane Doe national TV interview", outlet: "Example Network", medium: "video", outlet_type: "major_news" })] };
    resolvesTo[GR("tv")] = GENUINE;
    answers[GENUINE] = { source: { url: GENUINE, about_athlete: "yes", read: true, medium: "video" }, statements: [{ text: "I always wanted to play on the big stage.", verbatim: true, speaker: "athlete", topics: ["ambition"], timestamp: "0:42" }], items: {} };
    process.env.RESEARCH_TARGETED_READ_MAX = "1";
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => [r.url, r.mode])).toEqual([[GENUINE, "youtube"]]);
    expect(readSeen.some((r) => r.url.includes("FAKEfake001") || r.request.includes("FAKEfake001"))).toBe(false);
    const out = (await outputsOf(run.id)).read!.read!;
    expect(out.sources).toEqual([expect.objectContaining({ url: GENUINE, discoveredUrl: GR("tv"), origin: "item", completed: true })]);
    expect(JSON.stringify(out)).not.toContain("FAKEfake001");
    const ev = await allEvidenceOf(run.id);
    expect(ev.some((e) => (e.source_url ?? "").includes("FAKEfake001"))).toBe(false);
    expect(ev.find((e) => e.kind === "athlete_statement")).toMatchObject({ source_url: GENUINE, lineage_status: "source_read" });
    // the discovery row is left exactly as discovered: the interview is real, only its id was wrong — never marked nonexistent
    const q3 = (await rowsOf(run.id)).find((r) => r.query_id === "Q3")!;
    expect((await evidenceOf(q3.id)).find((e) => (e.claim as any).item === "athlete_media")).toMatchObject({ suspect: false, claim: expect.objectContaining({ url: FAKE }) });
  });

  test("LIVE-shaped grounding (every web.title is just the domain): a video matched on its oEmbed title and an article matched on its URL slug are read at the genuine resolved URLs; a domain-only chunk with no slug match stays unmatched", async () => {
    const GENUINE = "https://www.youtube.com/watch?v=GENUINEid01";
    const ARTICLE = "https://regional.example.com/news/2026/05/01/jane-doe-talks-leadership-and-community-12345";
    scenario.Q3 = { anchor: "matched", chunks: [
      { url: GR("lyt"), domain: "youtube.com", title: "youtube.com" },
      { url: GR("lart"), domain: "regional.example.com", title: "regional.example.com" },
      { url: GR("lnone"), domain: "athletics.example.edu", title: "athletics.example.edu" },
    ], findings: [
      media("https://www.youtube.com/watch?v=FABRICATED1", "interview", { title: "Jane Doe national TV interview", outlet: "Example Network", medium: "video" }),
      media("https://regional.example.com/a-path-the-model-made-up", "interview", { title: "Jane Doe talks leadership and community", outlet: "Regional Example" }),
      media("https://athletics.example.edu/feature/jane-doe-profile-made-up", "profile", { title: "Jane Doe feature profile" }),
    ] };
    resolvesTo = { [GR("lyt")]: GENUINE, [GR("lart")]: ARTICLE, [GR("lnone")]: "https://athletics.example.edu/sports/womens-basketball/roster/season/2026" };
    videoInfoMock.mockImplementation(async (u: string) => (u === GENUINE ? { exists: true, title: "Jane Doe on National TV: the full interview" } : { exists: false, title: null }));
    answers[GENUINE] = { source: { url: GENUINE, about_athlete: "yes", read: true }, statements: [{ text: "I always wanted to play on the big stage.", verbatim: true, speaker: "athlete", topics: ["ambition"] }], items: {} };
    answers[ARTICLE] = { source: { url: ARTICLE, about_athlete: "yes", read: true }, statements: [{ text: "Leading starts with listening.", verbatim: true, speaker: "athlete", topics: ["leadership"] }], items: {} };
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url).sort()).toEqual([ARTICLE, GENUINE].sort());
    expect(readSeen.some((r) => /FABRICATED1|made-up/.test(r.url) || /FABRICATED1|made-up/.test(r.request))).toBe(false);
    expect(videoInfoMock).toHaveBeenCalledWith(GENUINE);
    const out = (await outputsOf(run.id)).read!.read!;
    expect(out).toMatchObject({ candidates: 2, skipped: { ungrounded: 1 } });
    expect(out.sources.map((s) => [s.url, s.discoveredUrl, s.completed]).sort()).toEqual([[ARTICLE, GR("lart"), true], [GENUINE, GR("lyt"), true]].sort());
    expect(out.skippedSources).toContainEqual({ reason: "ungrounded", evidenceId: expect.any(String), title: "Jane Doe feature profile" });
    const ev = await allEvidenceOf(run.id);
    expect(ev.some((e) => /FABRICATED1|made-up/.test(e.source_url ?? ""))).toBe(false);
    expect(ev.filter((e) => e.kind === "athlete_statement").map((e) => e.source_url).sort()).toEqual([ARTICLE, GENUINE].sort());
  });

  test("no grounding match: the invented URL is rejected (ungrounded), no call is spent, and the athlete_media row is unchanged", async () => {
    const INVENTED = "https://invented.example.com/a-made-up-interview";
    scenario.Q3 = { anchor: "matched", chunks: [GROUNDED[2]], findings:[media(INVENTED, "interview", { title: "Exclusive: an interview grounding never retrieved" })] };
    resolvesTo = {};
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readMock).not.toHaveBeenCalled();
    expect(resolveMock.mock.calls.every(([u]) => String(u).startsWith("https://vertexaisearch.cloud.google.com/grounding-api-redirect/"))).toBe(true);   // only grounding links are resolved: nothing repaired, guessed or searched for
    const q3 = (await rowsOf(run.id)).find((r) => r.query_id === "Q3")!;
    const row = (await evidenceOf(q3.id)).find((e) => (e.claim as any).item === "athlete_media")!;
    const out = (await outputsOf(run.id)).read!;
    expect(out).toMatchObject({ skipped: "no_read_candidates", ran: false, read: { candidates: 0, skipped: { ungrounded: 1 } } });
    expect(out.read!.skippedSources).toEqual([{ reason: "ungrounded", evidenceId: row.id, title: "Exclusive: an interview grounding never retrieved" }]);
    expect(JSON.stringify(out)).not.toContain(INVENTED);
    expect((await rowsOf(run.id)).map((r) => r.query_id)).not.toContain("READ");
    const [after] = await db.select().from(researchEvidence).where(eq(researchEvidence.id, row.id));
    expect(after).toEqual(row);
    expect(after).toMatchObject({ suspect: false, claim: expect.objectContaining({ url: INVENTED }) });
  });

  test("a grounded page about the athlete that the model did not list enters the pool (ranked as a mention); an unrelated retrieved page does not", async () => {
    athleteId = await seedAthlete("Jane Quillfeather");
    const ABOUT = "https://local.example.com/quillfeather-leads-late-rally";
    scenario.Q3 = { anchor: "matched", findings: [], chunks: [
      { url: GR("about"), domain: "local.example.com", title: "Quillfeather leads late rally in season opener" },
      { url: GR("other"), domain: "weather.example.com", title: "Weekend weather outlook" },
    ] };
    resolvesTo = { [GR("about")]: ABOUT, [GR("other")]: "https://weather.example.com/outlook" };
    answers[ABOUT] = { source: { url: ABOUT, about_athlete: "yes", read: true }, statements: [{ text: "We never stopped believing.", verbatim: true, speaker: "athlete", topics: ["leadership"] }], items: {} };
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(readSeen.map((r) => r.url)).toEqual([ABOUT]);
    expect((await outputsOf(run.id)).read!.read!).toMatchObject({ candidates: 1, sources: [expect.objectContaining({ url: ABOUT, discoveredUrl: GR("about"), origin: "grounding", evidenceId: null, completed: true })] });
  });

  test("YouTube existence (oEmbed): a video oEmbed does not know is skipped BEFORE any model call; the slot goes to the next source", async () => {
    videoInfoMock.mockImplementation(async (u: string) => (u === YT ? { exists: false, title: null } : { exists: true, title: null }));
    const { run } = await start({ queries: ["Q3"], trigger: "manual" });
    expect(videoInfoMock).toHaveBeenCalledWith(YT);
    expect(readSeen.map((r) => r.url)).toEqual([NEWS, CLUB, BLOG]);
    const out = (await outputsOf(run.id)).read!.read!;
    expect(out.skipped).toMatchObject({ video_unavailable: 1 });
    expect(out.skippedSources).toContainEqual(expect.objectContaining({ reason: "video_unavailable", url: YT }));
    expect((await rowsOf(run.id)).find((r) => r.query_id === "READ")).toMatchObject({ llm_attempts: 3 });
  });

  describe("backfill: up to RESEARCH_TARGETED_READ_MAX successful reads within RESEARCH_TARGETED_READ_MAX_ATTEMPTS calls", () => {
    const REAL = "https://feature.example.org/sits-down-with-jane";
    const EXTRA = "https://notes.example.com/jane-doe-notes";
    beforeEach(() => {
      resolvesTo[ABC] = REAL; resolvesTo[GR("extra")] = EXTRA;
      scenario.Q3 = { ...Q3_MEDIA, chunks: [...GROUNDED, { url: GR("extra"), domain: "notes.example.com", title: "Notebook: Jane Doe notes" }],
        findings: [...Q3_MEDIA.findings!, media(EXTRA, "mention", { title: "Notebook: Jane Doe notes" })] };
      answers[REAL] = { source: { url: REAL, about_athlete: "yes", read: true }, statements: [], items: {} };
      answers[EXTRA] = { source: { url: EXTRA, about_athlete: "yes", read: true }, statements: [], items: {} };
    });

    test("two failed reads, then successes: the walk moves on and stops at 3 successful reads (not at the attempts ceiling)", async () => {
      process.env.RESEARCH_TARGETED_READ_MAX_ATTEMPTS = "8";
      delete answers[YT]; delete answers[NEWS];                                       // URL context / video read fails
      const { run } = await start({ queries: ["Q3"], trigger: "manual" });
      expect(readSeen.map((r) => r.url)).toEqual([YT, NEWS, REAL, CLUB, BLOG]);     // EXTRA never reached
      const out = (await outputsOf(run.id)).read!.read!;
      expect(out.sources.map((s) => [s.url, s.completed])).toEqual([[YT, false], [NEWS, false], [REAL, true], [CLUB, true], [BLOG, true]]);
      expect(out.skipped).toMatchObject({ overCap: 1 });
      expect((await rowsOf(run.id)).find((r) => r.query_id === "READ")).toMatchObject({ llm_attempts: 5 });
    });

    test("every read fails: the walk stops at the hard ceiling of 5 model calls", async () => {
      answers = {};
      const { run } = await start({ queries: ["Q3"], trigger: "manual" });
      expect(readSeen.map((r) => r.url)).toEqual([YT, NEWS, REAL, CLUB, BLOG]);
      expect((await rowsOf(run.id)).find((r) => r.query_id === "READ")).toMatchObject({ llm_attempts: 5 });
      expect((await outputsOf(run.id)).read!.read!.sources.every((s) => !s.completed)).toBe(true);
    });

    test("sources already read successfully (same read spec) stay excluded while backfilling", async () => {
      await start({ queries: ["Q3"], trigger: "manual" });                          // YT, NEWS, REAL read
      readSeen.length = 0;
      delete answers[CLUB];
      const { run } = await start({ queries: ["Q3"], trigger: "manual" });
      expect(readSeen.map((r) => r.url)).toEqual([CLUB, BLOG, EXTRA]);              // CLUB fails, backfilled; the three read before are not re-read
      expect((await outputsOf(run.id)).read!.read!.skipped).toMatchObject({ alreadyRead: 3 });
    });
  });

  test("the identity gate holds the read like Q2–Q6 (no call, no row) when the run governs identity and Q1 did not resolve", async () => {
    await enterPending();
    scenario.Q1 = { anchor: "uncertain", findings: [NAME] };
    const { run } = await start({ governIdentity: true, trigger: "signup" });
    expect((await outputsOf(run.id)).read).toMatchObject({ skipped: "identity_gate", ran: false });
    expect(readMock).not.toHaveBeenCalled();
    expect((await rowsOf(run.id)).map((r) => r.query_id)).not.toContain("READ");
  });
});
