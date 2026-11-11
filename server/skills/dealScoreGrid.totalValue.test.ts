import { totalGuaranteedValue, matchRate, type OfferStruct } from "./dealScoreGrid";

const gorjana: OfferStruct = { amount: 7500, product_value: 6500, unit: "total", deliverable_counts: { posts: 6, stories: 6 } };

describe("gorjana — the deal she actually signed", () => {
  it("counts total guaranteed value, not cash alone", () => {
    expect(totalGuaranteedValue(gorjana)).toBe(14000);
  });

  it("positions per-deliverable on the TOTAL", () => {
    expect(matchRate(gorjana)).toEqual({ perUnit: 14000 / 12, key: "socialPost" });
  });
});
