/**
 * webSearchLimiter.ts — per-athlete rate limit for web-search grounding (spike).
 *
 * A simple in-memory sliding window keyed by athleteId, sitting ONLY in front of
 * grounded queries — never the loop as a whole. The agent loop peeks `allow()`
 * before enabling grounding for a turn and `record()`s afterward ONLY when the
 * turn actually grounded, so ordinary internal-tool turns never spend budget.
 * Over the limit → the loop skips grounding and answers from internal tools; it
 * never hard-fails the turn.
 *
 * SPIKE SCOPE: the window lives in this process's memory, so the cap is PER CLOUD
 * RUN INSTANCE, not global — an athlete spread across N instances effectively gets
 * ~N× the budget. A real distributed limit needs a shared store (Redis / Memory-
 * store). Flagged as a follow-up; fine for a single-instance / flagged spike.
 */

import { MILA } from "./config";

export interface WebSearchLimiter {
  /** May this athlete ground another query right now? Peek — does NOT consume. */
  allow(athleteId: string): boolean;
  /** Record one grounded query for this athlete (consume a window slot). */
  record(athleteId: string): void;
}

export interface WebSearchLimiterOptions {
  /** Max grounded calls per window. */
  max: number;
  /** Sliding-window length in ms. */
  windowMs: number;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

/**
 * Build a sliding-window limiter. `max`/`windowMs` are read live off `opts` on
 * every call, so the process singleton below can back them with config getters
 * and pick up env tuning without being reconstructed.
 */
export function createWebSearchLimiter(
  opts: WebSearchLimiterOptions,
): WebSearchLimiter {
  const hits = new Map<string, number[]>();
  const clock = opts.now ?? (() => Date.now());

  // Drop timestamps older than the window and delete empty buckets, so the map
  // only retains athletes active within the last window (bounded per-instance).
  const fresh = (athleteId: string): number[] => {
    const cutoff = clock() - opts.windowMs;
    const kept = (hits.get(athleteId) ?? []).filter((t) => t > cutoff);
    if (kept.length) hits.set(athleteId, kept);
    else hits.delete(athleteId);
    return kept;
  };

  return {
    allow: (athleteId) => fresh(athleteId).length < opts.max,
    record: (athleteId) => {
      const kept = fresh(athleteId);
      kept.push(clock());
      hits.set(athleteId, kept);
    },
  };
}

/**
 * Process-wide singleton the agent loop uses. Config is read live (getters) so
 * MILA_WEB_SEARCH_MAX / _WINDOW_MS tuning takes effect without reconstruction.
 */
export const webSearchLimiter = createWebSearchLimiter({
  get max() {
    return MILA.WEB_SEARCH_MAX_PER_WINDOW;
  },
  get windowMs() {
    return MILA.WEB_SEARCH_WINDOW_MS;
  },
});
