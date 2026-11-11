/**
 * social/storiesSchedule.ts — the pure scheduling rules for Instagram Stories (Step 1b design
 * §4–5). No I/O. The database selection in stories.ts implements exactly `lastLookDue`.
 */

export const STORY_LIFE_HOURS = 24;
export const DEFAULT_STORY_SWEEP_HOURS = 8;
export const DEFAULT_STORY_LAST_LOOK_HOURS = 22;
const HOUR = 3_600_000;

/** The story_insights-family metrics whose presence at/after the last-look age proves a successful reading. `listed` never does. */
export const STORY_SUCCESS_METRICS = ["reach", "view_count"] as const;

/**
 * A Story is due for a last look when its age is in [lastLookHours, 24 h) and it has no
 * successful insight observation at or after entity_time + lastLookHours. A failed attempt
 * leaves it due for the next tick; expiry closes the window for good.
 */
export function lastLookDue(entityTimeMs: number, nowMs: number, successObservedAtMs: number[], lastLookHours = DEFAULT_STORY_LAST_LOOK_HOURS): boolean {
  const age = nowMs - entityTimeMs;
  if (age < lastLookHours * HOUR || age >= STORY_LIFE_HOURS * HOUR) return false;
  const threshold = entityTimeMs + lastLookHours * HOUR;
  return !successObservedAtMs.some((t) => t >= threshold);
}

/** A Story whose 24 hours have passed is closed: its latest successful observation is final. */
export function storyClosed(entityTimeMs: number, asOfMs: number): boolean {
  return entityTimeMs + STORY_LIFE_HOURS * HOUR < asOfMs;
}

/**
 * Design §5 model, a LABELLED ASSUMPTION: views accrue like an exponential with half-life h,
 * so the amount accumulated by age x is proportional to 1 − 2^(−x/h). The share of the full
 * 24-hour total that arrives in the last `tailHours` is
 *   (2^(−(24−t)/h) − 2^(−24/h)) / (1 − 2^(−24/h)).
 * Used only to size the blind spot; the first month of real observations replaces it.
 */
export function tailShare(tailHours: number, halfLifeHours: number): number {
  const L = STORY_LIFE_HOURS;
  const total = 1 - 2 ** (-L / halfLifeHours);
  return (2 ** (-(L - tailHours) / halfLifeHours) - 2 ** (-L / halfLifeHours)) / total;
}
