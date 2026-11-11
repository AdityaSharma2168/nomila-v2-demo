/**
 * dealActions — the action resolver behind Deal Detail's sticky bar.
 *
 * The primary button IS Mila's recommendation: `resolveDealActions` switches on it, so
 * whatever it labels that button is what the athlete reads as "the thing to do". That
 * makes a wrong label worse than a missing one — it is advice, stated with the emphasis
 * of a filled accent button.
 *
 * Known gap, parked on purpose: on a deal where nobody has named a price the button still
 * says "Counter offer". Twelve deals were in that state in production, with Mila's own
 * text reading "Request full proposal" or "Get pricing & scope first" directly above it.
 * Fixing the LABEL alone made it worse — the tap still opened the counter composer — so
 * it waits for the label and the route to move together.
 *
 * isPriced is the test that will drive both. It lives here, shared with the Brief's
 * coPilotAction, which already uses it correctly.
 */

import { resolveDealActions, isPriced } from "./dealActions";
import type { DealItem } from "./DealCard";

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

describe("isPriced — shared by both action resolvers", () => {
  it("reads a real currency figure", () => {
    expect(isPriced(deal({ offerDisplay: "$2,000" }))).toBe(true);
    expect(isPriced(deal({ offerDisplay: "1.5k for the set" }))).toBe(true);
    expect(isPriced(deal({ offerAmount: "2,000" }))).toBe(true);
  });

  // The distinction that matters: a deliverable count is not a price.
  it("does NOT read a bare deliverable count as a price", () => {
    expect(isPriced(deal({ offerDisplay: "3 posts" }))).toBe(false);
    expect(isPriced(deal({ offerDisplay: "2 reels + 1 story" }))).toBe(false);
    expect(isPriced(deal())).toBe(false);
  });
});

describe("resolveDealActions — the primary is Mila's recommendation", () => {
  // KNOWN AND DELIBERATE: the label does not yet depend on whether a price exists.
  //
  // A price-aware label ("Ask for terms" when nothing has been offered) was shipped and
  // then reverted, because the tap still routes to the negotiate composer — so the
  // button told the truth while the sheet behind it drafted a counter to a price nobody
  // named. Blunt and consistent beats honest and contradicted.
  //
  // When the Brief and Explore All reply flows are designed together, both halves move
  // at once: the label AND the route (DealActionSheet mode "terms", which already
  // exists). Until then this test documents the state rather than the goal.
  it("says 'Counter offer' for any negotiate, priced or not", () => {
    expect(resolveDealActions(deal({ recommendation: "negotiate" })).primary?.label)
      .toBe("Counter offer");
    expect(resolveDealActions(deal({ recommendation: "negotiate", offerDisplay: "$1,200" })).primary?.label)
      .toBe("Counter offer");
  });

  it("still leads with accept when Mila says accept", () => {
    expect(resolveDealActions(deal({ recommendation: "accept" })).primary?.label)
      .toBe("Accept & reply");
  });

  it("still leads with decline when Mila says reject", () => {
    expect(resolveDealActions(deal({ recommendation: "reject" })).primary?.label)
      .toBe("Decline");
  });

  it("keeps the other routes available whatever the label says", () => {
    const { overflow } = resolveDealActions(deal({ recommendation: "negotiate" }));
    const kinds = overflow.map((a) => a.kind);
    expect(kinds).toContain("accept");
    expect(kinds).toContain("decline");
  });
});
