/**
 * memoryRerun.test.ts — the re-run rule: re-run only what used a changed fact, after a 30-minute quiet window, within
 * the daily caps.
 *
 *   pure     decideReruns (cited → understand, in the M.I.A.'s input → M.I.A., either → plan) and applyCaps
 *   flow     the memory_changed workflow on PGlite with the runner's clock: edits batch into one run; nothing before
 *            the window; understand + plan recorded as pending; the M.I.A. through requestEvaluation (mocked) at most
 *            once a day, a capped part waiting for the next day; an edit after `decide` starts a follow-up run
 *
 * The M.I.A. preview read and the M.I.A. trigger are mocked; no provider is reachable. Made-up names.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const miaInputs: string[] = [];
jest.mock("../services/miaPreview/preview", () => ({
  readMiaPreview: async () => ({ inputs: { public: miaInputs.map((factId) => ({ factId })), measured: [] } }),
}));
const requestEvaluation = jest.fn(async () => ({ runId: "00000000-0000-4000-8000-0000000000aa", created: true }));
jest.mock("../services/marketabilityBeta1Orchestrator", () => ({ requestEvaluation: (...a: any[]) => (requestEvaluation as any)(...a) }));

import { and, desc, eq } from "drizzle-orm";
import "../workflow/definitions/memoryChanged";
import { configureRunner, resetRunnerConfig, tick } from "../workflow/runner";
import { closeTestDb, db, initTestDb } from "../testUtils/pgliteDb";
import { athletes, memoryBriefs, memoryFacts, workflowRuns, workflowSteps } from "../../shared/schema";
import { applyCaps, decideReruns, MEMORY_CHANGED_PROCESS, nextUtcDay, pendingRerunsFor, QUIET_WINDOW_MS, RERUN_DAILY_CAPS } from "./memoryRerun";
import { correctFact, confirmFact, hideFact } from "../services/meKnows";

jest.setTimeout(180_000);

describe("decideReruns + applyCaps (pure)", () => {
  it("understand only when the Brief cites a changed fact; M.I.A. only when it was in its input; plan if either", () => {
    expect(decideReruns({ changedFactIds: ["x"], briefFactIds: ["x", "y"], miaInputFactIds: ["z"] })).toMatchObject({ understand: true, mia: false, plan: true, cited: ["x"], inMia: [] });
    expect(decideReruns({ changedFactIds: ["z"], briefFactIds: ["x"], miaInputFactIds: ["z"] })).toMatchObject({ understand: false, mia: true, plan: true, inMia: ["z"] });
    expect(decideReruns({ changedFactIds: ["q"], briefFactIds: ["x"], miaInputFactIds: ["z"] })).toMatchObject({ understand: false, mia: false, plan: false });
  });
  it("caps: Brief 2 a day, M.I.A. 1 a day; the plan waits with a capped part", () => {
    expect(RERUN_DAILY_CAPS).toEqual({ understand: 2, mia: 1 });
    const all = { understand: true, mia: true, plan: true };
    expect(applyCaps(all, { understand: 0, mia: 0 })).toEqual({ now: ["understand", "mia", "plan"], deferred: [] });
    expect(applyCaps(all, { understand: 1, mia: 1 })).toEqual({ now: ["understand"], deferred: ["mia", "plan"] });
    expect(applyCaps(all, { understand: 2, mia: 0 })).toEqual({ now: ["mia"], deferred: ["understand", "plan"] });
    expect(applyCaps({ understand: false, mia: false, plan: false }, { understand: 0, mia: 0 })).toEqual({ now: [], deferred: [] });
  });
  it("next UTC day", () => {
    expect(nextUtcDay(new Date("2026-10-10T23:59:00Z")).toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });
});

describe("memory_changed on the runner", () => {
  const NAME = "Quinn Example";
  let A = ""; let cited = ""; let inMia = ""; let other = "";
  // A fixed clock in the morning (UTC) of a day after the real one, so the window and the caps never straddle midnight.
  const real = new Date();
  let now = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate() + 1, 9));
  const advance = (ms: number) => { now = new Date(now.getTime() + ms); };

  const fact = async (claim: string) => (await db.insert(memoryFacts).values({ athlete_id: A, subject_kind: "athlete", subject_name: NAME, claim, type: "found", source_url: "https://example.org/f", confidence: 0.8 } as any).returning({ id: memoryFacts.id }))[0].id;
  const runs = () => db.select().from(workflowRuns).where(and(eq(workflowRuns.athlete_id, A), eq(workflowRuns.process, MEMORY_CHANGED_PROCESS))).orderBy(desc(workflowRuns.started_at));
  const stepOut = async (runId: string, step: string) => (await db.select().from(workflowSteps).where(and(eq(workflowSteps.run_id, runId), eq(workflowSteps.step, step))))[0];
  const drain = async () => { for (let i = 0; i < 6; i++) await tick(); };

  beforeAll(async () => {
    await initTestDb();
    configureRunner({ retry: { randomize: false, minTimeoutMs: 1, maxAttempts: 1 } }, () => now);
    [{ id: A }] = await db.insert(athletes).values({ full_name: NAME } as any).returning({ id: athletes.id });
    await db.insert(memoryFacts).values({ athlete_id: A, subject_kind: "athlete", subject_name: NAME, claim: `The athlete's name is ${NAME}.`, type: "said", source_ref: "onboarding/r#name", confidence: 1 } as any);
    cited = await fact("A fact the Brief cites.");
    inMia = await fact("A fact the M.I.A. read.");
    other = await fact("A fact nothing used.");
    miaInputs.push(inMia);
    await db.insert(memoryBriefs).values({ athlete_id: A, version: 1, status: "current", summary: "s", sections: [], fact_ids: [cited] } as any);
  });
  afterAll(async () => { resetRunnerConfig(); await closeTestDb(); });

  it("a cited fact corrected: nothing before the window; then understand + plan recorded pending, no M.I.A.", async () => {
    const r = await correctFact(A, cited, { claim: "The corrected fact." });
    await confirmFact(A, other);   // a confirm changes nothing
    await drain();
    const [run] = await runs();
    expect(run.id).toBe(r.rerun.runId);
    expect(run.status).toBe("running");
    expect((await stepOut(run.id, "quiet")).status).toBe("ready");

    advance(QUIET_WINDOW_MS + 1000);
    await drain();
    const [done] = await runs();
    expect(done.status).toBe("done");
    const decide = (await stepOut(done.id, "decide")).output as any;
    expect(decide.decision).toMatchObject({ understand: true, mia: false, plan: true, cited: [cited] });
    expect(decide.deferred).toEqual([]);
    const act = (await stepOut(done.id, "act")).output as any;
    expect(Object.keys(act.ran).sort()).toEqual(["plan", "understand"]);
    expect(act.ran.understand.status).toBe("pending");
    expect(requestEvaluation).not.toHaveBeenCalled();
    expect((await pendingRerunsFor(A)).understand).toBeTruthy();
  });

  it("a fact in the M.I.A.'s input hidden: the M.I.A. is asked through its own path; a fact nothing used re-runs nothing", async () => {
    await hideFact(A, inMia);
    await hideFact(A, other);
    advance(QUIET_WINDOW_MS + 1000);
    await drain();
    const [run] = await runs();
    const decide = (await stepOut(run.id, "decide")).output as any;
    expect(decide.decision).toMatchObject({ understand: false, mia: true, plan: true, inMia: [inMia] });
    expect(requestEvaluation).toHaveBeenCalledTimes(1);
    expect((requestEvaluation.mock.calls[0] as any[])[0]).toMatchObject({ athleteId: A, createdBy: MEMORY_CHANGED_PROCESS });
  });

  it("past the M.I.A.'s daily cap it waits for the next day, the plan with it; an edit after the decision starts a follow-up", async () => {
    // Restore the hidden input fact: the M.I.A. would re-run, but it already ran once today.
    const { restoreFact } = await import("../services/meKnows");
    await restoreFact(A, inMia);
    advance(QUIET_WINDOW_MS + 1000);
    await drain();
    const [run] = await runs();
    const decide = (await stepOut(run.id, "decide")).output as any;
    expect(decide.now).toEqual([]);
    expect(decide.deferred).toEqual(["mia", "plan"]);
    expect(run.status).toBe("running");
    expect((await stepOut(run.id, "wait")).ready_at.toISOString()).toBe(nextUtcDay(now).toISOString());
    expect(requestEvaluation).toHaveBeenCalledTimes(1);

    // An edit while this run waits joins it (one active run) but lands after its decision.
    const late = await fact("A new fact the Brief will cite.");
    await db.update(memoryBriefs).set({ fact_ids: [cited, late] }).where(eq(memoryBriefs.athlete_id, A));
    const joined = await hideFact(A, late);
    expect(joined.runId).toBe(run.id);

    now = new Date(nextUtcDay(now).getTime() + 60_000);
    await drain();
    const finished = (await runs()).find((x) => x.id === run.id)!;
    expect(finished.status).toBe("done");
    const deferredAct = (await stepOut(run.id, "act_deferred")).output as any;
    expect(Object.keys(deferredAct.ran).sort()).toEqual(["mia", "plan"]);
    expect(requestEvaluation).toHaveBeenCalledTimes(2);

    // The follow-up run picks up the late edit after its own window.
    const [follow] = await runs();
    expect(follow.id).not.toBe(run.id);
    advance(QUIET_WINDOW_MS + 1000);
    await drain();
    const d2 = (await stepOut(follow.id, "decide")).output as any;
    expect(d2.decision).toMatchObject({ understand: true, cited: [late] });
  });
});
