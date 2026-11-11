// WS5 · Your Week (outcome log) — yourWeekOutcome: the pure derivation core.
//
// Dependency-free (no React/RN) so it's unit-testable and YourWeekOutcome stays a thin
// view over it. It reuses weekLogic (sectionDeals) rather than re-deriving motion, and
// leaves the "Set aside" section to weekLogic.buildReceipt (agent_actions) untouched.
//
// The outcome log has three parts, of which TWO are deal-derived clickable buckets:
//
//   1. "What arrived" — this week's new-in-your-court deals, split BY TYPE (category).
//   2. "What you & Mila did" — this week's motion, split into a FIXED vocabulary of
//      buckets (counts dynamic): counters sent · asked for terms · replies to quality ·
//      gifting decided. Buckets are disjoint so a deal is never counted twice.
//   3. "Set aside by Nomila" — from agent_actions (handled by the view via buildReceipt).
//
// Every bucket carries a stable id so the view can render a clickable row and the
// orchestrator can drill into exactly those deals via `bucketDeals(...)`.

import type { DealItem, DealCategory } from "../DealCard";
import { sectionDeals } from "./weekLogic";

// ─── Bucket ids (stable contract with the orchestrator) ────────────────────────────

export type ArrivedBucketId = "arrived-paid" | "arrived-media" | "arrived-editorial" | "arrived-gifting";
export type DidBucketId     = "did-counters" | "did-asked" | "did-quality" | "did-gifting";
export type OutcomeBucketId = ArrivedBucketId | DidBucketId;

export interface OutcomeBucket {
  id:    OutcomeBucketId;
  label: string;   // fixed vocabulary
  count: number;   // dynamic
}

// ─── "What arrived" — by type ───────────────────────────────────────────────────────

const ARRIVED_LABEL: Record<DealCategory, { id: ArrivedBucketId; label: string }> = {
  PAID:      { id: "arrived-paid",      label: "Paid offers" },
  MEDIA:     { id: "arrived-media",     label: "Media & appearances" },
  EDITORIAL: { id: "arrived-editorial", label: "Product review" },
  GIFTING:   { id: "arrived-gifting",   label: "Gifting" },
};

// Stable display order regardless of arrival order.
const ARRIVED_ORDER: DealCategory[] = ["PAID", "MEDIA", "EDITORIAL", "GIFTING"];

/**
 * Split this week's "arrived" deals into by-type buckets. Returns ALL category buckets
 * ALWAYS (count 0 when nothing arrived in that category this week) so the taxonomy is
 * always visible — the view renders zero-count rows muted + non-tappable so the athlete
 * learns how the week is organized and what to expect.
 */
export function arrivedBuckets(deals: DealItem[], now: number = Date.now()): OutcomeBucket[] {
  const { arrived } = sectionDeals(deals, now);
  const counts = new Map<DealCategory, number>();
  for (const d of arrived) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return ARRIVED_ORDER.map((cat) => ({ ...ARRIVED_LABEL[cat], count: counts.get(cat) ?? 0 }));
}

// ─── "What you & Mila did" — fixed vocabulary, disjoint predicates ──────────────────

/** Deal has a stated price (something to counter, vs. a bare "asked for terms"). */
function isPriced(d: DealItem): boolean {
  return !!d.offerDisplay || !!d.offerAmount;
}

/**
 * Route a "you moved" deal into at most ONE "did" bucket (disjoint), or null.
 * Precedence keeps the buckets non-overlapping:
 *   - GIFTING resolved (accepted/rejected) → gifting decided
 *   - accepted quality (great/good)         → replies to quality
 *   - negotiating + priced                  → counters sent
 *   - negotiating + unpriced                → asked for terms
 */
export function didBucketOf(d: DealItem): DidBucketId | null {
  if (d.category === "GIFTING") {
    return d.status === "accepted" || d.status === "rejected" ? "did-gifting" : null;
  }
  if (d.status === "accepted") {
    return d.verdict === "great" || d.verdict === "good" ? "did-quality" : null;
  }
  if (d.status === "negotiating") {
    return isPriced(d) ? "did-counters" : "did-asked";
  }
  return null;
}

const DID_LABEL: Record<DidBucketId, string> = {
  "did-counters": "Counters sent",
  "did-asked":    "Asked for terms",
  "did-quality":  "Replies to quality",
  "did-gifting":  "Gifting decided",
};

const DID_ORDER: DidBucketId[] = ["did-counters", "did-asked", "did-quality", "did-gifting"];

/** Split this week's "you moved" deals into the fixed did-buckets. Returns ALL buckets
 *  ALWAYS (count 0 when none) — same always-visible-taxonomy rationale as arrivedBuckets. */
export function didBuckets(deals: DealItem[], now: number = Date.now()): OutcomeBucket[] {
  const { youMoved } = sectionDeals(deals, now);
  const counts = new Map<DidBucketId, number>();
  for (const d of youMoved) {
    const b = didBucketOf(d);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return DID_ORDER.map((id) => ({ id, label: DID_LABEL[id], count: counts.get(id) ?? 0 }));
}

// ─── Resolve a bucket id → its deals (for onOpenBucket drill-in + tests) ────────────

/** The exact deals behind a bucket id — the orchestrator uses this to drill in. */
export function bucketDeals(
  deals: DealItem[],
  id: OutcomeBucketId,
  now: number = Date.now(),
): DealItem[] {
  const { arrived, youMoved } = sectionDeals(deals, now);
  switch (id) {
    case "arrived-paid":      return arrived.filter((d) => d.category === "PAID");
    case "arrived-media":     return arrived.filter((d) => d.category === "MEDIA");
    case "arrived-editorial": return arrived.filter((d) => d.category === "EDITORIAL");
    case "arrived-gifting":   return arrived.filter((d) => d.category === "GIFTING");
    default:                  return youMoved.filter((d) => didBucketOf(d) === id);
  }
}

// ─── Whole-outcome shape (for the view + an "is there anything" check) ──────────────

export interface OutcomeLog {
  arrived: OutcomeBucket[];
  did:     OutcomeBucket[];
}

export function buildOutcomeLog(deals: DealItem[], now: number = Date.now()): OutcomeLog {
  return { arrived: arrivedBuckets(deals, now), did: didBuckets(deals, now) };
}

/** True when nothing actually happened this week (every bucket is zero) — drives the
 *  calm empty state. Note the bucket arrays are never empty now (all categories always
 *  render), so we check the COUNTS, not the lengths. */
export function outcomeIsEmpty(log: OutcomeLog): boolean {
  const allZero = (bs: OutcomeBucket[]) => bs.every((b) => b.count === 0);
  return allZero(log.arrived) && allZero(log.did);
}
