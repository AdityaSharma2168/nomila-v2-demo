/**
 * opportunityOrder — the deterministic order, pinned on the 6 Oct ranking-trial cases (Mia's dev
 * candidates plus three test-only filed cases), ordered by decision D3 (DEALS_BOARD_V2, retired 2 Nov 2026: always on).
 */
import { askPhrase, cardLine, isCommissionOnly, motionLine, orderOpportunities, standingOf, stateOf, type OrderInput } from "./opportunityOrder";

const confirmed = (tier: string) => ({ brand_tier: tier, enrichment: { identity: { status: "confirmed", domain: "x.com", own_sources: ["x.com"], basis: "own_domain_source", checked_at: "" } } });
const unconfirmed = { brand_tier: "established", enrichment: { identity: { status: "unconfirmed", domain: "startx1.com", own_sources: [], basis: "no_own_domain_source", checked_at: "" } } };

describe("standingOf", () => {
  it("reads tier only from CONFIRMED research", () => {
    expect(standingOf(confirmed("premium"), "agency")).toBe("established");
    expect(standingOf(confirmed("mid"), "direct")).toBe("mid");
    expect(standingOf(confirmed("emerging"), "direct")).toBe("emerging");
    expect(standingOf(unconfirmed, "direct")).toBe("none");                       // StartX1
    expect(standingOf({ brand_tier: "established", enrichment: { industry: "x" } }, "direct")).toBe("none"); // never checked
    expect(standingOf(null, "direct")).toBe("none");
  });
  it("an unverifiable sender is last whatever the research says", () => {
    expect(standingOf(confirmed("established"), "unverifiable")).toBe("unverifiable");
  });
});

describe("stateOf", () => {
  it("maps the lead thread's qualification", () => {
    expect(stateOf("workable", { unit: "gifting_only" })).toBe("product");
    expect(stateOf("workable", null, "Terms are stated (product); it isn't a cash-only offer")).toBe("product");
    expect(stateOf("workable", { amount: 7500, unit: "total" })).toBe("cash");
    expect(stateOf("workable", null, "Terms are stated (cash plus product)")).toBe("cash");
    expect(stateOf("below_floor", null)).toBe("below_floor");
    expect(stateOf("needs_terms", null)).toBe("needs_terms");
    expect(stateOf(null, null)).toBe("unqualified");
  });
  it("commission only is the product state (owner, 23 Oct 2026: handled exactly like product only)", () => {
    expect(stateOf("workable", { unit: "commission_only", amount: null })).toBe("product");
    expect(stateOf("workable", null, "Terms are stated (commission); it isn't a cash-only offer")).toBe("product");
    // A stated cash figure beside a commission is still a fee offer.
    expect(stateOf("workable", { unit: "total", amount: 1000 }, "Terms are stated ($1,000 cash)")).toBe("cash");
    expect(isCommissionOnly({ unit: "commission_only" })).toBe(true);
    expect(isCommissionOnly({ amount: 500 }, "Terms are stated (commission)")).toBe(false);
    expect(isCommissionOnly({ unit: "gifting_only" }, "Terms are stated (product)")).toBe(false);
  });
});

it("orders the trial-2 cases by D3: state first, the confirmed tier only a tiebreak, unverifiable senders last", () => {
  const c = (id: string, standing: OrderInput["standing"], state: OrderInput["state"], channel: OrderInput["channel"], at: string): OrderInput =>
    ({ id, standing, state, channel, lastActivityAt: at });
  const items = [
    c("Xingye", "unverifiable", "needs_terms", "unverifiable", "2026-08-28"),
    c("NextGen", "none", "product", "direct", "2026-08-29"),
    c("POPMART", "none", "below_floor", "agency", "2026-09-28"),
    c("Hisense", "established", "needs_terms", "agency", "2026-09-28"),
    c("StartX1", "none", "needs_terms", "direct", "2026-09-14"),
    c("MPG", "emerging", "product", "direct", "2026-08-29"),
    c("Jaambu", "unverifiable", "cash", "unverifiable", "2026-09-29"),
    c("HomeImprovement", "none", "needs_terms", "agency", "2026-08-29"),
    c("MUDWTR", "established", "product", "agency", "2026-10-01"),
    c("Brazil", "established", "needs_terms", "direct", "2026-09-28"),
    c("StanEats", "none", "needs_terms", "direct", "2026-09-22"),
    c("INIU", "established", "needs_terms", "agency", "2026-08-26"),
    c("Harrison", "none", "needs_terms", "direct", "2026-09-25"),
  ];
  expect(orderOpportunities(items).map((x) => x.id)).toEqual([
    "POPMART",
    "Brazil", "Hisense", "INIU", "Harrison", "StanEats", "StartX1", "HomeImprovement",
    "MUDWTR", "MPG", "NextGen",
    "Jaambu", "Xingye",
  ]);
});

it("is total and stable: ties break by newest activity, then id", () => {
  const a = { id: "b", standing: "none" as const, state: "needs_terms" as const, channel: "direct" as const, lastActivityAt: "2026-09-01" };
  const b = { ...a, id: "a" };
  expect(orderOpportunities([a, b]).map((x) => x.id)).toEqual(["a", "b"]);
});

describe("cardLine", () => {
  it("never names a rate; shows a figure only when the brand stated it", () => {
    expect(cardLine({ state: "needs_terms", channel: "agency", ask: "create 3 Instagram Reels.", herMoveSince: "2026-08-29T12:00:00Z" }))
      .toBe("Via an agency · Their ask: Create 3 Instagram Reels · no fee yet · Waiting on you since Aug 29");
    expect(cardLine({ state: "needs_terms", channel: "direct" })).toBe("Interested in working together · no fee yet");
    // a request of her: answered, never "no fee yet"
    expect(cardLine({ kind: "interview", state: "needs_terms", channel: "direct", ask: "a podcast interview", herMoveSince: "2026-09-25T12:00:00Z" }))
      .toBe("Interview request · Their ask: A podcast interview · Waiting on you since Sep 25");
    expect(cardLine({ kind: "school", state: "needs_terms", channel: "direct", ask: "disclose your NIL agreement" }))
      .toBe("From your school · Their ask: Disclose your NIL agreement");
    expect(cardLine({ state: "below_floor", channel: "agency", cash: 150 })).toBe("$150 offered, under your floor for this work");
    // A named agency is already on the card's chip: the line doesn't repeat it.
    expect(cardLine({ state: "needs_terms", channel: "agency", agencyNamed: true })).toBe("Interested in working together · no fee yet");
    expect(cardLine({ state: "product", channel: "direct", confirmedCategory: "Nutrition" })).toBe("Nutrition · Product only, no cash");
  });

  it("leads with the money they stated, then their ask", () => {
    expect(cardLine({ state: "cash", channel: "agency", agencyNamed: true, cash: 625, ask: "1 Instagram Reel + reposting to TikTok.", herMoveSince: "2026-10-20T12:00:00Z" }))
      .toBe("$625 · 1 Instagram Reel + reposting to TikTok · Waiting on you since Oct 20");
    // Paid, but no figure yet: say so and still show the ask.
    expect(cardLine({ state: "cash", channel: "agency", agencyNamed: true, ask: "reply with your rates for a video" }))
      .toBe("Paid, no amount yet · Reply with your rates for a video");
    expect(cardLine({ state: "product", channel: "direct", ask: "try the product and share your thoughts" }))
      .toBe("Product only, no cash · Try the product and share your thoughts");
    // Commission only: the product card's line, in its own true words.
    expect(cardLine({ state: "product", channel: "direct", commissionOnly: true, ask: "join our ambassador programme" }))
      .toBe("Commission only, no set fee · Join our ambassador programme");
  });
});

describe("motionLine", () => {
  it("keeps the stage word and adds what's on the table", () => {
    expect(motionLine({ effectiveStatus: "negotiating", herMoveSince: "2026-10-20T12:00:00Z", cash: 625, ask: "1 Instagram Reel + reposting to TikTok" }))
      .toBe("$625 · 1 Instagram Reel + reposting to TikTok · Negotiating · Waiting on you since Oct 20");
    expect(motionLine({ effectiveStatus: "accepted" })).toBe("Agreed · Their move");
  });
});

describe("askPhrase", () => {
  it("cuts a long ask at a word", () => {
    const long = askPhrase("create one dedicated TikTok video and two Instagram stories about the new season launch event next month", 60)!;
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
    expect(askPhrase("  ")).toBeNull();
  });
});
