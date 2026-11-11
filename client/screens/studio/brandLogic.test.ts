import { brandsFromDeals } from "./brandLogic";
import { suggestionsFrom } from "./personalLogic";
import type { DealItem } from "../../components/deals/DealCard";
import type { Fixture } from "../../hooks/use-studio-pending";

const deal = (over: Partial<DealItem>): DealItem =>
  ({
    id: "d",
    brandName: "gorjana",
    brandDomain: null,
    brandId: 1,
    category: "commercial",
    status: "accepted",
    verdict: null,
    source: "Gmail",
    sourceType: "Email",
    score: null,
    timeAgo: "1d",
    aiSummary: "",
    ...over,
  }) as DealItem;

describe("brands from deals", () => {
  it("gives a brand one row however many threads it arrived on", () => {
    // gorjana on four email threads is four deals — showing it four times looks broken.
    const brands = brandsFromDeals([
      deal({ id: "1" }),
      deal({ id: "2" }),
      deal({ id: "3" }),
      deal({ id: "4" }),
    ]);
    expect(brands).toHaveLength(1);
    expect(brands[0].dealCount).toBe(4);
  });

  it("carries brand_id through, because that is what a preview request wants", () => {
    expect(brandsFromDeals([deal({ brandId: 42 })])[0].brandId).toBe(42);
  });

  it("still collapses a brand the resolver never matched to an id", () => {
    const brands = brandsFromDeals([
      deal({ id: "1", brandId: null, brandName: "Vuori" }),
      deal({ id: "2", brandId: null, brandName: "vuori" }),
    ]);
    expect(brands).toHaveLength(1);
    expect(brands[0].dealCount).toBe(2);
  });

  it("does not merge two different brands that both lack an id", () => {
    const brands = brandsFromDeals([
      deal({ id: "1", brandId: null, brandName: "Vuori" }),
      deal({ id: "2", brandId: null, brandName: "Celsius" }),
    ]);
    expect(brands).toHaveLength(2);
  });

  it("takes a domain from whichever row has one, since that is what resolves the logo", () => {
    const brands = brandsFromDeals([
      deal({ id: "1", brandDomain: null }),
      deal({ id: "2", brandDomain: "gorjana.com" }),
    ]);
    expect(brands[0].domain).toBe("gorjana.com");
  });

  it("leaves out a rejected deal and a filed-away thread", () => {
    // The real vocabulary is detected|pending|negotiating|accepted|completed|rejected. Being filed
    // is threadStatus, a different field — guarding on a "declined" status would filter nothing.
    const brands = brandsFromDeals([
      deal({ id: "1", brandId: 1, brandName: "gorjana", status: "accepted" }),
      deal({ id: "2", brandId: 2, brandName: "Alo", status: "rejected" }),
      deal({ id: "3", brandId: 3, brandName: "Old", threadStatus: "archived" }),
    ]);
    expect(brands.map((b) => b.name)).toEqual(["gorjana"]);
  });

  it("keeps a completed deal, because a finished one is when a recap gets made", () => {
    const brands = brandsFromDeals([deal({ status: "completed" })]);
    expect(brands.map((b) => b.name)).toEqual(["gorjana"]);
  });

  it("skips a deal with no brand at all rather than rendering a blank row", () => {
    expect(brandsFromDeals([deal({ brandName: "" })])).toEqual([]);
  });

  it("leads with the brand she works with most", () => {
    const brands = brandsFromDeals([
      deal({ id: "1", brandId: 1, brandName: "gorjana" }),
      deal({ id: "2", brandId: 2, brandName: "Alo" }),
      deal({ id: "3", brandId: 2, brandName: "Alo" }),
    ]);
    expect(brands.map((b) => b.name)).toEqual(["Alo", "gorjana"]);
  });

  it("breaks a tie alphabetically rather than by arrival order", () => {
    const brands = brandsFromDeals([
      deal({ id: "1", brandId: 1, brandName: "Zephyr" }),
      deal({ id: "2", brandId: 2, brandName: "Alo" }),
    ]);
    expect(brands.map((b) => b.name)).toEqual(["Alo", "Zephyr"]);
  });
});

describe("suggestions", () => {
  const fixture = (daysAhead: number): Fixture => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return {
      id: "f1",
      startsAt: d.toISOString(),
      opponent: "Cal",
      venue: "Maples",
      home: true,
    };
  };

  it("suggests nothing rather than filler when the calendar is empty", () => {
    expect(suggestionsFrom([])).toEqual([]);
  });

  it("ignores fixtures that have already happened", () => {
    expect(suggestionsFrom([fixture(-4)])).toEqual([]);
  });

  it("offers a teaser and a recap off one upcoming fixture", () => {
    const s = suggestionsFrom([fixture(3)]);
    expect(s).toHaveLength(2);
    expect(s[0].purpose).toMatch(/teaser/i);
    expect(s[1].purpose).toMatch(/recap/i);
  });

  it("cites where each suggestion came from", () => {
    // A suggestion that cannot say why it exists is a guess wearing authority.
    suggestionsFrom([fixture(2)]).forEach((s) => expect(s.from).toBeTruthy());
  });

  it("hands the brand flow a purpose in plain words", () => {
    const s = suggestionsFrom([fixture(2)]);
    expect(s[0].purpose).toMatch(/game|match|fixture/i);
    expect(s[1].purpose).toMatch(/recap|week/i);
  });
});
