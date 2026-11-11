/**
 * askTermsLogic — pure-function unit tests (no React, no RN, no network).
 * Covers the Ask-for-Terms batch core:
 *   - the unpriced candidate predicate (open + no price named + repliable + not filed)
 *   - "no price named" reading only real currency figures (money-safe)
 *   - age × sender-type segmentation (sender-type wins; fresh/quiet/old buckets)
 *   - the subtractive default-checked rule (all on, OLD off)
 *   - grouping + selection summary
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/askterms
 */

import type { DealItem } from "../DealCard";
import {
  hasNamedPrice,
  isUnpricedInbound,
  isUnpricedCandidate,
  isPaidTypeCategory,
  looksCommissionOrReferral,
  isDeclineRecommended,
  countExcludedLowValue,
  dealAgeDays,
  segmentOf,
  defaultChecked,
  selectCandidateRows,
  buildSegments,
  defaultCheckedIds,
  summarizeSelection,
  canApprove,
  withApproval,
  withoutApproval,
  approvedToSend,
  sendApprovedLabel,
} from "./askTermsLogic";

// A fixed "now" so age buckets are deterministic.
const NOW = Date.UTC(2026, 6, 26); // 2026-07-26
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// Minimal DealItem factory — only the fields the logic reads matter.
function deal(over: Partial<DealItem> = {}): DealItem {
  return {
    id:         over.id ?? Math.random().toString(36).slice(2),
    brandName:  "Acme",
    category:   "PAID",
    status:     "detected",
    verdict:    "fair",
    source:     "gmail",
    sourceType: "Email",
    score:      5,
    timeAgo:    "2d ago",
    aiSummary:  "",
    threadId:   "t-1",
    lastMessageAt: daysAgo(2),
    ...over,
  } as DealItem;
}

describe("hasNamedPrice — money-safe price detection", () => {
  it("false when there's no dollar figure anywhere", () => {
    expect(hasNamedPrice(deal())).toBe(false);
  });
  it("true from offerAmount ($500)", () => {
    expect(hasNamedPrice(deal({ offerAmount: "$500" }))).toBe(true);
  });
  it("true from a bare numeric offerAmount (500)", () => {
    expect(hasNamedPrice(deal({ offerAmount: "500" }))).toBe(true);
  });
  it("true from offerDisplay with a currency figure", () => {
    expect(hasNamedPrice(deal({ offerDisplay: "$75/creative · 15%" }))).toBe(true);
  });
  it("true from offerHistory", () => {
    expect(hasNamedPrice(deal({ offerHistory: [500, 750] }))).toBe(true);
  });
  it("does NOT treat a bare '3 posts' style string as money", () => {
    // offerDisplay with no $ → not a price
    expect(hasNamedPrice(deal({ offerDisplay: "3 posts, 2 stories" }))).toBe(false);
  });
});

describe("isUnpricedCandidate — who belongs in the pool", () => {
  it("accepts an open, unpriced, repliable, unfiled inbound", () => {
    expect(isUnpricedCandidate(deal())).toBe(true);
  });
  it("rejects a priced deal", () => {
    expect(isUnpricedCandidate(deal({ offerAmount: "$1,000" }))).toBe(false);
  });
  it("rejects a settled deal (accepted/completed/rejected)", () => {
    expect(isUnpricedCandidate(deal({ status: "accepted" }))).toBe(false);
    expect(isUnpricedCandidate(deal({ status: "rejected" }))).toBe(false);
    expect(isUnpricedCandidate(deal({ status: "completed" }))).toBe(false);
  });
  it("rejects a deal with no thread to reply to", () => {
    expect(isUnpricedCandidate(deal({ threadId: null }))).toBe(false);
  });
  it("rejects a filed/set-aside thread (archived)", () => {
    expect(isUnpricedCandidate(deal({ threadStatus: "archived" }))).toBe(false);
  });
  it("accepts negotiating + pending when still unpriced", () => {
    expect(isUnpricedCandidate(deal({ status: "negotiating" }))).toBe(true);
    expect(isUnpricedCandidate(deal({ status: "pending" }))).toBe(true);
  });
  it("reads the thread's qualification when it exists — only needs_terms qualifies", () => {
    expect(isUnpricedCandidate(deal({ qualification: "needs_terms" }))).toBe(true);
    // A figure on the card does not override a needs_terms qualification (the classify decided).
    expect(isUnpricedCandidate(deal({ qualification: "needs_terms", offerAmount: "$1,000" }))).toBe(true);
    for (const q of ["workable", "below_floor", "verify_first", "not_relevant"]) {
      expect(isUnpricedCandidate(deal({ qualification: q }))).toBe(false);
    }
    // Still open + repliable + unfiled first.
    expect(isUnpricedCandidate(deal({ qualification: "needs_terms", threadStatus: "archived" }))).toBe(false);
  });
  it("falls back to the old unpriced rule when there is no qualification", () => {
    expect(isUnpricedCandidate(deal({ qualification: null }))).toBe(true);
    expect(isUnpricedCandidate(deal({ qualification: null, offerAmount: "$1,000" }))).toBe(false);
  });
});

describe("value qualification — only pursue deals worth an ask", () => {
  it("isPaidTypeCategory keeps PAID/EDITORIAL; drops GIFTING and the requests of her (MEDIA interviews, SCHOOL_NIL)", () => {
    expect(isPaidTypeCategory("PAID")).toBe(true);
    expect(isPaidTypeCategory("MEDIA")).toBe(false);
    expect(isPaidTypeCategory("EDITORIAL")).toBe(true);
    expect(isPaidTypeCategory("SCHOOL_NIL")).toBe(false);
    expect(isPaidTypeCategory("GIFTING")).toBe(false);
  });

  it("excludes GIFTING-only deals from candidates", () => {
    expect(isUnpricedInbound(deal({ category: "GIFTING" }))).toBe(true);   // it IS a raw unpriced inbound
    expect(isUnpricedCandidate(deal({ category: "GIFTING" }))).toBe(false); // but NOT a qualified candidate
  });

  it("looksCommissionOrReferral flags commission / referral / MLM offers", () => {
    expect(looksCommissionOrReferral(deal({ aiSummary: "Earn 20% commission on every sale" }))).toBe(true);
    expect(looksCommissionOrReferral(deal({ offerDisplay: "$50 per referral" }))).toBe(true);
    expect(looksCommissionOrReferral(deal({ aiSummary: "Join our affiliate program" }))).toBe(true);
    expect(looksCommissionOrReferral(deal({ aiSummary: "Wants two Instagram posts about our shoes" }))).toBe(false);
  });

  it("excludes commission/referral inbounds from candidates", () => {
    expect(isUnpricedCandidate(deal({ aiSummary: "Earn 15% commission per sale" }))).toBe(false);
  });

  it("isDeclineRecommended flags reject/delete recommendations", () => {
    expect(isDeclineRecommended(deal({ recommendation: "reject" }))).toBe(true);
    expect(isDeclineRecommended(deal({ recommendation: "delete" }))).toBe(true);
    expect(isDeclineRecommended(deal({ recommendation: "negotiate" }))).toBe(false);
  });

  it("excludes deals Mila already recommends passing (reject/delete)", () => {
    expect(isUnpricedCandidate(deal({ recommendation: "reject" }))).toBe(false);
    expect(isUnpricedCandidate(deal({ recommendation: "delete" }))).toBe(false);
  });

  it("countExcludedLowValue counts raw inbounds dropped by qualification", () => {
    const deals = [
      deal({ id: "keep" }),                                     // qualified
      deal({ id: "gift", category: "GIFTING" }),               // excluded
      deal({ id: "comm", aiSummary: "10% commission on sales" }), // excluded
      deal({ id: "pass", recommendation: "reject" }),          // excluded
      deal({ id: "priced", offerAmount: "$500" }),             // not even a raw inbound (priced)
    ];
    expect(countExcludedLowValue(deals, NOW)).toBe(3);
  });
});

describe("dealAgeDays", () => {
  it("counts days since last activity", () => {
    expect(dealAgeDays(deal({ lastMessageAt: daysAgo(10) }), NOW)).toBe(10);
  });
  it("falls back to detectedAt when no last message", () => {
    expect(dealAgeDays(deal({ lastMessageAt: null, detectedAt: daysAgo(45) }), NOW)).toBe(45);
  });
  it("treats an unknown date as age 0 (never punished into 'old')", () => {
    expect(dealAgeDays(deal({ lastMessageAt: null, detectedAt: undefined }), NOW)).toBe(0);
  });
});

describe("segmentOf — age × sender-type, sender-type wins", () => {
  it("fresh: direct + <30d", () => {
    expect(segmentOf(deal({ lastMessageAt: daysAgo(5) }), NOW)).toBe("fresh");
  });
  it("quiet: direct + 30–90d", () => {
    expect(segmentOf(deal({ lastMessageAt: daysAgo(45) }), NOW)).toBe("quiet");
  });
  it("old: direct + 90+d", () => {
    expect(segmentOf(deal({ lastMessageAt: daysAgo(200) }), NOW)).toBe("old");
  });
  it("agency wins over age (even an old agency thread is 'agency')", () => {
    expect(segmentOf(deal({ viaAgency: true, lastMessageAt: daysAgo(200) }), NOW)).toBe("agency");
    expect(segmentOf(deal({ viaAgency: true, lastMessageAt: daysAgo(3) }), NOW)).toBe("agency");
  });
  it("boundary: exactly 30d → quiet, exactly 90d → old", () => {
    expect(segmentOf(deal({ lastMessageAt: daysAgo(30) }), NOW)).toBe("quiet");
    expect(segmentOf(deal({ lastMessageAt: daysAgo(90) }), NOW)).toBe("old");
  });
});

describe("defaultChecked — subtractive, OLD off", () => {
  it("fresh / agency / quiet start checked", () => {
    expect(defaultChecked("fresh")).toBe(true);
    expect(defaultChecked("agency")).toBe(true);
    expect(defaultChecked("quiet")).toBe(true);
  });
  it("old starts unchecked", () => {
    expect(defaultChecked("old")).toBe(false);
  });
});

describe("selection + grouping", () => {
  const deals = [
    deal({ id: "fresh1", lastMessageAt: daysAgo(3) }),
    deal({ id: "quiet1", lastMessageAt: daysAgo(50) }),
    deal({ id: "old1",   lastMessageAt: daysAgo(120) }),
    deal({ id: "agency1", viaAgency: true, agencyName: "WME", lastMessageAt: daysAgo(100) }),
    deal({ id: "priced", offerAmount: "$800" }),          // excluded (priced)
    deal({ id: "filed",  threadStatus: "archived" }),      // excluded (filed)
    deal({ id: "settled", status: "accepted" }),           // excluded (settled)
  ];

  it("selectCandidateRows drops priced/filed/settled", () => {
    const rows = selectCandidateRows(deals, NOW);
    const ids = rows.map((r) => r.deal.id).sort();
    expect(ids).toEqual(["agency1", "fresh1", "old1", "quiet1"]);
  });

  it("buildSegments groups in order and omits empties", () => {
    const groups = buildSegments(deals, NOW);
    expect(groups.map((g) => g.meta.id)).toEqual(["fresh", "agency", "quiet", "old"]);
    expect(groups.find((g) => g.meta.id === "old")!.rows[0].deal.id).toBe("old1");
  });

  it("defaultCheckedIds pre-checks everything except OLD", () => {
    const ids = defaultCheckedIds(deals, NOW);
    expect(ids.has("fresh1")).toBe(true);
    expect(ids.has("agency1")).toBe(true);
    expect(ids.has("quiet1")).toBe(true);
    expect(ids.has("old1")).toBe(false); // OLD off by default
  });

  it("summarizeSelection splits will-ask vs set-aside over the candidate pool", () => {
    const checked = defaultCheckedIds(deals, NOW); // 3 on, old off
    const s = summarizeSelection(deals, checked, NOW);
    expect(s.total).toBe(4);
    expect(s.willAsk).toBe(3);
    expect(s.setAside).toBe(1);
  });
});

// ─── Per-message approval ──────────────────────────────────────────────────────

describe("per-message approval", () => {
  const pa = (id: string, body: string) => ({ id, payload: { body } as Record<string, unknown> });

  it("a row can be approved only once opened, and not while it is being edited", () => {
    expect(canApprove("a", new Set(), null)).toBe(false);
    expect(canApprove("a", new Set(["a"]), null)).toBe(true);
    expect(canApprove("a", new Set(["a"]), "a")).toBe(false);
    expect(canApprove("a", new Set(["a"]), "b")).toBe(true);
  });

  it("only approved rows send, each with the body it was approved on, in list order", () => {
    let approved = withApproval(new Map(), "c", "C body");
    approved = withApproval(approved, "a", "A body");
    const out = approvedToSend([pa("a", "A body"), pa("b", "B body"), pa("c", "C body")], approved);
    expect(out.map((r) => [r.pa.id, r.body])).toEqual([["a", "A body"], ["c", "C body"]]);
  });

  it("a row whose body changed after approval does not send; clearing removes it", () => {
    const approved = withApproval(new Map(), "a", "old");
    expect(approvedToSend([pa("a", "new")], approved)).toEqual([]);
    expect(withoutApproval(approved, "a").has("a")).toBe(false);
    expect(approved.has("a")).toBe(true); // never mutates the state it was given
  });

  it("labels the primary button by the approved count", () => {
    expect(sendApprovedLabel(0)).toBe("Send 0 approved replies");
    expect(sendApprovedLabel(1)).toBe("Send 1 approved reply");
    expect(sendApprovedLabel(4)).toBe("Send 4 approved replies");
  });
});
