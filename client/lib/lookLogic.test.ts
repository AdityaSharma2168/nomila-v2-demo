import fs from "fs";
import path from "path";
import { suggestTimes, presetStarts, withUndo, alternativeTimes, inBatches, slotBatches, PRESETS, SLOTS_PER_REQUEST, type Timers } from "./lookLogic";

describe("open times in request-sized batches", () => {
  it("SLOTS_PER_REQUEST matches the server's limit (offers.ts addSlots refuses more)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../server/services/bookings/offers.ts"), "utf8");
    const m = /startsRaw\.length > (\d+)/.exec(src);
    expect(m && Number(m[1])).toBe(SLOTS_PER_REQUEST);
  });
  it("a preset can make more times than one request takes; the batches cover every one of them, in order", () => {
    const sunday = new Date(2026, 10, 1, 9, 0, 0);
    const evenings = presetStarts("weekday_evenings", sunday);
    expect(evenings.length).toBe(24);
    expect(evenings.length).toBeGreaterThan(SLOTS_PER_REQUEST);
    const everyDay = presetStarts("weekday_evenings", sunday, { days: [0, 1, 2, 3, 4, 5, 6] });
    for (const starts of [evenings, everyDay, presetStarts("weekends", sunday)]) {
      const batches = inBatches(starts);
      expect(batches.every((b) => b.length >= 1 && b.length <= SLOTS_PER_REQUEST)).toBe(true);
      expect(batches.flat()).toEqual(starts);
    }
  });
  it("inBatches: nothing in, nothing out; exact multiples leave no empty tail", () => {
    expect(inBatches([])).toEqual([]);
    expect(inBatches([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it("slotBatches skips the times already added", () => {
    expect(slotBatches(["a", "b", "c"], ["b"], 1)).toEqual([["a"], ["c"]]);
    expect(slotBatches(["a"], ["a"])).toEqual([]);
  });
});

describe("suggestTimes", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("spreads across days first, soonest first, at most n", () => {
    const open = [
      { startsAt: "2026-10-22T12:30:00Z" }, // too soon (< 60 min lead)
      { startsAt: "2026-10-23T18:00:00Z" },
      { startsAt: "2026-10-23T19:00:00Z" },
      { startsAt: "2026-10-24T18:00:00Z" },
      { startsAt: "2026-10-25T10:00:00Z" },
      { startsAt: "2026-10-26T10:00:00Z" },
    ];
    expect(suggestTimes(open, now).map((t) => t.startsAt)).toEqual(["2026-10-23T18:00:00Z", "2026-10-24T18:00:00Z", "2026-10-25T10:00:00Z"]);
  });
  it("fills from the same day when there are fewer days than chips", () => {
    const open = [{ startsAt: "2026-10-23T18:00:00Z" }, { startsAt: "2026-10-23T19:00:00Z" }, { startsAt: "2026-10-23T20:00:00Z" }];
    expect(suggestTimes(open, now)).toHaveLength(3);
  });
  it("is empty when nothing is open", () => {
    expect(suggestTimes([], now)).toEqual([]);
  });
});

describe("presetStarts", () => {
  const now = new Date(2026, 9, 19, 9, 0, 0); // Monday 19 Oct 2026, 9 am local
  it("weekday evenings: Mon–Thu, three evening starts each, within the horizon", () => {
    const starts = presetStarts("weekday_evenings", new Date(2026, 9, 18, 9, 0, 0), { horizonDays: 6 }); // from Sunday
    const days = new Set(starts.map((s) => new Date(s).getDay()));
    expect([...days].sort()).toEqual([1, 2, 3, 4]);
    expect(starts.every((s) => [18, 19, 20].includes(new Date(s).getHours()))).toBe(true);
  });
  it("respects the day chips", () => {
    const starts = presetStarts("weekends", now, { days: [6], horizonDays: 7 });
    expect(starts.every((s) => new Date(s).getDay() === 6)).toBe(true);
    expect(starts.length).toBe(PRESETS.weekends.hours.length);
  });
  it("never starts inside the lead time", () => {
    const starts = presetStarts("weekday_evenings", now, { minLeadHours: 12, horizonDays: 1 });
    expect(starts.every((s) => Date.parse(s) >= now.getTime() + 12 * 3_600_000)).toBe(true);
  });
  it("only when I say gives no times", () => {
    expect(presetStarts("only_when_i_say", now)).toEqual([]);
  });
});

describe("withUndo", () => {
  function fakeTimers() {
    let pending: (() => void) | null = null;
    const t: Timers = { set: (fn) => { pending = fn; return 1; }, clear: () => { pending = null; } };
    return { t, fire: () => pending?.() };
  }
  it("commits when the window closes", () => {
    const f = fakeTimers(); const commit = jest.fn();
    withUndo(commit, 10_000, f.t); f.fire();
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it("undo inside the window never commits", () => {
    const f = fakeTimers(); const commit = jest.fn();
    const u = withUndo(commit, 10_000, f.t);
    expect(u.undo()).toBe(true); f.fire();
    expect(commit).not.toHaveBeenCalled();
  });
  it("undo after commit is refused; flush commits once", () => {
    const f = fakeTimers(); const commit = jest.fn();
    const u = withUndo(commit, 10_000, f.t);
    u.flush(); expect(u.undo()).toBe(false); f.fire();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("alternativeTimes", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("uses open times first, never the requested one", () => {
    const open = [{ startsAt: "2026-10-23T18:00:00Z" }, { startsAt: "2026-10-24T18:00:00Z" }, { startsAt: "2026-10-25T18:00:00Z" }, { startsAt: "2026-10-26T18:00:00Z" }];
    expect(alternativeTimes("2026-10-23T18:00:00Z", open, now)).toEqual(["2026-10-24T18:00:00Z", "2026-10-25T18:00:00Z", "2026-10-26T18:00:00Z"]);
  });
  it("falls back to the same hour on the next days", () => {
    expect(alternativeTimes("2026-10-23T18:00:00Z", [], now)).toEqual(["2026-10-24T18:00:00.000Z", "2026-10-25T18:00:00.000Z", "2026-10-26T18:00:00.000Z"]);
  });
});
