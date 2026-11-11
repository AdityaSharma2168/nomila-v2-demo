/**
 * runner.test.ts — pins the guarantees the runner promises (see runner.ts header).
 *
 * Runs on PGlite (real Postgres in the worker). No network, no tracing (LANGFUSE_TRACING is
 * unset → traceUnit is a passthrough). The clock is injected so leases and backoff are tested
 * without sleeping.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { and, eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../shared/schema";
import { __resetRegistry, defineWorkflow, getDefinition } from "./registry";
import {
  backoffMs, cancelRun, completeStep, configureRunner, expireLeases, getRun, HELD_READY_AT, kick,
  resetRunnerConfig, retryRun, startRun, tick, WorkflowError,
} from "./runner";

// A movable clock: every runner timestamp comes from here.
let nowMs = Date.parse("2026-09-03T12:00:00Z");
const now = () => new Date(nowMs);
const advanceClock = (ms: number) => { nowMs += ms; };

let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Runner Test");
});
afterAll(closeTestDb);

beforeEach(async () => {
  __resetRegistry();
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1000, factor: 5, maxTimeoutMs: 60_000, maxAttempts: 3 } }, now);
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
});

const stepsOf = (runId: string) => db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId));

// ─── Happy path ───────────────────────────────────────────────────────────────

test("a two-step code workflow runs to done on start (kick), outputs are references and ordered", async () => {
  const seen: string[] = [];
  defineWorkflow({ process: "p_basic", version: 1, steps: [
    { name: "one", kind: "code", run: async (ctx) => { seen.push(`one:${ctx.attempt}`); return { snapshot_id: "s1" }; } },
    { name: "two", kind: "code", run: async (ctx) => { seen.push(`two`); return { got: ctx.outputs.one }; } },
  ]});
  const { run, created } = await startRun({ process: "p_basic", athleteId, createdBy: "test" });
  expect(created).toBe(true);
  expect(run.status).toBe("done");
  expect(seen).toEqual(["one:1", "two"]);
  const steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.step, s.status])).toEqual([["one", "done"], ["two", "done"]]);
  expect(steps[1].output).toEqual({ got: { snapshot_id: "s1" } });
});

// ─── Claim exclusivity ────────────────────────────────────────────────────────

test("two consumers ticking over the same ready rows never run a step twice", async () => {
  let runs = 0;
  defineWorkflow({ process: "p_once", version: 1, steps: [
    { name: "only", kind: "code", run: async () => { runs++; return {}; } },
  ]});
  await startRun({ process: "p_once", athleteId, kick: false });
  // Two ticks racing: the second must find nothing to claim.
  const [a, b] = await Promise.all([tick(20), tick(20)]);
  expect(a.claimed + b.claimed).toBe(1);
  expect(runs).toBe(1);
});

// ─── Resume after a dead process ──────────────────────────────────────────────

test("a running step whose lease expired goes back to ready as the SAME attempt (a lapse is not an attempt); output recorded once", async () => {
  let calls = 0;
  defineWorkflow({ process: "p_lease", version: 1, steps: [
    { name: "slow", kind: "code", leaseMs: 60_000, run: async () => { calls++; return { ok: calls }; } },
  ]});
  const { run } = await startRun({ process: "p_lease", athleteId, kick: false });
  // Simulate a process that claimed the step and died: mark it running with a lease in the past.
  await db.update(workflowSteps).set({ status: "running", started_at: now(), lease_until: new Date(nowMs - 1), lease_owner: "dead", lease_token: "11111111-1111-1111-1111-111111111111" })
    .where(eq(workflowSteps.run_id, run.id));

  const expired = await expireLeases();
  expect(expired).toBe(1);
  let steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.attempt, s.status, s.lease_reclaims, s.lease_owner])).toEqual([[1, "ready", 1, null]]);
  expect(steps[0].error).toMatch(/lease expired \(reclaim 1 of 3\); not an attempt/);

  // Ready again at once (no backoff: the lapse was not the step's error).
  const t = await tick();
  expect(t.done).toBe(1);
  steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.attempt, s.status, s.error])).toEqual([[1, "done", null]]);
  expect(calls).toBe(1);
  expect((await getRun(run.id))!.run.status).toBe("done");
});

// ─── await_human ──────────────────────────────────────────────────────────────

test("await_human parks the run with a payload; complete advances it; a repeat complete is a no-op", async () => {
  const writes: unknown[] = [];
  defineWorkflow({ process: "p_human", version: 1, steps: [
    { name: "research", kind: "code", run: async () => ({ snapshot_id: "snap-1" }) },
    { name: "review", kind: "await_human",
      payload:  async (ctx) => ({ show: ctx.outputs.research }),
      complete: async (_ctx, fields) => { writes.push(fields); return { accepted: true }; } },
    { name: "score", kind: "code", run: async () => ({ score: 653 }) },
  ]});
  const { run } = await startRun({ process: "p_human", athleteId });
  expect(run.status).toBe("waiting");
  expect(run.current_step).toBe("review");
  const waiting = (await stepsOf(run.id)).find((s) => s.step === "review")!;
  expect(waiting.status).toBe("waiting");
  expect(waiting.input).toEqual({ show: { snapshot_id: "snap-1" } });

  // Tenancy: another athlete cannot complete it.
  const other = await seedAthlete("Someone Else");
  await expect(completeStep({ runId: run.id, step: "review", fields: { x: 1 }, mode: "chat", athleteId: other }))
    .rejects.toMatchObject({ code: "not_found" });

  const done = await completeStep({ runId: run.id, step: "review", fields: { position: "midfielder" }, mode: "voice", athleteId });
  expect(done.alreadyDone).toBe(false);
  expect(done.run.status).toBe("done");                 // score ran via kick
  expect(writes).toEqual([{ position: "midfielder" }]);
  const review = (await stepsOf(run.id)).find((s) => s.step === "review")!;
  expect(review.mode).toBe("voice");
  expect(review.output).toEqual({ accepted: true });

  const again = await completeStep({ runId: run.id, step: "review", fields: { position: "forward" }, mode: "chat", athleteId });
  expect(again.alreadyDone).toBe(true);
  expect(writes).toHaveLength(1);                       // the write did not repeat
});

// ─── schedule ─────────────────────────────────────────────────────────────────

test("a schedule step is not claimed until its ready time", async () => {
  let ran = false;
  defineWorkflow({ process: "p_sched", version: 1, steps: [
    { name: "wait_a_day", kind: "schedule", readyAt: () => new Date(nowMs + 24 * 3600_000) },
    { name: "then", kind: "code", run: async () => { ran = true; return {}; } },
  ]});
  const { run } = await startRun({ process: "p_sched", athleteId });
  expect(run.status).toBe("running");
  expect((await tick()).claimed).toBe(0);
  expect(ran).toBe(false);
  advanceClock(24 * 3600_000 + 1);
  const t = await tick();
  expect(t.claimed).toBe(1);                            // the schedule step itself
  expect(t.kicked).toBe(1);                             // 'then' ran inline, not next minute
  expect(ran).toBe(true);
  expect((await getRun(run.id))!.run.status).toBe("done");
});

// ─── Failure and retry policy ─────────────────────────────────────────────────

test("a step that keeps failing retries with backoff, then fails the run with the step name and error", async () => {
  let attempts = 0;
  defineWorkflow({ process: "p_fail", version: 1, steps: [
    { name: "flaky", kind: "model", run: async () => { attempts++; throw new Error(`boom ${attempts}`); } },
  ]});
  const { run } = await startRun({ process: "p_fail", athleteId });     // attempt 1 fails in the kick
  expect((await getRun(run.id))!.run.status).toBe("running");
  expect((await tick()).claimed).toBe(0);                               // attempt 2 not due yet
  advanceClock(1000);  await tick();                                    // attempt 2 fails
  expect((await getRun(run.id))!.run.status).toBe("running");
  advanceClock(5000);  await tick();                                    // attempt 3 fails → run failed
  const after = (await getRun(run.id))!;
  expect(attempts).toBe(3);
  expect(after.run.status).toBe("failed");
  expect(after.run.current_step).toBe("flaky");
  expect(after.run.last_error).toBe("flaky: boom 3");
  expect(after.steps.map((s) => s.status)).toEqual(["failed", "failed", "failed"]);

  // Operator retry: a fresh attempt, and this time it succeeds.
  attempts = 100;
  getDefinition("p_fail").steps[0].run = async () => ({ fixed: true });
  const retried = await retryRun(run.id);
  expect(retried.status).toBe("done");
});

test("backoff follows the policy: min × factor^(n-1), capped, with optional jitter", () => {
  const p = { maxAttempts: 4, factor: 5, minTimeoutMs: 60_000, maxTimeoutMs: 30 * 60_000, randomize: false };
  expect(backoffMs(p, 1)).toBe(60_000);
  expect(backoffMs(p, 2)).toBe(300_000);
  expect(backoffMs(p, 3)).toBe(1_500_000);
  expect(backoffMs(p, 4)).toBe(1_800_000);              // capped
  expect(backoffMs({ ...p, randomize: true }, 1, () => 0)).toBe(30_000);    // × 0.5
  expect(backoffMs({ ...p, randomize: true }, 1, () => 0.999)).toBe(89_940); // × ~1.5
});

// ─── One active run per athlete and process ───────────────────────────────────

test("a second start for the same athlete and process returns the first run; idempotency keys do the same", async () => {
  defineWorkflow({ process: "p_one", version: 1, steps: [
    { name: "hold", kind: "await_human", payload: async () => ({}), complete: async () => ({}) },
  ]});
  const first  = await startRun({ process: "p_one", athleteId, idempotencyKey: "connect:abc" });
  const second = await startRun({ process: "p_one", athleteId });
  expect(second.created).toBe(false);
  expect(second.run.id).toBe(first.run.id);

  // A different athlete, same idempotency key → the key wins and returns the first run too.
  const other = await seedAthlete("Other");
  const third = await startRun({ process: "p_one", athleteId: other, idempotencyKey: "connect:abc" });
  expect(third.created).toBe(false);
  expect(third.run.id).toBe(first.run.id);

  // After the first run finishes, a new one may start.
  await cancelRun(first.run.id);
  const fourth = await startRun({ process: "p_one", athleteId });
  expect(fourth.created).toBe(true);
  expect(fourth.run.id).not.toBe(first.run.id);
});

test("a definition may scope the active-run rule by input: two platforms run at once, the same platform collapses", async () => {
  defineWorkflow({ process: "p_scope", version: 1, activeScope: (i: any) => `p_scope:${i.platform}`, steps: [
    { name: "hold", kind: "await_human", payload: async () => ({}), complete: async () => ({}) },
  ]});
  const ig = await startRun({ process: "p_scope", athleteId, input: { platform: "instagram" } });
  const tk = await startRun({ process: "p_scope", athleteId, input: { platform: "tiktok" } });
  expect(ig.created && tk.created).toBe(true);
  expect(ig.run.id).not.toBe(tk.run.id);
  expect(ig.run.active_scope).toBe("p_scope:instagram");
  const ig2 = await startRun({ process: "p_scope", athleteId, input: { platform: "instagram" } });
  expect(ig2.created).toBe(false);
  expect(ig2.run.id).toBe(ig.run.id);                   // the same platform's run, not TikTok's
});

// ─── Parallel siblings ────────────────────────────────────────────────────────

test("parallel siblings share an ordinal; the run advances only when all are done, and one failure fails the run", async () => {
  const order: string[] = [];
  defineWorkflow({ process: "p_par", version: 1, steps: [
    { name: "first_look", kind: "code", run: async () => { order.push("first_look"); return { fl: 1 }; } },
    { name: "research",   kind: "model", parallel: true, run: async () => { order.push("research"); return { r: 1 }; } },
    { name: "summary",    kind: "code", run: async (ctx) => { order.push("summary"); return { has: Object.keys(ctx.outputs).sort() }; } },
  ]});
  const def = getDefinition("p_par");
  expect(def.steps.map((s) => s.ordinal)).toEqual([0, 0, 1]);

  const { run } = await startRun({ process: "p_par", athleteId });
  expect(run.status).toBe("done");
  expect(order.slice(0, 2).sort()).toEqual(["first_look", "research"]);
  expect(order[2]).toBe("summary");
  const summary = (await stepsOf(run.id)).find((s) => s.step === "summary")!;
  expect(summary.output).toEqual({ has: ["first_look", "research"] });

  // One sibling failing (past its attempts) fails the run.
  __resetRegistry();
  configureRunner({ retry: { maxAttempts: 1 } }, now);
  defineWorkflow({ process: "p_par2", version: 1, steps: [
    { name: "ok",  kind: "code", run: async () => ({}) },
    { name: "bad", kind: "code", parallel: true, run: async () => { throw new Error("nope"); } },
    { name: "never", kind: "code", run: async () => ({}) },
  ]});
  const r2 = await startRun({ process: "p_par2", athleteId: await seedAthlete("Par2") });
  expect(r2.run.status).toBe("failed");
  expect((await stepsOf(r2.run.id)).some((s) => s.step === "never")).toBe(false);
});

test("parallel siblings run at the same time (they overlap), and the next ordinal opens exactly once", async () => {
  const events: string[] = [];
  let started = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((r) => { release = r; });
  // Each sibling waits until the other has started (or 2 s, so a sequential runner fails the test instead of hanging).
  const sibling = (name: string) => async () => {
    events.push(`start:${name}`);
    if (++started === 2) release();
    await Promise.race([bothStarted, new Promise((r) => setTimeout(r, 2000))]);
    events.push(`end:${name}`);
    return { n: name };
  };
  let nextRuns = 0;
  defineWorkflow({ process: "p_overlap", version: 1, steps: [
    { name: "a", kind: "code", run: sibling("a") },
    { name: "b", kind: "code", parallel: true, run: sibling("b") },
    { name: "next", kind: "code", run: async () => { nextRuns++; return {}; } },
  ]});
  const { run } = await startRun({ process: "p_overlap", athleteId });
  expect(run.status).toBe("done");
  // Both started before either ended: they overlapped.
  expect(events.slice(0, 2).sort()).toEqual(["start:a", "start:b"]);
  expect(nextRuns).toBe(1);
  const rows = await stepsOf(run.id);
  expect(rows.filter((s) => s.step === "next")).toHaveLength(1);
});

test("a failing parallel sibling retries on its own; the other sibling's result stands and the run advances once", async () => {
  let badCalls = 0;
  defineWorkflow({ process: "p_iso", version: 1, steps: [
    { name: "good", kind: "code", run: async () => ({ ok: true }) },
    { name: "flaky", kind: "code", parallel: true, run: async () => { badCalls++; if (badCalls === 1) throw new Error("first try fails"); return { ok: true }; } },
    { name: "after", kind: "code", run: async () => ({}) },
  ]});
  const { run } = await startRun({ process: "p_iso", athleteId });
  let rows = await stepsOf(run.id);
  expect(rows.find((s) => s.step === "good")!.status).toBe("done");
  expect(rows.filter((s) => s.step === "flaky").map((s) => s.status).sort()).toEqual(["failed", "ready"]);
  expect(rows.some((s) => s.step === "after")).toBe(false);
  advanceClock(1_000);                       // past the 1 s backoff
  await tick(20);
  rows = await stepsOf(run.id);
  expect(rows.filter((s) => s.step === "after")).toHaveLength(1);
  expect((await getRun(run.id))!.run.status).toBe("done");
  expect(rows.filter((s) => s.step === "good")).toHaveLength(1);   // never re-run
});

// ─── Size guard ───────────────────────────────────────────────────────────────

test("an output over the payload cap is rejected with a clear error and the step fails", async () => {
  configureRunner({ payloadCapBytes: 200, retry: { maxAttempts: 1 } }, now);
  defineWorkflow({ process: "p_big", version: 1, steps: [
    { name: "blob", kind: "code", run: async () => ({ doc: "x".repeat(500) }) },
  ]});
  const { run } = await startRun({ process: "p_big", athleteId });
  expect(run.status).toBe("failed");
  expect(run.last_error).toMatch(/blob: Output of step "blob" is \d+ bytes; the cap is 200/);
  await expect(startRun({ process: "p_big", athleteId: await seedAthlete("Big"), input: { doc: "y".repeat(500) } }))
    .rejects.toBeInstanceOf(WorkflowError);
});

// ─── Versioning ───────────────────────────────────────────────────────────────

test("a run started on v1 keeps running v1 after v2 is registered", async () => {
  const ran: string[] = [];
  defineWorkflow({ process: "p_ver", version: 1, steps: [
    { name: "gate", kind: "await_human", payload: async () => ({}), complete: async () => ({}) },
    { name: "tail", kind: "code", run: async () => { ran.push("v1-tail"); return {}; } },
  ]});
  const { run } = await startRun({ process: "p_ver", athleteId });
  expect(run.definition_version).toBe(1);

  defineWorkflow({ process: "p_ver", version: 2, steps: [
    { name: "gate", kind: "await_human", payload: async () => ({}), complete: async () => ({}) },
    { name: "tail", kind: "code", run: async () => { ran.push("v2-tail"); return {}; } },
    { name: "extra", kind: "code", run: async () => { ran.push("v2-extra"); return {}; } },
  ]});
  expect(getDefinition("p_ver").version).toBe(2);        // latest for NEW runs

  const done = await completeStep({ runId: run.id, step: "gate", fields: {}, mode: "form", athleteId });
  expect(done.run.status).toBe("done");
  expect(ran).toEqual(["v1-tail"]);                      // not v2's steps
  expect((await stepsOf(run.id)).some((s) => s.step === "extra")).toBe(false);
});

// ─── Cancel ───────────────────────────────────────────────────────────────────

test("cancel skips ready and waiting steps and nothing runs afterwards", async () => {
  let ran = false;
  defineWorkflow({ process: "p_cancel", version: 1, steps: [
    { name: "gate", kind: "await_human", payload: async () => ({}), complete: async () => ({}) },
    { name: "after", kind: "code", run: async () => { ran = true; return {}; } },
  ]});
  const { run } = await startRun({ process: "p_cancel", athleteId });
  const canceled = await cancelRun(run.id);
  expect(canceled.status).toBe("canceled");
  expect((await stepsOf(run.id)).map((s) => s.status)).toEqual(["skipped"]);
  await expect(completeStep({ runId: run.id, step: "gate", fields: {}, mode: "chat", athleteId })).rejects.toMatchObject({ code: "not_waiting" });
  await tick();
  expect(ran).toBe(false);
  // kick on a canceled run is a no-op
  expect(await kick(run.id)).toBe(0);
});

// ─── Registry validation ──────────────────────────────────────────────────────

test("the registry rejects malformed definitions and duplicate versions", () => {
  expect(() => defineWorkflow({ process: "Bad Name", version: 1, steps: [{ name: "a", kind: "code", run: async () => ({}) }] })).toThrow(/snake_case/);
  expect(() => defineWorkflow({ process: "p_dup", version: 1, steps: [{ name: "a", kind: "code" }] })).toThrow(/needs run/);
  defineWorkflow({ process: "p_dup", version: 1, steps: [{ name: "a", kind: "code", run: async () => ({}) }] });
  expect(() => defineWorkflow({ process: "p_dup", version: 1, steps: [{ name: "a", kind: "code", run: async () => ({}) }] })).toThrow(/bump the version/);
  expect(() => defineWorkflow({ process: "p_par_h", version: 1, steps: [
    { name: "a", kind: "code", run: async () => ({}) },
    { name: "h", kind: "await_human", parallel: true, payload: async () => ({}), complete: async () => ({}) },
  ]})).toThrow(/await_human cannot be parallel/);
});

// ─── Held start (the daily research cap's queue) ──────────────────────────────

test("holdUntil: a held run exists (one active run per athlete holds) but no kick or tick runs it until its ready_at is moved to now", async () => {
  const seen: string[] = [];
  defineWorkflow({ process: "p_held", version: 1, steps: [
    { name: "one", kind: "code", run: async () => { seen.push("one"); return {}; } },
  ]});
  const { run, created } = await startRun({ process: "p_held", athleteId, createdBy: "test", holdUntil: HELD_READY_AT });
  expect(created).toBe(true);
  expect(run.status).toBe("running");
  expect((await startRun({ process: "p_held", athleteId, createdBy: "test" })).created).toBe(false);   // still the active run
  expect(await kick(run.id)).toBe(0);
  advanceClock(400 * 86_400_000);
  expect((await tick()).claimed).toBe(0);
  expect(seen).toEqual([]);
  await db.update(workflowSteps).set({ ready_at: now() }).where(eq(workflowSteps.run_id, run.id));   // released
  expect((await tick()).done).toBe(1);
  expect(seen).toEqual(["one"]);
  expect((await getRun(run.id))!.run.status).toBe("done");
});
