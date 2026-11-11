/**
 * The gate bounds concurrency, preserves order, and never leaks a slot.
 *
 * Concurrency code is worth testing precisely because its failures are invisible in review: a
 * leaked slot looks like nothing until the tenth burst deadlocks, and a LIFO queue looks
 * correct until the oldest request in a burst starves. Each test below drives the gate with
 * controllable promises rather than timers, so the assertions are about ordering and counts
 * rather than about how fast the machine running CI happens to be.
 */

import { createGate } from "./llm";

/** A promise whose settlement this test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued microtasks drain, so `run()` bodies that were unblocked actually start. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("createGate", () => {
  it("runs up to the limit at once and makes the rest wait", async () => {
    const gate = createGate(2);
    const d = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    d.forEach((x, i) => void gate.run(async () => { started.push(i); await x.promise; }));
    await settle();

    expect(started).toEqual([0, 1]);   // the third is queued, not running
    expect(gate.active).toBe(2);
    expect(gate.pending).toBe(1);

    d[0].resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);
  });

  it("admits waiters in FIFO order", async () => {
    // LIFO would let a steady arrival rate starve the oldest waiter — which in a Gmail burst
    // is the message whose webhook is closest to timing out.
    const gate = createGate(1);
    const blocker = deferred();
    const order: string[] = [];

    void gate.run(async () => { order.push("first"); await blocker.promise; });
    await settle();
    for (const label of ["a", "b", "c"]) void gate.run(async () => { order.push(label); });

    blocker.resolve();
    await settle();
    await settle();

    expect(order).toEqual(["first", "a", "b", "c"]);
  });

  it("releases the slot when the task throws", async () => {
    // The leak that matters: if a rejection skipped release, one failed classify would
    // permanently shrink the pool, and enough of them would wedge the pipeline entirely.
    const gate = createGate(1);

    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");

    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
    await expect(gate.run(async () => "still works")).resolves.toBe("still works");
  });

  it("propagates the resolved value untouched", async () => {
    const gate = createGate(2);
    const value = { choices: [{ message: { content: "{}" } }] };
    await expect(gate.run(async () => value)).resolves.toBe(value);
  });

  it("drains a burst far larger than the limit, losing nothing", async () => {
    const gate = createGate(3);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => gate.run(async () => i)),
    );

    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });

  it("never exceeds the limit under a mixed success/failure burst", async () => {
    const gate = createGate(4);
    let peak = 0;

    await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        gate.run(async () => {
          peak = Math.max(peak, gate.active);
          await settle();
          if (i % 5 === 0) throw new Error(`fail ${i}`);
          return i;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(gate.active).toBe(0);
  });

  it("treats a nonsensical limit as 1 rather than as unbounded", async () => {
    // The plausible way to get a 0 or a NaN here is a mistyped env var. Reading that as
    // "no limit" would silently reinstate the exact bug the gate exists to prevent.
    for (const bad of [0, -5, NaN]) {
      const gate = createGate(bad);
      const blocker = deferred();
      void gate.run(async () => { await blocker.promise; });
      void gate.run(async () => {});
      await settle();

      expect(gate.active).toBe(1);
      expect(gate.pending).toBe(1);
      blocker.resolve();
      await settle();
    }
  });

  it("keeps allSettled results in INPUT order while bounding concurrency", async () => {
    // Load-bearing for the Gmail webhook, which maps results back to messages by index
    // (`results.forEach((r, i) => messages[i]`) to build its dead-letter list. If gating
    // reordered results, a dead-letter would be filed against the wrong message id.
    const gate = createGate(2);
    const finishOrder: number[] = [];

    const results = await Promise.allSettled(
      [40, 10, 30, 0, 20].map((delay, i) =>
        gate.run(async () => {
          await new Promise((r) => setTimeout(r, delay));
          finishOrder.push(i);
          if (i === 2) throw new Error("message 2 failed");
          return i;
        }),
      ),
    );

    // Completion order is genuinely not input order — otherwise this proves nothing.
    expect(finishOrder).not.toEqual([0, 1, 2, 3, 4]);

    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "rejected")))
      .toEqual([0, 1, "rejected", 3, 4]);
  });

  it("floors a fractional limit instead of admitting a partial slot", async () => {
    const gate = createGate(2.9);
    const blockers = [deferred(), deferred(), deferred()];
    blockers.forEach((b) => void gate.run(async () => { await b.promise; }));
    await settle();

    expect(gate.active).toBe(2);
    blockers.forEach((b) => b.resolve());
    await settle();
  });
});
