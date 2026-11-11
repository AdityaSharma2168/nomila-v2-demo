/**
 * agent/moments/facts.ts — what a moment is in memory, and when two are the same one. Pure functions, no database.
 *
 * The one moments store (design "Moments → post kits" §2) is memory_facts itself: a moment is a dated event fact
 * (subject_kind "event", topic "moment", observed_on its date). Research seeds it once at onboarding; the weekly moments
 * scan (scan.ts) refreshes, de-duplicates and retires it; every other step only reads it — the plan's DATED EVENTS and
 * its daily sweep, Home's "Coming up", the chat context and the Brief's timing section.
 *
 * Same moment = the same normalised name (lower case, accents and punctuation out, then a loose containment match, the
 * rule services/mediaSearch.ts normalizeBrandName / brandNamesMatch uses for brand names) AND the same date at the
 * coarser of the two precisions (the same day; the same month when either is month-only; the same year when either is
 * year-only).
 */
import type { DatePrecision, MemoryFact } from "../../../shared/agent";

/**
 * The last day a stored date stands for: the day itself, the month's last day ("2026-10" is stored as 2026-10-01 and
 * runs to the 31st), or the year's. A moment is still upcoming while this is today or later.
 */
export function periodEnd(date: string, precision: DatePrecision | null | undefined): string {
  if (precision === "year") return `${date.slice(0, 4)}-12-31`;
  if (precision === "month") {
    const [y, m] = date.slice(0, 7).split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  return date.slice(0, 10);
}

/** A dated fact that has not ended by `today` (its period runs to today or later). */
export const notEnded = (f: Pick<MemoryFact, "date" | "datePrecision">, today: string): boolean => !!f.date && periodEnd(f.date, f.datePrecision) >= today;

/** The research topics a dated event fact may be filed under: "moment" (research 1.11.0 on) and "upcoming" (before). */
export const EVENT_TOPICS = ["moment", "upcoming"] as const;

/**
 * A dated upcoming event fact: about an event, or filed as a moment or as upcoming, with a date, active or disputed.
 * The predicate the plan's DATED EVENTS, its daily sweep and Home's "Coming up" all read.
 */
export function isEventFact(f: Pick<MemoryFact, "date" | "topic" | "subject" | "status">): boolean {
  // A result they told us about an event (topic "result", milaCards/outcomes.ts) is about the event, not an event itself.
  if (f.topic === "result") return false;
  return !!f.date && ((EVENT_TOPICS as readonly string[]).includes(f.topic ?? "") || f.subject.kind === "event") && (f.status === "active" || f.status === "disputed");
}

/** A moment's name, normalised for matching: lower case, accents and punctuation out, single spaces. */
export function normalizeMomentName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Two names for the same moment: equal once normalised, or one contains the other (each at least 3 characters). */
export function momentNamesMatch(a: string, b: string): boolean {
  const na = normalizeMomentName(a);
  const nb = normalizeMomentName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na));
}

/** Two stored dates for the same moment, compared at the coarser precision (null precision = a day). */
export function momentDatesMatch(a: { date: string; precision: DatePrecision | null | undefined }, b: { date: string; precision: DatePrecision | null | undefined }): boolean {
  const pa = a.precision ?? "day";
  const pb = b.precision ?? "day";
  if (pa === "year" || pb === "year") return a.date.slice(0, 4) === b.date.slice(0, 4);
  if (pa === "month" || pb === "month") return a.date.slice(0, 7) === b.date.slice(0, 7);
  return a.date.slice(0, 10) === b.date.slice(0, 10);
}

/** The name a moment goes by: the event's subject name when it is an event fact, else its claim. */
export function momentNameOf(f: Pick<MemoryFact, "subject" | "claim">): string {
  return f.subject.kind === "event" && f.subject.name.trim() ? f.subject.name : f.claim;
}

/** The first stored moment that is the same moment as this candidate (date + normalised name), if any. */
export function findSameMoment<T extends Pick<MemoryFact, "subject" | "claim" | "date" | "datePrecision">>(
  candidate: { name: string; date: string; precision: DatePrecision },
  stored: readonly T[],
): T | null {
  return stored.find((f) => !!f.date
    && momentDatesMatch({ date: candidate.date, precision: candidate.precision }, { date: f.date, precision: f.datePrecision })
    && momentNamesMatch(candidate.name, momentNameOf(f))) ?? null;
}
