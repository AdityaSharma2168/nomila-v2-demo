/**
 * coPilotActions — pure-function unit tests (no React, no RN, no network).
 * Covers every decision branch: reject/delete, unpriced (askTerms vs sendRate regex),
 * priced (draftYes vs counter), the money detector, junk/empty input, and the uniform
 * "I'll decide" secondary that every card shares.
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/brief
 */

import { coPilotAction, isPriced, asksForRate } from "./coPilotActions";
import type { DealItem } from "../DealCard";

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
    timeAgo:    "2d ago",
    aiSummary:  "They want a launch post.",
    ...over,
  };
}

// ─── isPriced — the money detector ──────────────────────────────────────────────

describe("isPriced — real currency figures only", () => {
  it("detects $-marked amounts in offerDisplay or offerAmount", () => {
    expect(isPriced(deal({ offerAmount: "$2,000" }))).toBe(true);
    expect(isPriced(deal({ offerDisplay: "$500 for one post" }))).toBe(true);
  });

  it("detects thousands-separated and k/m magnitude figures", () => {
    expect(isPriced(deal({ offerDisplay: "2,000 flat" }))).toBe(true);
    expect(isPriced(deal({ offerDisplay: "1.5k per post" }))).toBe(true);
    expect(isPriced(deal({ offerAmount: "€800" }))).toBe(true);
  });

  it("a bare deliverable count is NOT priced", () => {
    expect(isPriced(deal({ offerDisplay: "3 posts" }))).toBe(false);
    expect(isPriced(deal({ offerDisplay: "3 posts + 1 story" }))).toBe(false);
  });

  it("nothing stated is NOT priced", () => {
    expect(isPriced(deal({ offerDisplay: undefined, offerAmount: undefined }))).toBe(false);
  });
});

// ─── asksForRate — the sendRate regex ───────────────────────────────────────────

describe("asksForRate — brand asking for HER rate/quote", () => {
  it("matches rate/quote/pricing questions across convAsk + aiSummary", () => {
    expect(asksForRate(deal({ convAsk: "What's your rate for a reel?" }))).toBe(true);
    expect(asksForRate(deal({ convAsk: "How much would you charge?" }))).toBe(true);
    expect(asksForRate(deal({ aiSummary: "They ask what you cost for a post." }))).toBe(true);
    expect(asksForRate(deal({ convAsk: "Can you send a quote?" }))).toBe(true);
    expect(asksForRate(deal({ convAsk: "What's your pricing?" }))).toBe(true);
    expect(asksForRate(deal({ convAsk: "What is the budget you have in mind?" }))).toBe(true);
    expect(asksForRate(deal({ convAsk: "Please send your rate card." }))).toBe(true);
  });

  it("does not match a plain collaboration ask", () => {
    expect(asksForRate(deal({ convAsk: "We'd love a launch post.", aiSummary: "Wants a post." }))).toBe(false);
  });
});

// ─── coPilotAction — every branch ───────────────────────────────────────────────

const DECIDE = { kind: "decide", label: "I'll decide" };

describe("coPilotAction — reject / delete → Not for me", () => {
  it("reject → notForMe · I'll decide", () => {
    expect(coPilotAction(deal({ recommendation: "reject" }))).toEqual({
      primary:   { kind: "notForMe", label: "Not for me" },
      secondary: DECIDE,
    });
  });

  it("delete → notForMe · I'll decide (even when priced)", () => {
    expect(coPilotAction(deal({ recommendation: "delete", offerAmount: "$5,000" }))).toEqual({
      primary:   { kind: "notForMe", label: "Not for me" },
      secondary: DECIDE,
    });
  });
});

describe("coPilotAction — unpriced", () => {
  it("brand asked her rate → sendRate · I'll decide", () => {
    const p = coPilotAction(deal({ convAsk: "What's your rate?" }));
    expect(p.primary).toEqual({ kind: "sendRate", label: "Send your rate" });
    expect(p.secondary).toEqual(DECIDE);
  });

  it("no price + no rate ask → askTerms · I'll decide", () => {
    const p = coPilotAction(deal({ convAsk: "We'd love to work with you.", aiSummary: "Wants a post." }));
    expect(p.primary).toEqual({ kind: "askTerms", label: "Ask for terms" });
    expect(p.secondary).toEqual(DECIDE);
  });

  it("a bare count ('3 posts') is treated as unpriced → askTerms", () => {
    expect(coPilotAction(deal({ offerDisplay: "3 posts", aiSummary: "Wants three posts." })).primary.kind).toBe("askTerms");
  });

  it("negotiate recommendation but unpriced still asks for terms (nothing to counter)", () => {
    expect(coPilotAction(deal({ recommendation: "negotiate", offerDisplay: undefined })).primary.kind).toBe("askTerms");
  });
});

describe("coPilotAction — priced", () => {
  it("accept → draftYes · I'll decide", () => {
    const p = coPilotAction(deal({ recommendation: "accept", offerAmount: "$2,000" }));
    expect(p.primary).toEqual({ kind: "draftYes", label: "Draft a yes" });
    expect(p.secondary).toEqual(DECIDE);
  });

  it("negotiate → counter · I'll decide", () => {
    const p = coPilotAction(deal({ recommendation: "negotiate", offerDisplay: "$800 for 2 posts" }));
    expect(p.primary).toEqual({ kind: "counter", label: "Counter" });
    expect(p.secondary).toEqual(DECIDE);
  });

  it("no recommendation but priced → counter (default push-back)", () => {
    expect(coPilotAction(deal({ recommendation: undefined, offerAmount: "$1,500" })).primary.kind).toBe("counter");
  });

  it("priced deal ignores a rate-ask regex hit (price wins)", () => {
    // convAsk mentions 'rate' but a real price is on the table → counter, not sendRate.
    expect(coPilotAction(deal({ offerAmount: "$3,000", convAsk: "What's your rate beyond this?" })).primary.kind).toBe("counter");
  });
});

describe("coPilotAction — junk / empty input", () => {
  it("a bare deal with no fields → askTerms · I'll decide", () => {
    const p = coPilotAction(deal({ aiSummary: "", convAsk: undefined, offerDisplay: undefined, offerAmount: undefined }));
    expect(p.primary).toEqual({ kind: "askTerms", label: "Ask for terms" });
    expect(p.secondary).toEqual(DECIDE);
  });
});

describe("coPilotAction — the secondary is uniform", () => {
  it("is 'I'll decide' on every branch", () => {
    const samples = [
      deal({ recommendation: "reject" }),
      deal({ recommendation: "delete", offerAmount: "$5,000" }),
      deal({ convAsk: "What's your rate?" }),
      deal({ aiSummary: "Wants a post." }),
      deal({ recommendation: "accept", offerAmount: "$2,000" }),
      deal({ recommendation: "negotiate", offerDisplay: "$800" }),
    ];
    for (const d of samples) {
      expect(coPilotAction(d).secondary).toEqual({ kind: "decide", label: "I'll decide" });
    }
  });
});
