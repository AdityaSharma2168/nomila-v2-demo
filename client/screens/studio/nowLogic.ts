/**
 * nowLogic — how a deadline reads.
 *
 * A date is not urgency. "Due 6 Sep" makes her do the arithmetic; "2 days left" is the fact she
 * actually wanted, and "3 days late" is one she needs to see before anything else on the screen.
 */
import type { Deliverable } from "../../hooks/use-studio-pending";

const DAY = 24 * 60 * 60 * 1000;

/**
 * A DATE-ONLY string is a CALENDAR DAY. An ISO TIMESTAMP is an instant. Reading the first as the
 * second is a real, shipped, off-by-one — and `due_on` is exactly the column that triggers it.
 *
 * `new Date("2026-10-12")` is parsed as UTC midnight. Read back through the LOCAL getters below,
 * that is 11 Oct for every athlete west of Greenwich — so a deliverable due TODAY rendered
 * "1 day late", and one due in three days said two. Measured in America/Los_Angeles:
 *
 *     daysUntil("2026-10-12")  on 12 Oct  →  -1   →  "1 days late"     ← wrong
 *     daysUntil("2026-10-15")  on 12 Oct  →   2   →  "2 days left"     ← wrong, it is 3
 *
 * `deal_deliverables.due_on` is a DATE column and arrives as "YYYY-MM-DD" (Drizzle's `date()` is
 * PgDateString), so this is the common case rather than the edge one. The schema already knew:
 * `deals.term_end` carries the same warning — "midnight-UTC would render as the 30th for an
 * athlete on the US west coast".
 *
 * So a date-only string is constructed in LOCAL time, which makes it the same calendar day it
 * names, everywhere. A full timestamp keeps its existing meaning and its existing tests.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDay(iso: string): Date {
  const m = DATE_ONLY.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
}

/**
 * Whole days between today and a date, counted in local calendar days rather than elapsed hours —
 * something due tomorrow morning is "tomorrow", not "in 14 hours".
 */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const due = localDay(iso);
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / DAY);
}

/**
 * What the pill on a deliverable says.
 *
 * Optional work never gets a countdown: a deadline on something nobody is waiting for is manufactured
 * pressure, and it would sit in the same row as a real one.
 */
export function dueLabel(d: Deliverable, now: Date = new Date()): string {
  if (d.optional) return "Optional";
  if (!d.dueOn) return "No date";

  const days = daysUntil(d.dueOn, now);
  if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} late`;
  if (days === 0) return "Due today";
  if (days === 1) return "Tomorrow";
  if (days <= 14) return `${days} days left`;
  // localDay here too, and not as a tidy-up: `new Date(d.dueOn)` would print "Due 11 Oct" for a
  // date due on the 12th, which is the same bug one line lower down and just as visible.
  return `Due ${localDay(d.dueOn).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Late first, then soonest. Optional and undated work sinks — it is not competing for the same attention. */
export function byUrgency(a: Deliverable, b: Deliverable, now: Date = new Date()): number {
  const rank = (d: Deliverable) => {
    if (d.optional || !d.dueOn) return Number.MAX_SAFE_INTEGER;
    return daysUntil(d.dueOn, now);
  };
  return rank(a) - rank(b);
}
