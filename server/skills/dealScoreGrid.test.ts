import { matchRate, type OfferStruct } from "./dealScoreGrid";

describe("an ambassador contract is priced per year, not per post", () => {
  // The real shape: a multi-year endorsement, valued as a lump across its term.
  const adidas: OfferStruct = {
    amount: 80_000, product_value: 40_000, unit: "total",
    deliverable_counts: { posts: 48, appearances: 40, autographs: 80 },
    counts_basis: "term", deal_type: "ambassador", term_months: 48,
  };

  it("annualizes the term instead of dividing by deliverables", () => {
    const m = matchRate(adidas)!;
    expect(m.key).toBe("projectedAnnualValue");
    expect(m.perUnit).toBe(30_000);            // $120,000 over 4 years
  });

  it("does NOT price it as posts", () => {
    // The old path: $120,000 ÷ 168 deliverables = $714, judged against a post rate.
    expect(matchRate(adidas)!.perUnit).not.toBeCloseTo(120_000 / 168, 0);
  });

  it("uses the ambassador rate when there is no annual figure to be had", () => {
    const oneOff: OfferStruct = {
      amount: 5_000, unit: "total", deal_type: "ambassador",
      deliverable_counts: { appearances: 2 }, counts_basis: "per_year",
    };
    expect(matchRate(oneOff)!.key).toBe("ambassador");
  });
});

describe("what must NOT change", () => {
  // gorjana: a genuine content deal. It was priced correctly before and must stay so.
  const gorjana: OfferStruct = {
    amount: 7_500, product_value: 6_500, unit: "total",
    deliverable_counts: { posts: 6, reels: 6 }, deal_type: "social_post",
  };

  it("gorjana still prices per deliverable against the post rate", () => {
    const m = matchRate(gorjana)!;
    expect(m.key).toBe("socialPost");
    expect(m.perUnit).toBeCloseTo(14_000 / 12, 2);
  });

  it("an unknown deal type falls back to the post rate, as before", () => {
    const m = matchRate({ amount: 1_200, unit: "per_post" })!;
    expect(m.key).toBe("socialPost");
  });

  it("an appearance offer still uses the appearance rate", () => {
    expect(matchRate({ amount: 900, unit: "per_appearance" })!.key).toBe("appearance");
  });

  it("monthly still annualizes to the projected annual value", () => {
    const m = matchRate({ amount: 2_000, unit: "monthly" })!;
    expect(m.key).toBe("projectedAnnualValue");
    expect(m.perUnit).toBe(24_000);
  });
});

describe("a term shorter than a year is not an annual rate", () => {
  it("a 3-month campaign is not annualized", () => {
    // $9,000 over three months is not a $36,000-a-year athlete.
    const m = matchRate({
      amount: 9_000, unit: "total", term_months: 3, deal_type: "ambassador",
      deliverable_counts: { posts: 3 }, counts_basis: "term",
    })!;
    expect(m.perUnit).not.toBe(36_000);
  });
});
