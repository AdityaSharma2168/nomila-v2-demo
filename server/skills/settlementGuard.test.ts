/**
 * Payment / invoice notices are never offers (19 Oct phone review): an ask or deliverables that are only settlement
 * language ("Goods and services supplied as invoiced") make no offer and no reply she owes. Pure.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));

import { isSettlementOnly } from "../lib/emailFilters";
import { enforceQualification } from "./dealQualification";
import { settlementGuard } from "./threadSummarizer";

it("isSettlementOnly: settlement wording with no ask, never a real ask that mentions invoicing", () => {
  expect(isSettlementOnly("Goods and services supplied as invoiced.")).toBe(true);
  expect(isSettlementOnly("Goods and services supplied / invoice settlement")).toBe(true);
  expect(isSettlementOnly("Payment advice for items settled by bank transfer")).toBe(true);
  expect(isSettlementOnly("Send your invoice after the post goes live")).toBe(false);
  expect(isSettlementOnly("Two Instagram posts for the spring campaign, paid as invoiced")).toBe(false);
  expect(isSettlementOnly("One reel and a story")).toBe(false);
  expect(isSettlementOnly("")).toBe(false);
  expect(isSettlementOnly(null)).toBe(false);
});

it("settlementGuard: a settlement-only ask records no ask and no reply owed; a real ask is untouched", () => {
  expect(settlementGuard({ ask: "Goods and services supplied as invoiced.", awaiting_response_from: "athlete", last_contact: "2026-10-15" }))
    .toEqual({ ask: null, awaiting_response_from: "unknown", last_contact: "2026-10-15" });
  const real = { ask: "Post one reel about the launch", awaiting_response_from: "athlete" };
  expect(settlementGuard(real)).toBe(real);
  const none = { ask: null, awaiting_response_from: "brand" };
  expect(settlementGuard(none)).toBe(none);
});

describe("enforceQualification: deliverables that are only settlement language are not an offer", () => {
  const model = { qualification: "workable", channel: "direct", cash_amount: 5000, comp_kind: "cash", reason: "Terms are stated" } as any;

  it("a payment advice with an amount → not_relevant, never workable", () => {
    const q = enforceQualification({ model, from: "ap@northwind-group.test", deliverables: ["Goods and services supplied / invoice settlement"], floors: null, category: "PAID" });
    expect(q).toMatchObject({ qualification: "not_relevant", qualification_reason: "A payment or invoice notice, not an offer." });
  });

  it("a real offer with a settlement-worded line among real deliverables stays termed", () => {
    const q = enforceQualification({ model, from: "maya@northwind-apparel.test", deliverables: ["One Instagram reel", "Paid as invoiced within 30 days"], floors: null, category: "PAID" });
    expect(q?.qualification).toBe("workable");
  });
});
