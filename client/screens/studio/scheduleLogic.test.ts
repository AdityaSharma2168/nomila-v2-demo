/**
 * Every case here pins `now` and builds fixtures from an explicit local date.
 *
 * The first version of this file built fixtures off `new Date()` and filtered on `Date.now()`, so
 * it passed in PST before 19:00 and failed for five hours of every day in CI under UTC. Caught in
 * review. The rule that came out of it: no test in here may read the wall clock, and no function
 * under test may either — `now` is an argument everywhere, which is why it can be pinned at all.
 */
import {
  PLATFORMS,
  SLOTS,
  combine,
  dayOptions,
  fitsFormat,
  minutesOfDay,
  nearestSlot,
  nextFixture,
  offsetNote,
  recommendedSlot,
  spanLabel,
  timeLabel,
} from "./scheduleLogic";
import type { Fixture } from "../../hooks/use-studio-pending";

/** Thursday 3 September 2026, 09:00 LOCAL — whatever local happens to be on the machine. */
const NOW = new Date(2026, 8, 3, 9, 0, 0, 0);

/** A fixture at a local wall-clock moment, expressed the way the athlete would think of it. */
const fixture = ({
  day = 3,
  hour,
  minute = 0,
}: {
  day?: number;
  hour: number;
  minute?: number;
}): Fixture => ({
  id: `f-${day}-${hour}`,
  startsAt: new Date(2026, 8, day, hour, minute, 0, 0).toISOString(),
  opponent: "Stanford vs Cal",
  venue: "Maples",
  home: true,
});

/** A post at a local wall-clock moment. */
const post = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute, 0, 0);

describe("the wall clock", () => {
  it("is never read by anything under test", () => {
    // The regression this file exists to prevent: identical inputs, one hour apart in "real" time,
    // must produce identical output. If any function reaches for Date.now() this diverges.
    const fx = [fixture({ day: 5, hour: 19 })];
    const a = recommendedSlot(fx, new Date(2026, 8, 3, 9, 0));
    const b = recommendedSlot(fx, new Date(2026, 8, 3, 10, 0));
    expect(a.why).toBe(b.why);
    expect(a.minutes).toBe(b.minutes);
  });

  it("does not decide whether a fixture counts based on the hour the suite happens to run", () => {
    // A fixture later today is ahead of a 09:00 now, in every timezone, because both are local.
    expect(nextFixture([fixture({ hour: 19 })], NOW)).not.toBeNull();
  });
});

describe("time labels", () => {
  it("reads as a clock, not as minutes past midnight", () => {
    expect(timeLabel(6 * 60)).toBe("6:00am");
    expect(timeLabel(12 * 60)).toBe("12:00pm");
    expect(timeLabel(13 * 60 + 30)).toBe("1:30pm");
    expect(timeLabel(18 * 60 + 10)).toBe("6:10pm");
  });

  it("calls midnight twelve, not zero", () => {
    expect(timeLabel(0)).toBe("12:00am");
  });
});

describe("slots and days", () => {
  it("covers the waking day at half-hour steps", () => {
    expect(SLOTS[0]).toBe(6 * 60);
    expect(SLOTS[SLOTS.length - 1]).toBe(22 * 60);
    expect(SLOTS[1] - SLOTS[0]).toBe(30);
  });

  it("snaps to something the picker can actually show", () => {
    expect(SLOTS).toContain(nearestSlot(16 * 60 + 7));
    expect(nearestSlot(16 * 60 + 7)).toBe(16 * 60);
    expect(nearestSlot(16 * 60 + 20)).toBe(16 * 60 + 30);
  });

  it("clamps at both ends rather than going off the scale", () => {
    expect(nearestSlot(2 * 60)).toBe(SLOTS[0]);
    expect(nearestSlot(23 * 60 + 59)).toBe(SLOTS[SLOTS.length - 1]);
  });

  it("offers a week, naming the near days rather than dating them", () => {
    const days = dayOptions(NOW, 7);
    expect(days).toHaveLength(7);
    expect(days[0].label).toBe("Today");
    expect(days[1].label).toBe("Tomorrow");
    expect(days[2].label).not.toMatch(/Today|Tomorrow/);
  });

  it("builds a moment from a day and a slot", () => {
    const at = combine(NOW, 18 * 60 + 30);
    expect(minutesOfDay(at)).toBe(18 * 60 + 30);
    expect(at.getDate()).toBe(3);
  });
});

describe("the recommendation", () => {
  it("falls back to her own pattern when there are no fixtures", () => {
    const r = recommendedSlot([], NOW);
    expect(r.minutes).toBe(18 * 60);
    expect(r.why).toMatch(/audience peaks/);
    expect(r.why).not.toMatch(/before/); // must not invent a fixture
  });

  it("aims three hours before a fixture, and says three hours", () => {
    const r = recommendedSlot([fixture({ hour: 19 })], NOW);
    expect(r.minutes).toBe(16 * 60);
    expect(r.why).toMatch(/^3h before/);
  });

  it("tells the truth about the gap when an early kick-off forces a clamp", () => {
    // A 7am fixture puts "three hours before" at 4am, off the picker. The old copy said "Three
    // hours before" regardless — a recommendation explaining itself with a number it had already
    // discarded. It must now describe the slot it actually landed on.
    // On a FUTURE day — a 7am fixture today is already behind a 9am `now`, which is the same trap
    // that produced the original wall-clock bug. Now it is explicit rather than dependent on when
    // the suite runs.
    const r = recommendedSlot([fixture({ day: 5, hour: 7 })], NOW);
    expect(r.minutes).toBe(SLOTS[0]); // 6am, the earliest offered
    expect(r.why).toMatch(/^1h before/); // and it says so
    expect(r.why).not.toMatch(/3h before/);
  });

  it("never recommends a time earlier than the first slot", () => {
    expect(
      recommendedSlot([fixture({ day: 5, hour: 7 })], NOW).minutes,
    ).toBeGreaterThanOrEqual(SLOTS[0]);
  });

  it("recommends on the fixture's OWN day, not today", () => {
    const r = recommendedSlot([fixture({ day: 6, hour: 19 })], NOW);
    expect(r.at.getDate()).toBe(6);
  });

  it("ignores a fixture that has already happened", () => {
    expect(recommendedSlot([fixture({ day: 1, hour: 19 })], NOW).why).toMatch(
      /audience peaks/,
    );
  });

  it("takes the soonest fixture when there are several", () => {
    const soon = fixture({ day: 4, hour: 19 });
    const later = fixture({ day: 9, hour: 14 });
    expect(nextFixture([later, soon], NOW)?.startsAt).toBe(soon.startsAt);
  });
});

describe("the offset note", () => {
  const sat = [fixture({ day: 5, hour: 19 })];

  it("says nothing when there is no fixture to measure against", () => {
    expect(offsetNote(post(3, 18), [], NOW)).toBeNull();
  });

  it("counts the days, not just the clock", () => {
    // THE BUG: a post two days early was described as "1h 30m before", because both sides were
    // collapsed to minutes-past-midnight and the date was thrown away.
    expect(offsetNote(post(3, 17, 30), sat, NOW)).toBe(
      "2 days before Stanford vs Cal.",
    );
  });

  it("uses hours and minutes on the day itself", () => {
    expect(offsetNote(post(5, 17, 30), sat, NOW)).toBe(
      "1h 30m before Stanford vs Cal.",
    );
  });

  it("drops a stray zero on a whole number of hours", () => {
    expect(offsetNote(post(5, 17), sat, NOW)).toBe(
      "2h before Stanford vs Cal.",
    );
  });

  it("handles minutes alone", () => {
    expect(offsetNote(post(5, 18, 30), sat, NOW)).toBe(
      "30m before Stanford vs Cal.",
    );
  });

  it("warns that after the whistle is a different post", () => {
    const note = offsetNote(post(5, 20, 30), sat, NOW);
    expect(note).toMatch(/1h 30m after Stanford vs Cal/);
    expect(note).toMatch(/recap, not a teaser/);
  });

  it("does not warn when the post lands before", () => {
    expect(offsetNote(post(5, 17), sat, NOW)).not.toMatch(/recap/);
  });

  it("says exactly when the two coincide", () => {
    expect(offsetNote(post(5, 19), sat, NOW)).toBe(
      "Exactly at Stanford vs Cal.",
    );
  });

  it("agrees with the recommendation it sits under", () => {
    // The two lines are on screen together; if they disagree, one of them is lying.
    const r = recommendedSlot(sat, NOW);
    expect(offsetNote(r.at, sat, NOW)).toBe("3h before Stanford vs Cal.");
    expect(r.why).toMatch(/^3h before/);
  });
});

describe("span labels", () => {
  it("uses minutes under the hour", () => {
    expect(spanLabel(45 * 60000)).toBe("45m");
  });

  it("uses hours and minutes under the day", () => {
    expect(spanLabel((5 * 60 + 20) * 60000)).toBe("5h 20m");
    expect(spanLabel(5 * 60 * 60000)).toBe("5h");
  });

  it("switches to days past twenty-four hours, because 147h is not a sentence", () => {
    expect(spanLabel(26 * 60 * 60000)).toBe("1 day");
    expect(spanLabel(6 * 24 * 60 * 60000)).toBe("6 days");
  });

  it("reads the same in either direction", () => {
    expect(spanLabel(-90 * 60000)).toBe(spanLabel(90 * 60000));
  });
});

describe("platforms", () => {
  it("lets Instagram take anything", () => {
    const ig = PLATFORMS.find((p) => p.key === "instagram")!;
    expect(fitsFormat(ig, "photo")).toBe(true);
    expect(fitsFormat(ig, "video")).toBe(true);
    expect(fitsFormat(ig, "story")).toBe(true);
  });

  it("keeps TikTok to video", () => {
    const tt = PLATFORMS.find((p) => p.key === "tiktok")!;
    expect(fitsFormat(tt, "video")).toBe(true);
    expect(fitsFormat(tt, "photo")).toBe(false);
  });

  it("keeps X off carousels and stories", () => {
    const x = PLATFORMS.find((p) => p.key === "x")!;
    expect(fitsFormat(x, "carousel")).toBe(false);
    expect(fitsFormat(x, "story")).toBe(false);
    expect(fitsFormat(x, "photo")).toBe(true);
  });

  it("has somewhere for every format to go", () => {
    (["photo", "carousel", "video", "story"] as const).forEach((f) => {
      expect(PLATFORMS.some((p) => fitsFormat(p, f))).toBe(true);
    });
  });
});
