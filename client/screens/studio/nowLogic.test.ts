/**
 * TZ IS PINNED, AND THAT IS THE POINT OF HALF THIS FILE.
 *
 * The date-only off-by-one below only manifests WEST of Greenwich: `new Date("2026-10-12")` is UTC
 * midnight, so in UTC it reads back as the 12th and every assertion passes whether the bug is
 * present or not. A test that cannot fail on CI is not a test. Set before any import so no Date has
 * been constructed yet.
 */
process.env.TZ = "America/Los_Angeles";

import { byUrgency, daysUntil, dueLabel, localDay } from "./nowLogic";
import type { Deliverable } from "../../hooks/use-studio-pending";

const NOW = new Date("2026-09-03T09:00:00");
const on = (iso: string | null, optional = false): Deliverable => ({
  id: iso ?? "none",
  dealId: null,
  brandId: 1,
  brandName: "gorjana",
  campaign: "Coastal Capsule",
  format: "Reel · 9:16",
  dueOn: iso,
  optional,
  delivered: 2,
  total: 3,
});

describe("counting days", () => {
  it("counts calendar days, not elapsed hours", () => {
    // Due tomorrow morning is "tomorrow", not "in 14 hours".
    expect(daysUntil("2026-09-04T08:00:00", NOW)).toBe(1);
    expect(daysUntil("2026-09-03T23:00:00", NOW)).toBe(0);
  });

  it("goes negative once the date has passed", () => {
    expect(daysUntil("2026-08-31T12:00:00", NOW)).toBe(-3);
  });
});

describe("the due pill", () => {
  it("leads with lateness", () => {
    expect(dueLabel(on("2026-08-31T12:00:00"), NOW)).toBe("3 days late");
  });

  it("says a day, singular, when it is one", () => {
    expect(dueLabel(on("2026-09-02T12:00:00"), NOW)).toBe("1 day late");
  });

  it("names today and tomorrow rather than counting them", () => {
    expect(dueLabel(on("2026-09-03T18:00:00"), NOW)).toBe("Due today");
    expect(dueLabel(on("2026-09-04T09:00:00"), NOW)).toBe("Tomorrow");
  });

  it("counts down inside a fortnight", () => {
    expect(dueLabel(on("2026-09-08T09:00:00"), NOW)).toBe("5 days left");
  });

  it("falls back to a date once a countdown stops meaning anything", () => {
    // "78 days left" is not urgency, it is arithmetic nobody asked for.
    expect(dueLabel(on("2026-11-20T09:00:00"), NOW)).toMatch(/^Due /);
  });

  it("never puts a countdown on optional work", () => {
    // A deadline on something nobody is waiting for is manufactured pressure.
    expect(dueLabel(on("2026-09-04T09:00:00", true), NOW)).toBe("Optional");
  });

  it("says so plainly when there is no date at all", () => {
    expect(dueLabel(on(null), NOW)).toBe("No date");
  });
});

describe("urgency order", () => {
  it("puts late work above work merely due", () => {
    const late = on("2026-08-30T09:00:00");
    const soon = on("2026-09-05T09:00:00");
    expect([soon, late].sort((a, b) => byUrgency(a, b, NOW))[0]).toBe(late);
  });

  it("sinks optional and undated work below everything with a real date", () => {
    const opt = on("2026-09-04T09:00:00", true);
    const none = on(null);
    const real = on("2026-11-01T09:00:00");
    const sorted = [opt, none, real].sort((a, b) => byUrgency(a, b, NOW));
    expect(sorted[0]).toBe(real);
  });

  it("orders two real dates soonest first", () => {
    const a = on("2026-09-05T09:00:00");
    const b = on("2026-09-04T09:00:00");
    expect([a, b].sort((x, y) => byUrgency(x, y, NOW))[0]).toBe(b);
  });
});

/**
 * ─── DATE-ONLY STRINGS ARE CALENDAR DAYS ────────────────────────────────────────────────────────
 *
 * `deal_deliverables.due_on` is a DATE column and arrives as "YYYY-MM-DD". Parsed as an instant it
 * lands a day early for anyone west of Greenwich, which put "1 days late" on work that was due
 * today. Every case here fails against the old implementation in this timezone.
 */
describe("a date-only due_on is the day it names", () => {
  // 12 Oct 2026, 09:00 LOCAL. Nothing here uses a UTC constructor on purpose.
  const OCT12 = new Date(2026, 9, 12, 9, 0, 0);

  it("reads today as today, not as yesterday", () => {
    expect(daysUntil("2026-10-12", OCT12)).toBe(0);
    expect(dueLabel(on("2026-10-12"), OCT12)).toBe("Due today");
  });

  it("counts forward correctly", () => {
    expect(daysUntil("2026-10-13", OCT12)).toBe(1);
    expect(daysUntil("2026-10-15", OCT12)).toBe(3);
    expect(dueLabel(on("2026-10-13"), OCT12)).toBe("Tomorrow");
    expect(dueLabel(on("2026-10-15"), OCT12)).toBe("3 days left");
  });

  it("counts backward correctly", () => {
    expect(daysUntil("2026-10-11", OCT12)).toBe(-1);
    expect(dueLabel(on("2026-10-11"), OCT12)).toBe("1 day late");
  });

  it("prints the date it was given, not the day before", () => {
    // The second half of the same bug: dueLabel's far-future branch had its own `new Date(dueOn)`.
    // Asserted on the DAY NUMBER rather than the whole string: the order of day and month is the
    // runtime locale's business, and pinning it here would make this a test of Intl, not of us.
    const label = dueLabel(on("2026-11-20"), OCT12);
    expect(label).toMatch(/\b20\b/);
    expect(label).not.toMatch(/\b19\b/);
  });

  it("leaves a full timestamp alone", () => {
    // localDay only special-cases the date-only shape; an instant keeps its existing meaning.
    expect(localDay("2026-10-12T08:00:00").getDate()).toBe(12);
    expect(daysUntil("2026-10-13T08:00:00", OCT12)).toBe(1);
  });

  it("orders a date-only deadline against a timestamp one correctly", () => {
    // byUrgency shares daysUntil, so the fix has to hold through it too.
    const dateOnly = on("2026-10-13");
    const later = on("2026-10-20T09:00:00");
    expect(byUrgency(dateOnly, later, OCT12)).toBeLessThan(0);
  });
});
