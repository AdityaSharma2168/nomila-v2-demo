/**
 * availabilityLogic.test — flexible hours: the weekly model, quick starts → hours, hours → open times (back-to-back
 * starts, 15-minute edges, several blocks a day, the lead time, the 4-week horizon, DST in a pinned zone), validation,
 * "What fans see", and Edit hours' add / withdraw plan (never a booked time).
 */
import {
  HORIZON_DAYS, PRESET_HOURS, addBlock, blockProblem, blockStarts, commonBlock, countLine, fmtBlock, fmtClock, fmtDays,
  fromAvailability, hoursDays, hoursFromSlots, hoursProblems, hoursStarts, hoursSummary, inHours, instantOf,
  matchingPreset, planHoursChange, presetHours, removeBlock, sameHours, setAllBlocks, setBlock, snapMinutes,
  suggestBlock, toAvailability, toggleDay, uniformHours, type WeekHours,
} from "./availabilityLogic";
import type { SlotView } from "./bookingsTypes";

const hm = (h: number, m = 0) => h * 60 + m;
const local = (y: number, mo: number, d: number, h: number, m = 0) => new Date(y, mo, d, h, m).toISOString();
// Sunday 1 Nov 2026, 9 am on the phone's clock.
const SUNDAY = new Date(2026, 10, 1, 9, 0, 0);
// The owner's example: Mon, Wed, Thu 6–9 pm; Tue 7:00–8:15 am and 5:30–8:00 pm.
const MIXED: WeekHours = {
  1: [{ start: hm(18), end: hm(21) }], 3: [{ start: hm(18), end: hm(21) }], 4: [{ start: hm(18), end: hm(21) }],
  2: [{ start: hm(17, 30), end: hm(20) }, { start: hm(7), end: hm(8, 15) }],
};

describe("the weekly model and quick starts", () => {
  it("a quick start fills the hours; the days come back Monday first", () => {
    expect(presetHours("weekday_evenings")).toEqual(uniformHours([1, 2, 3, 4], { start: hm(18), end: hm(21) }));
    expect(hoursDays(presetHours("weekends"))).toEqual([6, 0]);
    expect(PRESET_HOURS.weekends.block).toEqual({ start: hm(10), end: hm(16) });
  });

  it("matchingPreset follows the hours, not the last chip tapped", () => {
    const h = presetHours("weekday_evenings");
    expect(matchingPreset(h)).toBe("weekday_evenings");
    expect(matchingPreset(toggleDay(h, 5, { start: hm(18), end: hm(21) }))).toBeNull();
    expect(matchingPreset(setAllBlocks(h, { start: hm(17), end: hm(21) }))).toBeNull();
    expect(matchingPreset({})).toBeNull();
  });

  it("commonBlock: the one block all open days share, else null", () => {
    expect(commonBlock(presetHours("weekends"))).toEqual({ start: hm(10), end: hm(16) });
    expect(commonBlock(MIXED)).toBeNull();
    expect(commonBlock({})).toBeNull();
    expect(commonBlock({ 1: [{ start: 0, end: 60 }, { start: 120, end: 180 }] })).toBeNull();
  });

  it("toggle a day, set / add / remove blocks; removing the last block closes the day", () => {
    let h = toggleDay({}, 2, { start: hm(7), end: hm(8, 15) });
    h = addBlock(h, 2, { start: hm(17, 30), end: hm(20) });
    expect(h[2]).toEqual([{ start: hm(7), end: hm(8, 15) }, { start: hm(17, 30), end: hm(20) }]);
    h = setBlock(h, 2, 1, { start: hm(6), end: hm(6, 45) });
    expect(h[2]![0]).toEqual({ start: hm(6), end: hm(6, 45) });   // re-sorted
    h = removeBlock(removeBlock(h, 2, 0), 2, 0);
    expect(hoursDays(h)).toEqual([]);
    expect(toggleDay(toggleDay({}, 1, { start: 0, end: 60 }), 1, { start: 0, end: 60 })).toEqual({});
  });

  it("suggestBlock: a second block after the last, else before the first, else none", () => {
    expect(suggestBlock([{ start: hm(7), end: hm(8, 15) }], 30)).toEqual({ start: hm(9, 15), end: hm(10, 15) });
    expect(suggestBlock([{ start: hm(18), end: hm(23) }], 30)).toEqual({ start: hm(16), end: hm(17) });
    expect(suggestBlock([{ start: 0, end: 1440 }], 30)).toBeNull();
    expect(suggestBlock(Array.from({ length: 6 }, (_, i) => ({ start: i * 60, end: i * 60 + 30 })), 30)).toBeNull();
  });

  it("round-trips through the stored shape (offers.availability) with the preset it still matches", () => {
    const a = toAvailability(MIXED);
    expect(a).toMatchObject({ version: 1, preset: null });
    expect(a.blocks[0]).toEqual({ day: 1, start: hm(18), end: hm(21) });
    expect(a.blocks.filter((b) => b.day === 2)).toEqual([{ day: 2, start: hm(7), end: hm(8, 15) }, { day: 2, start: hm(17, 30), end: hm(20) }]);
    expect(sameHours(fromAvailability(a)!, MIXED)).toBe(true);
    expect(toAvailability(presetHours("weekends")).preset).toBe("weekends");
    expect(fromAvailability(null)).toBeNull();
    expect(fromAvailability({ version: 1, preset: null, blocks: [] })).toBeNull();
  });

  it("snapMinutes keeps to the 15-minute grid", () => {
    expect(snapMinutes(hm(7, 7))).toBe(hm(7));
    expect(snapMinutes(hm(7, 8))).toBe(hm(7, 15));
    expect(snapMinutes(1500)).toBe(1440);
  });
});

describe("words", () => {
  it("clock and block labels: am/pm once when shared; midnight", () => {
    expect(fmtClock(0)).toBe("12:00 am");
    expect(fmtClock(hm(12))).toBe("12:00 pm");
    expect(fmtClock(hm(20, 15))).toBe("8:15 pm");
    expect(fmtBlock({ start: hm(18), end: hm(21) })).toBe("6:00–9:00 pm");
    expect(fmtBlock({ start: hm(10), end: hm(16) })).toBe("10:00 am–4:00 pm");
    expect(fmtBlock({ start: hm(22), end: 1440 })).toBe("10:00 pm–12:00 am");
  });

  it("days: three or more in a row read as a run", () => {
    expect(fmtDays([1, 3, 4])).toBe("Mon, Wed, Thu");
    expect(fmtDays([1, 2, 3, 4])).toBe("Mon–Thu");
    expect(fmtDays([6, 0])).toBe("Sat, Sun");
    expect(fmtDays([1, 2, 4, 5, 6])).toBe("Mon, Tue, Thu–Sat");
  });

  it("What fans see: the owner's example, word for word", () => {
    expect(hoursSummary(MIXED)).toBe("Mon, Wed, Thu 6:00–9:00 pm · Tue 7:00–8:15 am, 5:30–8:00 pm");
    expect(hoursSummary(presetHours("weekday_evenings"))).toBe("Mon–Thu 6:00–9:00 pm");
    expect(hoursSummary(presetHours("weekends"))).toBe("Sat, Sun 10:00 am–4:00 pm");
    expect(hoursSummary({})).toBe("");
  });

  it("the count line", () => {
    expect(countLine(24)).toBe("24 open times over the next 4 weeks.");
    expect(countLine(1)).toBe("1 open time over the next 4 weeks.");
    expect(countLine(0)).toBe("No open times fit in the next 4 weeks.");
  });
});

describe("validation", () => {
  it("each block: 15-minute steps, ends after it starts (by midnight), fits one session", () => {
    expect(blockProblem({ start: hm(18), end: hm(21) }, 60)).toBeNull();
    expect(blockProblem({ start: hm(18), end: hm(18) }, 30)).toBe("Until must be after From.");
    expect(blockProblem({ start: hm(19), end: hm(18) }, 30)).toBe("Until must be after From.");
    expect(blockProblem({ start: hm(18, 10), end: hm(19) }, 30)).toBe("Pick times in 15-minute steps.");
    expect(blockProblem({ start: hm(7), end: hm(7, 15) }, 30)).toBe("7:00–7:15 am is shorter than a 30-min session.");
    expect(blockProblem({ start: hm(7), end: hm(7, 30) }, 30)).toBeNull();   // exactly one session
  });

  it("the whole week: a day at least, no overlapping blocks in a day, each block fits", () => {
    expect(hoursProblems({}, 30)).toEqual(["Pick at least one day."]);
    expect(hoursProblems(MIXED, 30)).toEqual([]);
    expect(hoursProblems({ 2: [{ start: hm(7), end: hm(9) }, { start: hm(8, 30), end: hm(10) }] }, 30))
      .toEqual(["Tue: 7:00–9:00 am and 8:30–10:00 am overlap."]);
    expect(hoursProblems({ 2: [{ start: hm(7), end: hm(8) }, { start: hm(8), end: hm(9) }] }, 30)).toEqual([]);   // touching is fine
    expect(hoursProblems(MIXED, 90)).toEqual(["Tue: 7:00–8:15 am is shorter than a 90-min session."]);
  });
});

describe("hours → open times", () => {
  it("back-to-back starts by the session's length; a block must fit the full session", () => {
    expect(blockStarts({ start: hm(18), end: hm(20) }, 30)).toEqual([hm(18), hm(18, 30), hm(19), hm(19, 30)]);
    expect(blockStarts({ start: hm(7), end: hm(8, 15) }, 30)).toEqual([hm(7), hm(7, 30)]);       // 8:00 + 30 > 8:15
    expect(blockStarts({ start: hm(7), end: hm(8, 15) }, 15)).toEqual([hm(7), hm(7, 15), hm(7, 30), hm(7, 45), hm(8)]);
    expect(blockStarts({ start: hm(7), end: hm(8, 15) }, 45)).toEqual([hm(7)]);
    expect(blockStarts({ start: hm(7), end: hm(7, 15) }, 30)).toEqual([]);                        // too short
    expect(blockStarts({ start: hm(23), end: 1440 }, 60)).toEqual([hm(23)]);                       // up to midnight
  });

  it("several blocks a day, every open day of the next 4 weeks, in order", () => {
    const starts = hoursStarts({ 2: MIXED[2] }, 30, SUNDAY);
    // 4 Tuesdays × (7:00, 7:30 + 5:30 … 7:30 pm) = 4 × 7.
    expect(starts).toHaveLength(28);
    expect(starts.slice(0, 7)).toEqual([
      local(2026, 10, 3, 7), local(2026, 10, 3, 7, 30), local(2026, 10, 3, 17, 30), local(2026, 10, 3, 18),
      local(2026, 10, 3, 18, 30), local(2026, 10, 3, 19), local(2026, 10, 3, 19, 30),
    ]);
    expect([...starts].sort()).toEqual(starts.slice().sort());
    expect(Date.parse(starts.at(-1)!)).toBeLessThan(SUNDAY.getTime() + HORIZON_DAYS * 86_400_000);
  });

  it("Weekday evenings, 30 min, over 4 weeks from a Sunday: 16 evenings × 6 = 96", () => {
    expect(hoursStarts(presetHours("weekday_evenings"), 30, SUNDAY)).toHaveLength(96);
    expect(hoursStarts(presetHours("weekday_evenings"), 60, SUNDAY)).toHaveLength(48);
    expect(hoursStarts(presetHours("weekday_evenings"), 60, SUNDAY, { horizonDays: 7 })).toHaveLength(12);
  });

  it("never sooner than the lead time (12 hours by default); exactly 12 hours counts", () => {
    const tuesday6am = new Date(2026, 10, 3, 6, 0, 0);
    const starts = hoursStarts({ 2: MIXED[2] }, 30, tuesday6am, { horizonDays: 1 });
    expect(starts).toEqual([local(2026, 10, 3, 18), local(2026, 10, 3, 18, 30), local(2026, 10, 3, 19), local(2026, 10, 3, 19, 30)]);
    expect(hoursStarts({ 2: MIXED[2] }, 30, tuesday6am, { horizonDays: 1, minLeadHours: 3 })).toHaveLength(5);
    expect(hoursStarts({ 2: MIXED[2] }, 30, tuesday6am, { horizonDays: 1, minLeadHours: 0 })).toHaveLength(7);
  });

  it("no open days, or blocks too short, make no times", () => {
    expect(hoursStarts({}, 30, SUNDAY)).toEqual([]);
    expect(hoursStarts({ 1: [{ start: hm(7), end: hm(7, 15) }] }, 30, SUNDAY)).toEqual([]);
  });

  describe("in a pinned time zone (DST)", () => {
    const NY = "America/New_York";
    it("evenings keep her wall clock across the November change (6 pm EDT, then 6 pm EST)", () => {
      const starts = hoursStarts({ 4: [{ start: hm(18), end: hm(18, 30) }], 1: [{ start: hm(18), end: hm(18, 30) }] }, 30,
        new Date("2026-10-28T12:00:00Z"), { timeZone: NY, horizonDays: 7, minLeadHours: 0 });
      expect(starts).toEqual(["2026-10-29T22:00:00.000Z", "2026-11-02T23:00:00.000Z"]);
    });

    it("the night clocks go back: 1:00 and 1:30 once each (the first), never overlapping", () => {
      const starts = hoursStarts({ 0: [{ start: hm(0, 30), end: hm(3) }] }, 30, new Date("2026-10-31T00:00:00Z"), { timeZone: NY, horizonDays: 3, minLeadHours: 0 });
      expect(starts).toEqual([
        "2026-11-01T04:30:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T07:30:00.000Z",
      ]);
      for (let i = 1; i < starts.length; i++) expect(Date.parse(starts[i]) - Date.parse(starts[i - 1])).toBeGreaterThanOrEqual(30 * 60_000);
    });

    it("the night clocks go forward: the skipped hour has no times", () => {
      const starts = hoursStarts({ 0: [{ start: hm(1), end: hm(4) }] }, 30, new Date("2027-03-13T00:00:00Z"), { timeZone: NY, horizonDays: 3, minLeadHours: 0 });
      expect(starts).toEqual(["2027-03-14T06:00:00.000Z", "2027-03-14T06:30:00.000Z", "2027-03-14T07:00:00.000Z", "2027-03-14T07:30:00.000Z"]);
      expect(instantOf({ y: 2027, mo: 2, d: 14, minutes: hm(2, 30) }, NY)).toBeNull();
    });

    it("a half-hour zone, and today read in HER zone (not the phone's)", () => {
      // 20:00Z Sunday is already Monday 1:30 am in Kolkata (+5:30): Monday's 6 pm is the first time.
      const starts = hoursStarts({ 1: [{ start: hm(18), end: hm(18, 30) }] }, 30, new Date("2026-11-01T20:00:00Z"), { timeZone: "Asia/Kolkata", horizonDays: 1, minLeadHours: 0 });
      expect(starts).toEqual(["2026-11-02T12:30:00.000Z"]);
    });

    it("inHours reads a time on her own day and clock", () => {
      const h: WeekHours = { 0: [{ start: hm(1), end: hm(2) }] };
      expect(inHours("2026-11-01T05:00:00.000Z", "2026-11-01T05:30:00.000Z", h, NY)).toBe(true);    // 1:00 EDT
      expect(inHours("2026-11-01T06:30:00.000Z", "2026-11-01T07:00:00.000Z", h, NY)).toBe(true);    // 1:30 EST
      expect(inHours("2026-11-01T07:00:00.000Z", "2026-11-01T07:30:00.000Z", h, NY)).toBe(false);   // 2:00 EST
    });
  });
});

describe("Edit hours: what to add and what to withdraw", () => {
  let n = 0;
  const slot = (startsAt: string, minutes = 30, over: Partial<SlotView> = {}): SlotView => ({
    id: `s${++n}`, startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(), taken: false, capacity: 1, spotsTaken: 0, spotsLeft: 1, ...over,
  });
  const evenings = presetHours("weekday_evenings");

  it("keeps times inside the hours, withdraws open ones outside, never a booked one, never a past one", () => {
    const inside = slot(local(2026, 10, 2, 18));                                     // Mon 6 pm
    const outside = slot(local(2026, 10, 7, 11));                                     // Sat 11 am
    const outsideBooked = slot(local(2026, 10, 8, 11), 30, { taken: true, spotsLeft: 0, spotsTaken: 1 });
    const groupSpot = slot(local(2026, 10, 8, 14), 30, { capacity: 10, spotsTaken: 2, spotsLeft: 8 });   // open group, 2 booked
    const past = slot(local(2026, 10, 1, 8));                                         // Sun 8 am, before now
    const plan = planHoursChange([inside, outside, outsideBooked, groupSpot, past], evenings, 30, SUNDAY);
    expect(plan.withdraw).toEqual([outside.id]);
    expect(plan.keptBooked).toBe(2);
    expect(plan.add).not.toContain(inside.startsAt);
    expect(plan.add).toHaveLength(95);
  });

  it("a kept time off the new grid blocks the new times it would overlap (the server refuses overlaps)", () => {
    const offGrid = slot(local(2026, 10, 2, 18, 15));                                 // Mon 6:15–6:45 pm
    const plan = planHoursChange([offGrid], evenings, 30, SUNDAY);
    expect(plan.withdraw).toEqual([]);
    expect(plan.add).not.toContain(local(2026, 10, 2, 18));
    expect(plan.add).not.toContain(local(2026, 10, 2, 18, 30));
    expect(plan.add).toContain(local(2026, 10, 2, 19));
    expect(plan.add).toHaveLength(94);
  });

  it("a booked time outside the hours still blocks overlapping new times", () => {
    const booked = slot(local(2026, 10, 2, 17, 45), 30, { taken: true });              // Mon 5:45–6:15 pm, booked
    const plan = planHoursChange([booked], evenings, 30, SUNDAY);
    expect(plan.withdraw).toEqual([]);
    expect(plan.keptBooked).toBe(1);
    expect(plan.add).not.toContain(local(2026, 10, 2, 18));
  });

  it("the same hours again change nothing", () => {
    const all = hoursStarts(evenings, 30, SUNDAY).map((s) => slot(s));
    expect(planHoursChange(all, evenings, 30, SUNDAY)).toEqual({ add: [], withdraw: [], keptBooked: 0 });
  });

  it("an offer from before flexible hours reopens with hours that hold all its times", () => {
    const slots = [slot(local(2026, 10, 2, 18)), slot(local(2026, 10, 2, 18, 30)), slot(local(2026, 10, 9, 20)), slot(local(2026, 10, 7, 10, 10), 45)];
    const h = hoursFromSlots(slots)!;
    expect(h).toEqual({ 1: [{ start: hm(18), end: hm(19) }, { start: hm(20), end: hm(20, 30) }], 6: [{ start: hm(10), end: hm(11) }] });
    expect(planHoursChange(slots, h, 30, SUNDAY).withdraw).toEqual([]);
    expect(hoursFromSlots([])).toBeNull();
  });
});
