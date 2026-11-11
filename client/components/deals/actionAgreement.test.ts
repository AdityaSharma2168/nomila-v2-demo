/**
 * actionAgreement — the Brief and Deal Detail must name the same move for the same deal.
 *
 * They did not. Two resolvers took the same inputs and answered the same question with
 * different logic, and they disagreed on six of seven cases. Three were different ACTS
 * rather than different wording — the worst being an unpriced deal where the Brief said
 * "Ask for terms" and Deal Detail said "Accept & reply". Accept what? No offer had been
 * made.
 *
 * The split was never a design decision. The commit that added the co-pilot pair describes
 * the prop as "additive — Classic + ClassicListV2 (no prop) render the old action bar
 * unchanged", which is a safe-rollout pattern with the migration left unfinished.
 *
 * coPilotPrimary is that migration finished: one resolver, rendered two ways. These tests
 * pin the agreement, and pin the cases where the two are still deliberately allowed to
 * differ — lifecycle states the co-pilot resolver knows nothing about.
 */

import { coPilotAction } from "./brief/coPilotActions";
import { coPilotPrimary, resolveDealActions } from "./dealActions";
import type { DealItem } from "./DealCard";

const deal = (over: Partial<DealItem> = {}): DealItem => ({
  id: "d1", brandName: "Acme", category: "PAID", status: "detected", verdict: "fair",
  source: "gmail", sourceType: "Email", score: 5, timeAgo: "2d ago", aiSummary: "",
  ...over,
} as DealItem);

describe("the two surfaces agree on the move", () => {
  const cases: [string, Partial<DealItem>][] = [
    ["unpriced, negotiate",   { recommendation: "negotiate" }],
    ["priced, negotiate",     { recommendation: "negotiate", offerDisplay: "$1,200" }],
    ["they asked her rate",   { recommendation: "negotiate", convAsk: "please reply with your rates" }],
    ["accept with a price",   { recommendation: "accept", offerDisplay: "$14,000" }],
    ["accept, unpriced",      { recommendation: "accept" }],
    ["reject",                { recommendation: "reject" }],
    ["delete",                { recommendation: "delete" }],
  ];

  it.each(cases)("%s — Deal Detail shows the Brief's label", (_name, over) => {
    const d = deal(over);
    expect(coPilotPrimary(d).label).toBe(coPilotAction(d).primary.label);
  });

  // The case that motivated all of this: nothing to counter, nothing to accept.
  it("never says 'accept' on a deal where no offer exists", () => {
    const d = deal({ recommendation: "accept" });
    expect(coPilotPrimary(d).label).toBe("Ask for terms");
    expect(coPilotPrimary(d).kind).toBe("askTerms");
  });

  it("routes an unpriced negotiate to request-terms, not a counter", () => {
    expect(coPilotPrimary(deal({ recommendation: "negotiate" })).kind).toBe("askTerms");
  });

  it("counters only once a real number is on the table", () => {
    const d = deal({ recommendation: "negotiate", offerDisplay: "$1,200" });
    expect(coPilotPrimary(d).kind).toBe("negotiate");
  });

  it("a deliverable count is not a number to counter", () => {
    const d = deal({ recommendation: "negotiate", offerDisplay: "3 posts" });
    expect(coPilotPrimary(d).kind).toBe("askTerms");
  });
});

describe("what the co-pilot resolver is NOT allowed to decide", () => {
  // A completed deal must never be told to "Draft a yes". resolveDealActions owns the
  // lifecycle states, and Deal Detail keeps using it for them.
  it.each(["accepted", "completed", "rejected"])("%s is a lifecycle state, not a move", (status) => {
    const { primary } = resolveDealActions(deal({ status: status as DealItem["status"] }));
    expect(primary?.kind).toBe("viewThread");
  });

  it("waiting on the brand yields no primary at all", () => {
    const { primary, waiting } = resolveDealActions(
      deal({ status: "negotiating", awaitingResponseFrom: "brand" }),
    );
    expect(waiting).toBe(true);
    expect(primary).toBeNull();
  });

  it("the overflow still comes from resolveDealActions, untouched", () => {
    const { overflow } = resolveDealActions(deal({ recommendation: "negotiate" }));
    expect(overflow.map((a) => a.kind)).toEqual(expect.arrayContaining(["accept", "decline", "save"]));
  });
});
