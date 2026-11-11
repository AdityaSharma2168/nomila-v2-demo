/**
 * lifecycle.test.ts — PR E2b on the real runner and a real (PGlite) Postgres, with the provider boundary mocked
 * (geminiDirect, Trends, GDELT are jest.fn fakes; nothing reaches a network). Design record
 * docs/architecture/phase-a/pr-e-identity-resolution-design.md §1.2 T1/T6/T7/T8/T9, §2.3, §3 D11, §5.3, §5.4, D14, D18.
 *
 *   - lifecycle entry: boundary off ⇒ a no-op (no row, no run, no call); on + direct ⇒ T1 then the governed v3 run under
 *     the planner's day key, idempotent on retry and with the planner the same day; seeded athletes are never entered
 *   - admin "resolve identity": T1 (admin) / T7 (admin) and a Q1-only governed run; resolved is sticky
 *   - re-entry: T7 on each anchor-change kind (name, sport, said affiliation, proof affiliation, known handle) from
 *     ambiguous and failed; T9 from resolved on name/sport only; an unchanged anchor is refused
 *   - the planner under the direct binding: NULL never planned; pending → Q1 only; ambiguous/failed held until the TTL or
 *     an anchor change (T7 at enqueue); held domains re-planned once resolved (D18); profile plannable (direct only);
 *     the same ledger admission and reservations; the per-run and nightly caps apply to lifecycle and planner runs
 *   - the confirmation service: T6 only from ambiguous and only against Q1 evidence; a proof affiliation breaks a
 *     namesake tie; T8; account ownership never resolves
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../../lib/pgAdvisoryLock", () => ({ LOCK_RESEARCH_PLANNER: 2n, LOCK_INBOX_SYNC: 1n, withAdvisoryLock: async (_k: bigint, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }) }));
jest.mock("../../../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../../../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
jest.mock("../../../lib/research/providers/geminiGrounded", () => ({ groundedSearch: jest.fn(), GEMINI_PROVIDER_ID: "gemini_grounded" }));
jest.mock("../../../lib/research/providers/kimiExtract", () => ({ extractWithCitations: jest.fn() }));
jest.mock("../../../lib/trends", () => ({ fetchGoogleTrends: jest.fn() }));
jest.mock("../../../lib/gdelt", () => ({ fetchGdelt: jest.fn() }));
jest.mock("../../../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn() }));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../../../testUtils/pgliteDb";
import { athleteAffiliations, athleteAsserted, athleteResearchState, athletes, researchBudgetDays, researchEvidence, researchRuns, workflowRuns, workflowSteps } from "../../../../shared/schema";
import { configureRunner, getRun, kick, resetRunnerConfig } from "../../../workflow/runner";
import "../../../workflow/definitions/researchRefresh";   // registers research_refresh v1, v2, v3
import type { DirectCallOpts, DirectCallResult } from "../../../lib/research/providers/geminiDirect";
import { grandfatherMembership } from "../identity/users";
import { __resetResearchPolicyCache, DEFAULT_PLANNER_POLICY, DEFAULT_RESEARCH_POLICY, type ResearchPolicy } from "./config";
import * as identityResolution from "./identityResolution";
import { anchorHash, applyIdentityTransition, readIdentityState, type IdentityValue } from "./identityResolution";
import { nightlyLedger, type NightlyLedger } from "./ledger";
import { adminResolveIdentity, currentIdentityAnchor, reenterIdentityResolution, researchRunKey, startLifecycleResearch } from "./lifecycle";
import { confirmByProofAffiliation, confirmPublicIdentity, PUBLIC_IDENTITY_FIELD, rejectPublicIdentity } from "./confirmation";
import { evaluateNight, runResearchPlanner, type AthleteInfo, type IdentityPlanInfo, type StateRowLike } from "./planner";
import { mergePlan, planV3, v3PlanBudget } from "./plans";
import { PLANNABLE_DOMAINS, PLANNABLE_DOMAINS_DIRECT, plannableDomainsFor, type ResearchDomain } from "./registries";
import { requestRefresh } from "./triggers";
import type { V3QueryOutput } from "./v3Stage";
import type { Finding } from "./spec/directEvidenceV2";
import type { QueryId, SectionId } from "./spec/researchSpecV1";

// ── the fake provider boundary (as researchRefreshV3.test.ts) ─────────────────
type Anchor = "matched" | "uncertain" | "not_resolved" | null;
interface F { section: SectionId; item: string; value: Record<string, unknown>; statement: string }
interface Spec { anchor?: Anchor; confidence?: number | null; namesakes?: number; findings?: F[]; notFound?: string[]; completed?: boolean; attempts?: number }
const URL0 = "https://example.edu/roster/jane-doe";
const providerCalls = { n: 0 };

async function fakeDirect(opts: DirectCallOpts, spec: Spec): Promise<DirectCallResult> {
  const env = opts.envelopeId;
  let attempts = 0, refused = false;
  for (let n = 0; n < (spec.attempts ?? 1); n++) {
    if (!(await opts.reserve())) { refused = true; break; }
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
      chunks: [{ id: `${env}:c0`, url: URL0, domain: "example.edu", title: "Roster", text: findings.map((f) => f.statement).join(" "), textKind: "provider_answer_segments" }], supports: [], raw: null, request: { path: "fake" },
      usage: { calls: attempts, latencyMs: 5, promptTokens: 10, completionTokens: 5 }, errors: completed ? [] : [{ step: "attempt-3", message: refused ? "LLM budget reservation refused — no call made" : "provider call timed out after 60000 ms", class: refused ? "budget" : "timeout" }] },
    parsed: null,
    parsedV2: completed ? { items, identity: { anchorMatch: spec.anchor === undefined ? "matched" : spec.anchor, confidence: spec.confidence === undefined ? 0.9 : spec.confidence, namesakes }, parseError: null, unknownItems: [] } : null,
    prose: "", markerFound: completed, attempts, refused, completed, nativeSources: completed ? 1 : 0, searchQueries: 1,
  };
}

const NAME: F = { section: "S1", item: "full_name", value: { full: "Jane Doe" }, statement: "Her full name is Jane Doe." };
const CLASS_YEAR: F = { section: "S2", item: "education_class_year", value: { class_year_label: "Junior", season: "2026" }, statement: "Jane Doe is a junior in the 2026 season." };
const TEAM: F = { section: "S2", item: "current_affiliation", value: { organization: "Riverside University", organization_type: "college", level: "NCAA D1" }, statement: "Jane Doe plays for Riverside University." };
const Q1_RESOLVED: Spec = { anchor: "matched", findings: [NAME, CLASS_YEAR] };
const Q1_AMBIGUOUS: Spec = { anchor: "matched", namesakes: 2, findings: [NAME, TEAM] };       // T-e: namesakes, no supplied team ⇒ ambiguous
const Q1_FAILED: Spec = { anchor: "not_resolved", notFound: ["full_name"] };
const Q1_T5: Spec = { completed: false, attempts: 1 };
const EMPTY: Spec = { anchor: "matched" };

let scenario: Partial<Record<QueryId, Spec>> = {};
const direct = (jest.requireMock("../../../lib/research/providers/geminiDirect") as { geminiDirect: jest.Mock }).geminiDirect;
const trends = (jest.requireMock("../../../lib/trends") as { fetchGoogleTrends: jest.Mock }).fetchGoogleTrends;
const gdelt = (jest.requireMock("../../../lib/gdelt") as { fetchGdelt: jest.Mock }).fetchGdelt;
const askedQueries: string[] = [];

// ── flags ─────────────────────────────────────────────────────────────────────
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_KEYS = ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER"];
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of FLAG_KEYS) delete process.env[k]; Object.assign(process.env, f); };

// ── helpers ───────────────────────────────────────────────────────────────────
const NOW = new Date();
const DAY = 86_400_000;
let seq = 0;
/** A signed-up athlete (self membership) or, with member:false, a seeded/calibration row (none). */
async function makeAthlete(opts: { member?: boolean } = {}): Promise<{ id: string; userId: string | null }> {
  const id = await seedAthlete(`Jane Doe ${++seq}${Math.random().toString(36).slice(2, 6)}`);
  await db.update(athletes).set({ sport: "soccer", status: "raw" } as any).where(eq(athletes.id, id));
  if (opts.member === false) return { id, userId: null };
  const m = await grandfatherMembership({ athleteId: id, uid: `uid-${id}`, note: "test" });
  return { id, userId: m!.userId };
}
const stateOf = async (id: string) => (await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, id)))[0];
const runsOf = async (id: string) => db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, id));
const researchRowsOf = async (wf: string) => db.select().from(researchRuns).where(eq(researchRuns.workflow_run_id, wf));
const outputsOf = async (runId: string) => Object.fromEntries((await getRun(runId))!.steps.map((s: any) => [s.step, s.output])) as Record<string, V3QueryOutput>;
const assertedOf = async (id: string) => db.select().from(athleteAsserted).where(and(eq(athleteAsserted.athlete_id, id), eq(athleteAsserted.field, PUBLIC_IDENTITY_FIELD)));
const hashNow = async (id: string) => anchorHash((await currentIdentityAnchor(id))!);
/** Put an athlete at `value` the way the transition table does (T1 then a Q1 determination), with the CURRENT anchor hash. */
async function seedDetermination(id: string, value: Exclude<IdentityValue, null | "pending">, at: Date = NOW): Promise<void> {
  await db.insert(athleteResearchState).values({ athlete_id: id, research_status: "seed_only" }).onConflictDoNothing();
  const h = await hashNow(id);
  await applyIdentityTransition(id, (await readIdentityState(id))!, { kind: "enter", trigger: "admin", by: "test", anchorHash: h }, { at });
  const determination = value === "resolved" ? { outcome: "resolved" as const, anchorMatch: "matched" as const, confidence: 0.9, namesakes: 0, corroboratedBy: [] }
    : value === "ambiguous" ? { outcome: "ambiguous" as const, anchorMatch: "uncertain" as const, confidence: 0.4, namesakes: 1, reason: "uncertain" as const }
    : { outcome: "failed" as const, anchorMatch: "not_resolved" as const, confidence: null, namesakes: 0, reason: "no_public_match" as const };
  const r = await applyIdentityTransition(id, (await readIdentityState(id))!, { kind: "q1", determination, researchRunId: "rr-seed", workflowRunId: null, requestAnchorHash: h, currentAnchorHash: h }, { at });
  expect(r).toMatchObject({ written: true, to: value });
}

beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(async () => {
  flags(ON);
  __resetResearchPolicyCache();
  resetRunnerConfig(); configureRunner({ retry: { randomize: false } });
  await db.delete(workflowSteps); await db.delete(workflowRuns); await db.delete(researchBudgetDays);
  scenario = { Q1: Q1_RESOLVED, Q2: EMPTY, Q3: EMPTY, Q4: EMPTY, Q5: EMPTY, Q6: EMPTY };
  providerCalls.n = 0; askedQueries.length = 0;
  direct.mockReset().mockImplementation(async (_request: string, opts: DirectCallOpts) => { askedQueries.push(opts.query!.id); return fakeDirect(opts, scenario[opts.query!.id as QueryId] ?? EMPTY); });
  trends.mockReset().mockResolvedValue({ interestScore: 42, relatedQueries: [], timeframe: "90d" });
  gdelt.mockReset().mockResolvedValue({ articleCount: 3, avgTone: 1.5, recentArticles: [] });
});
afterEach(() => { process.env = env; jest.restoreAllMocks(); });

// ── 1. lifecycle entry ────────────────────────────────────────────────────────
describe("lifecycle entry (T1 + the governed v3 run; D14, §5.4)", () => {
  for (const [label, f] of [
    ["every flag off", {}],
    ["execution gate on, binding kimi (today's deployed binding)", { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "kimi" }],
    ["binding direct, execution gate off", { RESEARCH_REFRESH_PROVIDER: "direct" }],
  ] as const) {
    test(`boundary off (${label}) ⇒ a no-op identical to today: no state row, no run, no provider call`, async () => {
      flags(f as Record<string, string>);
      const a = await makeAthlete();
      expect(await startLifecycleResearch(a.id, "signup")).toEqual({ started: false, reason: "disabled" });
      expect(await startLifecycleResearch(a.id, "claim")).toEqual({ started: false, reason: "disabled" });
      expect(await adminResolveIdentity(a.id, { by: "admin-1" })).toEqual({ started: false, reason: "disabled" });
      expect(await reenterIdentityResolution(a.id, { trigger: "ttl" })).toEqual({ written: false, reason: "disabled" });
      expect(await stateOf(a.id)).toBeUndefined();
      expect(await runsOf(a.id)).toEqual([]);
      expect(direct).not.toHaveBeenCalled();
    });
  }

  test("on + direct: T1 (NULL → pending, trigger signup, by her self user, the v3 anchor) then ONE governed v3 run under the planner's day key", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_T5;                                  // no determination: the column keeps T1's provenance to inspect
    const r = await startLifecycleResearch(a.id, "signup", { asOf: NOW });
    expect(r).toMatchObject({ started: true, transition: "T1", created: true });
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("pending");
    expect(s.identity_resolution_detail).toMatchObject({ trigger: "signup", by: a.userId, previous: null });
    const [wf] = await runsOf(a.id);
    expect(wf).toMatchObject({ process: "research_refresh", definition_version: 3, idempotency_key: researchRunKey(a.id, NOW), created_by: "lifecycle_signup" });
    expect(wf.input).toMatchObject({ governIdentity: true, trigger: "signup", signals: true, queries: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"], reserveCalls: DEFAULT_PLANNER_POLICY.maxCallsPerRun, estUsd: 0.21 });
    // the anchor T1 recorded is the anchor the v3 stage asked Q1 with (one construction)
    const q1 = (await researchRowsOf(wf.id)).find((x) => x.query_id === "Q1")!;
    expect((s.identity_resolution_detail as any).anchorHash).toBe((q1.summary as any).identity.requestAnchorHash);
    expect(direct).toHaveBeenCalledTimes(1);              // Q1 only: Q2–Q6 held by the gate (pending)
  });

  test("on + direct, Q1 resolves: Q2–Q6 + signals run in the same lifecycle run (T1 → T2)", async () => {
    const a = await makeAthlete();
    const r = await startLifecycleResearch(a.id, "signup");
    expect(r).toMatchObject({ started: true, transition: "T1" });
    expect(direct).toHaveBeenCalledTimes(6);
    expect(trends).toHaveBeenCalledTimes(1);
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("resolved");
    expect(s.identity_resolution_detail).toMatchObject({ basis: "q1", previous: { value: "pending" } });
  });

  test("claim-link: T1 records trigger claim", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(a.id, "claim");
    expect((await stateOf(a.id)).identity_resolution_detail).toMatchObject({ trigger: "claim" });
    expect((await runsOf(a.id))[0].created_by).toBe("lifecycle_claim");
  });

  test("idempotent on retry: a second call while pending returns the SAME run (same key), writes nothing new, calls nothing", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_T5;
    const first = await startLifecycleResearch(a.id, "signup", { asOf: NOW });
    const detail = (await stateOf(a.id)).identity_resolution_detail;
    const again = await startLifecycleResearch(a.id, "signup", { asOf: NOW });
    expect(again).toMatchObject({ started: true, transition: null, created: false });
    expect((again as any).workflowRunId).toBe((first as any).workflowRunId);
    expect(await runsOf(a.id)).toHaveLength(1);
    expect((await stateOf(a.id)).identity_resolution_detail).toEqual(detail);
    expect(direct).toHaveBeenCalledTimes(1);
  });

  test("same-day idempotency with the planner: the planner's pending → Q1 plan returns the lifecycle run, never a second one", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(a.id, "signup", { asOf: NOW });
    const summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
    expect(summary.mode).toBe("enqueue");
    expect(await runsOf(a.id)).toHaveLength(1);
    expect(summary.enqueued).toBe(0);
  });

  test("already governed (any determination) ⇒ no second T1 and no run, on any day", async () => {
    const a = await makeAthlete();
    await startLifecycleResearch(a.id, "signup", { asOf: NOW });            // → resolved
    direct.mockClear();
    const later = new Date(NOW.getTime() + 3 * DAY);
    expect(await startLifecycleResearch(a.id, "signup", { asOf: later })).toEqual({ started: false, reason: "already_governed", value: "resolved" });
    expect(await runsOf(a.id)).toHaveLength(1);
    expect(direct).not.toHaveBeenCalled();
  });

  test("seeded / calibration athletes are never entered: no self membership ⇒ refused before any write (lifecycle and admin)", async () => {
    const seeded = await makeAthlete({ member: false });
    expect(await startLifecycleResearch(seeded.id, "signup")).toEqual({ started: false, reason: "no_self_membership" });
    expect(await adminResolveIdentity(seeded.id, { by: "admin-1" })).toEqual({ started: false, reason: "no_self_membership" });
    expect(await stateOf(seeded.id)).toBeUndefined();
    expect(await runsOf(seeded.id)).toEqual([]);
    expect(direct).not.toHaveBeenCalled();
  });
});

// ── 2. admin ──────────────────────────────────────────────────────────────────
describe("admin \"resolve identity\" (T1 admin, T7 admin)", () => {
  test("NULL → T1 (trigger admin, by the operator) and a Q1-only governed run", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_AMBIGUOUS;
    const r = await adminResolveIdentity(a.id, { by: "admin-1", asOf: NOW });
    expect(r).toMatchObject({ started: true, transition: "T1" });
    expect(askedQueries).toEqual(["Q1"]);
    const [wf] = await runsOf(a.id);
    expect(wf).toMatchObject({ definition_version: 3, created_by: "admin", idempotency_key: researchRunKey(a.id, NOW) });
    expect(wf.input).toMatchObject({ domains: ["identity"], governIdentity: true, trigger: "manual", reserveCalls: 3 });
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("ambiguous");
    expect((s.identity_resolution_detail as any).previous).toMatchObject({ value: "pending" });
  });

  test("ambiguous | failed → T7 (trigger admin); resolved is sticky; pending starts the run without a transition", async () => {
    for (const v of ["ambiguous", "failed"] as const) {
      const a = await makeAthlete();
      await seedDetermination(a.id, v);
      scenario.Q1 = Q1_T5;
      const r = await adminResolveIdentity(a.id, { by: "admin-1" });
      expect(r).toMatchObject({ started: true, transition: "T7" });
      expect((await stateOf(a.id)).identity_resolution_detail).toMatchObject({ trigger: "admin", previous: { value: v } });
    }
    const res = await makeAthlete();
    await seedDetermination(res.id, "resolved");
    expect(await adminResolveIdentity(res.id, { by: "admin-1" })).toEqual({ started: false, reason: "resolved_sticky", value: "resolved" });
    const p = await makeAthlete();
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(p.id, "signup", { asOf: new Date(NOW.getTime() - DAY) });
    expect(await adminResolveIdentity(p.id, { by: "admin-1" })).toMatchObject({ started: true, transition: null, created: true });
  });
});

// ── 3. re-entry ───────────────────────────────────────────────────────────────
describe("re-entry: T7 (ambiguous | failed → pending) and T9 (resolved → pending, name/sport only), via anchorHash", () => {
  const KINDS: Array<[string, boolean, (id: string) => Promise<void>]> = [
    ["name edit", true, async (id) => { await db.update(athletes).set({ full_name: "Janet Doe-Smith" } as any).where(eq(athletes.id, id)); }],
    ["sport edit", true, async (id) => { await db.update(athletes).set({ sport: "basketball" } as any).where(eq(athletes.id, id)); }],
    // (A new said/proof affiliation moved the anchor only through the canonical search reader, CANONICAL_CONTEXT_READERS
    // "search", which never ran live and was deleted 2 Nov 2026: the live anchor carries no ledger team.)
    ["a new known handle", false, async (id) => { await seedConnection({ athleteId: id, platform: "instagram", status: "active" }); await db.update(athletes).set({ socials: { instagram: "@janedoe_fc" } } as any).where(eq(athletes.id, id)); }],
  ];

  for (const [kind, nameOrSport, change] of KINDS) {
    for (const from of ["ambiguous", "failed"] as const) {
      test(`T7: ${from} + ${kind} → pending (trigger anchor_changed, previous kept, new anchorHash)`, async () => {
        const a = await makeAthlete();
        await seedDetermination(a.id, from);
        const before = await hashNow(a.id);
        await change(a.id);
        const after = await hashNow(a.id);
        expect(after).not.toBe(before);
        const r = await reenterIdentityResolution(a.id, { trigger: "anchor_changed", nameOrSportChanged: nameOrSport });
        expect(r).toMatchObject({ written: true, transition: "T7", from, to: "pending" });
        expect((await stateOf(a.id)).identity_resolution_detail).toMatchObject({ trigger: "anchor_changed", anchorHash: after, previous: { value: from, basis: "q1" } });
      });
    }
    test(`T9: resolved + ${kind} → ${nameOrSport ? "pending (T9)" : "refused: resolved re-enters only on a name or sport change"}`, async () => {
      const a = await makeAthlete();
      await seedDetermination(a.id, "resolved");
      await change(a.id);
      const r = await reenterIdentityResolution(a.id, { trigger: "anchor_changed", nameOrSportChanged: nameOrSport });
      if (nameOrSport) expect(r).toMatchObject({ written: true, transition: "T9", from: "resolved", to: "pending" });
      else { expect(r).toMatchObject({ written: false, reason: "refused" }); expect((await stateOf(a.id)).identity_resolution).toBe("resolved"); }
    });
  }

  // The live anchor is name + sport + known handles; its team is always null (no caller hands searchInputsFor a team),
  // so a new affiliation does NOT re-enter on its own. It still helps once Q1 runs again (the TTL, a name/sport edit, a
  // new handle, or the admin act): a proof affiliation breaks a namesake tie (the confirmation tests below). Pinned so a
  // change to that (the ledger team in the anchor) is a deliberate decision, not a side effect.
  test("a new said or proof affiliation leaves the anchor unchanged: re-entry is refused and the planner keeps it held", async () => {
    for (const kind of ["said", "proof"] as const) {
      const a = await makeAthlete();
      await seedDetermination(a.id, "failed", new Date(NOW.getTime() - 10 * DAY));
      const before = await hashNow(a.id);
      await db.insert(athleteAffiliations).values({ athlete_id: a.id, org_name: "Riverside University", org_kind: "school", kind, is_primary: true });
      expect((await currentIdentityAnchor(a.id))!.team).toBeNull();
      expect(await hashNow(a.id)).toBe(before);
      expect(await reenterIdentityResolution(a.id, { trigger: "anchor_changed" })).toMatchObject({ written: false, reason: "refused" });
      const summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
      expect(summary.enqueued).toBe(0);
      expect((await stateOf(a.id)).identity_resolution).toBe("failed");
      await db.delete(athleteAffiliations).where(eq(athleteAffiliations.athlete_id, a.id));
    }
  });

  test("anchor unchanged ⇒ refused (no write) from ambiguous, failed and resolved", async () => {
    for (const v of ["ambiguous", "failed", "resolved"] as const) {
      const a = await makeAthlete();
      await seedDetermination(a.id, v);
      const before = await stateOf(a.id);
      const r = await reenterIdentityResolution(a.id, { trigger: "anchor_changed", nameOrSportChanged: true });
      expect(r).toMatchObject({ written: false, reason: "refused", detail: expect.stringMatching(/unchanged anchor hash/) });
      expect((await stateOf(a.id)).identity_resolution_detail).toEqual(before.identity_resolution_detail);
    }
  });

  test("never from NULL or pending (those are T1 / a determination, not re-entries)", async () => {
    const a = await makeAthlete();
    await db.insert(athleteResearchState).values({ athlete_id: a.id }).onConflictDoNothing();
    expect(await reenterIdentityResolution(a.id, { trigger: "ttl" })).toMatchObject({ written: false, reason: "refused" });
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(a.id, "signup");
    expect(await reenterIdentityResolution(a.id, { trigger: "ttl" })).toMatchObject({ written: false, reason: "refused", from: "pending" });
  });
});

// ── 4. the planner under the direct binding ───────────────────────────────────
const AT = new Date("2026-09-15T05:10:00.000Z");
const iso = (d: Date) => d.toISOString();
const ledger = (over: Partial<NightlyLedger> = {}): NightlyLedger => ({ day: "2026-09-15", llmExecutedToday: 0, signalsToday: 0, otherToday: 0, usdExecutedToday: 0, runsToday: 0, signalRunsToday: 0, llmReserved: 0, usdReserved: 0, queuedAthleteIds: new Set(), athletesRunToday: new Set(), ...over });
const policyWith = (planner: Partial<ResearchPolicy["planner"]>): ResearchPolicy => ({ ...DEFAULT_RESEARCH_POLICY, planner: { ...DEFAULT_RESEARCH_POLICY.planner, ...planner } });
const row = (athleteId: string, over: Partial<StateRowLike> = {}): StateRowLike => ({ athleteId, researchStatus: "identity_resolved", identityConfidence: 1, identityResolvedAt: iso(AT), domains: {}, disputedDomains: [], pending: [], refreshFailures: {}, updatedAt: iso(AT), virtual: false, ...over });
const info = (athleteId: string): AthleteInfo => ({ athleteId, status: "claimed", hasIdentitySignal: true, realUser: true });
const ALL = ["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"];
/** Every domain complete and fresh, except those listed as stale. */
const domainsWith = (stale: string[] = []) => Object.fromEntries(ALL.map((d) => [d, { status: "complete", lastRunId: "r0", lastResearchedAt: iso(new Date(AT.getTime() - DAY)), staleAfter: iso(new Date(AT.getTime() + (stale.includes(d) ? -1 : 30) * DAY)), blockingDispute: false }]));
const held = (domains: ResearchDomain[]) => domains.map((domain) => ({ domain, trigger: "event" as const, reason: "identity_gate", requestedAt: iso(AT) }));
const evalV3 = (rows: StateRowLike[], identity: Record<string, Partial<IdentityPlanInfo>>, over: { ledger?: Partial<NightlyLedger>; policy?: ResearchPolicy } = {}) =>
  evaluateNight({ rows, athletes: new Map(rows.map((r) => [r.athleteId, info(r.athleteId)])), policy: over.policy ?? DEFAULT_RESEARCH_POLICY, ledger: ledger(over.ledger), asOf: AT, activeAthletes: new Set(),
    v3: { identity: new Map(Object.entries(identity).map(([k, v]) => [k, { value: null, determinedAt: null, anchorChanged: false, ...v }])) } });

describe("planner (pure): identity-aware admission under the direct binding", () => {
  test("NULL is never planned — not even with research, an identity_resolved account status, stale domains and pending requests", () => {
    const ev = evalV3([row("n", { domains: domainsWith(ALL), pending: held(["press"]) })], { n: { value: null } });
    expect(ev.candidates).toEqual([]);
    expect(ev.identity).toEqual({ not_entered: 1 });
  });

  test("pending → Q1 only (identity), whatever else is stale or held; its failure back-off defers it", () => {
    const ev = evalV3([row("p", { domains: domainsWith(ALL), pending: held(["press", "achievements"]) })], { p: { value: "pending" } });
    expect(ev.admitted).toHaveLength(1);
    expect(ev.admitted[0]).toMatchObject({ domains: ["identity"], version: 3, llmCalls: 1, reserveCalls: 3, trigger: "event" });
    expect(planV3(ev.admitted[0].domains).queries).toEqual(["Q1"]);
    const deferredRow = row("p", { refreshFailures: { identity: { count: 3, deferredUntil: iso(new Date(AT.getTime() + DAY)) } } });
    expect(evalV3([deferredRow], { p: { value: "pending" } }).candidates).toEqual([]);
  });

  test("ambiguous / failed: held (no automatic re-run, D6) until the identity TTL (365 d) or an anchor change ⇒ Q1 with a T7 re-entry", () => {
    for (const v of ["ambiguous", "failed"] as const) {
      const recent = iso(new Date(AT.getTime() - 30 * DAY)), old = iso(new Date(AT.getTime() - 366 * DAY));
      expect(evalV3([row("x", { domains: domainsWith(ALL), pending: held(["press"]) })], { x: { value: v, determinedAt: recent } }).candidates).toEqual([]);
      const ttl = evalV3([row("x")], { x: { value: v, determinedAt: old } });
      expect(ttl.admitted[0]).toMatchObject({ domains: ["identity"], reenter: "ttl", trigger: "ttl" });
      const moved = evalV3([row("x")], { x: { value: v, determinedAt: recent, anchorChanged: true } });
      expect(moved.admitted[0]).toMatchObject({ domains: ["identity"], reenter: "anchor_changed", trigger: "event" });
    }
  });

  test("resolved: gate-held domains are re-planned (D18) with the due ones; profile is plannable on its own (D11)", () => {
    const ev = evalV3([row("r", { domains: domainsWith(["profile"]), pending: held(["press", "signals"]) })], { r: { value: "resolved" } });
    expect(ev.admitted[0]).toMatchObject({ version: 3, trigger: "event" });
    expect(ev.admitted[0].domains.sort()).toEqual(["press", "profile", "signals"]);
    expect(ev.admitted[0].reenter).toBeUndefined();
  });

  test("profile plannable under direct ONLY: profile alone due → v3 plans Q1 + Q6; kimi (v2) never plans profile alone and mergePlan is unchanged", () => {
    const r = row("r", { domains: domainsWith(["profile"]) });
    const v3 = evalV3([r], { r: { value: "resolved" } });
    expect(v3.admitted[0].domains).toEqual(["profile"]);
    expect(planV3(["profile"]).queries).toEqual(["Q1", "Q6"]);
    const kimi = evaluateNight({ rows: [r], athletes: new Map([["r", info("r")]]), policy: DEFAULT_RESEARCH_POLICY, ledger: ledger(), asOf: AT, activeAthletes: new Set() });
    expect(kimi.candidates).toEqual([]);
    expect(kimi.identity).toBeUndefined();
    expect(PLANNABLE_DOMAINS).not.toContain("profile");
    expect(plannableDomainsFor("kimi")).toBe(PLANNABLE_DOMAINS);
    expect(plannableDomainsFor("direct")).toEqual(["identity", "profile", "affiliations", "achievements", "press", "brand_mentions", "narrative", "social_handles", "signals"]);
    expect(PLANNABLE_DOMAINS_DIRECT).toContain("profile");
    expect(mergePlan(["affiliations"]).domains.sort()).toEqual(["affiliations", "profile"]);   // the v2 companion stays
  });

  test("budget guards: v3 plans are admitted against the SAME ledger (remaining LLM calls / USD / per-run USD cap)", () => {
    const full = row("f", { domains: {} });
    const ok = evalV3([full], { f: { value: "resolved" } });
    expect(ok.admitted[0]).toMatchObject({ full: true, reserveCalls: DEFAULT_PLANNER_POLICY.maxCallsPerRun, llmCalls: 6 });
    expect(ok.admitted[0].reserveCalls).toBe(v3PlanBudget(planV3(ok.admitted[0].domains), DEFAULT_RESEARCH_POLICY).reserveCalls);
    const night = evalV3([full], { f: { value: "resolved" } }, { ledger: { llmExecutedToday: DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight - 2 } });
    expect(night.admitted).toEqual([]); expect(night.deferred.budget).toHaveLength(1);
    const reserved = evalV3([row("p")], { p: { value: "pending" } }, { ledger: { llmReserved: DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight - 2 } });
    expect(reserved.deferred.budget).toHaveLength(1);                 // even a Q1-only plan (3 reserved) waits
    const capped = evalV3([full], { f: { value: "resolved" } }, { policy: policyWith({ maxUsdPerRun: 0.05 }) });
    expect(capped.deferred.run_over_cap).toHaveLength(1);
  });
});

describe("planner (enqueue): T7 by TTL, anchor change, D18, the same reservations and caps", () => {
  test("TTL re-entry through the planner: ambiguous 366 d ago → T7 (ttl) at enqueue, then a Q1-only v3 run whose reservation the ledger counts", async () => {
    const a = await makeAthlete();
    await seedDetermination(a.id, "ambiguous", new Date(NOW.getTime() - 366 * DAY));
    const summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
    expect(summary).toMatchObject({ mode: "enqueue", enqueued: 1 });
    expect((summary.plans[0] as any)).toMatchObject({ reentry: "T7" });
    expect(summary.transitions).toMatchObject({ "identity:reenter_ttl": 1 });
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("pending");
    expect(s.identity_resolution_detail).toMatchObject({ trigger: "ttl", previous: { value: "ambiguous" } });
    const [wf] = await runsOf(a.id);
    expect(wf).toMatchObject({ definition_version: 3, created_by: "schedule", idempotency_key: researchRunKey(a.id, NOW) });
    expect(wf.input).toMatchObject({ domains: ["identity"], governIdentity: true, trigger: "ttl", reserveCalls: 3, plannerRunId: summary.plannerRunId });
    const l = await nightlyLedger(NOW);
    expect(l.llmReserved).toBe(3); expect(l.queuedAthleteIds.has(a.id)).toBe(true);
    await kick(wf.id);                                     // the worker runs it: Q1 only, then T2
    expect(askedQueries).toEqual(["Q1"]);
    expect((await stateOf(a.id)).identity_resolution).toBe("resolved");
  });

  test("within the TTL and anchor unchanged ⇒ nothing (no transition, no run); an anchor change found by anchorHash ⇒ T7 (anchor_changed)", async () => {
    const a = await makeAthlete();
    await seedDetermination(a.id, "failed", new Date(NOW.getTime() - 10 * DAY));
    let summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
    expect(summary.enqueued).toBe(0);
    expect(summary.transitions).toMatchObject({ "identity:failed_held": 1 });
    expect((await stateOf(a.id)).identity_resolution).toBe("failed");
    await db.update(athletes).set({ full_name: "Janet Doe-Smith" } as any).where(eq(athletes.id, a.id));
    summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
    expect(summary.enqueued).toBe(1);
    expect((await stateOf(a.id)).identity_resolution_detail).toMatchObject({ trigger: "anchor_changed", previous: { value: "failed" } });
  });

  test("D18 end to end: gate-held domains wait in pending while ambiguous, and run ONCE identity resolves (athlete confirmation)", async () => {
    const a = await makeAthlete();
    scenario.Q1 = Q1_AMBIGUOUS;
    await startLifecycleResearch(a.id, "signup", { asOf: new Date(NOW.getTime() - DAY) });
    let s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("ambiguous");
    const heldDomains = (s.pending as Array<{ domain: string; reason: string }>).filter((p) => p.reason === "identity_gate").map((p) => p.domain).sort();
    expect(heldDomains).toEqual(["achievements", "brand_mentions", "narrative", "press", "profile", "signals", "social_handles"]);
    // still ambiguous: the planner admits nothing
    expect((await runResearchPlanner({ asOf: NOW, athleteId: a.id })).enqueued).toBe(0);
    // she confirms herself against Q1's evidence (T6)
    const q1 = (await db.select().from(researchRuns).where(and(eq(researchRuns.athlete_id, a.id), eq(researchRuns.query_id, "Q1"))))[0];
    const ev = await db.select({ id: researchEvidence.id }).from(researchEvidence).where(eq(researchEvidence.run_id, q1.id));
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: ev.map((e) => e.id), q1ResearchRunId: q1.id })).toMatchObject({ ok: true, transition: "T6" });
    const summary = await runResearchPlanner({ asOf: NOW, athleteId: a.id });
    expect(summary.enqueued).toBe(1);
    const wf = (await runsOf(a.id)).find((r) => r.created_by === "schedule")!;
    expect((wf.input as any).domains.sort()).toEqual(expect.arrayContaining(heldDomains));
    expect((wf.input as any).governIdentity).toBe(true);
    s = await stateOf(a.id);
    expect((s.pending as unknown[]).length).toBe(0);                     // consumed once planned
    direct.mockClear(); askedQueries.length = 0;
    await kick(wf.id);
    expect(askedQueries).toEqual(expect.arrayContaining(["Q2", "Q3", "Q4", "Q6"]));
    const out = await outputsOf(wf.id);
    expect(out.signals).toMatchObject({ ran: true, gate: { enforced: true, value: "resolved" } });
  });

  test("the per-run cap and the nightly cap apply to lifecycle and planner-started runs (reserveLlmCall, unchanged)", async () => {
    // lifecycle: maxCallsPerRun spans the whole run (Q1 3 + Q2 3 + Q3 2 = 8; Q4–Q6 refused before any call)
    const a = await makeAthlete();
    for (const q of ["Q2", "Q3", "Q4", "Q5", "Q6"] as QueryId[]) scenario[q] = { anchor: "matched", attempts: 3 };
    scenario.Q1 = { ...Q1_RESOLVED, attempts: 3 };
    await startLifecycleResearch(a.id, "signup");
    expect(providerCalls.n).toBe(DEFAULT_PLANNER_POLICY.maxCallsPerRun);
    // planner-started: a night with one slot left lets Q1 take it and refuses the rest
    const b = await makeAthlete();
    await seedDetermination(b.id, "ambiguous", new Date(NOW.getTime() - 366 * DAY));
    await db.delete(researchBudgetDays);
    const day = NOW.toISOString().slice(0, 10);
    await db.insert(researchBudgetDays).values({ day, llm_attempts: DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight - 4 });
    const summary = await runResearchPlanner({ asOf: NOW, athleteId: b.id });
    expect(summary.enqueued).toBe(1);                       // 3 reserved ≤ 4 left
    await db.update(researchBudgetDays).set({ llm_attempts: DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight - 1 }).where(eq(researchBudgetDays.day, day));
    providerCalls.n = 0;
    scenario.Q1 = { ...Q1_RESOLVED, attempts: 3 };
    await kick((await runsOf(b.id))[0].id);
    expect(providerCalls.n).toBe(1);                        // the last slot; the 2nd attempt is refused before the call
    const [d] = await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day));
    expect(d.llm_attempts).toBe(DEFAULT_PLANNER_POLICY.maxLlmCallsPerNight);
  });

  test("seeded athletes and NULL rows are never planned by the direct planner (the column, never the account signal)", async () => {
    const seeded = await makeAthlete({ member: false });
    await db.insert(athleteResearchState).values({ athlete_id: seeded.id, research_status: "identity_resolved" });
    const summary = await runResearchPlanner({ asOf: NOW, athleteId: seeded.id });
    expect(summary.enqueued).toBe(0);
    expect(summary.transitions).toMatchObject({ "identity:not_entered": 1 });
    expect(await runsOf(seeded.id)).toEqual([]);
    expect((await stateOf(seeded.id)).identity_resolution).toBeNull();
  });

  test("requestRefresh accepts profile under direct only (kimi drops it, as before)", async () => {
    const a = await makeAthlete();
    expect(await requestRefresh(a.id, ["profile", "press"], "event", "test", AT)).toEqual({ queued: 2 });
    flags({ ...ON, RESEARCH_REFRESH_PROVIDER: "kimi" });
    const b = await makeAthlete();
    expect(await requestRefresh(b.id, ["profile", "press"], "event", "test", AT)).toEqual({ queued: 1 });
  });
});

// ── 5. the confirmation service ───────────────────────────────────────────────
describe("athlete confirmation (T6 / T8; §2.3, D8)", () => {
  /** An athlete whose lifecycle Q1 left `ambiguous` (namesakes, no corroborated discriminator). */
  async function ambiguousAthlete() {
    const a = await makeAthlete();
    scenario.Q1 = Q1_AMBIGUOUS;
    await startLifecycleResearch(a.id, "signup");
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("ambiguous");
    expect((s.identity_resolution_detail as any).reason).toBe("namesakes_uncorroborated");
    const q1 = (await db.select().from(researchRuns).where(and(eq(researchRuns.athlete_id, a.id), eq(researchRuns.query_id, "Q1"))))[0];
    const ev = await db.select({ id: researchEvidence.id, kind: researchEvidence.kind, claim: researchEvidence.claim }).from(researchEvidence).where(eq(researchEvidence.run_id, q1.id));
    return { ...a, q1Id: q1.id, evidence: ev };
  }

  test("T6: she confirms Q1 evidence as herself → resolved; stored as an athlete_asserted public_identity row the provenance points at", async () => {
    const a = await ambiguousAthlete();
    const ids = a.evidence.filter((e) => e.kind !== "identity_signal").map((e) => e.id);
    const r = await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: ids, q1ResearchRunId: a.q1Id, said: "the Riverside one is me" });
    expect(r).toMatchObject({ ok: true, transition: "T6" });
    const [row] = await assertedOf(a.id);
    expect(row.value).toEqual({ confirms: true, evidenceIds: ids, q1ResearchRunId: a.q1Id });
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("resolved");
    expect(s.identity_resolution_detail).toMatchObject({ basis: "athlete_confirmed", assertedId: row.id, evidenceIds: ids, q1ResearchRunId: a.q1Id, by: a.userId, previous: { value: "ambiguous" } });
  });

  test("refused, writing NOTHING (no asserted row), from NULL, pending and failed", async () => {
    const n = await makeAthlete();
    expect(await confirmPublicIdentity({ athleteId: n.id, userId: n.userId!, evidenceIds: ["x"], q1ResearchRunId: "x" })).toMatchObject({ ok: false, reason: "not_ambiguous", value: null });
    const p = await makeAthlete();
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(p.id, "signup");
    expect(await confirmPublicIdentity({ athleteId: p.id, userId: p.userId!, evidenceIds: ["x"], q1ResearchRunId: "x" })).toMatchObject({ ok: false, reason: "not_ambiguous", value: "pending" });
    const f = await makeAthlete();
    scenario.Q1 = Q1_FAILED;
    await startLifecycleResearch(f.id, "signup");
    expect((await stateOf(f.id)).identity_resolution).toBe("failed");
    const fq1 = (await db.select().from(researchRuns).where(and(eq(researchRuns.athlete_id, f.id), eq(researchRuns.query_id, "Q1"))))[0];
    const fev = await db.select({ id: researchEvidence.id }).from(researchEvidence).where(eq(researchEvidence.run_id, fq1.id));
    expect(await confirmPublicIdentity({ athleteId: f.id, userId: f.userId!, evidenceIds: fev.map((e) => e.id), q1ResearchRunId: fq1.id })).toMatchObject({ ok: false, reason: "not_ambiguous", value: "failed" });
    for (const x of [n, p, f]) expect(await assertedOf(x.id)).toEqual([]);
    expect((await stateOf(p.id)).identity_resolution).toBe("pending");
    expect((await stateOf(f.id)).identity_resolution).toBe("failed");
  });

  test("only against Q1 evidence: another run, another athlete's evidence, no evidence, or the wrong Q1 run are refused with nothing written", async () => {
    const a = await ambiguousAthlete();
    const other = await ambiguousAthlete();
    // a non-Q1 row of hers with evidence
    const [q2] = await db.insert(researchRuns).values({ athlete_id: a.id, domain: "refresh", trigger: "manual", status: "ok", query_id: "Q2" }).returning({ id: researchRuns.id });
    const [q2ev] = await db.insert(researchEvidence).values({ athlete_id: a.id, run_id: q2.id, kind: "press_mention", claim: { title: "x" } as any, lineage_status: "native_supported", retrieved_at: new Date(), dedupe_key: "q2-x" }).returning({ id: researchEvidence.id });
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [q2ev.id], q1ResearchRunId: q2.id })).toMatchObject({ ok: false, reason: "q1_run_mismatch" });
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [q2ev.id], q1ResearchRunId: a.q1Id })).toMatchObject({ ok: false, reason: "evidence_not_q1" });
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [other.evidence[0].id], q1ResearchRunId: a.q1Id })).toMatchObject({ ok: false, reason: "evidence_not_q1" });
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [], q1ResearchRunId: a.q1Id })).toMatchObject({ ok: false, reason: "no_evidence" });
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [a.evidence[0].id], q1ResearchRunId: other.q1Id })).toMatchObject({ ok: false, reason: "q1_run_mismatch" });
    expect(await assertedOf(a.id)).toEqual([]);
    expect((await stateOf(a.id)).identity_resolution).toBe("ambiguous");
  });

  test("account ownership NEVER resolves: claimed + self membership + an active connection leave pending as pending; only her self user may speak", async () => {
    const a = await makeAthlete();
    await db.update(athletes).set({ auth_id: `uid-${a.id}`, claimed_at: new Date(), status: "claimed" } as any).where(eq(athletes.id, a.id));
    await seedConnection({ athleteId: a.id, platform: "instagram", status: "active" });
    scenario.Q1 = Q1_T5;
    await startLifecycleResearch(a.id, "claim");
    expect((await stateOf(a.id)).identity_resolution).toBe("pending");
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: ["any"], q1ResearchRunId: "any" })).toMatchObject({ ok: false, reason: "not_ambiguous" });
    expect(await confirmByProofAffiliation({ athleteId: a.id, userId: a.userId! })).toMatchObject({ ok: false, reason: "not_ambiguous" });
    expect((await stateOf(a.id)).identity_resolution).toBe("pending");
    // not her self user: refused before anything is read or written
    const b = await ambiguousAthlete();
    expect(await confirmPublicIdentity({ athleteId: b.id, userId: a.userId!, evidenceIds: [b.evidence[0].id], q1ResearchRunId: b.q1Id })).toMatchObject({ ok: false, reason: "not_self" });
    expect(await assertedOf(b.id)).toEqual([]);
  });

  test("a verified PROOF affiliation breaks the namesake tie (exact normalized match only); a near miss does not", async () => {
    const a = await ambiguousAthlete();
    await db.insert(athleteAffiliations).values({ athlete_id: a.id, org_name: "Riverside", org_kind: "school", kind: "proof", is_primary: true });
    expect(await confirmByProofAffiliation({ athleteId: a.id, userId: a.userId! })).toMatchObject({ ok: false, reason: "proof_not_corroborated" });
    await db.update(athleteAffiliations).set({ org_name: "Riverside  University" }).where(eq(athleteAffiliations.athlete_id, a.id));
    const r = await confirmByProofAffiliation({ athleteId: a.id, userId: a.userId! });
    expect(r).toMatchObject({ ok: true, transition: "T6", q1ResearchRunId: a.q1Id });
    const [row] = await assertedOf(a.id);
    expect(row.value).toMatchObject({ confirms: true, q1ResearchRunId: a.q1Id, proofAffiliationIds: [expect.any(String)] });
    expect((await stateOf(a.id)).identity_resolution_detail).toMatchObject({ basis: "athlete_confirmed", assertedId: row.id });
    // a SAID affiliation is not proof
    const b = await ambiguousAthlete();
    await db.insert(athleteAffiliations).values({ athlete_id: b.id, org_name: "Riverside University", org_kind: "school", kind: "said", is_primary: true });
    expect(await confirmByProofAffiliation({ athleteId: b.id, userId: b.userId! })).toMatchObject({ ok: false, reason: "no_proof_affiliation" });
  });

  test("T8: rejection takes resolved → ambiguous; it is refused from any other value; she can then confirm against her latest Q1 run", async () => {
    const a = await makeAthlete();
    await startLifecycleResearch(a.id, "signup");             // → resolved by Q1
    expect(await rejectPublicIdentity({ athleteId: a.id, userId: a.userId!, said: "that is not me" })).toMatchObject({ ok: true, transition: "T8" });
    const s = await stateOf(a.id);
    expect(s.identity_resolution).toBe("ambiguous");
    const [row] = await assertedOf(a.id);
    expect(row.value).toMatchObject({ confirms: false });
    expect(s.identity_resolution_detail).toMatchObject({ basis: "athlete_rejected", assertedId: row.id, previous: { value: "resolved", basis: "q1" } });
    expect(await rejectPublicIdentity({ athleteId: a.id, userId: a.userId! })).toMatchObject({ ok: false, reason: "not_resolved", value: "ambiguous" });
    const q1 = (await db.select().from(researchRuns).where(and(eq(researchRuns.athlete_id, a.id), eq(researchRuns.query_id, "Q1"))))[0];
    const ev = await db.select({ id: researchEvidence.id }).from(researchEvidence).where(eq(researchEvidence.run_id, q1.id));
    expect(await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [ev[0].id], q1ResearchRunId: q1.id })).toMatchObject({ ok: true, transition: "T6" });
    const rows = await assertedOf(a.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.id === row.id)!.superseded_by).toEqual(rows.find((x) => x.id !== row.id)!.id);
  });

  test("a lost compare-and-set retracts her statement (a refused statement leaves nothing in force)", async () => {
    const a = await ambiguousAthlete();
    jest.spyOn(identityResolution, "applyIdentityTransition").mockResolvedValueOnce({ written: false, reason: "cas_lost", expected: "ambiguous", observed: "resolved" });
    const r = await confirmPublicIdentity({ athleteId: a.id, userId: a.userId!, evidenceIds: [a.evidence[0].id], q1ResearchRunId: a.q1Id });
    expect(r).toMatchObject({ ok: false, reason: "transition_lost" });
    const [row] = await assertedOf(a.id);
    expect(row.retracted_at).not.toBeNull();
    expect((await stateOf(a.id)).identity_resolution).toBe("ambiguous");
  });
});

