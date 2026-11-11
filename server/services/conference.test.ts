/**
 * conference.test.ts — v7.2: conference names compare by their short form, and no school list decides
 * a tier. Pinned: the normaliser's three rules, and that the power list is matched after normalising.
 */

import { normalizeConference, POWER_CONFERENCES } from "./conference";

test("a parenthesised abbreviation wins, then a known full name, else the string as given", () => {
  expect(normalizeConference("Atlantic Coast Conference (ACC)")).toBe("ACC");
  expect(normalizeConference("Big Ten Conference")).toBe("Big Ten");
  expect(normalizeConference("  SEC ")).toBe("SEC");
  expect(normalizeConference("Girls Academy (GA)")).toBe("GA");
  expect(normalizeConference("Mountain West")).toBe("Mountain West");
  expect(normalizeConference("")).toBeNull();
  expect(normalizeConference(null)).toBeNull();
});

test("every long form of a power conference lands on the list", () => {
  for (const long of ["Atlantic Coast Conference (ACC)", "Southeastern Conference", "Big Ten Conference", "Big 12 Conference", "Pac-12 Conference", "Big East Conference"]) {
    expect((POWER_CONFERENCES as readonly string[]).includes(normalizeConference(long)!)).toBe(true);
  }
  expect((POWER_CONFERENCES as readonly string[]).includes(normalizeConference("Mountain West")!)).toBe(false);
});
