/**
 * brands.test.ts — which sportswear brand her sentence names, and what a photograph must not show.
 *
 * Pure, but brands.ts reaches services/mediaSearch for `brandNamesMatch`, and mediaSearch builds
 * cloud clients at load — so its three network-edge imports are stood in, and nothing else.
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(),
  cosine: jest.fn(),
}));
jest.mock("../../lib/mediaStore", () => ({ signedUrl: jest.fn() }));

import { brandFlag, brandsNamed, brandsOf, brandsToAvoid } from "./brands";

const names = (sentence: string) => brandsNamed(sentence).map((b) => b.name);

describe("brandsNamed", () => {
  /**
   * ⚠️ MUTATION: find the brand with `brandNamesMatch(sentence, spelling)` — the name-against-name
   * rule, whose substring half reads a brand out of any word that contains it. This reds, and nothing
   * else does.
   */
  it("reads a brand she named as a whole word — never one inside another word", () => {
    expect(names("back to basics: my first week of training")).toEqual([]);
    expect(names("the pumaless edit")).toEqual([]);
    expect(names("an ad for my Adidas drop")).toEqual(["Adidas"]);
  });

  it("knows a brand by the ways it is written", () => {
    expect(names("new Under Armor season")).toEqual(["Under Armour"]);
    expect(names("NEW BALANCE, finally")).toEqual(["New Balance"]);
  });
});

describe("brandsToAvoid", () => {
  it("is empty when she named no brand — an unbranded ad has nothing to contradict", () => {
    expect(brandsToAvoid("something for the new season")).toEqual([]);
  });

  it("never avoids a brand she named, even when she named two", () => {
    const avoid = brandsToAvoid("Nike and Adidas, side by side").map(
      (b) => b.name,
    );
    expect(avoid).not.toContain("Nike");
    expect(avoid).not.toContain("Adidas");
    expect(avoid).toContain("Puma");
  });
});

describe("brandFlag", () => {
  it("states what the photo shows, by the name she reads — and is silent about her own brand and the rest", () => {
    const avoid = brandsToAvoid("an Adidas ad");
    expect(brandFlag(["NIKE", "a school crest", "Adidas"], avoid)).toBe(
      "This photo shows Nike.",
    );
    expect(brandFlag(["Adidas Originals", "a drink"], avoid)).toBeNull();
    expect(brandFlag([], avoid)).toBeNull();
  });
});

/**
 * ⚠️ MUTATION, red here by name: make `foldBrand` the identity (return `raw`) — every folded row of
 * the grid reds, and the dedupe row with it.
 */
describe("brandsOf — the observed alias clusters fold to one name each", () => {
  const vision = (brands: unknown[]) => ({ brands_visible: brands });

  it.each([
    ["Stanford", "Stanford"],
    ["Stanford University", "Stanford"],
    ["Stanford Athletics", "Stanford"],
    ["Stanford Cardinal", "Stanford"],
    ["stanford cardinal", "Stanford"],
    ["Bolyn", "Bolyn"],
    ["Bolyn Sporting Goods", "Bolyn"],
    ["BOLYN sporting goods", "Bolyn"],
    ["Gotham FC", "Gotham FC"],
    ["NJ/NY Gotham FC", "Gotham FC"],
    // Outside every cluster: the tagger's own string, untouched.
    ["Nike", "Nike"],
    ["Georgetown G", "Georgetown G"],
    ["Hoyas", "Hoyas"],
    ["Stanford Medicine", "Stanford Medicine"],
  ])("%s → %s", (raw, folded) => {
    expect(brandsOf(vision([raw]))).toEqual([folded]);
  });

  it("keeps the tagger's order, drops the duplicate a fold makes, and skips non-strings", () => {
    expect(
      brandsOf(
        vision([
          "Nike",
          "Stanford University",
          7,
          "Stanford Cardinal",
          "Adidas",
          null,
        ]),
      ),
    ).toEqual(["Nike", "Stanford", "Adidas"]);
    expect(brandsOf(null)).toEqual([]);
    expect(brandsOf({ brands_visible: "Nike" })).toEqual([]);
  });
});
