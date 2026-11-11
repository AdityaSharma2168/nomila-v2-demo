/**
 * facts.test.ts — the one moments store's predicates (pure functions, no database, no model).
 *
 *   F1 isEventFact: a dated fact about an event, or filed under topic "moment" (research 1.11.0) or "upcoming" (before),
 *      active or disputed; nothing undated, superseded or removed
 *   F2 names: lower case, accents and punctuation out; equal, or one inside the other (each ≥ 3 characters)
 *   F3 dates: the same day; the same month when either is month-only; the same year when either is year-only
 *   F4 findSameMoment: date AND name; the event's subject name, else the claim
 */
import type { MemoryFact } from "../../../shared/agent";
import { findSameMoment, isEventFact, momentDatesMatch, momentNameOf, momentNamesMatch, normalizeMomentName } from "./facts";

const fact = (over: Partial<MemoryFact>): MemoryFact => ({
  id: "f", athleteId: "a", subject: { kind: "event", name: "Home opener" }, claim: "The home opener.", type: "found", source: { url: "https://example.org/x" },
  date: "2026-10-18", confidence: 0.9, status: "active", supersededBy: null, runId: null, createdAt: "2026-10-01T00:00:00.000Z",
  disputes: null, alsoSeenAt: [], sensitive: false, careKind: null, topic: "moment", sourceType: null, datePrecision: null, field: null, fieldValue: null,
  ...over,
});

test("F1: isEventFact — dated, about an event or filed as a moment / upcoming, active or disputed", () => {
  expect(isEventFact(fact({}))).toBe(true);
  expect(isEventFact(fact({ subject: { kind: "athlete", name: "Pat" }, topic: "moment" }))).toBe(true);     // hardened: topic moment
  expect(isEventFact(fact({ subject: { kind: "athlete", name: "Pat" }, topic: "upcoming" }))).toBe(true);
  expect(isEventFact(fact({ subject: { kind: "event", name: "Final" }, topic: "competition" }))).toBe(true);  // about an event
  expect(isEventFact(fact({ subject: { kind: "athlete", name: "Pat" }, topic: "career" }))).toBe(false);
  expect(isEventFact(fact({ date: null }))).toBe(false);
  expect(isEventFact(fact({ status: "disputed" }))).toBe(true);
  for (const status of ["superseded", "removed"] as const) expect(isEventFact(fact({ status }))).toBe(false);
});

test("F2: names match once normalised, or when one holds the other", () => {
  expect(normalizeMomentName("  Conférence Home-Opener!! ")).toBe("conference home opener");
  expect(momentNamesMatch("Home opener", "home-opener")).toBe(true);
  expect(momentNamesMatch("Home opener", "Conference home opener")).toBe(true);
  expect(momentNamesMatch("Home opener", "Season finale")).toBe(false);
  expect(momentNamesMatch("Hi", "Hi there")).toBe(false);                              // too short to contain-match
  expect(momentNamesMatch("Hi", "hi")).toBe(true);
  expect(momentNamesMatch("", "x")).toBe(false);
});

test("F3: dates match at the coarser precision", () => {
  const d = (date: string, precision: "day" | "month" | "year" | null = "day") => ({ date, precision });
  expect(momentDatesMatch(d("2026-10-18"), d("2026-10-18"))).toBe(true);
  expect(momentDatesMatch(d("2026-10-18"), d("2026-10-19"))).toBe(false);
  expect(momentDatesMatch(d("2026-10-18", null), d("2026-10-18"))).toBe(true);        // null precision = a day
  expect(momentDatesMatch(d("2026-10-01", "month"), d("2026-10-18"))).toBe(true);
  expect(momentDatesMatch(d("2026-10-01", "month"), d("2026-11-02"))).toBe(false);
  expect(momentDatesMatch(d("2026-01-01", "year"), d("2026-10-18"))).toBe(true);
  expect(momentDatesMatch(d("2026-01-01", "year"), d("2027-01-02"))).toBe(false);
});

test("F4: findSameMoment needs the date AND the name; it reads the event's name, else the claim", () => {
  const opener = fact({ id: "o", subject: { kind: "event", name: "Home opener" }, date: "2026-10-18" });
  const finale = fact({ id: "f2", subject: { kind: "event", name: "Season finale" }, date: "2026-11-20" });
  const aboutHer = fact({ id: "h", subject: { kind: "athlete", name: "Pat Example" }, claim: "Signing day", date: "2026-11-05", topic: "upcoming" });
  expect(momentNameOf(aboutHer)).toBe("Signing day");
  expect(findSameMoment({ name: "Conference home opener", date: "2026-10-18", precision: "day" }, [finale, opener])?.id).toBe("o");
  expect(findSameMoment({ name: "Home opener", date: "2026-10-25", precision: "day" }, [opener])).toBeNull();     // another date
  expect(findSameMoment({ name: "Home opener", date: "2026-10-01", precision: "month" }, [opener])?.id).toBe("o"); // the month holds it
  expect(findSameMoment({ name: "Signing day", date: "2026-11-05", precision: "day" }, [aboutHer])?.id).toBe("h");
  expect(findSameMoment({ name: "Season finale", date: "2026-11-20", precision: "day" }, [fact({ id: "u", date: null, subject: { kind: "event", name: "Season finale" } })])).toBeNull();
});
