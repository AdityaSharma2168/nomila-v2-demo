/**
 * dealRanking.ts — deterministic, server-authoritative Brief ranking (WS3 §3.7).
 *
 * The Brief's "top asks" order must be decided on the server, not guessed by the
 * client's score-sort (`use-deals.ts`), so every surface agrees on what matters
 * most. These functions are dependency-free (no db, no LLM) and take an injectable
 * `now` so they're trivially unit-testable and give the same answer on server or
 * client.
 *
 * Rank signals, in descending weight (spec §3.7; the deal score that used to sit
 * between deadline and freshness is gone — inbox_threads.score dropped in 0088):
 *   1. awaiting-athlete — you OWE a reply. Dominant: debt sits at the top of the Brief.
 *   2. deadline proximity — a nearer (or overdue) deadline outranks a far one.
 *   3. freshness (thread age) — recent activity breaks ties above a fossil.
 */

export interface DealRankInput {
  /** conversation_state.key_details.awaiting_response_from */
  awaitingResponseFrom?: string | null;
  /** classification.deadline — ISO date/timestamp, or null. */
  deadline?: string | null;
  /** inbox_threads.last_message_at — the last activity on the thread. */
  lastMessageAt?: string | Date | null;
  /** deals.detected_at — fallback age anchor when there's no message timestamp. */
  detectedAt?: string | Date | null;
}

const DAY_MS = 86_400_000;

function toDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Whole days since the thread last saw activity (`last_message_at`, falling back to
 * `detected_at`). This is STALENESS — a live deal is small, a fossil is large.
 * Returns null when there's no timestamp to anchor on. Never negative.
 */
export function threadAgeDays(input: DealRankInput, now: Date = new Date()): number | null {
  const anchor = toDate(input.lastMessageAt) ?? toDate(input.detectedAt);
  if (!anchor) return null;
  return Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / DAY_MS));
}

// ── component sub-scores (each bounded so the weighting order is stable) ──

/** 1000 when the athlete owes the reply; 0 otherwise. The dominant Brief signal. */
function awaitingComponent(awaiting: string | null | undefined): number {
  return awaiting === "athlete" ? 1000 : 0;
}

// A deadline that's just passed is still act-now urgent (she might still catch it);
// but once it's well past, the window has closed — the deal is likely dead, so it must
// DEPRIORITIZE, not stay pinned to the top. (Bug fixed: `daysUntil <= 0 → 500` boosted
// months-old / past-event deals — e.g. a "World Cup" campaign — as if due today.)
const DEADLINE_GRACE_DAYS  = 3;   // overdue within this → still maximally urgent
export const DEADLINE_EXPIRE_DAYS = 21; // overdue beyond this → window closed (0 urgency, "expired")

/**
 * 0..500 by deadline proximity, honest about the past:
 *  - upcoming (≤30d out): ramps 500 (imminent) → 0 (30d away).
 *  - just overdue (≤GRACE): 500 — act now.
 *  - overdue GRACE..EXPIRE: ramps 500 → 0 as the window closes.
 *  - overdue > EXPIRE, or no deadline: 0.
 */
function deadlineComponent(deadline: string | null | undefined, now: Date): number {
  const d = toDate(deadline ?? null);
  if (!d) return 0;
  const daysUntil = (d.getTime() - now.getTime()) / DAY_MS;
  if (daysUntil > 0) return Math.round(500 * clamp((30 - daysUntil) / 30, 0, 1)); // upcoming
  const overdue = -daysUntil;
  if (overdue <= DEADLINE_GRACE_DAYS) return 500; // just missed — still act now
  // Ramp down to 0 as the window closes; past EXPIRE, it's dead weight.
  return Math.round(500 * clamp((DEADLINE_EXPIRE_DAYS - overdue) / (DEADLINE_EXPIRE_DAYS - DEADLINE_GRACE_DAYS), 0, 1));
}

/** True once a deadline is well past (window closed) — the UI can show "Expired" and
 *  the Brief can drop it from "needs you". Null/absent/future/just-overdue → false. */
export function isDeadlineExpired(deadline: string | null | undefined, now: Date = new Date()): boolean {
  const d = toDate(deadline ?? null);
  if (!d) return false;
  const overdue = (now.getTime() - d.getTime()) / DAY_MS;
  return overdue > DEADLINE_EXPIRE_DAYS;
}

/** 0..50 recency tiebreak: today → 50, ramps to 0 by 14 days stale; unknown → 0. */
function freshnessComponent(ageDays: number | null): number {
  if (ageDays == null) return 0;
  return Math.round(50 * clamp((14 - ageDays) / 14, 0, 1));
}

/**
 * The composite rank score for a deal. Higher = higher in the Brief. Deterministic:
 * the same inputs always yield the same number, and the component bounds guarantee
 * the signal priority (awaiting ≫ deadline ≫ freshness).
 */
export function computeDealRank(input: DealRankInput, now: Date = new Date()): number {
  const ageDays = threadAgeDays(input, now);
  return (
    awaitingComponent(input.awaitingResponseFrom) +
    deadlineComponent(input.deadline, now) +
    freshnessComponent(ageDays)
  );
}

/**
 * Stable descending sort by rank. Ties (identical rank) fall back to fresher-first,
 * then id, so the order is total and reproducible across requests.
 */
export function compareByRank<T extends DealRankInput & { id?: string }>(
  a: T,
  b: T,
  now: Date = new Date(),
): number {
  const ra = computeDealRank(a, now);
  const rb = computeDealRank(b, now);
  if (rb !== ra) return rb - ra;
  const aa = threadAgeDays(a, now) ?? Number.MAX_SAFE_INTEGER;
  const ba = threadAgeDays(b, now) ?? Number.MAX_SAFE_INTEGER;
  if (aa !== ba) return aa - ba; // fresher (smaller age) first
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}
