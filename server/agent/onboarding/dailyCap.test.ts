/**
 * dailyCap.test.ts — the daily cap on sign-up research spend (DAILY_RESEARCH_CAP_USD), end to end on Express + PGlite
 * through the real onboarding start route and the real runner. `kick` is mocked and the model transport throws, so no
 * provider is ever reached; nothing here runs a research step.
 *
 *   C1 the day's spend sums BOTH sources (agent_runs.cost_micro_usd + mia_evaluation_runs.cost_usd) for athletes in their
 *      sign-up window only (agent-front, created in the last SIGNUP_WINDOW_DAYS), since UTC midnight only
 *   C2 under the cap: the research starts (kicked, steps due now, researchQueued false)
 *   C3 over the cap: the sign-up still gets her run, said facts and name_sport checkpoint, but the research is QUEUED
 *      (held, not kicked); the state says researchQueued + researchExpectedBy (the next UTC midnight); a release the same
 *      day starts nothing
 *   C4 the next UTC day the tick's release starts it (steps due now), oldest first; a newcomer never jumps the queue
 *   C5 in-flight research is reserved at the per-onboarding cap (a burst cannot all start before its spend lands)
 *   C6 no cap (unset) ⇒ never queued, and anything queued is released; a "Meet Mila" opt-in skips the queue's
 *      reservation (it starts with room for less than one sign-up) but not the hard stop: past the cap it is held too
 *   C7 only a SPENDING step reserves: a run parked on the conversation (await_human) or the finish (code) reserves
 *      nothing, even with its run status 'waiting' or 'running'; a model step open (ready or running) does
 *   C9 a held signup_research run nobody needs (a promoted landing sign-up, or one researched elsewhere since) is never
 *      released: the release cancels it, and it neither counts as queued nor blocks a newcomer
 *   C8 the waitlist's agent research (signup_research) counts: her agent runs and M.I.A. spend are sign-up spend even
 *      though she is not an agent-front sign-up, and a signup_research run with a model step open is reserved
 *   C10 each run is reserved at its worst case: the per-onboarding cap PLUS the M.I.A. reserve (DAILY_CAP_MIA_RESERVE_USD)
 *   C11 ATOMIC: concurrent admits of held runs never overshoot (room for two ⇒ exactly two start), through the advisory
 *       transaction lock
 *   C12 FAIL CLOSED: when the budget cannot be read the sign-up still gets her run, but it is held (queued), never
 *       started; the tick releases it once the budget reads again
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));
const mockKick = jest.fn(async () => 0);
jest.mock("../../workflow/runner", () => ({ ...jest.requireActual("../../workflow/runner"), kick: (...a: unknown[]) => (mockKick as any)(...a) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns, athletes, miaEvaluationRuns, miaEvidenceSnapshots } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import { configureRunner, HELD_READY_AT, resetRunnerConfig } from "../../workflow/runner";
import { dbStore } from "../research/dbStore";
import { setResponsesTransport } from "../research/llm";
import { agentOnboardingRouter } from "./routes";
import { admitHeldRun, dailyResearchCapMicroUsd, DAILY_RESEARCH_CAP_FALLBACK_USD, DAILY_RESEARCH_CAP_MAX_USD, nextUtcMidnight, perRunReserveMicroUsd, releaseQueuedOnboardings, shouldQueueNewResearch, signupSpendTodayMicroUsd, SIGNUP_RESEARCH_PROCESS, utcMidnight } from "./dailyCap";

let server: Server;
let base = "";
const env = process.env;
const USD = 1_000_000;

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A new agent-front sign-up (the only kind whose spend counts). */
const signupAthlete = (name: string, extra: Record<string, unknown> = {}) => seedAthlete(name, { agent_onboarding_required: true, ...extra } as any);

async function spendAgent(athleteId: string, usd: number, at = new Date()) {
  await db.insert(agentRuns).values({ athlete_id: athleteId, skill_id: "research", skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low",
    status: "completed", cost_micro_usd: Math.round(usd * USD), started_at: at, ended_at: at } as any);
}
async function spendMia(athleteId: string, usd: number, at = new Date()) {
  const [snap] = await db.insert(miaEvidenceSnapshots).values({ athlete_id: athleteId, name: "x", sport: "golf", evidence_as_of: at, digest: `d-${Math.random()}`, trigger_reason: "IDENTITY_RESOLVED" } as any).returning({ id: miaEvidenceSnapshots.id });
  await db.insert(miaEvaluationRuns).values({ snapshot_id: snap.id, athlete_id: athleteId, status: "ok", evaluator_version: "v", provider: "openai", model: "m", cost_usd: usd.toFixed(4), started_at: at } as any);
}

/** The run's first-step rows: held (queued) or due. */
async function firstSteps(runId: string) {
  return db.select({ step: workflowSteps.step, status: workflowSteps.status, ready_at: workflowSteps.ready_at }).from(workflowSteps).where(eq(workflowSteps.run_id, runId));
}
/** Her research steps finished and the run parked on the conversation: what a real run looks like after the merge. */
async function researchDone(runId: string) {
  await db.update(workflowSteps).set({ status: "done" }).where(eq(workflowSteps.run_id, runId));
  await db.insert(workflowSteps).values({ run_id: runId, step: "conversation", ordinal: 8, kind: "await_human", status: "waiting", input: {} } as any);
  await db.update(workflowRuns).set({ status: "waiting" }).where(eq(workflowRuns.id, runId));
}

/** A run of `process` with the given steps (as the runner writes them), for the in-flight rule. */
async function seedRun(athleteId: string, process: string, status: "running" | "waiting", steps: Array<{ step: string; kind: string; status: string }>) {
  const [run] = await db.insert(workflowRuns).values({ athlete_id: athleteId, process, definition_version: 1, active_scope: process, status, input: {}, created_by: "test", started_at: new Date() } as any).returning({ id: workflowRuns.id });
  for (const [i, s] of steps.entries()) await db.insert(workflowSteps).values({ run_id: run.id, ordinal: i, ...s, input: {} } as any);
  return run.id;
}

const held = (rows: Array<{ ready_at: Date }>) => rows.length > 0 && rows.every((r) => r.ready_at.getTime() >= HELD_READY_AT.getTime());

beforeAll(async () => {
  await initTestDb();
  setResponsesTransport((async () => { throw new Error("no model in this test"); }) as any);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", agentOnboardingRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env = env;
  setResponsesTransport(null);
  await new Promise((r) => server.close(r));
  await closeTestDb();
});
beforeEach(async () => {
  process.env = { ...env, AGENT_ONBOARDING: "true", DAILY_RESEARCH_CAP_USD: "200", DAILY_CAP_MIA_RESERVE_USD: "0" };   // C10 covers the M.I.A. reserve
  delete process.env.AGENT_ONBOARDING_COST_CAP_USD;   // the per-onboarding cap: its default $2
  resetRunnerConfig();
  mockKick.mockClear();
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  await db.delete(miaEvaluationRuns); await db.delete(miaEvidenceSnapshots); await db.delete(agentRuns);
});

test("C1: the day's sign-up spend sums both sources, for sign-up-window athletes only, since UTC midnight only", async () => {
  const a = await signupAthlete("Spend One");
  const b = await signupAthlete("Spend Two");
  await spendAgent(a, 1.5); await spendMia(a, 0.25); await spendMia(b, 0.1);
  const yesterday = new Date(utcMidnight(new Date()).getTime() - 3_600_000);
  await spendAgent(a, 50, yesterday); await spendMia(b, 50, yesterday);                         // before UTC midnight: not today
  const existing = await seedAthlete("Existing Athlete");                                       // not an agent-front sign-up
  await spendAgent(existing, 70); await spendMia(existing, 70);
  const old = await signupAthlete("Old Signup", { created_at: new Date(Date.now() - 30 * 86_400_000) });   // outside the window
  await spendAgent(old, 80);
  const s = await signupSpendTodayMicroUsd(new Date());
  expect(s).toEqual({ agentRuns: 1.5 * USD, mia: 0.35 * USD, legacyResearch: 0, governedResearch: 0, total: 1.85 * USD });
});

test("C2: under the cap the research starts at once", async () => {
  const id = await signupAthlete("Under Cap", { status: "waitlisted" });                   // a join-flow sign-up: waitlisted never blocks her research
  await spendAgent(id, 100); await spendMia(id, 50);                                            // 150 + 2 ≤ 200
  const r = await call(id, "POST", "/agent/onboarding/start", { name: "Under Cap", sports: ["Golf"] });
  expect(r.status).toBe(202);
  expect(r.body.researchQueued).toBe(false);
  expect(mockKick).toHaveBeenCalledWith(r.body.runId);
  const steps = await firstSteps(r.body.runId);
  expect(steps.map((s) => s.step).sort()).toEqual(["research_a", "research_b"]);
  expect(held(steps)).toBe(false);
  const state = await call(id, "GET", "/agent/onboarding");
  expect(state.body).toMatchObject({ researchQueued: false, researchExpectedBy: null });
});

test("C3 + C4: over the cap (both sources summed) the research is queued, then started the next UTC day", async () => {
  const spender = await signupAthlete("Big Spender");
  await spendAgent(spender, 150);                                                               // 150 + 2 ≤ 200: room on agent_runs alone
  const early = await signupAthlete("Early Bird");
  const ok = await call(early, "POST", "/agent/onboarding/start", { name: "Early Bird", sports: ["Golf"] });
  expect(ok.body.researchQueued).toBe(false);
  await researchDone(ok.body.runId);                                                            // her research is done (no longer in flight)

  await spendMia(spender, 49);                                                                  // 199 + 2 > 200: only the SUM is over
  const id = await signupAthlete("Over Cap");
  const r = await call(id, "POST", "/agent/onboarding/start", { name: "Over Cap", sports: ["Golf", "Tennis"] });
  expect(r.status).toBe(202);
  expect(r.body.researchQueued).toBe(true);
  expect(mockKick).not.toHaveBeenCalledWith(r.body.runId);
  expect(held(await firstSteps(r.body.runId))).toBe(true);
  // The plain steps are complete: the run, her said facts and the name_sport checkpoint.
  const facts = (await dbStore.listFacts(id, ["active"])).filter((f) => f.type === "said").map((f) => f.claim).sort();
  expect(facts).toEqual(["Over Cap also plays Tennis.", "Over Cap's main sport is Golf.", "The athlete's name is Over Cap."]);
  expect((await dbStore.getCheckpoints(id, r.body.runId)).name_sport?.status).toBe("done");
  const [row] = await db.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, id));
  expect(row.sport).toBe("Golf");

  const state = await call(id, "GET", "/agent/onboarding");
  expect(state.body.researchQueued).toBe(true);
  expect(state.body.researchExpectedBy).toBe(nextUtcMidnight(new Date()).toISOString());

  // A second sign-up queues behind her; a same-day release starts nobody (still over the cap).
  const later = await signupAthlete("Later Signup");
  const r2 = await call(later, "POST", "/agent/onboarding/start", { name: "Later Signup", sports: ["Golf"] });
  expect(r2.body.researchQueued).toBe(true);
  expect(await releaseQueuedOnboardings(new Date())).toBe(0);
  expect(held(await firstSteps(r.body.runId))).toBe(true);

  // The next UTC day the spend resets: the tick's release starts them, oldest first, steps due now.
  const tomorrow = new Date(nextUtcMidnight(new Date()).getTime() + 60_000);
  configureRunner({}, () => tomorrow);
  expect(await releaseQueuedOnboardings(tomorrow, 1)).toBe(1);
  const steps = await firstSteps(r.body.runId);
  expect(held(steps)).toBe(false);
  expect(steps.every((s) => s.status === "ready" && s.ready_at.getTime() === tomorrow.getTime())).toBe(true);
  expect(held(await firstSteps(r2.body.runId))).toBe(true);                                     // the batch limit: one at a time here
  expect(await releaseQueuedOnboardings(tomorrow)).toBe(1);
  expect(held(await firstSteps(r2.body.runId))).toBe(false);
  expect((await call(id, "GET", "/agent/onboarding")).body.researchQueued).toBe(false);
});

test("C4: while anyone is queued, a newcomer queues too, even with room (first come, first served)", async () => {
  const first = await signupAthlete("Queued First");
  const s = await signupAthlete("Spender Two");
  await spendAgent(s, 199);
  const q = await call(first, "POST", "/agent/onboarding/start", { name: "Queued First", sports: ["Golf"] });
  expect(q.body.researchQueued).toBe(true);
  await db.delete(agentRuns);                                                                   // room again (as if a new day)…
  const next = await signupAthlete("Newcomer");
  const r = await call(next, "POST", "/agent/onboarding/start", { name: "Newcomer", sports: ["Golf"] });
  expect(r.body.researchQueued).toBe(true);                                                     // …but she waits her turn
  expect(await releaseQueuedOnboardings(new Date())).toBe(2);
});

test("C5: research in flight is reserved at the per-onboarding cap", async () => {
  process.env.DAILY_RESEARCH_CAP_USD = "5";                                                     // room for two $2 onboardings
  const ids = await Promise.all(["Burst A", "Burst B", "Burst C"].map((n) => signupAthlete(n)));
  const out = [];
  for (const [i, id] of ids.entries()) out.push((await call(id, "POST", "/agent/onboarding/start", { name: `Burst ${"ABC"[i]}`, sports: ["Golf"] })).body.researchQueued);
  expect(out).toEqual([false, false, true]);                                                    // no spend recorded yet, still only two start
  const [first] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.athlete_id, ids[0]));
  await researchDone(first.id);                                                                 // one finishes its research
  expect(await releaseQueuedOnboardings(new Date())).toBe(1);
});

test("C6: no cap ⇒ never queued and anything queued is released; a Meet Mila opt-in skips the reservation, not the hard stop", async () => {
  const s = await signupAthlete("Spender Three");
  await spendAgent(s, 199);                                                                     // under the cap, but no room for a $2 sign-up
  const optIn = await seedAthlete("Existing Opt In", { sport: "Golf" } as any);
  const o = await call(optIn, "POST", "/agent/onboarding/start", { name: "Existing Opt In", sport: "Golf", optIn: true });
  expect(o.body.researchQueued).toBe(false);
  await spendAgent(s, 301);                                                                     // past the cap: the hard stop holds it
  const optInLate = await seedAthlete("Late Opt In", { sport: "Golf" } as any);
  const late = await call(optInLate, "POST", "/agent/onboarding/start", { name: "Late Opt In", sport: "Golf", optIn: true });
  expect(late.body.researchQueued).toBe(true);
  expect(held(await firstSteps(late.body.runId))).toBe(true);
  const q = await signupAthlete("Queued Before Lift");
  expect((await call(q, "POST", "/agent/onboarding/start", { name: "Queued Before Lift", sports: ["Golf"] })).body.researchQueued).toBe(true);

  delete process.env.DAILY_RESEARCH_CAP_USD;
  const n = await signupAthlete("No Cap");
  expect((await call(n, "POST", "/agent/onboarding/start", { name: "No Cap", sports: ["Golf"] })).body.researchQueued).toBe(false);
  expect(await releaseQueuedOnboardings(new Date())).toBe(2);                                   // the sign-up and the late opt-in
  // An unreadable value is the $300 fallback (spend guards, fail closed): a cap applies, so with the two runs just
  // released holding their reservations this sign-up is QUEUED (held for budget), not run uncapped and not refused.
  process.env.DAILY_RESEARCH_CAP_USD = "not a number";
  const m = await signupAthlete("Bad Cap");
  const bad = await call(m, "POST", "/agent/onboarding/start", { name: "Bad Cap", sports: ["Golf"] });
  expect(bad.status).toBeLessThan(300);
  expect(dailyResearchCapMicroUsd()).toBe(DAILY_RESEARCH_CAP_FALLBACK_USD * 1_000_000);
});

test("C7: only a spending step reserves; a run parked on the conversation or the finish reserves nothing", async () => {
  process.env.DAILY_RESEARCH_CAP_USD = "5";                                                     // room for two $2 reservations
  const done = { kind: "model", status: "done" };
  // Two onboardings parked on the conversation for weeks (run 'waiting'), and one on the finish step (run 'running').
  for (const n of ["Parked A", "Parked B"]) {
    await seedRun(await signupAthlete(n), "agent_onboarding", "waiting", [{ step: "research_a", ...done }, { step: "research_merge", ...done }, { step: "conversation", kind: "await_human", status: "waiting" }]);
  }
  await seedRun(await signupAthlete("Finishing"), "agent_onboarding", "running", [{ step: "insights", ...done }, { step: "finish", kind: "code", status: "ready" }]);
  expect(await shouldQueueNewResearch()).toBe(false);                                           // 0 reserved: 0 + 1 × 2 ≤ 5

  // A model step open reserves, whatever the run status: a turn-time sibling on a waiting run, a running pass.
  await seedRun(await signupAthlete("Sibling"), "agent_onboarding", "waiting", [{ step: "insights", kind: "model", status: "running" }, { step: "conversation", kind: "await_human", status: "waiting" }]);
  expect(await shouldQueueNewResearch()).toBe(false);                                           // 1 reserved: 2 + 2 ≤ 5
  await seedRun(await signupAthlete("Passing"), "agent_onboarding", "running", [{ step: "research_a", kind: "model", status: "ready" }]);
  expect(await shouldQueueNewResearch()).toBe(true);                                            // 2 reserved: 4 + 2 > 5

  // A legacy run parked on the greeting reserves nothing (unchanged rule); its open research step does.
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  await seedRun(await seedAthlete("Legacy Parked"), "onboarding", "waiting", [{ step: "research", kind: "model", status: "done" }, { step: "greet", kind: "await_human", status: "waiting" }]);
  await seedRun(await seedAthlete("Legacy Parked Two"), "onboarding", "waiting", [{ step: "research", kind: "model", status: "done" }, { step: "greet", kind: "await_human", status: "waiting" }]);
  expect(await shouldQueueNewResearch()).toBe(false);
});

test("C8: the waitlist's agent research (signup_research) is counted and reserved", async () => {
  const w = await seedAthlete("Waitlist Researched", { status: "waitlisted" } as any);              // NOT an agent-front sign-up
  await seedRun(w, SIGNUP_RESEARCH_PROCESS, "running", [{ step: "mia_preview", kind: "model", status: "running" }]);
  await spendAgent(w, 0.8); await spendMia(w, 0.28);
  const none = await seedAthlete("No Research Run", { status: "waitlisted" } as any);              // no sign-up run of any kind
  await spendAgent(none, 9);
  expect(await signupSpendTodayMicroUsd(new Date())).toEqual({ agentRuns: 0.8 * USD, mia: 0.28 * USD, legacyResearch: 0, governedResearch: 0, total: 1.08 * USD });

  process.env.DAILY_RESEARCH_CAP_USD = "6";                                                     // 1.08 + (1 + 1) × 2 ≤ 6; one more would not fit
  expect(await shouldQueueNewResearch()).toBe(false);
  await seedRun(await seedAthlete("Second Waitlister", { status: "waitlisted" } as any), SIGNUP_RESEARCH_PROCESS, "running", [{ step: "research_a", kind: "model", status: "ready" }]);
  expect(await shouldQueueNewResearch()).toBe(true);                                            // 1.08 + 3 × 2 > 6
  // Her research finished (the run is done): nothing reserved.
  await db.update(workflowSteps).set({ status: "done" });
  await db.update(workflowRuns).set({ status: "done" });
  expect(await shouldQueueNewResearch()).toBe(false);
});

test("C9: a held sign-up research is never released once she is promoted or researched elsewhere", async () => {
  process.env.DAILY_RESEARCH_CAP_USD = "200";
  const heldSteps = [{ step: "research_a", kind: "model", status: "ready" }];
  const hold = async (runId: string) => db.update(workflowSteps).set({ ready_at: HELD_READY_AT }).where(eq(workflowSteps.run_id, runId));
  const createdBy = (runId: string, by: string) => db.update(workflowRuns).set({ created_by: by }).where(eq(workflowRuns.id, runId));
  const promoted = await seedAthlete("Promoted Waiter", { status: "active" } as any);
  const p = await seedRun(promoted, SIGNUP_RESEARCH_PROCESS, "running", heldSteps); await hold(p); await createdBy(p, "signup");
  const elsewhere = await seedAthlete("Researched Elsewhere", { status: "raw" } as any);
  const x = await seedRun(elsewhere, SIGNUP_RESEARCH_PROCESS, "running", heldSteps); await hold(x); await createdBy(x, "app_signup");
  await seedRun(elsewhere, "agent_onboarding", "waiting", [{ step: "conversation", kind: "await_human", status: "waiting" }]);
  const waiting = await seedAthlete("Still Waitlisted", { status: "waitlisted" } as any);
  const w = await seedRun(waiting, SIGNUP_RESEARCH_PROCESS, "running", heldSteps); await hold(w); await createdBy(w, "signup");

  expect(await releaseQueuedOnboardings(new Date())).toBe(1);                                   // only hers
  const status = async (id: string) => (await db.select({ s: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, id)))[0].s;
  expect([await status(p), await status(x), await status(w)]).toEqual(["canceled", "canceled", "running"]);
  expect(await shouldQueueNewResearch()).toBe(false);                                           // nothing stale left in the queue
});

test("C10: each run is reserved at the per-onboarding cap plus the M.I.A. reserve", async () => {
  process.env.DAILY_CAP_MIA_RESERVE_USD = "1";
  expect(perRunReserveMicroUsd()).toBe(3 * USD);                                                // $2 + $1
  delete process.env.DAILY_CAP_MIA_RESERVE_USD;
  expect(perRunReserveMicroUsd()).toBe(3 * USD);                                                // the default M.I.A. reserve is $1
  process.env.DAILY_CAP_MIA_RESERVE_USD = "1";
  process.env.DAILY_RESEARCH_CAP_USD = "5";                                                     // room for ONE $3 run, not two
  const ids = await Promise.all(["Reserve A", "Reserve B"].map((n) => signupAthlete(n)));
  const out = [];
  for (const [i, id] of ids.entries()) out.push((await call(id, "POST", "/agent/onboarding/start", { name: `Reserve ${"AB"[i]}`, sports: ["Golf"] })).body.researchQueued);
  expect(out).toEqual([false, true]);
});

test("C11: concurrent admits never overshoot the cap (one advisory transaction lock)", async () => {
  process.env.DAILY_RESEARCH_CAP_USD = "5";                                                     // room for two $2 runs
  const heldRuns = async (names: string[]) => {
    const ids: string[] = [];
    for (const [i, n] of names.entries()) {
      const runId = await seedRun(await signupAthlete(n), "agent_onboarding", "running", [{ step: "research_a", kind: "model", status: "ready" }]);
      await db.update(workflowSteps).set({ ready_at: HELD_READY_AT }).where(eq(workflowSteps.run_id, runId));
      await db.update(workflowRuns).set({ started_at: new Date(Date.now() - 60_000 + i * 1000) }).where(eq(workflowRuns.id, runId));
      ids.push(runId);
    }
    return ids;
  };
  // In arrival order: the first two start, the rest stay queued.
  const seq = await heldRuns(["Seq A", "Seq B", "Seq C", "Seq D"]);
  const outSeq: boolean[] = [];
  for (const id of seq) outSeq.push(await admitHeldRun(id));
  expect(outSeq).toEqual([true, true, false, false]);

  // All at once, in any order: never more than two start, and what was admitted is exactly what started.
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  const par = await heldRuns(["Par A", "Par B", "Par C", "Par D"]);
  const admitted = await Promise.all([...par].reverse().map((id) => admitHeldRun(id)));
  const nAdmitted = admitted.filter(Boolean).length;
  const started = (await Promise.all(par.map(async (id) => !held(await firstSteps(id))))).filter(Boolean).length;
  expect(nAdmitted).toBeGreaterThanOrEqual(1);
  expect(nAdmitted).toBeLessThanOrEqual(2);
  expect(started).toBe(nAdmitted);
  await releaseQueuedOnboardings(new Date());                                                   // the tick fills the rest of the room, no more
  expect((await Promise.all(par.map(async (id) => !held(await firstSteps(id))))).filter(Boolean).length).toBe(2);
});

test("C12: a budget that cannot be read holds the research (fail closed); the tick starts it later", async () => {
  process.env.DAILY_RESEARCH_CAP_USD = "200";
  const id = await signupAthlete("Unreadable Budget");
  const spy = jest.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db down"));
  const r = await call(id, "POST", "/agent/onboarding/start", { name: "Unreadable Budget", sports: ["Golf"] });
  spy.mockRestore();
  expect(r.status).toBe(202);                                                                   // her sign-up still goes through
  expect(r.body.researchQueued).toBe(true);
  expect(held(await firstSteps(r.body.runId))).toBe(true);
  expect(mockKick).not.toHaveBeenCalled();
  expect(await releaseQueuedOnboardings(new Date())).toBe(1);                                   // the budget reads again
  expect(held(await firstSteps(r.body.runId))).toBe(false);
});

test("spend guards: DAILY_RESEARCH_CAP_USD set but unreadable is the fallback, and it is clamped to its maximum", () => {
  process.env.DAILY_RESEARCH_CAP_USD = "abc";
  expect(dailyResearchCapMicroUsd()).toBe(DAILY_RESEARCH_CAP_FALLBACK_USD * 1_000_000);
  process.env.DAILY_RESEARCH_CAP_USD = "1e9";
  expect(dailyResearchCapMicroUsd()).toBe(DAILY_RESEARCH_CAP_MAX_USD * 1_000_000);
  delete process.env.DAILY_RESEARCH_CAP_USD;
  expect(dailyResearchCapMicroUsd()).toBeNull();
});
