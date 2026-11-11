/**
 * stories.health.test.ts — an empty Story list must be distinguishable from a broken Story pipeline.
 *
 * Both close a sweep as `status: "ok"` with `items: 0`, which is how Step 1b spent five days recorded as "waiting for
 * the athlete's first Story" while fourteen consecutive sweeps returned an empty list for an account that had posted
 * to feed and shared it to Story. The signal is the conjunction: consecutive empty sweeps AND feed activity inside the
 * same window.
 */
import { assessStoryCollection, STORY_EMPTY_SWEEP_THRESHOLD } from "./storiesHealth";

const H = 3_600_000;
const T = Date.parse("2026-09-15T08:20:00.000Z");
/** Eight-hourly sweeps, newest first, all empty and healthy. */
const emptySweeps = (n: number) => Array.from({ length: n }, (_, k) => ({ items: 0, startedAt: new Date(T - k * 8 * H), status: "ok" }));

describe("assessStoryCollection", () => {
  it("quiet account: many empty sweeps, no feed activity in the window — not suspect", () => {
    const h = assessStoryCollection(emptySweeps(14), "2026-08-01T00:00:00.000Z");
    expect(h.consecutiveEmptySweeps).toBe(14);
    expect(h.feedActivityInsideEmptyWindow).toBe(false);
    expect(h.suspect).toBe(false);
  });

  it("Mia's real shape: empty sweeps while posting to feed — suspect", () => {
    const h = assessStoryCollection(emptySweeps(14), "2026-09-13T01:23:12.000Z");
    expect(h.consecutiveEmptySweeps).toBe(14);
    expect(h.feedActivityInsideEmptyWindow).toBe(true);
    expect(h.suspect).toBe(true);
  });

  it("does not cry wolf below the threshold", () => {
    const h = assessStoryCollection(emptySweeps(STORY_EMPTY_SWEEP_THRESHOLD - 1), "2026-09-15T00:00:00.000Z");
    expect(h.suspect).toBe(false);
  });

  it("a Story found resets the count — the run before it is not counted", () => {
    const runs = [...emptySweeps(3), { items: 5, startedAt: new Date(T - 3 * 8 * H), status: "ok" }, ...emptySweeps(10)];
    expect(assessStoryCollection(runs, "2026-09-15T00:00:00.000Z").consecutiveEmptySweeps).toBe(3);
  });

  it("a failed sweep stops the count — a failure is already visible, it is not silence", () => {
    const runs = [...emptySweeps(2), { items: 0, startedAt: new Date(T - 2 * 8 * H), status: "failed" }, ...emptySweeps(10)];
    const h = assessStoryCollection(runs, "2026-09-15T00:00:00.000Z");
    expect(h.consecutiveEmptySweeps).toBe(2);
    expect(h.suspect).toBe(false);
  });

  it("feed activity older than the empty window does not trigger it", () => {
    const h = assessStoryCollection(emptySweeps(10), new Date(T - 11 * 8 * H).toISOString());
    expect(h.feedActivityInsideEmptyWindow).toBe(false);
    expect(h.suspect).toBe(false);
  });

  it("no sweeps at all is not suspect", () => {
    expect(assessStoryCollection([], "2026-09-15T00:00:00.000Z").suspect).toBe(false);
  });
});
