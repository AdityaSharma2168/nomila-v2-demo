/**
 * yourWeekOutcome — pure-function unit tests (no React, no RN, no network).
 * Covers the outcome-log bucket derivation:
 *   - arrivedBuckets: this week's new-in-your-court deals split BY TYPE
 *   - didBuckets: disjoint "you & Mila did" buckets (counters / asked / quality / gifting)
 *   - bucketDeals: resolving a bucket id back to its exact deals
 *   - outcomeIsEmpty: the calm empty state
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/week
 */

import {
  arrivedBuckets,
  didBuckets,
  didBucketOf,
  bucketDeals,
  buildOutcomeLog,
  outcomeIsEmpty,
} from "./yourWeekOutcomeLogic";
import type { DealItem } from "../DealCard";

const NOW = Date.UTC(2026, 6, 25);
const daysAgoISO = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function deal(over: Partial<DealItem> = {}): DealItem {
  return {
    id:         "d1",
    brandName:  "Playermaker",
    category:   "PAID",
    status:     "detected",
    verdict:    "good",
    source:     "gmail",
    sourceType: "Email",
    score:      7,
    timeAgo:    "1d ago",
    aiSummary:  "They want a launch post.",
    detectedAt:    daysAgoISO(1),
    lastMessageAt: daysAgoISO(1),
    ...over,
  };
}

// A deal that lands in "arrived": new-ish, your court, recent activity.
const arrived = (over: Partial<DealItem> = {}) =>
  deal({ status: "detected", awaitingResponseFrom: "athlete", lastMessageAt: daysAgoISO(1), ...over });

// A deal that lands in "you moved": brand's turn + recent (you just replied), or accepted.
const moved = (over: Partial<DealItem> = {}) =>
  deal({ status: "negotiating", awaitingResponseFrom: "brand", lastMessageAt: daysAgoISO(1), ...over });

// ─── arrivedBuckets — by type ───────────────────────────────────────────────────

describe("arrivedBuckets", () => {
  it("returns ALL category buckets in a stable order, counting each (zeros included)", () => {
    const deals = [
      arrived({ id: "p1", category: "PAID" }),
      arrived({ id: "p2", category: "PAID" }),
      arrived({ id: "g1", category: "GIFTING" }),
    ];
    const buckets = arrivedBuckets(deals, NOW);
    // Every category always present (taxonomy is always visible), in ARRIVED_ORDER.
    expect(buckets.map((b) => [b.id, b.count])).toEqual([
      ["arrived-paid", 2],
      ["arrived-media", 0],
      ["arrived-editorial", 0],
      ["arrived-gifting", 1],
    ]);
  });

  it("returns all-zero buckets when nothing arrived this week", () => {
    const zeros = arrivedBuckets([], NOW);
    expect(zeros.map((b) => b.count)).toEqual([0, 0, 0, 0]);
    // A stale unread deal is NOT this week's arrival → still all zeros.
    expect(arrivedBuckets([arrived({ lastMessageAt: daysAgoISO(45) })], NOW).map((b) => b.count))
      .toEqual([0, 0, 0, 0]);
  });
});

// ─── didBuckets — disjoint vocabulary ───────────────────────────────────────────

describe("didBucketOf — disjoint routing", () => {
  it("routes a priced negotiation to counters, an unpriced one to asked", () => {
    expect(didBucketOf(moved({ offerAmount: "$2,000" }))).toBe("did-counters");
    expect(didBucketOf(moved({ offerAmount: undefined, offerDisplay: undefined }))).toBe("did-asked");
  });

  it("routes an accepted quality deal to replies-to-quality", () => {
    expect(didBucketOf(deal({ status: "accepted", verdict: "great" }))).toBe("did-quality");
    expect(didBucketOf(deal({ status: "accepted", verdict: "poor" }))).toBeNull();
  });

  it("routes any resolved gifting deal to gifting-decided (takes precedence)", () => {
    expect(didBucketOf(deal({ category: "GIFTING", status: "accepted", verdict: "great" }))).toBe("did-gifting");
    expect(didBucketOf(deal({ category: "GIFTING", status: "rejected" }))).toBe("did-gifting");
  });
});

describe("didBuckets", () => {
  it("counts each disjoint bucket from this week's moved deals", () => {
    const deals = [
      moved({ id: "c1", offerAmount: "$2,000" }),                                  // counters
      moved({ id: "a1", offerAmount: undefined, offerDisplay: undefined }),        // asked
      deal({ id: "q1", status: "accepted", verdict: "good" }),                     // quality
      deal({ id: "gi", category: "GIFTING", status: "accepted", verdict: "good" }),// gifting
    ];
    const buckets = didBuckets(deals, NOW);
    expect(buckets.map((b) => [b.id, b.count])).toEqual([
      ["did-counters", 1],
      ["did-asked", 1],
      ["did-quality", 1],
      ["did-gifting", 1],
    ]);
  });
});

// ─── bucketDeals — resolve id → its exact deals ─────────────────────────────────

describe("bucketDeals", () => {
  it("returns exactly the deals behind an arrived bucket", () => {
    const deals = [
      arrived({ id: "p1", category: "PAID" }),
      arrived({ id: "g1", category: "GIFTING" }),
    ];
    expect(bucketDeals(deals, "arrived-paid", NOW).map((d) => d.id)).toEqual(["p1"]);
    expect(bucketDeals(deals, "arrived-gifting", NOW).map((d) => d.id)).toEqual(["g1"]);
  });

  it("returns exactly the deals behind a did bucket", () => {
    const deals = [moved({ id: "c1", offerAmount: "$2,000" }), moved({ id: "a1", offerAmount: undefined, offerDisplay: undefined })];
    expect(bucketDeals(deals, "did-counters", NOW).map((d) => d.id)).toEqual(["c1"]);
    expect(bucketDeals(deals, "did-asked", NOW).map((d) => d.id)).toEqual(["a1"]);
  });
});

// ─── outcomeIsEmpty ─────────────────────────────────────────────────────────────

describe("buildOutcomeLog / outcomeIsEmpty", () => {
  it("is empty when nothing arrived and nothing moved", () => {
    expect(outcomeIsEmpty(buildOutcomeLog([], NOW))).toBe(true);
  });
  it("is not empty when something arrived", () => {
    expect(outcomeIsEmpty(buildOutcomeLog([arrived()], NOW))).toBe(false);
  });
});
