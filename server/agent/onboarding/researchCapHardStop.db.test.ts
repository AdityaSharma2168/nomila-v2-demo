/**
 * researchCapHardStop.db.test.ts — DAILY_RESEARCH_CAP_USD as a HARD STOP for every research start, on PGlite through
 * the real runner. No provider is reached: runs are created and never executed (background work off, kicks are spies).
 * Made-up athletes only.
 *
 *   H1 the one check (dailyCap.ts researchCapRefusal): no cap ⇒ no refusal; under ⇒ none; at or above ⇒ daily_cap (next
 *      UTC midnight); a sign-up held by the cap ⇒ daily_cap (nobody jumps its queue); an unreadable budget ⇒ refused
 *   H2 the runner refuses a new UNHELD run of every research process past the cap (nothing inserted); a held start, a
 *      non-research process and an existing run with the same key are untouched; under the cap it starts
 *   H3 every entry point: the lean refresh, Mila's refresh_research, the identity re-check (identityRecheck.db.test.ts
 *      I7), the agent research refresh — refused, nothing started; under the cap they start
 *   H4 sign-up research keeps "held, then released": an uncapped start (the Meet Mila opt-in, an operator's promotion)
 *      past the cap is created HELD instead of started, and the minute tick's release starts it once there is room
 *   H5 the cap unreadable ⇒ the entry points refuse (fail closed)
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../../lib/backgroundHost", () => ({ runsBackgroundWork: () => false }));   // kick is a no-op
jest.setTimeout(180_000);

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { agentRuns } from "../../../shared/schema";
import { workflowRuns, workflowSteps } from "../../../shared/schemaWorkflow";
import "../../workflow/definitions/index";
import { HELD_READY_AT, ResearchCapError, startRun } from "../../workflow/runner";
import * as dailyCap from "./dailyCap";
import { CAPPED_RESEARCH_PROCESSES, FOOTPRINT_SKILL_ID, nextUtcMidnight, releaseQueuedOnboardings, researchCapRefusal } from "./dailyCap";
import { startSignupResearchRun } from "./signupResearch";
import { requestLeanRefresh } from "../researchRefresh/leanRefresh";
import { requestResearchRefresh } from "../researchRefresh/sweep";
import { researchTools } from "../researchRefresh/tools";

const env = process.env;
const USD = 1_000_000;
const kick = jest.fn();
let seq = 0;
const athlete = () => { seq++; return seedAthlete(`Casey Sample ${seq}`, { sport: "Rowing", status: "active", auth_id: `uid-cap-${seq}`, email: `casey${seq}@example.com` } as any); };
/** Spend that counts for any athlete (a footprint check, dailyCap.ts). */
const spend = (athleteId: string, usd: number) => db.insert(agentRuns).values({ athlete_id: athleteId, skill_id: FOOTPRINT_SKILL_ID, skill_version: "1", trigger: "event", provider: "openai", model: "m", effort: "low", status: "completed", cost_micro_usd: Math.round(usd * USD), started_at: new Date(), ended_at: new Date() } as any);
const runsOf = (athleteId: string) => db.select().from(workflowRuns).where(eq(workflowRuns.athlete_id, athleteId));
const isHeld = async (runId: string) => (await db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId))).every((s) => s.ready_at.getTime() >= HELD_READY_AT.getTime());

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(async () => {
  process.env = { ...env, LEAN_SIGNUP_RESEARCH: "true", AGENT_RESEARCH_REFRESH: "true", DAILY_RESEARCH_CAP_USD: "10", DAILY_CAP_MIA_RESERVE_USD: "0" };
  for (const k of ["AGENT_RESEARCH_REFRESH_DAY_CAP_USD", "AGENT_RESEARCH_REFRESH_RUN_CAP_USD", "AGENT_ONBOARDING_COST_CAP_USD"]) delete process.env[k];
  kick.mockClear();
  await db.delete(workflowSteps); await db.delete(workflowRuns); await db.delete(agentRuns);
});

test("H1: the one check — none without a cap or under it; refused at or above it, while a sign-up is held, or unreadable", async () => {
  const now = new Date();
  delete process.env.DAILY_RESEARCH_CAP_USD;
  expect(await researchCapRefusal(now, async () => { throw new Error("never read without a cap"); })).toBeNull();
  process.env.DAILY_RESEARCH_CAP_USD = "10";
  const id = await athlete();
  await spend(id, 9.99);
  expect(await researchCapRefusal(now)).toBeNull();
  await spend(id, 0.01);                                                                  // exactly at the cap
  expect(await researchCapRefusal(now)).toEqual({ reason: "daily_cap", nextAllowedAt: nextUtcMidnight(now).toISOString() });
  await db.delete(agentRuns);
  // A sign-up held by the cap (its first step waits on HELD_READY_AT): nobody jumps that queue.
  const queued = await athlete();
  const [run] = await db.insert(workflowRuns).values({ athlete_id: queued, process: "signup_research", definition_version: 1, active_scope: "signup_research", status: "running", input: {}, created_by: "athlete", started_at: new Date() } as any).returning();
  await db.insert(workflowSteps).values({ run_id: run.id, step: "lean_research", ordinal: 0, kind: "model", status: "ready", ready_at: HELD_READY_AT, input: {} } as any);
  expect(await researchCapRefusal(now)).toMatchObject({ reason: "daily_cap" });
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  // Unreadable ⇒ refused (fail closed).
  expect(await researchCapRefusal(now, async () => { throw new Error("db down"); })).toMatchObject({ reason: "cap_unreadable" });
});

test("H2: the runner refuses a new unheld research run past the cap; held, non-research and existing runs are untouched", async () => {
  const id = await athlete();
  await spend(id, 10);
  expect([...CAPPED_RESEARCH_PROCESSES].sort()).toEqual(["agent_onboarding", "agent_research_refresh", "lean_research_refresh", "onboarding", "research_refresh", "research_v2_shadow", "signup_research"]);
  for (const process of ["lean_research_refresh", "agent_research_refresh", "research_refresh"]) {
    await expect(startRun({ process, athleteId: id, input: { name: "Casey", sport: "Rowing", topics: ["all"], aims: null, trigger: "manual", reason: "t" }, kick: false })).rejects.toBeInstanceOf(ResearchCapError);
  }
  expect(await runsOf(id)).toEqual([]);
  // Held (sign-up research is admitted under the cap's lock instead): created.
  const held = await startRun({ process: "signup_research", athleteId: id, input: { name: "Casey", sport: "Rowing" }, holdUntil: HELD_READY_AT, kick: false });
  expect(held.created).toBe(true);
  // Not research: untouched.
  expect((await startRun({ process: "identity_refresh", athleteId: id, input: { reason: "t" }, kick: false })).created).toBe(true);
  // An existing run with the same key is returned (nothing new starts). (The held sign-up above would refuse it: gone.)
  await db.delete(workflowSteps); await db.delete(workflowRuns);
  const other = await athlete();
  process.env.DAILY_RESEARCH_CAP_USD = "1000";
  const first = await startRun({ process: "lean_research_refresh", athleteId: other, idempotencyKey: `k-${other}`, input: { name: "Casey", sport: "Rowing", topics: ["all"], aims: null }, kick: false });
  process.env.DAILY_RESEARCH_CAP_USD = "10";
  expect(await startRun({ process: "lean_research_refresh", athleteId: other, idempotencyKey: `k-${other}`, input: {}, kick: false })).toMatchObject({ created: false, run: { id: first.run.id } });
});

test("H3: every entry point past the cap starts nothing; under it, they start", async () => {
  const id = await athlete();
  await spend(id, 10);
  expect(await requestLeanRefresh(id, ["all"], { kick })).toMatchObject({ started: false, reason: "daily_budget", nextAllowedAt: nextUtcMidnight(new Date()).toISOString() });
  const [tool] = researchTools({ kick });
  const r: any = await tool.execute!({ athleteId: id, runId: "chat-run", skillId: "chat" } as any, { topics: ["partners"] });
  expect(r.status).toBe("error");
  expect(r.reason).toMatch(/"refused":"daily_budget"/);
  expect(await requestResearchRefresh(id, { trigger: "manual", reason: "operator", kick: false })).toEqual({ started: false, reason: "research_cap" });
  expect(await runsOf(id)).toEqual([]);
  expect(kick).not.toHaveBeenCalled();

  process.env.DAILY_RESEARCH_CAP_USD = "1000";
  expect(await requestLeanRefresh(id, ["all"], { kick })).toMatchObject({ started: true });
  expect(await requestResearchRefresh(id, { trigger: "manual", reason: "operator", kick: false })).toMatchObject({ started: true });
  expect((await runsOf(id)).map((x) => x.process).sort()).toEqual(["agent_research_refresh", "lean_research_refresh"]);
});

test("H4: sign-up research keeps held-then-released — an uncapped start past the cap is created held, the tick releases it", async () => {
  const id = await athlete();
  await spend(id, 10);
  const o = await startSignupResearchRun({ process: "agent_onboarding", athleteId: id, input: { name: "Casey", sport: "Rowing", optIn: true }, createdBy: "athlete", kick: false }, { capped: false });
  expect(o).toMatchObject({ created: true, queued: true });
  expect(await isHeld(o.run.id)).toBe(true);
  expect(await releaseQueuedOnboardings(new Date())).toBe(0);                             // still no room today
  await db.delete(agentRuns);                                                             // there is room again
  expect(await releaseQueuedOnboardings(new Date())).toBe(1);
  expect(await isHeld(o.run.id)).toBe(false);
  // Under the cap an uncapped start runs at once, as before.
  const other = await athlete();
  const p = await startSignupResearchRun({ process: "agent_onboarding", athleteId: other, input: { name: "Casey", sport: "Rowing", optIn: true }, createdBy: "athlete", kick: false }, { capped: false });
  expect(p).toMatchObject({ created: true, queued: false });
  expect(await isHeld(p.run.id)).toBe(false);
});

test("H5: the cap unreadable ⇒ the entry points refuse (fail closed)", async () => {
  const id = await athlete();
  const spy = jest.spyOn(dailyCap, "researchCapRefusal").mockResolvedValue({ reason: "cap_unreadable", nextAllowedAt: new Date(Date.now() + 300_000).toISOString() });
  try {
    expect(await requestLeanRefresh(id, ["all"], { kick })).toMatchObject({ started: false, reason: "daily_budget" });
    expect(await requestResearchRefresh(id, { trigger: "manual", reason: "operator", kick: false })).toEqual({ started: false, reason: "research_cap" });
    expect(await runsOf(id)).toEqual([]);
  } finally { spy.mockRestore(); }
});
