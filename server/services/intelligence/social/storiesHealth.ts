/**
 * storiesHealth.ts — pure decision: is an empty Story list quiet, or blindness?
 *
 * Kept free of database imports so it can be unit-tested directly, the same way storiesSchedule.ts is.
 */

/**
 * Story collection health — is an empty Story list the athlete posting nothing, or us being unable to see it?
 *
 * Those two states are otherwise indistinguishable: both close a sweep as `status: "ok"` with `items: 0`. That cost
 * five days once — Step 1b was recorded as "waiting for the athlete's first Story" while fourteen consecutive sweeps
 * returned `{"data": []}` for an account that had posted to feed and shared it to Story. Nothing in the system could
 * tell the difference, so nobody looked.
 *
 * The signal is the conjunction: consecutive empty sweeps AND feed activity inside the same window. An athlete who
 * posts nothing at all is quiet, not broken; an athlete who is posting to feed and never appears to post a Story is
 * either genuinely a non-Story user or invisible to us — and that is worth a human glance either way.
 *
 * Read-only. Never fails a sweep; a health check that breaks collection is worse than the gap it reports.
 */
export interface StoryCollectionHealth {
  consecutiveEmptySweeps: number;
  lastFeedContentAt: string | null;
  feedActivityInsideEmptyWindow: boolean;
  suspect: boolean;
}

/** Consecutive empty sweeps before we call it suspect. Eight-hourly sweeps, so 6 is about two days. */
export const STORY_EMPTY_SWEEP_THRESHOLD = 6;

/** The decision, separated from the queries so it is testable without a database. Newest run first. */
export function assessStoryCollection(
  runs: ReadonlyArray<{ items: number | null; startedAt: Date | string | null; status: string | null }>,
  lastFeedContentAt: string | null,
  threshold = STORY_EMPTY_SWEEP_THRESHOLD,
): StoryCollectionHealth {
  let consecutiveEmptySweeps = 0;
  for (const r of runs) {
    if (r.status === "failed") break;          // a failure is already visible; it is not silence
    if ((r.items ?? 0) > 0) break;
    consecutiveEmptySweeps += 1;
  }
  const oldestEmpty = consecutiveEmptySweeps > 0 ? runs[consecutiveEmptySweeps - 1]?.startedAt ?? null : null;
  const windowStart = oldestEmpty ? new Date(oldestEmpty) : null;
  const feedActivityInsideEmptyWindow = !!(lastFeedContentAt && windowStart && new Date(lastFeedContentAt) >= windowStart);
  return {
    consecutiveEmptySweeps,
    lastFeedContentAt,
    feedActivityInsideEmptyWindow,
    suspect: consecutiveEmptySweeps >= threshold && feedActivityInsideEmptyWindow,
  };
}

