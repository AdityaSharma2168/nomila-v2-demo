/**
 * signupResearch.test.ts — the daily sign-up research cap (DAILY_RESEARCH_CAP_USD) on EVERY sign-up route, through the
 * one chokepoint (signupResearch.ts startSignupResearchRun), on Express + PGlite with the real runner. The runner's kick
 * is a no-op (backgroundHost mocked off: the minute tick's job), researchAthlete and the M.I.A. request are mocked to
 * throw / no-op and the lifecycle service is mocked, so no provider is ever reached and no research step runs.
 *
 *   S1 under the cap the landing waitlist sign-up (POST /waitlist) starts the legacy onboarding run normally (steps due)
 *   S2 over the cap — on LEGACY researchAthlete spend alone (estimated from the snapshot's calls and tokens) — the
 *      waitlist sign-up still joins (200, waitlisted) and her run exists HELD; the release tick starts it once there
 *      is room (the next UTC day)
 *   S3 legacy research in flight is reserved (a legacy run whose research step is open), and released when it finishes
 *   S4 the app's POST /auth/signup (non-agent front) is capped the same way
 *   S5 the spend counts every source: legacy snapshots, governed research_runs (trigger signup), and the agent runs of
 *      an athlete whose sign-up was the legacy path (created_by signup)
 *   A1 SIGNUP_RESEARCH_AGENT off: the landing starts the legacy run exactly as before (no signup_research run)
 *   A2 on: repeated landing posts start exactly ONE signup_research run (key signup_research:<id>), no legacy run, no
 *      researchAthlete; her said facts are written once; input is her real name and sport
 *   A3 on: never the "Athlete" fallback or the e-mail's local part as a name (no run until she gives a name)
 *   A4 never both routes: a legacy-researched athlete gets no agent run; an agent-researched athlete gets no legacy run
 *      after the flag goes off (rollback), on the landing and the app route
 *   A5 on: the app's /auth/signup (non-agent front, both branches) starts the same agent run and asks for no legacy M.I.A.
 *   A6 on: over the daily cap the agent run is queued (held) like every sign-up
 *   A7 on, with identity resolution on (dev): the landing and app sign-ups get the agent run and NO lifecycle research
 *      (the hook runs after the start and skips an agent-researched athlete); flag off: lifecycle research as before
 *   A8 on: a school / team given after the run started is recorded once as a said fact while the run has not merged
 *   A9 rollback: a FINISHED agent research marks her as agent path only while AGENT_ONBOARDING is on; an active one always
 *   A10 the agent start refuses when a lifecycle research_refresh run already exists for her
 *   G  guard: no sign-up research run is started anywhere but the chokepoint (static scan of server/)
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const verifyIdToken = jest.fn();
jest.mock("../../lib/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireFirebaseUser: (_req: any, _res: any, next: any) => next(),
  verifyIdTokenChecked: (t: string) => verifyIdToken(t),
  tokenFailure: () => ({ status: 401, body: { error: "Invalid or expired token" } }),
  firebaseAuth: { verifyIdToken: (t: string) => verifyIdToken(t), setCustomUserClaims: jest.fn().mockResolvedValue(undefined), createCustomToken: jest.fn().mockResolvedValue("custom") },
}));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op: nothing executes
const mockResearch = jest.fn(async () => { throw new Error("no provider in this test"); });
jest.mock("../../skills/researchAthlete", () => ({ ...jest.requireActual("../../skills/researchAthlete"), researchAthlete: (...a: unknown[]) => (mockResearch as any)(...a) }));
const mockRequestEvaluation = jest.fn(async () => ({}));
jest.mock("../../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: (...a: unknown[]) => (mockRequestEvaluation as any)(...a), getMarketability: jest.fn(async () => null) }));
jest.mock("../../services/intelligence/research/lifecycle", () => ({ startLifecycleResearch: jest.fn(async () => ({ started: false, reason: "disabled" })), reenterIdentityResolution: jest.fn() }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { client, closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, athleteSnapshots, athletes, researchRuns } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { configureRunner, HELD_READY_AT, resetRunnerConfig } from "../../workflow/runner";
import authRouter from "../../routes/auth";
import waitlistRouter from "../../routes/waitlist";
import { nextUtcMidnight, releaseQueuedOnboardings, signupSpendTodayMicroUsd } from "./dailyCap";
import { dbStore } from "../research/dbStore";
import { startSignupResearchRun } from "./signupResearch";

let server: Server; let base = ""; const env = process.env;
const USD = 1_000_000;
let n = 0; const uniq = (s: string) => `${s}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

const post = async (path: string, uid: string, body: Record<string, unknown>) => {
  verifyIdToken.mockResolvedValue({ uid, email: `${uid}@example.com`, email_verified: true });
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
};
/** The start is fire-and-forget from both routes: wait for the run to appear. */
async function runFor(athleteId: string) {
  for (let i = 0; i < 50; i++) {
    const [r] = await db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, athleteId));
    if (r) {
      const steps = await db.select({ step: workflowSteps.step, status: workflowSteps.status, ready_at: workflowSteps.ready_at }).from(workflowSteps).where(eq(workflowSteps.run_id, r.id));
      if (steps.length) return { run: r, steps };
    }
    await new Promise((res) => setTimeout(res, 40));
  }
  throw new Error(`no run for ${athleteId}`);
}
const held = (steps: Array<{ ready_at: Date }>) => steps.length > 0 && steps.every((s) => s.ready_at.getTime() >= HELD_READY_AT.getTime());
const idByUid = async (uid: string) => (await db.select({ id: athletes.id }).from(athletes).where(eq(athletes.auth_id, uid)))[0]!.id;

/** A legacy researchAthlete snapshot: 4 calls × $0.035 + 1M in × $1.50 + 0.2M out × $9.00 = $3.44 (gemini-3.5-flash on Vertex, verified 27 Oct 2026). */
async function legacySnapshot(at = new Date()) {
  const a = await seedAthlete(uniq("Researched"));
  await db.insert(athleteSnapshots).values({ athlete_id: a, trigger: "signup", created_at: at, as_of: at,
    sources: { apis_called: ["gemini_grounding"], gemini_usage: { prompt_tokens: 1_000_000, candidate_tokens: 200_000 }, gemini_stats: { retries_fired: 0 }, kimi_usage: { prompt_tokens: 0, completion_tokens: 0, total_cost_usd: 0 } } } as any);
}
const joinWaitlist = async (uid: string) => {
  const r = await post("/waitlist", uid, { first_name: "Wait", last_name: uniq("Lister"), sport: "Golf" });
  expect(r.status).toBe(200);
  return idByUid(uid);
};

beforeAll(async () => {
  await initTestDb();
  for (const f of ["0048_athlete_index.sql", "0051_identity_users.sql", "0052_identity_claim_sessions.sql"]) await client.exec(readFileSync(join(__dirname, "../../../migrations", f), "utf8"));
  const app = express(); app.use(express.json()); app.use("/auth", authRouter); app.use("/waitlist", waitlistRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { process.env = env; await new Promise<void>((r) => server.close(() => r())); await closeTestDb(); });
beforeEach(async () => {
  // Cap $1, each onboarding reserved at $0.50: room for two in flight with no spend.
  process.env = { ...env, SIGNUPS_OPEN: "true", ATHLETE_INDEX_CLAIM: "false", DAILY_RESEARCH_CAP_USD: "1", AGENT_ONBOARDING_COST_CAP_USD: "0.5", DAILY_CAP_MIA_RESERVE_USD: "0", NEW_ACCOUNTS_PER_IP_PER_HOUR: "0",
    RESEARCH_REFRESH_ENABLED: "false", RESEARCH_SUBSTRATE_WRITE: "false", RESEARCH_REFRESH_PROVIDER: "kimi" };
  resetRunnerConfig(); mockResearch.mockClear(); mockRequestEvaluation.mockClear();
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  await db.delete(athleteSnapshots); await db.delete(researchRuns); await db.delete(agentRuns);
});

test("S1: under the cap the landing waitlist sign-up starts the legacy onboarding run normally", async () => {
  const id = await joinWaitlist(uniq("uid-under"));
  const { run, steps } = await runFor(id);
  expect([run.process, run.created_by]).toEqual(["onboarding", "signup"]);
  expect(held(steps)).toBe(false);
  expect(steps.every((s) => s.status === "ready" && s.ready_at.getTime() <= Date.now())).toBe(true);   // due now
  expect(mockResearch).not.toHaveBeenCalled();
});

test("S2: over the cap on legacy research spend the waitlist sign-up joins and her run is held; the tick releases it the next day", async () => {
  await legacySnapshot();                                                                       // $3.44 + $0.50 > $1
  expect((await signupSpendTodayMicroUsd()).legacyResearch).toBe(3.44 * USD);
  const uid = uniq("uid-over");
  const r = await post("/waitlist", uid, { first_name: "Over", last_name: uniq("Budget"), sport: "Golf" });
  expect(r.status).toBe(200);                                                                   // nothing user-facing changes
  const id = await idByUid(uid);
  expect((await db.select({ status: athletes.status }).from(athletes).where(eq(athletes.id, id)))[0].status).toBe("waitlisted");
  const { run, steps } = await runFor(id);
  expect(held(steps)).toBe(true);
  expect(run.status).toBe("running");
  expect(await releaseQueuedOnboardings(new Date())).toBe(0);                                   // still over today

  const tomorrow = new Date(nextUtcMidnight(new Date()).getTime() + 60_000);
  configureRunner({}, () => tomorrow);
  expect(await releaseQueuedOnboardings(tomorrow)).toBe(1);
  const after = (await runFor(id)).steps;
  expect(held(after)).toBe(false);
  expect(after.every((s) => s.status === "ready" && s.ready_at.getTime() === tomorrow.getTime())).toBe(true);
});

test("S3: legacy research in flight is reserved, and its finish makes room for the queued one", async () => {
  const a = await joinWaitlist(uniq("uid-burst-a"));
  const b = await joinWaitlist(uniq("uid-burst-b"));
  const c = await joinWaitlist(uniq("uid-burst-c"));
  expect(held((await runFor(a)).steps)).toBe(false);
  expect(held((await runFor(b)).steps)).toBe(false);                                            // 0 + 2 × $0.50 ≤ $1
  expect(held((await runFor(c)).steps)).toBe(true);                                             // a third would not fit
  const ra = (await runFor(a)).run;
  await db.update(workflowSteps).set({ status: "done" }).where(eq(workflowSteps.run_id, ra.id)); // A's research finished (parks on greet)
  expect(await releaseQueuedOnboardings(new Date())).toBe(1);
  expect(held((await runFor(c)).steps)).toBe(false);
});

test("S4: the app's POST /auth/signup is capped the same way", async () => {
  await legacySnapshot();
  const r = await post("/auth/signup", uniq("uid-app"), { name: `App ${uniq("Signer")}`, role: "athlete", sport: "Golf" });
  expect(r.status).toBe(201);
  const { run, steps } = await runFor(r.json.id);
  expect([run.process, run.created_by]).toEqual(["onboarding", "app_signup"]);
  expect(held(steps)).toBe(true);
});

test("S5: the day's spend counts legacy snapshots, governed research and a legacy-path sign-up's agent runs", async () => {
  await legacySnapshot();
  const yesterday = new Date(Date.now() - 86_400_000 * 2);
  await legacySnapshot(yesterday);                                                              // not today
  const legacyPath = await seedAthlete(uniq("Legacy Path"));
  await db.insert(workflowRuns).values({ athlete_id: legacyPath, process: "onboarding", definition_version: 2, active_scope: "x", status: "done", input: {}, created_by: "signup", started_at: new Date() } as any);
  await db.insert(agentRuns).values({ athlete_id: legacyPath, skill_id: "research", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 300_000, started_at: new Date(), ended_at: new Date() } as any);
  const notSignup = await seedAthlete(uniq("Not Signup"));                                      // no sign-up run, not agent-front
  await db.insert(agentRuns).values({ athlete_id: notSignup, skill_id: "research", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: 9_000_000, started_at: new Date(), ended_at: new Date() } as any);
  await db.insert(researchRuns).values({ athlete_id: legacyPath, domain: "full", trigger: "signup", estimated_cost_usd: "0.2500" } as any);
  await db.insert(researchRuns).values({ athlete_id: legacyPath, domain: "full", trigger: "manual", estimated_cost_usd: "5.0000" } as any);   // not sign-up research
  expect(await signupSpendTodayMicroUsd()).toEqual({ agentRuns: 0.3 * USD, mia: 0, legacyResearch: 3.44 * USD, governedResearch: 0.25 * USD, total: 3.99 * USD });
});

// ─── A: SIGNUP_RESEARCH_AGENT ────────────────────────────────────────────────────────────────────────────────────────
const runsOf = (athleteId: string) => db.select({ id: workflowRuns.id, process: workflowRuns.process, created_by: workflowRuns.created_by, input: workflowRuns.input, key: workflowRuns.idempotency_key }).from(workflowRuns).where(eq(workflowRuns.athlete_id, athleteId));
/** Fire-and-forget starts: give them a moment to land (or not). */
const settle = () => new Promise((r) => setTimeout(r, 400));

test("A1: flag off ⇒ the landing starts the legacy run exactly as before", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "false";
  const id = await joinWaitlist(uniq("uid-a1"));
  const { run } = await runFor(id);
  expect([run.process, run.created_by, run.idempotency_key]).toEqual(["onboarding", "signup", `onboarding:${id}`]);
  await settle();
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["onboarding"]);
});

test("A2: flag on ⇒ repeated landing posts start exactly one signup_research run, said facts once, no legacy research", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  const uid = uniq("uid-a2");
  const last = uniq("Lister");
  expect((await post("/waitlist", uid, { first_name: "Wait", last_name: last })).status).toBe(200);   // step 1: no sport yet
  await settle();
  const id = await idByUid(uid);
  expect(await runsOf(id)).toEqual([]);
  expect((await post("/waitlist", uid, { sport: "Golf" })).status).toBe(200);
  const { run, steps } = await runFor(id);
  for (const body of [{ sport: "Golf", school: "Example State" }, { career_status: "active" }]) expect((await post("/waitlist", uid, body)).status).toBe(200);
  await settle();
  const runs = await runsOf(id);
  expect(runs.map((r) => [r.process, r.created_by, r.key])).toEqual([["signup_research", "signup", `signup_research:${id}`]]);
  expect(run.input).toEqual({ name: `Wait ${last}`, sport: "Golf" });
  expect(steps.map((s) => s.step).sort()).toEqual(["research_a", "research_b"]);
  expect(held(steps)).toBe(false);
  const said = (await dbStore.listFacts(id, ["active"])).filter((f) => f.type === "said").map((f) => f.claim).sort();
  // name and sport once, at creation; the school that came later once, as a late said fact (before the merge)
  expect(said).toEqual([`The athlete's name is Wait ${last}.`, `Wait ${last}'s school or team is Example State.`, `Wait ${last}'s sport is Golf.`]);
  expect(mockResearch).not.toHaveBeenCalled();
  expect((await db.select().from(athleteSnapshots).where(eq(athleteSnapshots.athlete_id, id))).length).toBe(0);
});

test("A3: flag on ⇒ never the Athlete fallback or the e-mail local part as the name", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  const uid = uniq("uid-a3");
  expect((await post("/waitlist", uid, { sport: "Golf" })).status).toBe(200);                   // no name: the row's name is the e-mail's local part
  await settle();
  const id = await idByUid(uid);
  expect(await runsOf(id)).toEqual([]);
  expect((await post("/waitlist", uid, { first_name: "Real", last_name: uniq("Name") })).status).toBe(200);   // she gives a name: now it starts
  const { run } = await runFor(id);
  expect(run.process).toBe("signup_research");
});

test("A4: never both routes for one athlete, either way round", async () => {
  // Legacy first (flag off), then the flag goes on: no agent run.
  process.env.SIGNUP_RESEARCH_AGENT = "false";
  const uid = uniq("uid-a4-legacy");
  const legacy = await joinWaitlist(uid);
  await runFor(legacy);
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  expect((await post("/waitlist", uid, { sport: "Tennis" })).status).toBe(200);
  await settle();
  expect((await runsOf(legacy)).map((r) => r.process)).toEqual(["onboarding"]);

  // Agent first, then rollback (flag off): her repeat posts start no legacy run.
  const uid2 = uniq("uid-a4-agent");
  const agent = await joinWaitlist(uid2);
  expect((await runFor(agent)).run.process).toBe("signup_research");
  process.env.SIGNUP_RESEARCH_AGENT = "false";
  expect((await post("/waitlist", uid2, { sport: "Golf" })).status).toBe(200);
  await settle();
  expect((await runsOf(agent)).map((r) => r.process)).toEqual(["signup_research"]);
  const refused = await startSignupResearchRun({ process: "onboarding", athleteId: agent, createdBy: "signup", idempotencyKey: `onboarding:${agent}` }, { capped: true });
  expect(refused).toMatchObject({ created: false, refused: "agent_research" });
  // Only an explicit operator rollback (agent front off) may still start legacy for her.
  const forced = await startSignupResearchRun({ process: "onboarding", athleteId: agent, createdBy: "admin", idempotencyKey: `onboarding:${agent}` }, { capped: false, legacyAfterAgentResearch: true });
  expect(forced.created).toBe(true);
});

test("A5: flag on ⇒ the app's /auth/signup starts the same agent run and asks for no legacy M.I.A.", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  const r = await post("/auth/signup", uniq("uid-a5"), { name: `App ${uniq("Signer")}`, role: "athlete", sport: "Golf" });
  expect(r.status).toBe(201);
  const { run } = await runFor(r.json.id);
  expect([run.process, run.created_by]).toEqual(["signup_research", "app_signup"]);
  await settle();
  expect((await runsOf(r.json.id)).length).toBe(1);
  expect(mockRequestEvaluation).not.toHaveBeenCalled();
});

test("A6: flag on ⇒ over the daily cap the agent run is queued like every sign-up", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  await legacySnapshot();                                                                       // $3.44 + $0.50 > $1
  const id = await joinWaitlist(uniq("uid-a6"));
  const { run, steps } = await runFor(id);
  expect(run.process).toBe("signup_research");
  expect(held(steps)).toBe(true);
  const tomorrow = new Date(nextUtcMidnight(new Date()).getTime() + 60_000);
  configureRunner({}, () => tomorrow);
  expect(await releaseQueuedOnboardings(tomorrow)).toBe(1);
  expect(held((await runFor(id)).steps)).toBe(false);
});

test("A7: with identity resolution on, an agent-researched sign-up never also gets lifecycle research", async () => {
  const { startLifecycleResearch } = require("../../services/intelligence/research/lifecycle");
  Object.assign(process.env, { RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_PROVIDER: "direct", DAILY_RESEARCH_CAP_USD: "" });
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  startLifecycleResearch.mockClear();
  const agent = await joinWaitlist(uniq("uid-a7"));
  expect((await runFor(agent)).run.process).toBe("signup_research");
  const app = await post("/auth/signup", uniq("uid-a7-app"), { name: `App ${uniq("Seven")}`, role: "athlete", sport: "Golf" });
  expect((await runFor(app.json.id)).run.process).toBe("signup_research");
  await settle();
  expect(startLifecycleResearch).not.toHaveBeenCalled();

  process.env.SIGNUP_RESEARCH_AGENT = "false";                                                  // flag off: today's lifecycle entry
  const legacy = await joinWaitlist(uniq("uid-a7-legacy"));
  await runFor(legacy);
  await settle();
  expect(startLifecycleResearch).toHaveBeenCalledWith(legacy, "signup");
  expect(startLifecycleResearch).toHaveBeenCalledTimes(1);
});

test("A8: a school / team given after the run started is recorded once, before the merge", async () => {
  process.env.SIGNUP_RESEARCH_AGENT = "true";
  const uid = uniq("uid-a8");
  const id = await joinWaitlist(uid);
  await runFor(id);
  const [{ full_name }] = await db.select({ full_name: athletes.full_name }).from(athletes).where(eq(athletes.id, id));
  for (let i = 0; i < 2; i++) expect((await post("/waitlist", uid, { school: "Example Tech" })).status).toBe(200);
  await settle();
  const school = (await dbStore.listFacts(id, ["active"])).filter((f) => f.type === "said" && /school or team/.test(f.claim)).map((f) => f.claim);
  expect(school).toEqual([`${full_name}'s school or team is Example Tech.`]);
});

test("A9: a finished agent research keeps her on the agent path only while the agent app front is on", async () => {
  const { isAgentFrontAthlete } = require("../../services/agentFrontAthlete");
  const id = await seedAthlete(uniq("Rolled Back"), { status: "active" } as any);
  const [run] = await db.insert(workflowRuns).values({ athlete_id: id, process: "signup_research", definition_version: 2, active_scope: "signup_research", status: "running", input: {}, created_by: "signup", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  delete process.env.AGENT_ONBOARDING;
  expect(await isAgentFrontAthlete(id)).toBe(true);                                             // research in flight: always
  await db.update(workflowRuns).set({ status: "done" }).where(eq(workflowRuns.id, run.id));
  expect(await isAgentFrontAthlete(id)).toBe(false);                                            // finished + front off: the legacy app's hooks apply
  process.env.AGENT_ONBOARDING = "true";
  expect(await isAgentFrontAthlete(id)).toBe(true);                                             // finished + front on: the agent owns her
  await db.update(workflowRuns).set({ status: "canceled" }).where(eq(workflowRuns.id, run.id));
  expect(await isAgentFrontAthlete(id)).toBe(false);
});

test("A10: the agent start refuses when lifecycle research already exists for her", async () => {
  const { startSignupAgentResearch } = require("./signupResearch");
  const id = await seedAthlete(`Lifecycle ${uniq("First")}`, { sport: "Golf", status: "waitlisted" } as any);
  await db.insert(workflowRuns).values({ athlete_id: id, process: "research_refresh", definition_version: 3, active_scope: "research_refresh", status: "running", input: {}, created_by: "lifecycle_signup", started_at: new Date() } as any);
  expect(await startSignupAgentResearch(id, { createdBy: "signup" })).toEqual({ started: false, reason: "lifecycle_research" });
  expect((await runsOf(id)).map((r) => r.process)).toEqual(["research_refresh"]);
  const manual = await seedAthlete(`Manual ${uniq("Refresh")}`, { sport: "Golf", status: "waitlisted" } as any);   // not lifecycle: no refusal
  await db.insert(workflowRuns).values({ athlete_id: manual, process: "research_refresh", definition_version: 1, active_scope: "research_refresh", status: "done", input: {}, created_by: "admin", started_at: new Date() } as any);
  expect(await startSignupAgentResearch(manual, { createdBy: "signup" })).toMatchObject({ started: true });
});

// ─── G: the guard ────────────────────────────────────────────────────────────────────────────────────────────────────
const SERVER = join(__dirname, "../..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "testUtils" && name !== "__tests__") sources(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(SERVER, p).split("\\").join("/");

test("G: no sign-up research run is started anywhere but the chokepoint", () => {
  const SIGNUP_PROCESS = /process:\s*(?:"onboarding"|'onboarding'|"agent_onboarding"|'agent_onboarding'|AGENT_ONBOARDING_PROCESS|"signup_research"|'signup_research'|SIGNUP_RESEARCH_PROCESS)\b/;
  const offenders: string[] = [];
  const holds: string[] = [];
  for (const file of sources(SERVER)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\bstartRun\s*\(/g)) {
      const args = text.slice(m.index!, m.index! + 600).split(/\)\s*[;.\n]/)[0];
      if (SIGNUP_PROCESS.test(args) && rel(file) !== "agent/onboarding/signupResearch.ts") offenders.push(`${rel(file)}: ${args.slice(0, 120)}`);
    }
    if (/holdUntil:\s*HELD_READY_AT\s*[,}]/.test(text)) holds.push(rel(file));
  }
  expect(offenders).toEqual([]);
  expect(holds).toEqual(["agent/onboarding/signupResearch.ts"]);   // only the chokepoint queues

  // researchAthlete with the "signup" trigger runs only inside the legacy onboarding definition (started through the chokepoint).
  const signupResearchers = sources(SERVER).filter((f) => /researchAthlete\([^)]*"signup"/.test(readFileSync(f, "utf8"))).map(rel);
  expect(signupResearchers).toEqual(["workflow/definitions/onboarding.ts"]);

  // The lifecycle entry's governed run goes through the chokepoint; the routes use it for every sign-up start.
  const lifecycle = readFileSync(join(SERVER, "services/intelligence/research/lifecycle.ts"), "utf8");
  expect(lifecycle).toMatch(/startSignupResearchRun\(start, \{ capped: true \}\)/);
  expect(lifecycle).toMatch(/`lifecycle_\$\{trigger\}`, asOf, \{ signup: true \}\)/);
  for (const f of ["routes/waitlist.ts", "routes/auth.ts", "agent/onboarding/service.ts"]) {
    expect(readFileSync(join(SERVER, f), "utf8")).toMatch(/startSignupResearchRun\([^]*?\{ capped: (true|body\.optIn !== true) \}\)/);
  }
  // SIGNUP_RESEARCH_AGENT: the landing and the app sign-up start the agent run only through the chokepoint's
  // startSignupAgentResearch, and each legacy sign-up start there sits in the flag-off branch.
  const agentStarters = sources(SERVER).filter((f) => /\bstartSignupAgentResearch\(/.test(readFileSync(f, "utf8"))).map(rel).sort();
  // The landing goes through the "real athlete?" check first (footprintCheck.ts startSignupResearchChecked), which
  // starts the agent run through the same chokepoint.
  expect(agentStarters).toEqual(["agent/onboarding/footprintCheck.ts", "agent/onboarding/signupResearch.ts", "routes/auth.ts"]);
  expect(readFileSync(join(SERVER, "routes/waitlist.ts"), "utf8")).toMatch(/startSignupResearchChecked\(athleteId/);
  // Agent-researched athletes are on the agent path, so the legacy lifecycle / refresh / M.I.A. hooks skip them.
  expect(readFileSync(join(SERVER, "services/agentFrontAthlete.ts"), "utf8")).toMatch(/w\.process = 'signup_research'/);
  for (const f of ["routes/waitlist.ts", "routes/auth.ts"]) {
    const text = readFileSync(join(SERVER, f), "utf8");
    const legacy = [...text.matchAll(/startSignupResearchRun\(\{ process: "onboarding"/g)];
    expect(legacy.length).toBe(1);
    expect(text.slice(Math.max(0, legacy[0].index! - 700), legacy[0].index!)).toContain("signupResearchAgentEnabled()");
  }
});

// Prod switched on for the waitlist on 24 Oct 2026 (owner, option a: no promotions until the agent app is live in prod).
test("G2: SIGNUP_RESEARCH_AGENT is on exactly once in the dev yaml and in the prod yaml", () => {
  const { parse } = require("yaml");
  const envOf = (f: string) => (parse(readFileSync(join(SERVER, "..", "gcp", f), "utf8")).spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>).filter((e) => e.name === "SIGNUP_RESEARCH_AGENT");
  expect(envOf("cloud-run-dev.yaml")).toEqual([{ name: "SIGNUP_RESEARCH_AGENT", value: "true" }]);
  expect(envOf("cloud-run-prod.yaml")).toEqual([{ name: "SIGNUP_RESEARCH_AGENT", value: "true" }]);
});
