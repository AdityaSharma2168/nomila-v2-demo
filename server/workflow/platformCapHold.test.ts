/**
 * platformCapHold.test.ts — sign-up research QUEUES when the platform day cap refuses it, never fails (owner, 10 Nov
 * 2026: as many waitlist sign-ups as possible). Real runner + PGlite; the steps are fakes (or a real step with its
 * model path mocked), so no provider is reached.
 *
 *   H1 a research step that throws the platform cap's refusal is HELD: back to `ready` at HELD_READY_AT, the same
 *      attempt, no failed row, the run still running and reported queued; the tick never claims it
 *   H2 headroom, not just "reached": while there is no room on the platform cap for one more run's worst case (even
 *      UNDER the cap) nothing is admitted or released; with room the release + tick finish the run; one run per slot
 *   H3 scope: agent onboarding's athlete-facing steps (opening), other processes and a non-lifecycle research_refresh
 *      still fail as before; so does any other error in a research step
 *   H4 a hold at a LATER step (after a step that finished) and beside a PARALLEL sibling still running: the run is not
 *      queued (and stays reserved) until the sibling ends, then it is; a failed run's leftover held row is not queued
 *   H5 a lost lease: the hold is a compare-and-set, so a row another runner reclaimed is left to that runner
 *   H6 an unreadable platform total starts nothing (fail closed)
 *   H7 runs held longer than HELD_TOO_LONG_DAYS are counted for the alert log
 *   H8 a REAL step path: the mia_preview step (its M.I.A. call mocked to be refused) is held, not swallowed
 *   H9 the refusal is recognised by class, code, message and cause; the sign-up cap's fallback stays under the platform max
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const mockPreview = jest.fn();
jest.mock("../services/miaPreview/preview", () => ({ getMiaPreview: (...a: unknown[]) => mockPreview(...a) }));

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../shared/schema";
import { __resetRegistry, defineWorkflow } from "./registry";
import { configureRunner, HELD_READY_AT, resetRunnerConfig, startRun, tick } from "./runner";
import { isPlatformCapError, PlatformCapError, PLATFORM_CAP_MESSAGE, PLATFORM_DAY_CAP_MAX_USD, setPlatformSpendReaderForTests } from "../lib/platformSpend";
import {
  admitHeldRun, DAILY_RESEARCH_CAP_FALLBACK_USD, holdsOnPlatformCap, logHeldTooLong, perRunReserveMicroUsd, releaseQueuedOnboardings,
  researchQueueState, resetHeldLongLogForTests,
} from "../agent/onboarding/dailyCap";
import { researchStateFrom } from "../agent/onboarding/waitlistProgress";
import { SIGNUP_MIA_STEP } from "../agent/onboarding/signupResearchWorkflow";
import type { StepDef } from "./types";

jest.setTimeout(120_000);

const USD = 1_000_000;
let athleteId: string;
let refuse = true;
let calls = 0;
const env = process.env;

/** The platform's total today, in dollars (the default cap is $25). */
const platformSpent = (usd: number) => setPlatformSpendReaderForTests(async () => Math.round(usd * USD));
const refusal = () => new PlatformCapError(30 * USD, 25 * USD);

const capStep = (name: string, extra: Partial<StepDef> = {}): StepDef => ({
  name, kind: "model", ...extra, run: async () => { calls++; if (refuse) throw refusal(); return { ok: true }; },
});
const stepsOf = (runId: string) => db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId));
const runOf = async (runId: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0];
const isHeldRow = (r: { status: string; ready_at: Date }) => r.status === "ready" && r.ready_at.getTime() >= HELD_READY_AT.getTime();
/** Make every due-later ready row due now (a retry's backoff), so the next tick claims it. */
const dueNow = () => db.update(workflowSteps).set({ ready_at: new Date(0) }).where(eq(workflowSteps.status, "ready"));

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Platform Cap Hold", { status: "waitlisted" } as any);
});
afterAll(async () => { process.env = env; setPlatformSpendReaderForTests(null); await closeTestDb(); });

beforeEach(async () => {
  process.env = { ...env, DAILY_CAP_MIA_RESERVE_USD: "1" };
  delete process.env.DAILY_RESEARCH_CAP_USD;        // the sign-up cap unset: only the platform cap decides here
  delete process.env.PLATFORM_DAY_COST_CAP_USD;     // its $25 default
  delete process.env.AGENT_ONBOARDING_COST_CAP_USD; // $2 per run (+ $1 M.I.A. reserve = $3 a run)
  __resetRegistry();
  resetRunnerConfig();
  resetHeldLongLogForTests();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1000, factor: 5, maxTimeoutMs: 60_000, maxAttempts: 2 } });
  defineWorkflow({ process: "signup_research", version: 1, steps: [capStep("lean_research")] });
  defineWorkflow({ process: "research_refresh", version: 1, steps: [capStep("research")] });
  defineWorkflow({ process: "agent_onboarding", version: 1, steps: [capStep("opening")] });
  defineWorkflow({ process: "p_other", version: 1, steps: [capStep("lean_research")] });
  refuse = true; calls = 0;
  platformSpent(30);                                                        // over the $25 default
  mockPreview.mockReset();
  await db.delete(workflowSteps); await db.delete(workflowRuns);
});

test("H1: a research step refused by the platform cap is held (queued), not failed, and spends no attempt", async () => {
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false });
  await tick();
  expect(calls).toBe(1);
  const rows = await stepsOf(run.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ step: "lean_research", status: "ready", attempt: 1, lease_owner: null, lease_token: null });
  expect(isHeldRow(rows[0])).toBe(true);
  expect(rows[0].error).toMatch(/^held, not an attempt: /);
  expect((await runOf(run.id)).status).toBe("running");
  expect((await researchQueueState(run.id)).queued).toBe(true);
  await tick();                                                             // a held step is never claimed by the tick
  expect(calls).toBe(1);
});

test("H2: nothing starts without headroom for one more run (even UNDER the cap); with room, one run per free slot", async () => {
  const a = (await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false })).run;
  await tick();
  expect(perRunReserveMicroUsd() / USD).toBe(3);                            // $2 per run + $1 M.I.A. reserve

  platformSpent(23);                                                        // under $25, but 23 + 3 > 25: no room
  expect(await releaseQueuedOnboardings()).toBe(0);
  expect(await admitHeldRun(a.id)).toBe(false);
  expect((await researchQueueState(a.id)).queued).toBe(true);

  // 19 + 1 x 3 = 22 and 19 + 2 x 3 = 25 fit under $25; 19 + 3 x 3 = 28 does not: two of the three start.
  const b = (await startRun({ process: "signup_research", athleteId: await seedAthlete("Cap Hold B"), createdBy: "test", kick: false })).run;
  const c = (await startRun({ process: "signup_research", athleteId: await seedAthlete("Cap Hold C"), createdBy: "test", kick: false })).run;
  platformSpent(30);
  await tick();
  expect(await Promise.all([a, b, c].map(async (r) => (await researchQueueState(r.id)).queued))).toEqual([true, true, true]);
  platformSpent(19); refuse = false;
  expect(await releaseQueuedOnboardings()).toBe(2);
  await tick();
  expect((await runOf(a.id)).status).toBe("done");
  expect((await runOf(b.id)).status).toBe("done");
  expect((await researchQueueState(c.id)).queued).toBe(true);
});

test("H2b: a new sign-up run created held is admitted only with headroom on the platform cap", async () => {
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false, holdUntil: HELD_READY_AT });
  platformSpent(23);
  expect(await admitHeldRun(run.id)).toBe(false);
  platformSpent(0);
  expect(await admitHeldRun(run.id)).toBe(true);
});

test("H3: athlete-facing onboarding steps, other processes, a non-lifecycle refresh and other errors still fail", async () => {
  const opening = (await startRun({ process: "agent_onboarding", athleteId, createdBy: "test", kick: false })).run;
  const other = (await startRun({ process: "p_other", athleteId, createdBy: "test", kick: false })).run;
  const refresh = (await startRun({ process: "research_refresh", athleteId, createdBy: "admin", kick: false })).run;
  for (let i = 0; i < 3; i++) { await tick(); await dueNow(); }
  for (const r of [opening, other, refresh]) expect((await runOf(r.id)).status).toBe("failed");

  const err = refusal();
  expect(holdsOnPlatformCap(err, { process: "research_refresh", created_by: "lifecycle_signup" }, "research")).toBe(true);
  for (const p of ["agent_onboarding", "signup_research", "onboarding"]) {
    for (const s of ["research_a", "research_b", "research_merge", "lean_research", "quick_score", "mia_preview"]) expect([p, s, holdsOnPlatformCap(err, { process: p }, s)]).toEqual([p, s, true]);
    for (const s of ["opening", "understand", "insights", "moments", "conversation"]) expect([p, s, holdsOnPlatformCap(err, { process: p }, s)]).toEqual([p, s, false]);
  }
  expect(holdsOnPlatformCap(new Error("provider down"), { process: "signup_research" }, "lean_research")).toBe(false);
});

test("H4: a hold at a later step beside a running parallel sibling: not queued (still reserved) until the sibling ends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  __resetRegistry();
  defineWorkflow({ process: "signup_research", version: 1, steps: [
    { name: "prepare", kind: "code", run: async () => ({ ready: true }) },
    capStep("lean_research"),
    { name: "quick_score", kind: "model", parallel: true, run: async () => { await gate; return { score: 1 }; } },
  ] });
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false });
  // One tick: prepare finishes, its kick opens the next ordinal; lean_research holds, quick_score waits on the gate.
  const ticking = tick();
  for (let i = 0; i < 100 && !(await stepsOf(run.id)).some((r) => r.step === "lean_research" && isHeldRow(r)); i++) await new Promise((r) => setTimeout(r, 20));
  const mid = await stepsOf(run.id);
  expect(isHeldRow(mid.find((r) => r.step === "lean_research")!)).toBe(true);
  expect(mid.find((r) => r.step === "quick_score")?.status).toBe("running");
  expect((await researchQueueState(run.id)).queued).toBe(false);            // a sibling is still running
  expect(researchStateFrom({ status: "running" }, mid as any, new Date()).state).toBe("running");
  platformSpent(0); refuse = false;
  expect(await releaseQueuedOnboardings()).toBe(0);                         // not queued, so not released yet

  release(); await ticking;                                                 // the sibling ends
  expect((await researchQueueState(run.id)).queued).toBe(true);
  expect(researchStateFrom({ status: "running" }, (await stepsOf(run.id)) as any, new Date()).state).toBe("queued");
  expect(await releaseQueuedOnboardings()).toBe(1);
  await tick();
  expect((await runOf(run.id)).status).toBe("done");

  // A failed run's leftover held row is never "queued".
  const f = (await startRun({ process: "signup_research", athleteId: await seedAthlete("Cap Hold F"), createdBy: "test", kick: false, holdUntil: HELD_READY_AT })).run;
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.id));
  expect((await researchQueueState(f.id)).queued).toBe(false);
});

test("H5: a lost lease: the hold is compare-and-set, the reclaiming runner's row is left alone", async () => {
  __resetRegistry();
  defineWorkflow({ process: "signup_research", version: 1, steps: [{ name: "lean_research", kind: "model", run: async (ctx) => {
    // Another runner reclaimed this row while we worked: its lease is no longer ours.
    await db.update(workflowSteps).set({ lease_token: "00000000-0000-0000-0000-000000000001", lease_owner: "other" }).where(eq(workflowSteps.run_id, ctx.runId));
    throw refusal();
  } }] });
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false });
  await tick();
  const [row] = await stepsOf(run.id);
  expect(row).toMatchObject({ status: "running", lease_owner: "other" });
  expect((await runOf(run.id)).status).toBe("running");
});

test("H6: an unreadable platform total starts nothing (fail closed)", async () => {
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false, holdUntil: HELD_READY_AT });
  setPlatformSpendReaderForTests(async () => { throw new Error("db down"); });
  expect(await admitHeldRun(run.id)).toBe(false);
  expect(await releaseQueuedOnboardings()).toBe(0);
  expect((await researchQueueState(run.id)).queued).toBe(true);
});

test("H7: runs held longer than the alert window are counted (once an hour per process)", async () => {
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false, holdUntil: HELD_READY_AT });
  const now = new Date();
  expect(await logHeldTooLong(now)).toBe(0);
  resetHeldLongLogForTests();
  await db.update(workflowRuns).set({ started_at: new Date(now.getTime() - 3 * 86_400_000) }).where(eq(workflowRuns.id, run.id));
  expect(await logHeldTooLong(now)).toBe(1);
  expect(await logHeldTooLong(new Date(now.getTime() + 60_000))).toBe(-1);  // throttled
});

test("H8: a real step (mia_preview) refused by the platform cap is held, not swallowed as \"failed\"", async () => {
  __resetRegistry();
  defineWorkflow({ process: "signup_research", version: 1, steps: [SIGNUP_MIA_STEP] });
  mockPreview.mockRejectedValueOnce(refusal());
  const { run } = await startRun({ process: "signup_research", athleteId, createdBy: "test", kick: false });
  await tick();
  const [row] = await stepsOf(run.id);
  expect(row.step).toBe("mia_preview");
  expect(isHeldRow(row)).toBe(true);
  // Any other error is still swallowed as before (the step returns "failed" and the run goes on).
  mockPreview.mockRejectedValueOnce(new Error("evaluator down"));
  platformSpent(0);
  expect(await releaseQueuedOnboardings()).toBe(1);
  await tick();
  const done = (await stepsOf(run.id)).find((r) => r.status === "done");
  expect(done?.output).toMatchObject({ status: "failed" });
});

test("H9: the refusal is recognised by class, code, message and cause; the fallback cap stays under the platform maximum", () => {
  expect(isPlatformCapError(refusal())).toBe(true);
  expect(isPlatformCapError(Object.assign(new Error("x"), { code: "platform_spend_cap" }))).toBe(true);
  expect(isPlatformCapError(new Error(`lean research: ${PLATFORM_CAP_MESSAGE}`))).toBe(true);
  expect(isPlatformCapError(new Error("wrapped", { cause: refusal() }))).toBe(true);
  expect(isPlatformCapError(new Error("cost cap reached: spent 2 of 2 USD"))).toBe(false);
  expect(isPlatformCapError(null)).toBe(false);
  expect(DAILY_RESEARCH_CAP_FALLBACK_USD).toBeLessThan(PLATFORM_DAY_CAP_MAX_USD);
});
