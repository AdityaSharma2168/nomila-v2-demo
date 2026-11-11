/**
 * adminIntelligence.test.ts — the development / admin seams for the intelligence pipeline, end to end over HTTP on a real
 * (PGlite) Postgres, the real runner and the real admin gate (requireAdmin / requireAuth with only Firebase token
 * verification faked). Every provider is mocked: geminiDirect, Trends, GDELT (research) and callEvaluator (M.I.A., a
 * frozen golden response). Nothing reaches a network.
 *
 *   - auth: every admin seam is admin-only (401 without a token, 403 for a non-admin); /me/identity needs her token
 *   - admin entering a public athlete WITHOUT an account: only with promoteWithoutAccount (the deliberate act)
 *   - lifecycle still never auto-enters seeded athletes (signup/claim hooks and the planner leave them NULL)
 *   - an on-demand FULL run including Q2–Q6 on the same UTC day as the Q1 resolve (no day-key collision); the gate holds
 *   - M.I.A. recompute: held for identity (409, nothing enqueued) vs permitted (202 → a recorded assessment)
 *   - inspect is read-only
 *   - the cohort runner over a mixed cohort (account / no account / already resolved / ambiguous / sparse / unknown id),
 *     budget-capped and resumed
 *   - the claim-inherits path: researched before signup → claimed → inherits, then adds her own evidence
 *   - the provisional gemini_direct cost entry
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/pgAdvisoryLock", () => ({ LOCK_RESEARCH_PLANNER: 2n, LOCK_INBOX_SYNC: 1n, withAdvisoryLock: async (_k: bigint, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }) }));
jest.mock("../lib/research/providers/geminiDirect", () => ({ geminiDirect: jest.fn(), GEMINI_DIRECT_PROVIDER_ID: "gemini_direct" }));
jest.mock("../lib/research/providers/geminiSourceRead", () => ({ geminiSourceRead: jest.fn() }));
jest.mock("../lib/research/providers/geminiGrounded", () => ({ groundedSearch: jest.fn(), GEMINI_PROVIDER_ID: "gemini_grounded" }));
jest.mock("../lib/research/providers/kimiExtract", () => ({ extractWithCitations: jest.fn() }));
jest.mock("../lib/trends", () => ({ fetchGoogleTrends: jest.fn() }));
jest.mock("../lib/gdelt", () => ({ fetchGdelt: jest.fn() }));
jest.mock("../skills/researchAthlete", () => ({ buildSearchName: (a: any) => a.full_name, researchAthlete: jest.fn() }));
jest.mock("../lib/notify", () => ({ notifyPromotion: jest.fn() }));
jest.mock("firebase-admin/app", () => ({ initializeApp: () => ({}), getApps: () => [] }));
jest.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser: async () => ({ disabled: false }),  // lib/auth's revocation check: never revoked here
   
    verifyIdToken: async (t: string) => {
      if (t === "admin-token") return { uid: "uid-operator", roles: ["admin"] };
      if (t.startsWith("user:")) return { uid: t.slice(5), roles: [] };
      throw new Error("invalid token");
    },
  }),
}));
/** The M.I.A. provider boundary. Never a real call. */
const callEvaluator = jest.fn();
jest.mock("../services/marketabilityBeta1Evaluator", () => {
  const actual = jest.requireActual("../services/marketabilityBeta1Evaluator");
  return { ...actual, callEvaluator: (...args: any[]) => callEvaluator(...args) };
});
jest.setTimeout(600_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import {
  athleteAsserted, athleteFacts, athleteResearchState, athletes, intelligenceLedger, miaEvaluationRuns, miaEvidenceSnapshots,
  researchBudgetDays, researchEvidence, researchRuns, workflowRuns, workflowSteps,
} from "../../shared/schema";
import adminRouter from "./admin";
import meIdentityRouter from "./meIdentity";
import { configureRunner, kick, resetRunnerConfig } from "../workflow/runner";
import "../workflow/definitions/index";
import type { DirectCallOpts, DirectCallResult } from "../lib/research/providers/geminiDirect";
import type { Finding } from "../services/intelligence/research/spec/directEvidenceV2";
import type { QueryId, SectionId } from "../services/intelligence/research/spec/researchSpecV1";
import { grandfatherMembership } from "../services/intelligence/identity/users";
import { linkUserToAthlete } from "../services/intelligence/identity/link";
import { __resetResearchPolicyCache, DEFAULT_COST_MODEL } from "../services/intelligence/research/config";
import { readIdentityState } from "../services/intelligence/research/identityResolution";
import { researchRunKey, startLifecycleResearch } from "../services/intelligence/research/lifecycle";
import { enterLifecycleResearch } from "../services/intelligence/research/lifecycleHooks";
import { runResearchPlanner } from "../services/intelligence/research/planner";
import { estimateCallUsd } from "../services/intelligence/research/plans";
import { httpSeamClient, runCohort, type CohortState, type SeamClient } from "../services/intelligence/seams/cohort";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../services/marketabilityBeta1FrozenParams";
import { BETA1_GOLDENS_PATH } from "../services/marketabilityBeta1Freeze";
import { BETA1_COHORTS_V0, BETA1_LOOKUPS_V1, BETA1_POLICY_V0, BETA1_PRIORS_V1, seedBeta1Params } from "../services/marketabilityBeta1Params";

// ── the fake research provider (as lifecycle.test.ts), chosen per athlete by the name in the request ──────────────
type Anchor = "matched" | "uncertain" | "not_resolved" | null;
interface F { section: SectionId; item: string; value: Record<string, unknown>; statement: string }
interface Spec { anchor?: Anchor; confidence?: number | null; namesakes?: number; findings?: F[]; notFound?: string[]; completed?: boolean; attempts?: number }
const URL0 = "https://example.edu/roster/athlete";
async function fakeDirect(opts: DirectCallOpts, spec: Spec): Promise<DirectCallResult> {
  const env = opts.envelopeId;
  let attempts = 0, refused = false;
  for (let n = 0; n < (spec.attempts ?? 1); n++) { if (!(await opts.reserve())) { refused = true; break; } attempts++; }
  const completed = !refused && spec.completed !== false;
  const findings: Finding[] = (spec.findings ?? []).map((f) => ({ section: f.section, item: f.item, value: f.value, statement: f.statement, asOf: "2026-10-01", sources: [{ url: URL0, title: null, publishedAt: null, quote: f.statement }],
    lineage: { level: "native_supported", match: "index_support", boundChunkIds: [`${env}:c0`], boundSources: [{ url: URL0, domain: "example.edu", title: null }], detail: null, bindingMethod: "quote_exact" } }));
  const items: Record<string, { status: "found" | "not_found"; reason: null; findings: Finding[] }> = {};
  for (const f of findings) (items[f.item] ??= { status: "found", reason: null, findings: [] }).findings.push(f);
  for (const id of spec.notFound ?? []) items[id] = { status: "not_found", reason: null, findings: [] };
  const namesakes = Array.from({ length: spec.namesakes ?? 0 }, (_, i) => ({ description: `another athlete #${i + 1}`, sourceUrl: null }));
  return {
    envelope: { id: env, provider: "gemini_direct", model: "gemini-test", queryName: opts.queryName, query: "(fake)", fetchedAt: "2026-10-01T00:00:00.000Z", answerText: findings.map((f) => f.statement).join(" "),
      chunks: [{ id: `${env}:c0`, url: URL0, domain: "example.edu", title: "Roster", text: findings.map((f) => f.statement).join(" "), textKind: "provider_answer_segments" }], supports: [], raw: null, request: { path: "fake" },
      usage: { calls: attempts, latencyMs: 5, promptTokens: 1000, completionTokens: 2000, searchQueries: 3 * attempts }, errors: completed ? [] : [{ step: "attempt-1", message: refused ? "LLM budget reservation refused — no call made" : "timeout", class: refused ? "budget" : "timeout" }] },
    parsed: null,
    parsedV2: completed ? { items, identity: { anchorMatch: spec.anchor === undefined ? "matched" : spec.anchor, confidence: spec.confidence === undefined ? 0.9 : spec.confidence, namesakes }, parseError: null, unknownItems: [] } : null,
    prose: "", markerFound: completed, attempts, refused, completed, nativeSources: completed ? 1 : 0, searchQueries: 3,
  };
}
const fName = (n: string): F => ({ section: "S1", item: "full_name", value: { full: n }, statement: `Her full name is ${n}.` });
const CLASS_YEAR: F = { section: "S2", item: "education_class_year", value: { class_year_label: "Junior", season: "2026" }, statement: "She is a junior in the 2026 season." };
const TEAM: F = { section: "S2", item: "current_affiliation", value: { organization: "Riverside University", organization_type: "college", level: "NCAA D1" }, statement: "She plays for Riverside University." };
type Profile = "resolved" | "ambiguous" | "sparse";
const Q1: Record<Profile, (n: string) => Spec> = {
  resolved: (n) => ({ anchor: "matched", findings: [fName(n), CLASS_YEAR] }),
  ambiguous: (n) => ({ anchor: "matched", namesakes: 2, findings: [fName(n), TEAM] }),   // T-e: namesakes, uncorroborated ⇒ ambiguous
  sparse: (n) => ({ anchor: "matched", findings: [fName(n)] }),
};
const profiles = new Map<string, Profile>();     // athlete name → Q1 profile
const asked: Array<{ name: string; q: string }> = [];

const direct = (jest.requireMock("../lib/research/providers/geminiDirect") as { geminiDirect: jest.Mock }).geminiDirect;
const trends = (jest.requireMock("../lib/trends") as { fetchGoogleTrends: jest.Mock }).fetchGoogleTrends;
const gdelt = (jest.requireMock("../lib/gdelt") as { fetchGdelt: jest.Mock }).fetchGdelt;

// ── M.I.A. golden (frozen evaluator response; the athlete gets the golden's sport so the evaluator has one) ──────────
const bundle = JSON.parse(readFileSync(BETA1_GOLDENS_PATH, "utf8")) as { athletes: { key: string; name: string; sport: string }[] };
const GOLDEN = bundle.athletes[0];
const ARTIFACTS = join(__dirname, "..", "scripts", "calibration", "runs", "blind-eval-v2", "gemini");
function frozenCall() {
  const raw = JSON.parse(readFileSync(join(ARTIFACTS, `${GOLDEN.key}.dev37.raw.json`), "utf8").replace(/\r\n/g, "\n"));
  return { model: raw.model, modelVersion: raw.modelVersion ?? null, responseId: raw.responseId ?? null, latencyMs: raw.latencyMs ?? 0, finishReason: raw.finishReason ?? null, truncated: !!raw.truncated,
    usage: raw.usage ?? { promptTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null, searchCalls: null }, costUsd: raw.costUsd ?? 0, text: raw.text, native: raw.native ?? {} };
}

// ── flags ─────────────────────────────────────────────────────────────────────
const ON = { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct" };
const FLAG_KEYS = ["RESEARCH_REFRESH_ENABLED", "RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_PROVIDER", "IDENTITY_MEMBERSHIP_READ"];
const env = process.env;
const flags = (f: Record<string, string>) => { process.env = { ...env }; for (const k of FLAG_KEYS) delete process.env[k]; Object.assign(process.env, f); __resetResearchPolicyCache(); };

// ── HTTP ──────────────────────────────────────────────────────────────────────
let server: Server; let base: string;
const ADMIN = "admin-token";
async function http(method: "GET" | "POST", path: string, opts: { token?: string | null; body?: unknown } = {}) {
  const token = opts.token === undefined ? ADMIN : opts.token;
  const r = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: opts.body !== undefined && method !== "GET" ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const A = (id: string) => `/api/v1/admin/intelligence/athletes/${id}`;

// ── fixtures ──────────────────────────────────────────────────────────────────
let seq = 0;
async function makeAthlete(profile: Profile, opts: { account?: boolean; sport?: string | null } = {}): Promise<{ id: string; name: string; uid: string | null }> {
  const name = `Athlete ${String.fromCharCode(65 + (seq % 26))}${++seq} ${Math.random().toString(36).slice(2, 6)}`;
  const id = await seedAthlete(name);
  await db.update(athletes).set({ sport: opts.sport === undefined ? GOLDEN.sport : opts.sport, status: "raw" } as any).where(eq(athletes.id, id));
  profiles.set(name, profile);
  if (opts.account === false) return { id, name, uid: null };
  const uid = `uid-${id}`;
  await grandfatherMembership({ athleteId: id, uid, note: "test" });
  await db.update(athletes).set({ auth_id: uid } as any).where(eq(athletes.id, id));
  return { id, name, uid };
}
const runsOf = async (id: string) => db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, id), eq(workflowRuns.process, "research_refresh")));
const miaRunsOf = async (id: string) => db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, id), eq(workflowRuns.process, "mia_evaluation")));
const factsOf = async (id: string) => db.select().from(athleteFacts).where(and(eq(athleteFacts.athlete_id, id), eq(athleteFacts.status, "current")));
const queriesAskedFor = (name: string) => asked.filter((x) => x.name === name).map((x) => x.q);

beforeAll(async () => {
  await initTestDb();
  await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, lookups: BETA1_LOOKUPS_V1, policy: BETA1_POLICY_V0, priors: BETA1_PRIORS_V1, cohorts: BETA1_COHORTS_V0, activate: true, createdBy: "dev-seams-test" });
  const app = express(); app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1/me", meIdentityRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 300_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  flags(ON);
  resetRunnerConfig(); configureRunner({ retry: { randomize: false, minTimeoutMs: 1 } });
  await db.delete(researchBudgetDays);
  asked.length = 0;
  direct.mockReset().mockImplementation(async (request: string, opts: DirectCallOpts) => {
    const name = [...profiles.keys()].find((n) => request.includes(n)) ?? "?";
    asked.push({ name, q: opts.query!.id });
    const p = profiles.get(name) ?? "sparse";
    return fakeDirect(opts, opts.query!.id === "Q1" ? Q1[p](name) : { anchor: "matched" });
  });
  trends.mockReset().mockResolvedValue({ interestScore: 42, relatedQueries: [], timeframe: "90d" });
  gdelt.mockReset().mockResolvedValue({ articleCount: 3, avgTone: 1.5, recentArticles: [] });
  callEvaluator.mockReset().mockImplementation(async () => frozenCall());
});
afterEach(() => { process.env = env; });

// ── 1. auth ───────────────────────────────────────────────────────────────────
describe("auth: admin seams are admin-only; /me/identity is the athlete's own", () => {
  test("no token → 401; a signed-in non-admin → 403; the admin role → through (every seam route)", async () => {
    const a = await makeAthlete("resolved");
    const routes: Array<["GET" | "POST", string]> = [["POST", `${A(a.id)}/resolve-identity`], ["POST", `${A(a.id)}/research`], ["POST", `${A(a.id)}/mia/recompute`], ["POST", `${A(a.id)}/knowledge/reprocess`], ["GET", A(a.id)]];
    for (const [m, p] of routes) {
      expect((await http(m, p, { token: null, body: {} })).status).toBe(401);
      expect((await http(m, p, { token: "garbage", body: {} })).status).toBe(401);
      expect((await http(m, p, { token: `user:${a.uid}`, body: {} })).status).toBe(403);   // the athlete herself is not an admin
    }
    expect((await http("GET", A(a.id))).status).toBe(200);
    // Concept 0.4 PR 4: the knowledge reprocess seam sits behind the same admin gate (the admin passes; a dry run writes nothing).
    const reprocess = await http("POST", `${A(a.id)}/knowledge/reprocess`, { body: { dryRun: true } });
    expect(reprocess.status).toBe(200);
    expect(reprocess.json).toMatchObject({ dryRun: true, wrote: false });
    for (const [m, p] of [["GET", "/api/v1/me/identity"], ["POST", "/api/v1/me/identity/confirm"], ["POST", "/api/v1/me/identity/reject"]] as const) {
      expect((await http(m, p, { token: null, body: {} })).status).toBe(401);
    }
    expect(direct).not.toHaveBeenCalled();
  });
});

// ── 2. resolve: accounts, no-account promotion, the lifecycle boundary ─────────
describe("resolve identity (T1/T7 admin, Q1 only)", () => {
  test("an athlete with an account: T1 + a Q1-only run, keyed per pending episode, executed inline", async () => {
    const a = await makeAthlete("resolved");
    const r = await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ started: true, transition: "T1", created: true, account: true, identity: "resolved", joinedOtherRun: false });
    expect(r.json.idempotencyKey).toMatch(new RegExp(`^${researchRunKey(a.id, new Date())}:admin_resolve:\\d+$`));
    expect(queriesAskedFor(a.name)).toEqual(["Q1"]);
    expect((await readIdentityState(a.id))!.detail).toMatchObject({ basis: "q1", previous: { value: "pending" } });
    // resolved is sticky
    expect(await http("POST", `${A(a.id)}/resolve-identity`, { body: {} })).toMatchObject({ status: 409, json: { started: false, reason: "resolved_sticky" } });
  });

  test("a public athlete with NO account is entered ONLY by the explicit promoteWithoutAccount act", async () => {
    const p = await makeAthlete("resolved", { account: false });
    const refused = await http("POST", `${A(p.id)}/resolve-identity`, { body: {} });
    expect(refused).toMatchObject({ status: 409, json: { started: false, reason: "no_self_membership" } });
    expect(refused.json.hint).toMatch(/promoteWithoutAccount/);
    expect(await readIdentityState(p.id)).toBeNull();
    expect(direct).not.toHaveBeenCalled();
    const ok = await http("POST", `${A(p.id)}/resolve-identity`, { body: { promoteWithoutAccount: true } });
    expect(ok).toMatchObject({ status: 200, json: { started: true, transition: "T1", account: false, identity: "resolved" } });
    const s = await readIdentityState(p.id);
    expect(s!.value).toBe("resolved");
    expect((s!.detail as any).previous).toMatchObject({ value: "pending" });
  });

  test("ambiguous → a same-day re-resolve (T7 admin) runs Q1 AGAIN (new episode key), not the earlier run", async () => {
    const a = await makeAthlete("ambiguous");
    const first = await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    expect(first.json).toMatchObject({ started: true, transition: "T1", identity: "ambiguous" });
    profiles.set(a.name, "resolved");
    const again = await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    expect(again.json).toMatchObject({ started: true, transition: "T7", created: true, identity: "resolved" });
    expect(again.json.workflowRunId).not.toBe(first.json.workflowRunId);
    expect(queriesAskedFor(a.name)).toEqual(["Q1", "Q1"]);
  });

  test("refusals: unknown athlete 404, no sport 422, boundary off 409 disabled (and nothing written)", async () => {
    expect((await http("POST", `${A("00000000-0000-0000-0000-000000000000")}/resolve-identity`, { body: {} })).status).toBe(404);
    expect((await http("POST", `${A("not-a-uuid")}/resolve-identity`, { body: {} })).status).toBe(404);
    const ns = await makeAthlete("resolved", { sport: null });
    expect((await http("POST", `${A(ns.id)}/resolve-identity`, { body: {} })).status).toBe(422);
    const a = await makeAthlete("resolved");
    flags({});
    expect(await http("POST", `${A(a.id)}/resolve-identity`, { body: {} })).toMatchObject({ status: 409, json: { reason: "disabled" } });
    expect(await http("POST", `${A(a.id)}/research`, { body: {} })).toMatchObject({ status: 409, json: { reason: "disabled" } });
    expect(await readIdentityState(a.id)).toBeNull();
    expect(direct).not.toHaveBeenCalled();
  });

  test("lifecycle still NEVER auto-enters a seeded athlete (signup / claim hooks, the planner); only the admin act can", async () => {
    const seeded = await makeAthlete("resolved", { account: false });
    expect(await startLifecycleResearch(seeded.id, "signup")).toEqual({ started: false, reason: "no_self_membership" });
    expect(await startLifecycleResearch(seeded.id, "claim")).toEqual({ started: false, reason: "no_self_membership" });
    await enterLifecycleResearch(seeded.id, "signup");
    const plan = await runResearchPlanner({ athleteId: seeded.id });
    expect(plan.enqueued).toBe(0);
    expect((await readIdentityState(seeded.id))?.value ?? null).toBeNull();   // the planner may hold a state row; never a determination
    expect(await runsOf(seeded.id)).toEqual([]);
    expect(direct).not.toHaveBeenCalled();
  });
});

// ── 3. research on demand ─────────────────────────────────────────────────────
describe("research: the full plan (Q1–Q6 + signals) on demand, the same UTC day, through the identity gate", () => {
  test("after a Q1-only resolve, a FULL run the same day runs Q2–Q6 (its own key, no collision with the day key)", async () => {
    const a = await makeAthlete("resolved");
    const res = await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    expect(res.json.identity).toBe("resolved");
    const r = await http("POST", `${A(a.id)}/research`, { body: { wait: true } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ started: true, created: true, identity: "resolved", plan: { queries: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"], signals: true } });
    expect(r.json.idempotencyKey).toBe(`${researchRunKey(a.id, new Date())}:admin_research:full`);
    expect(r.json.workflowRunId).not.toBe(res.json.workflowRunId);
    expect(queriesAskedFor(a.name)).toEqual(["Q1", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    expect(trends).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(researchRuns).where(eq(researchRuns.workflow_run_id, r.json.workflowRunId));
    expect(rows.map((x) => x.query_id).filter(Boolean).sort()).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
    // the provisional gemini_direct cost entry: v3 rows no longer record $0
    expect(rows.filter((x) => x.query_id).every((x) => Number(x.estimated_cost_usd) > 0)).toBe(true);
    // idempotent: the identical request again returns the same run; a label is the explicit "again today"
    const same = await http("POST", `${A(a.id)}/research`, { body: { wait: true } });
    expect(same.json).toMatchObject({ started: true, created: false, workflowRunId: r.json.workflowRunId });
    const relabel = await http("POST", `${A(a.id)}/research`, { body: { wait: true, label: "rerun-1" } });
    expect(relabel.json).toMatchObject({ started: true, created: true });
  });

  test("chosen domains run only their queries; default is queued for the tick (202), not run inline", async () => {
    const a = await makeAthlete("resolved");
    await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    asked.length = 0;
    const r = await http("POST", `${A(a.id)}/research`, { body: { domains: ["press"] } });
    expect(r.status).toBe(202);
    expect(r.json.plan.domains).toEqual(["press"]);
    expect(asked).toEqual([]);                                     // queued: the service's workflow tick executes it
    await kick(r.json.workflowRunId);
    expect(queriesAskedFor(a.name)).toEqual(r.json.plan.queries);
    expect(r.json.plan.queries).not.toContain("Q1");
    expect((await http("POST", `${A(a.id)}/research`, { body: { domains: ["nope"] } })).status).toBe(400);
  });

  test("the gate: NULL → identity_not_entered; ambiguous → identity_not_resolved; pending without Q1 → refused; nothing called", async () => {
    const n = await makeAthlete("resolved");
    expect(await http("POST", `${A(n.id)}/research`, { body: { wait: true } })).toMatchObject({ status: 409, json: { reason: "identity_not_entered" } });
    const amb = await makeAthlete("ambiguous");
    await http("POST", `${A(amb.id)}/resolve-identity`, { body: {} });
    asked.length = 0;
    expect(await http("POST", `${A(amb.id)}/research`, { body: { wait: true } })).toMatchObject({ status: 409, json: { reason: "identity_not_resolved", value: "ambiguous" } });
    const pend = await makeAthlete("resolved");
    await db.insert(athleteResearchState).values({ athlete_id: pend.id, research_status: "seed_only", identity_resolution: "pending", identity_resolution_detail: { at: new Date().toISOString(), trigger: "admin", anchorHash: "x", previous: null } } as any);
    expect(await http("POST", `${A(pend.id)}/research`, { body: { domains: ["press"], wait: true } })).toMatchObject({ status: 409, json: { reason: "identity_not_resolved", value: "pending" } });
    expect(asked).toEqual([]);
  });

  test("pending + the full plan: Q1 decides inside the run; ambiguous ⇒ Q2–Q6 held by the gate, no call", async () => {
    const pend = await makeAthlete("ambiguous");
    await db.insert(athleteResearchState).values({ athlete_id: pend.id, research_status: "seed_only", identity_resolution: "pending", identity_resolution_detail: { at: new Date().toISOString(), trigger: "admin", anchorHash: "x", previous: null } } as any);
    const r = await http("POST", `${A(pend.id)}/research`, { body: { wait: true } });
    expect(r.json).toMatchObject({ started: true });
    expect(queriesAskedFor(pend.name)).toEqual(["Q1"]);
    expect((await readIdentityState(pend.id))!.value).toBe("ambiguous");
    const ins = await http("GET", A(pend.id));
    expect(ins.json.researchRuns[0].steps.filter((s: any) => s.skipped === "identity_gate").map((s: any) => s.step)).toEqual(["q2", "q3", "q4", "q5", "q6", "signals", "read"]);   // the targeted read is held like Q2–Q6
  });
});

// ── 4. M.I.A. recompute ───────────────────────────────────────────────────────
describe("M.I.A. recompute: held for identity vs permitted", () => {
  test("not resolved (NULL, ambiguous) → 409 held, nothing enqueued, no evaluator call; resolved → 202, and with no memory facts nothing is evaluated", async () => {
    const n = await makeAthlete("resolved");
    const held = await http("POST", `${A(n.id)}/mia/recompute`, { body: {} });
    expect(held).toMatchObject({ status: 409, json: { held: "identity", identity: { value: null, reason: null }, athleteId: n.id } });
    const amb = await makeAthlete("ambiguous");
    await http("POST", `${A(amb.id)}/resolve-identity`, { body: {} });
    const held2 = await http("POST", `${A(amb.id)}/mia/recompute`, { body: {} });
    expect(held2).toMatchObject({ status: 409, json: { held: "identity", identity: { value: "ambiguous", reason: "namesakes_uncorroborated" } } });
    expect(await miaRunsOf(n.id)).toEqual([]); expect(await miaRunsOf(amb.id)).toEqual([]);
    expect(callEvaluator).not.toHaveBeenCalled();

    const ok = await makeAthlete("resolved");
    await http("POST", `${A(ok.id)}/resolve-identity`, { body: {} });
    const r = await http("POST", `${A(ok.id)}/mia/recompute`, { body: { reason: "dev seam" } });
    expect(r).toMatchObject({ status: 202, json: { created: true, athleteId: ok.id } });
    // Since 4 Nov 2026 M.I.A. scores only from memory facts and never searches: this athlete holds none, so the forced
    // recompute runs, records "no facts yet" and makes no provider call.
    expect(callEvaluator).not.toHaveBeenCalled();
    const ins = await http("GET", A(ok.id));
    expect(ins.json.mia.runs.find((m: any) => m.runId === r.json.runId)).toMatchObject({ status: "done", force: true, trigger: "USER_REQUESTED_REFRESH", blocked: null, evaluate: "skipped_no_facts", recorded: false });
    expect(ins.json.mia.score).toBeNull();
  });

  test("boundary off ⇒ never held (Beta.1 behaviour unchanged)", async () => {
    flags({});
    const n = await makeAthlete("resolved");
    expect((await http("POST", `${A(n.id)}/mia/recompute`, { body: {} })).status).toBe(202);
  });
});

// ── 5. inspect is read-only ───────────────────────────────────────────────────
describe("inspect", () => {
  const TABLES = [workflowRuns, workflowSteps, researchRuns, researchEvidence, athleteFacts, athleteResearchState, researchBudgetDays, miaEvaluationRuns, miaEvidenceSnapshots, intelligenceLedger, athleteAsserted];
  const snapshot = async () => Promise.all(TABLES.map(async (t) => JSON.stringify(await db.select().from(t as any).orderBy(sql`1`))));
  test("GET writes nothing (every touched table identical before and after), for NULL, resolved and unknown athletes", async () => {
    const a = await makeAthlete("resolved");
    await http("POST", `${A(a.id)}/resolve-identity`, { body: {} });
    await http("POST", `${A(a.id)}/research`, { body: { wait: true } });
    const b = await makeAthlete("resolved", { account: false });
    const before = await snapshot();
    const ia = await http("GET", A(a.id));
    const ib = await http("GET", A(b.id));
    expect((await http("GET", A("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(ia.json).toMatchObject({ contract: "intelligence-inspect/0.1", account: { hasSelfMembership: true }, identity: { value: "resolved", boundaryOn: true }, researchStatus: { contract: "research-status/1" } });
    expect(ia.json.knowledge.currentFacts).toBeGreaterThan(0);
    expect(ia.json.researchRuns[0]).toMatchObject({ status: "done", capped: false, reason: "admin:research_full" });
    expect(ia.json.budget).toMatchObject({ maxLlmCallsPerNight: 150, maxCallsPerRun: 8 });
    expect(ib.json).toMatchObject({ account: { hasSelfMembership: false }, identity: { value: null }, knowledge: { currentFacts: 0 } });
    expect(direct).toHaveBeenCalled();   // (only by the setup above)
  });
});

// ── 6. the cohort runner ──────────────────────────────────────────────────────
describe("cohort runner", () => {
  /** The HTTP client, plus what the service's workflow tick would do: execute a queued research run. */
  const client = (): SeamClient => {
    const h = httpSeamClient(base, ADMIN);
    return { ...h, runResearch: async (id, body) => { const r = await h.runResearch(id, body); if (r.body?.workflowRunId) await kick(r.body.workflowRunId); return r; } };
  };

  test("mixed cohort (account / no account / already resolved / ambiguous / sparse / unknown) → one report row each", async () => {
    const acct = await makeAthlete("resolved");
    const noAcct = await makeAthlete("resolved", { account: false });
    const already = await makeAthlete("resolved");
    await http("POST", `${A(already.id)}/resolve-identity`, { body: {} });
    const amb = await makeAthlete("ambiguous");
    const sparse = await makeAthlete("sparse", { account: false });
    const unknown = "00000000-0000-0000-0000-00000000dead";
    const saved: CohortState[] = [];
    const { report, stoppedBy } = await runCohort([acct.id, noAcct.id, already.id, amb.id, sparse.id, unknown], client(), { promoteWithoutAccount: true, pollMs: 1, timeoutMs: 5_000, sleep: async () => {}, save: (s) => { saved.push(JSON.parse(JSON.stringify(s))); } });
    expect(stoppedBy).toBeNull();
    const by = Object.fromEntries(report.map((r) => [r.athleteId, r]));
    for (const r of [by[acct.id], by[noAcct.id], by[already.id], by[sparse.id]]) {
      expect(r).toMatchObject({ outcome: "completed", identity: { value: "resolved" }, research: { outcome: "started", runStatus: "done", capped: false }, mia: { outcome: "requested" } });
      expect(r.facts.current).toBeGreaterThan(0);
      expect(Object.keys(r.research.settled).length).toBeGreaterThan(0);
      // No memory facts (this cohort is researched on the legacy substrate): M.I.A. is requested but scores nothing,
      // and never searches for them (4 Nov 2026).
      expect(r.mia.score).toBeNull();
    }
    expect(by[acct.id]).toMatchObject({ account: true, resolve: "started:T1" });
    expect(by[noAcct.id]).toMatchObject({ account: false, resolve: "started:T1" });
    expect(by[already.id]).toMatchObject({ resolve: "already_resolved" });
    expect(by[amb.id]).toMatchObject({ outcome: "held_for_identity", identity: { value: "ambiguous", reason: "namesakes_uncorroborated" }, research: { outcome: "held_for_identity" }, mia: { outcome: "held:identity", score: null } });
    expect(by[unknown]).toMatchObject({ outcome: "not_found" });
    expect(by[sparse.id].facts.current).toBeLessThanOrEqual(by[acct.id].facts.current);
    // Q2–Q6 ran for every resolved athlete and never for the ambiguous one
    for (const x of [acct, noAcct, already, sparse]) expect(queriesAskedFor(x.name)).toEqual(expect.arrayContaining(["Q2", "Q3", "Q4", "Q5", "Q6"]));
    expect(queriesAskedFor(amb.name)).toEqual(["Q1"]);
    expect(saved.length).toBeGreaterThan(0);

    // resumable: the same state again does nothing new (no provider call, same report)
    asked.length = 0; callEvaluator.mockClear();
    const again = await runCohort([acct.id, noAcct.id, already.id, amb.id, sparse.id, unknown], client(), { promoteWithoutAccount: true, pollMs: 1, timeoutMs: 5_000, sleep: async () => {} }, saved[saved.length - 1]);
    expect(again.report.find((r) => r.athleteId === acct.id)).toEqual(by[acct.id]);
    expect(asked.filter((x) => x.name !== amb.name)).toEqual([]);
    expect(callEvaluator).not.toHaveBeenCalled();
  });

  test("budget-aware: too little headroom stops the cohort and reports the rest capped (caps unchanged); resume continues", async () => {
    const x = await makeAthlete("resolved");
    const y = await makeAthlete("resolved");
    const day = new Date().toISOString().slice(0, 10);
    await db.insert(researchBudgetDays).values({ day, llm_attempts: 150 - 10 } as any);
    let state: CohortState | undefined;
    const first = await runCohort([x.id, y.id], client(), { pollMs: 1, timeoutMs: 5_000, sleep: async () => {}, save: (s) => { state = JSON.parse(JSON.stringify(s)); } });
    expect(first.stoppedBy).toBe("capped");
    expect(first.report.map((r) => r.outcome)).toEqual(["capped", "capped"]);
    expect(first.report[0].notes[0]).toMatch(/headroom 10 < 16/);
    expect(asked).toEqual([]);
    await db.update(researchBudgetDays).set({ llm_attempts: 0 } as any).where(eq(researchBudgetDays.day, day));   // a new budget day
    const second = await runCohort([x.id, y.id], client(), { pollMs: 1, timeoutMs: 5_000, sleep: async () => {} }, state);
    expect(second.report.map((r) => r.outcome)).toEqual(["completed", "completed"]);
  });

  test("a run refused by the ledger mid-way is reported capped and stops the cohort", async () => {
    const x = await makeAthlete("resolved");
    const y = await makeAthlete("resolved");
    await http("POST", `${A(x.id)}/resolve-identity`, { body: {} });
    await http("POST", `${A(y.id)}/resolve-identity`, { body: {} });
    const day = new Date().toISOString().slice(0, 10);
    const used = (await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day)))[0]?.llm_attempts ?? 0;
    // headroom exactly 16 (passes the pre-check), then a 5-attempt-per-query provider exhausts the per-run cap of 8
    await db.update(researchBudgetDays).set({ llm_attempts: 150 - 16 } as any).where(eq(researchBudgetDays.day, day));
    direct.mockImplementation(async (request: string, opts: DirectCallOpts) => { asked.push({ name: "?", q: opts.query!.id }); return fakeDirect(opts, { anchor: "matched", attempts: 5, findings: [fName(request.includes(x.name) ? x.name : y.name), CLASS_YEAR] }); });
    const r = await runCohort([x.id, y.id], client(), { mia: false, pollMs: 1, timeoutMs: 5_000, sleep: async () => {} });
    expect(used).toBeGreaterThan(0);
    expect(r.stoppedBy).toBe("capped");
    expect(r.report[0]).toMatchObject({ outcome: "capped", research: { capped: true } });
    expect(r.report[1].outcome).toBe("capped");
    const [row] = await db.select().from(researchBudgetDays).where(eq(researchBudgetDays.day, day));
    expect(row.llm_attempts).toBeLessThanOrEqual(150);
  });
});

// ── 7. claim inherits ─────────────────────────────────────────────────────────
describe("a public athlete researched before signup, later claimed", () => {
  test("the claim resolves to that athlete, inherits its governed public knowledge, then adds her own evidence", async () => {
    // before signup: a deliberately promoted public athlete, resolved and researched
    const p = await makeAthlete("resolved", { account: false });
    await http("POST", `${A(p.id)}/resolve-identity`, { body: { promoteWithoutAccount: true } });
    const run = await http("POST", `${A(p.id)}/research`, { body: { wait: true } });
    expect(run.json.started).toBe(true);
    const before = await factsOf(p.id);
    const identityBefore = await readIdentityState(p.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((f) => f.origin === "research")).toBe(true);
    const runsBefore = (await runsOf(p.id)).length;

    // the claim (as every claim-link site does: link, then converge on the lifecycle hook)
    const uid = `uid-claimer-${p.id}`;
    await linkUserToAthlete(p.id, uid, "firebase", "verified_unique_email", new Date(), { email: "claimer@example.com", emailVerified: true });
    asked.length = 0;
    expect(await startLifecycleResearch(p.id, "claim")).toEqual({ started: false, reason: "already_governed", value: "resolved" });
    await enterLifecycleResearch(p.id, "claim");
    expect((await runsOf(p.id)).length).toBe(runsBefore);            // no second full run: nothing is re-bought
    expect(asked).toEqual([]);
    expect(await readIdentityState(p.id)).toEqual(identityBefore);    // the governed identity is hers, unchanged
    expect((await factsOf(p.id)).map((f) => f.id).sort()).toEqual(before.map((f) => f.id).sort());   // inherited as is

    // she now speaks for herself (athlete-authenticated), and sees the governed identity she inherited
    const me = await http("GET", "/api/v1/me/identity", { token: `user:${uid}` });
    expect(me).toMatchObject({ status: 200, json: { enabled: true, identity: { value: "resolved", basis: "q1" } } });
    expect(me.json.candidates.q1ResearchRunId).toBeTruthy();
    const ins = await http("GET", A(p.id));
    expect(ins.json.account.hasSelfMembership).toBe(true);

    // ...then adds her own evidence: an athlete-authored statement and a connected account
    await db.insert(athleteAsserted).values({ athlete_id: p.id, field: "hometown", value: { text: "Lakeside" } as any, source: "settings" } as any);
    await seedConnection({ athleteId: p.id, platform: "instagram", status: "active" });
    const more = await http("POST", `${A(p.id)}/research`, { body: { domains: ["profile"], wait: true } });
    expect(more.json.started).toBe(true);
    const after = await factsOf(p.id);
    expect(after.some((f) => f.origin === "athlete_asserted" && f.fact_key === "hometown")).toBe(true);
    expect(after.some((f) => f.origin === "research")).toBe(true);   // the public knowledge stays beside it
    // and M.I.A. is permitted for her (resolved)
    expect((await http("POST", `${A(p.id)}/mia/recompute`, { body: {} })).status).toBe(202);
  });
});

// ── 8. the provisional cost entry ─────────────────────────────────────────────
test("gemini_direct: provisional list-price entry (tokens + per search query)", () => {
  expect(DEFAULT_COST_MODEL.gemini_direct).toEqual({ perMTokInUsd: 1.5, perMTokOutUsd: 9.0, perSearchQueryUsd: 0.014, provisional: true });
  // 3.5k in, 18.8k out (thinking incl.), 12.7 searches ≈ $0.352 (the O3 reconciliation of a measured run)
  expect(estimateCallUsd("gemini_direct", { promptTokens: 3500, completionTokens: 18_800, searchQueries: 12.7 }, DEFAULT_COST_MODEL)).toBeCloseTo(0.3523, 3);
  expect(estimateCallUsd("gemini_grounded", { calls: 1 }, DEFAULT_COST_MODEL)).toBe(0.035);   // unchanged
});
