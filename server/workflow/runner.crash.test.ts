/**
 * runner.crash.test.ts — crash-mid-step recovery for the Postgres runner (runner.ts).
 *
 * A "process" here is one tick() call. A crash is a step whose run() never returns: its row stays `running` with a
 * lease, nothing completes it, and the instance that claimed it is gone. A second "instance" (another tick() on the
 * same database, after the lease lapses) must reclaim and finish it. PGlite, injected clock, no providers.
 *
 * The contract pinned here (runner.ts header):
 *   • a lapsed lease (a crash, a replaced revision) is NOT an attempt: the row goes back to ready as the same attempt,
 *     at most MAX_LEASE_RECLAIMS times, then the run fails saying so; only an error the step throws spends an attempt
 *   • a heartbeat keeps a healthy long step's lease
 *   • only the lease holder can finish a row: a runner whose lease was reclaimed has its result discarded
 *   • SIGTERM (drainRunner) stops claiming and hands in-flight steps back as ready at once
 *
 * The injected clock moves lease times; heartbeats and the step deadline are real timers (shortened via config).
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { eq, sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { workflowRuns, workflowSteps } from "../../shared/schema";
import { __resetRegistry, defineWorkflow } from "./registry";
import { configureRunner, drainRunner, expireLeases, getRun, installRunnerShutdown, MAX_LEASE_RECLAIMS, resetRunnerConfig, shutdownSequence, startRun, stepDeadlineMs, tick } from "./runner";

let nowMs = Date.parse("2026-11-03T12:00:00Z");
const now = () => new Date(nowMs);
const advanceClock = (ms: number) => { nowMs += ms; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LEASE = 60_000;
let athleteId: string;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Crash Test");
  // The side effect the step performs: one row per idempotency key (the pattern a step uses to be safe to re-run).
  await db.execute(sql`CREATE TABLE IF NOT EXISTS crash_side_effects (key text PRIMARY KEY, attempt int NOT NULL)`);
});
afterAll(closeTestDb);

beforeEach(async () => {
  __resetRegistry();
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1000, factor: 5, maxTimeoutMs: 60_000, maxAttempts: 3 } }, now);
  await db.delete(workflowSteps);
  await db.delete(workflowRuns);
  await db.execute(sql`DELETE FROM crash_side_effects`);
});
afterEach(() => resetRunnerConfig());   // never leave the runner draining for the next test

const stepsOf = (runId: string) => db.select().from(workflowSteps).where(eq(workflowSteps.run_id, runId));
const sideEffects = async () => {
  const res: any = await db.execute(sql`SELECT key, attempt FROM crash_side_effects ORDER BY key`);
  return (res.rows ?? res) as Array<{ key: string; attempt: number }>;
};
const never = () => new Promise<never>(() => {});

/** A promise the test opens by hand, plus a signal that the step body has been entered. */
function gate() {
  let open!: () => void, entered!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const enteredP = new Promise<void>((r) => { entered = r; });
  return { open, opened, entered, enteredP };
}

/**
 * A two-step workflow whose first step writes a keyed side effect and, on its FIRST execution, then "dies" (never
 * returns). A reclaim re-runs the same attempt, so the crash is keyed on the call count, not ctx.attempt.
 */
function defineCrashy(process: string, maxAttempts: number, onEnter?: () => void) {
  const calls = { send: 0, after: 0, attempts: [] as number[] };
  defineWorkflow({ process, version: 1, steps: [
    { name: "send", kind: "code", leaseMs: LEASE, retry: { maxAttempts },
      run: async (ctx) => {
        calls.send++;
        calls.attempts.push(ctx.attempt);
        onEnter?.();
        // Idempotency key = run + step: a re-run of the same step finds its own earlier write and does nothing new.
        await db.execute(sql`INSERT INTO crash_side_effects (key, attempt) VALUES (${`${ctx.runId}:send`}, ${ctx.attempt}) ON CONFLICT (key) DO NOTHING`);
        if (calls.send === 1) return never();   // the process dies after the side effect, before completing
        return { sent: true };
      } },
    { name: "after", kind: "code", run: async () => { calls.after++; return { ok: true }; } },
  ]});
  return calls;
}

test("crash mid-step: a second instance reclaims the step after its lease expires (same attempt, not a retry) and completes the run; the keyed side effect is written once", async () => {
  const g = gate();
  const calls = defineCrashy("p_crash", 3, () => g.entered());
  const { run } = await startRun({ process: "p_crash", athleteId, kick: false });

  // Instance A claims and starts the step, then dies (its tick never returns).
  void tick();
  await g.enteredP;
  await sleep(20);   // let the INSERT land

  let steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.step, s.attempt, s.status])).toEqual([["send", 1, "running"]]);
  expect(steps[0].lease_until!.getTime()).toBe(nowMs + LEASE);
  expect(steps[0].lease_owner).toBeTruthy();
  expect(steps[0].lease_token).toBeTruthy();

  // Instance B ticks before the lease lapses: it must not touch the running step.
  advanceClock(LEASE - 1);
  const early = await tick();
  expect(early).toMatchObject({ expired: 0, claimed: 0 });

  // Lease lapses → B puts attempt 1 back to ready (no attempt spent, no backoff), claims it and finishes the run.
  advanceClock(2);
  const t1 = await tick();
  expect(t1.expired).toBe(1);
  expect(t1.done).toBeGreaterThanOrEqual(1);

  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.map((s) => [s.step, s.attempt, s.status, s.lease_reclaims])).toEqual([["send", 1, "done", 1], ["after", 1, "done", 0]]);
  // The step body ran twice (at-least-once), both as attempt 1; the keyed side effect exists once.
  expect(calls.attempts).toEqual([1, 1]);
  expect(calls.after).toBe(1);
  expect(await sideEffects()).toEqual([{ key: `${run.id}:send`, attempt: 1 }]);
});

test("revision replacement with no drain (SIGKILL after the grace period) leaves the run recoverable once the lease lapses", async () => {
  const g = gate();
  const calls = defineCrashy("p_sigterm", 3, () => g.entered());
  const { run } = await startRun({ process: "p_sigterm", athleteId, kick: false });

  void tick();          // old revision claims the step
  await g.enteredP;
  await sleep(20);
  advanceClock(10_000);
  // The new revision's minute ticks: nothing to do while the lease holds, recovery once it lapses.
  expect((await tick()).claimed).toBe(0);
  expect((await getRun(run.id))!.run.status).toBe("running");
  advanceClock(LEASE);
  expect((await tick()).expired).toBe(1);

  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(calls.after).toBe(1);
  expect(await sideEffects()).toHaveLength(1);
});

test("revision replacement on a maxAttempts: 1 step leaves the run recoverable (a lapsed lease spends no attempt)", async () => {
  const g = gate();
  defineCrashy("p_sigterm_once", 1, () => g.entered());
  const { run } = await startRun({ process: "p_sigterm_once", athleteId, kick: false });

  void tick();
  await g.enteredP;
  await sleep(20);
  advanceClock(LEASE + 10_000);
  await tick();

  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.filter((s) => s.step === "send").map((s) => [s.attempt, s.status])).toEqual([[1, "done"]]);
});

test("the heartbeat keeps a long step's lease: no other instance reclaims it while it runs past its lease", async () => {
  configureRunner({ heartbeatMs: 10 });
  const g = gate();
  let calls = 0;
  defineWorkflow({ process: "p_long", version: 1, steps: [
    { name: "long", kind: "code", leaseMs: LEASE, run: async () => { calls++; g.entered(); await g.opened; return { ok: true }; } },
  ]});
  const { run } = await startRun({ process: "p_long", athleteId, kick: false });
  const a = tick();
  await g.enteredP;

  // 2.4 leases of (injected) time pass while the step runs; the heartbeat moves lease_until forward each time.
  for (let i = 0; i < 3; i++) {
    advanceClock(LEASE * 0.8);
    await sleep(60);
    const [row] = await stepsOf(run.id);
    expect(row.lease_until!.getTime()).toBe(nowMs + LEASE);
    expect(await expireLeases()).toBe(0);   // another instance finds nothing to reclaim
  }
  g.open();
  expect(await a).toMatchObject({ done: 1, lost: 0 });
  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.map((s) => [s.attempt, s.status, s.lease_reclaims])).toEqual([[1, "done", 0]]);
  expect(calls).toBe(1);
});

test("completion with a lost lease is discarded: the reclaiming runner's result stands, recorded once", async () => {
  const g = gate();
  let calls = 0;
  defineWorkflow({ process: "p_lost", version: 1, steps: [
    { name: "slow", kind: "code", leaseMs: LEASE, run: async () => {
      const me = ++calls;
      if (me === 1) { g.entered(); await g.opened; return { by: "A" }; }   // A: alive but stalled (no beat reached the DB)
      return { by: "B" };
    } },
  ]});
  const { run } = await startRun({ process: "p_lost", athleteId, kick: false });
  const a = tick();               // instance A
  await g.enteredP;
  advanceClock(LEASE + 1);
  const b = await tick();          // instance B: the lease lapsed → reclaim, run, done
  expect(b).toMatchObject({ expired: 1, done: 1 });

  g.open();                       // A finally returns: its compare-and-set finds a row it no longer holds
  expect(await a).toMatchObject({ done: 0, lost: 1 });

  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.map((s) => [s.attempt, s.status, s.output])).toEqual([[1, "done", { by: "B" }]]);
});

test("a lost lease also discards the stale runner's ERROR: it neither spends an attempt nor fails the run", async () => {
  const g = gate();
  let calls = 0;
  defineWorkflow({ process: "p_lost_err", version: 1, steps: [
    { name: "slow", kind: "code", leaseMs: LEASE, retry: { maxAttempts: 1 }, run: async () => {
      const me = ++calls;
      if (me === 1) { g.entered(); await g.opened; throw new Error("A's late failure"); }
      return { by: "B" };
    } },
  ]});
  const { run } = await startRun({ process: "p_lost_err", athleteId, kick: false });
  const a = tick();
  await g.enteredP;
  advanceClock(LEASE + 1);
  await tick();
  g.open();
  expect(await a).toMatchObject({ failed: 0, lost: 1 });
  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.map((s) => [s.attempt, s.status])).toEqual([[1, "done"]]);
});

test("the crash-recovery budget is bounded: the lapse after MAX_LEASE_RECLAIMS fails the run with a clear reason", async () => {
  let calls = 0;
  defineWorkflow({ process: "p_crashloop", version: 1, steps: [
    { name: "kills_its_process", kind: "code", leaseMs: LEASE, retry: { maxAttempts: 3 }, run: async () => { calls++; return never(); } },
  ]});
  const { run } = await startRun({ process: "p_crashloop", athleteId, kick: false });

  void tick();                                  // first claim
  await sleep(20);
  for (let i = 1; i <= MAX_LEASE_RECLAIMS; i++) {
    advanceClock(LEASE + 1);
    void tick();                                // reclaim i → claimed and "crashes" again
    await sleep(40);
    const [row] = await stepsOf(run.id);
    expect([row.attempt, row.status, row.lease_reclaims]).toEqual([1, "running", i]);
  }
  advanceClock(LEASE + 1);
  const last = await tick();
  expect(last).toMatchObject({ expired: 1, claimed: 0 });

  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("failed");
  expect(final.run.last_error).toMatch(/kills_its_process: lease expired 4 times.*crash-recovery budget \(3 reclaims\) is spent/);
  // No retry attempt was scheduled: the budget is not the attempt count, and it is spent.
  expect(final.steps.map((s) => [s.attempt, s.status])).toEqual([[1, "failed"]]);
  expect(calls).toBe(MAX_LEASE_RECLAIMS + 1);
});

test("real errors thrown by the step still count as attempts (a lapse before them does not)", async () => {
  let calls = 0;
  defineWorkflow({ process: "p_errors", version: 1, steps: [
    { name: "flaky", kind: "code", leaseMs: LEASE, retry: { maxAttempts: 2 }, run: async () => {
      calls++;
      if (calls === 1) return never();          // a crash first: reclaimed, still attempt 1
      throw new Error(`boom ${calls}`);         // then real errors: attempt 1 fails, attempt 2 fails → run fails
    } },
  ]});
  const { run } = await startRun({ process: "p_errors", athleteId, kick: false });
  void tick();
  await sleep(20);
  advanceClock(LEASE + 1);
  await tick();                                 // reclaim + attempt 1 throws → retry scheduled after 1 s
  let steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.attempt, s.status, s.lease_reclaims]).sort()).toEqual([[1, "failed", 1], [2, "ready", 0]]);
  expect(steps.find((s) => s.attempt === 1)!.error).toBe("boom 2");

  advanceClock(1000);
  await tick();
  const final = (await getRun(run.id))!;
  expect(final.run.status).toBe("failed");
  expect(final.run.last_error).toBe("flaky: boom 3");
  expect(calls).toBe(3);
});

test("a hung step (alive, heartbeating) still ends: past its deadline the attempt fails as an error and retries", async () => {
  // A tiny real-time lease so the deadline (3 × lease) passes in the test; the injected clock does not move.
  let calls = 0;
  defineWorkflow({ process: "p_hung", version: 1, steps: [
    { name: "hangs", kind: "code", leaseMs: 30, retry: { maxAttempts: 2 }, run: async () => { calls++; if (calls === 1) return never(); return { ok: true }; } },
  ]});
  const { run } = await startRun({ process: "p_hung", athleteId, kick: false });
  expect(await tick()).toMatchObject({ failed: 1 });
  let steps = await stepsOf(run.id);
  expect(steps.find((s) => s.attempt === 1)!.error).toMatch(/did not finish within 90 ms \(its deadline is 3 × its lease\)/);
  advanceClock(1000);
  await tick();
  expect((await getRun(run.id))!.run.status).toBe("done");
  steps = await stepsOf(run.id);
  expect(steps.map((s) => [s.attempt, s.status]).sort()).toEqual([[1, "failed"], [2, "done"]]);
});

test("SIGTERM (drainRunner): stops claiming, lets a quick step finish, releases a slow one as ready at once for another instance", async () => {
  const slow = gate();
  const quick = gate();
  let slowCalls = 0;
  defineWorkflow({ process: "p_drain_slow", version: 1, steps: [
    { name: "slow", kind: "code", leaseMs: LEASE, run: async () => { if (++slowCalls === 1) { slow.entered(); await slow.opened; return { by: "old" }; } return { by: "new" }; } },
  ]});
  defineWorkflow({ process: "p_drain_quick", version: 1, steps: [
    { name: "quick", kind: "code", leaseMs: LEASE, run: async () => { quick.entered(); await quick.opened; return { ok: true }; } },
  ]});
  const { run: slowRun } = await startRun({ process: "p_drain_slow", athleteId, kick: false });
  const { run: quickRun } = await startRun({ process: "p_drain_quick", athleteId, kick: false });
  const old = tick();
  await Promise.all([slow.enteredP, quick.enteredP]);

  const drained = drainRunner(150);
  await sleep(20);
  quick.open();                                 // finishes inside the grace period
  // (Earlier tests' never-returning steps are still in this process's in-flight list; their leases are long gone.)
  expect(await drained).toMatchObject({ released: 1 });

  expect((await getRun(quickRun.id))!.run.status).toBe("done");
  const [released] = await stepsOf(slowRun.id);
  expect([released.status, released.attempt, released.lease_owner, released.lease_token, released.lease_reclaims]).toEqual(["ready", 1, null, null, 0]);
  expect(released.error).toMatch(/released at shutdown/);
  // The draining instance claims nothing more.
  expect((await tick()).claimed).toBe(0);

  // Another instance picks it up on its next tick, without waiting for the lease (the clock has not moved).
  resetRunnerConfig();
  configureRunner({ retry: { randomize: false, minTimeoutMs: 1000, factor: 5, maxTimeoutMs: 60_000, maxAttempts: 3 } }, now);
  expect(await tick()).toMatchObject({ claimed: 1, done: 1 });

  slow.open();                                  // the old instance's late result is discarded
  expect(await old).toMatchObject({ lost: 1 });
  const final = (await getRun(slowRun.id))!;
  expect(final.run.status).toBe("done");
  expect(final.steps.map((s) => [s.attempt, s.status, s.output])).toEqual([[1, "done", { by: "new" }]]);
});

// ─── Review fixes (#1199): queued claims, per-step deadline, shutdown with HTTP ───

test("a claimed row waiting for a worker slot keeps its lease: another instance never reclaims it while its batch-mate runs long", async () => {
  // One worker slot, two claimed rows: the second waits for the first. Without the queued-row renewal its claim-time
  // lease (defaultLeaseMs) lapses behind a long step, another instance reclaims it, and a healthy row spends crash budget.
  configureRunner({ parallelism: 1, heartbeatMs: 10, defaultLeaseMs: LEASE });
  const g = gate();
  defineWorkflow({ process: "p_q_long", version: 1, steps: [
    { name: "long", kind: "code", leaseMs: LEASE, run: async () => { g.entered(); await g.opened; return { ok: true }; } },
  ]});
  let waitedCalls = 0;
  defineWorkflow({ process: "p_q_waits", version: 1, steps: [
    { name: "waits", kind: "code", leaseMs: LEASE, run: async () => { waitedCalls++; return { ok: true }; } },
  ]});
  const { run: longRun } = await startRun({ process: "p_q_long", athleteId, kick: false });
  advanceClock(1);   // the long run's row is the older ready_at, so it is the one that takes the only slot
  const { run: waitRun } = await startRun({ process: "p_q_waits", athleteId, kick: false });
  const a = tick();
  await g.enteredP;

  for (let i = 0; i < 3; i++) {
    advanceClock(LEASE * 0.8);
    await sleep(60);
    expect(await expireLeases()).toBe(0);
    const [w] = await stepsOf(waitRun.id);
    expect([w.status, w.lease_reclaims, w.lease_until!.getTime()]).toEqual(["running", 0, nowMs + LEASE]);
  }
  g.open();
  expect(await a).toMatchObject({ claimed: 2, done: 2, lost: 0 });
  for (const id of [longRun.id, waitRun.id]) {
    const f = (await getRun(id))!;
    expect(f.run.status).toBe("done");
    expect(f.steps.map((s) => [s.attempt, s.status, s.lease_reclaims])).toEqual([[1, "done", 0]]);
  }
  expect(waitedCalls).toBe(1);
});

test("SIGTERM releases claimed-but-not-started rows at once, without waiting for the grace period or the lease", async () => {
  configureRunner({ parallelism: 1, defaultLeaseMs: LEASE });
  const g = gate();
  defineWorkflow({ process: "p_qd_long", version: 1, steps: [
    { name: "long", kind: "code", leaseMs: LEASE, run: async () => { g.entered(); await g.opened; return { ok: true }; } },
  ]});
  let waitedCalls = 0;
  defineWorkflow({ process: "p_qd_waits", version: 1, steps: [
    { name: "waits", kind: "code", leaseMs: LEASE, run: async () => { waitedCalls++; return { ok: true }; } },
  ]});
  await startRun({ process: "p_qd_long", athleteId, kick: false });
  advanceClock(1);
  const { run: waitRun } = await startRun({ process: "p_qd_waits", athleteId, kick: false });
  const a = tick();
  await g.enteredP;

  const drained = drainRunner(100);
  await sleep(20);
  // Released before the grace period ends: the queued row is ready again, same attempt, no reclaim, no owner.
  const [w] = await stepsOf(waitRun.id);
  expect([w.status, w.attempt, w.lease_owner, w.lease_token, w.lease_reclaims]).toEqual(["ready", 1, null, null, 0]);
  expect(await drained).toMatchObject({ queued: 1 });
  g.open();
  await a;
  expect(waitedCalls).toBe(0);   // the draining instance never started it
});

test("a step's declared deadlineMs replaces the default 3 × lease cap (a legitimately long step is not failed)", async () => {
  expect(stepDeadlineMs({ leaseMs: 30 })).toBe(90);
  expect(stepDeadlineMs({ leaseMs: 30, deadlineMs: 400 })).toBe(400);
  expect(stepDeadlineMs({})).toBe(5 * 60_000 * 3);
  let calls = 0;
  defineWorkflow({ process: "p_long_deadline", version: 1, steps: [
    // Runs 150 ms on a 30 ms lease: past the default 90 ms deadline, inside its declared 400 ms one.
    { name: "render", kind: "code", leaseMs: 30, deadlineMs: 400, retry: { maxAttempts: 1 }, run: async () => { calls++; await sleep(150); return { ok: true }; } },
  ]});
  const { run } = await startRun({ process: "p_long_deadline", athleteId, kick: false });
  const t = await tick();
  expect(t).toMatchObject({ claimed: 1, done: 1, failed: 0, lost: 0 });
  expect((await getRun(run.id))!.run.status).toBe("done");
  expect(calls).toBe(1);

  defineWorkflow({ process: "p_short_deadline", version: 1, steps: [
    { name: "render", kind: "code", leaseMs: 30, deadlineMs: 60, retry: { maxAttempts: 1 }, run: async () => { await sleep(150); return { ok: true }; } },
  ]});
  const { run: r2 } = await startRun({ process: "p_short_deadline", athleteId, kick: false });
  expect(await tick()).toMatchObject({ failed: 1 });
  const f = (await getRun(r2.id))!;
  expect(f.run.status).toBe("failed");
  expect(f.run.last_error).toMatch(/did not finish within 60 ms \(its declared deadlineMs\)/);
});

test("shutdown waits for the HTTP server to close as well as the drain, then exits 0", async () => {
  configureRunner({ shutdownGraceMs: 30 });   // earlier tests left never-returning steps in flight
  let closeDone!: () => void;
  const closing = new Promise<void>((r) => { closeDone = r; });
  const exits: number[] = [];
  const seq = shutdownSequence({ exit: (c) => exits.push(c), closeHttp: () => closing, hardMs: 5_000 });
  await sleep(50);
  expect(exits).toEqual([]);          // the runner is idle, but a request is still open
  closeDone();
  await seq;
  expect(exits).toEqual([0]);
});

test("shutdown exits at the hard limit even when HTTP never closes", async () => {
  configureRunner({ shutdownGraceMs: 30 });
  const exits: number[] = [];
  const t0 = Date.now();
  await shutdownSequence({ exit: (c) => exits.push(c), closeHttp: () => new Promise<void>(() => {}), hardMs: 80 });
  expect(exits).toEqual([0]);
  expect(Date.now() - t0).toBeLessThan(2_000);
});

test("installRunnerShutdown adds one SIGTERM listener, however often it is called", () => {
  const before = process.listenerCount("SIGTERM");
  installRunnerShutdown({ exit: () => {} });
  installRunnerShutdown({ exit: () => {} });
  const added = process.listeners("SIGTERM").slice(before);
  expect(added).toHaveLength(1);
  process.removeListener("SIGTERM", added[0] as any);
});
