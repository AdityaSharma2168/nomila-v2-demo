/**
 * stories.schedule.test.ts — the pure last-look rule and the blind-spot model (design §4–5).
 */

import { lastLookDue, storyClosed, tailShare } from "./storiesSchedule";

const H = 3_600_000;
const T0 = Date.parse("2026-09-12T10:00:00.000Z");   // entity_time

describe("lastLookDue", () => {
  it("a Story with only `listed` (no successful reading) at 22.5 h is due", () => {
    expect(lastLookDue(T0, T0 + 22.5 * H, [])).toBe(true);
  });
  it("a successful reading at 22.1 h satisfies the rule; one at 21.9 h does not", () => {
    expect(lastLookDue(T0, T0 + 22.5 * H, [T0 + 22.1 * H])).toBe(false);
    expect(lastLookDue(T0, T0 + 22.5 * H, [T0 + 21.9 * H])).toBe(true);
  });
  it("a failed attempt at 22.5 h leaves the Story due at 23.5 h; expiry closes the window", () => {
    expect(lastLookDue(T0, T0 + 23.5 * H, [])).toBe(true);
    expect(lastLookDue(T0, T0 + 24.0 * H, [])).toBe(false);
    expect(lastLookDue(T0, T0 + 24.5 * H, [])).toBe(false);
  });
  it("is not due before the last-look age, at any clock time", () => {
    for (const age of [0.5, 8, 16, 21.99]) expect(lastLookDue(T0, T0 + age * H, [])).toBe(false);
  });
  it("respects a configured last-look hour", () => {
    expect(lastLookDue(T0, T0 + 22.5 * H, [], 23)).toBe(false);
    expect(lastLookDue(T0, T0 + 23.2 * H, [], 23)).toBe(true);
  });
  it("storyClosed after 24 h", () => {
    expect(storyClosed(T0, T0 + 23.9 * H)).toBe(false);
    expect(storyClosed(T0, T0 + 24.1 * H)).toBe(true);
  });
});

describe("tailShare (design §5 table, normalized to the 24-hour total)", () => {
  const pct = (t: number, h: number) => Math.round(tailShare(t, h) * 1000) / 10;
  it("reproduces the reviewed table", () => {
    expect([pct(8, 4), pct(8, 6), pct(8, 8)]).toEqual([4.8, 10.1, 14.3]);
    expect([pct(4, 4), pct(4, 6), pct(4, 8)]).toEqual([1.6, 3.9, 5.9]);
    expect([pct(2, 4), pct(2, 6), pct(2, 8)]).toEqual([0.7, 1.7, 2.7]);
    expect([pct(1, 4), pct(1, 6), pct(1, 8)]).toEqual([0.3, 0.8, 1.3]);
  });
  it("is a share of the 24-hour total: the whole life is 100 %, nothing is 0 %", () => {
    expect(tailShare(24, 6)).toBeCloseTo(1, 10);
    expect(tailShare(0, 6)).toBeCloseTo(0, 10);
  });
});
