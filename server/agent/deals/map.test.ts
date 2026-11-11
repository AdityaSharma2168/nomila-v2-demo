/**
 * deals/map.test.ts — the board's rows as Mila reads them. Pure: no database, no provider.
 *
 * The board's next step can fall back on the qualification as SHE reads it on her own screen
 * (dealQualification.plainQualificationReason), which names her minimum as a figure. Mila must never read that figure.
 */
// No database: everything here is pure. Any database use would throw.
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("tests here never touch the database"); } }) }));

import type { BoardItem } from "../../services/opportunityBoard";
import { plainQualificationReason } from "../../skills/dealQualification";
import { floorFree, rowFromItem } from "./map";
import { rowForModel } from "./tools";

const herReason = plainQualificationReason({
  qualification: "below_floor", qualification_reason: null,
  qualification_floor: { cash: 1200, units: 3, floor: 1750, kind: "social_post", source: "athlete" },
} as any);

function item(over: Partial<BoardItem> = {}): BoardItem {
  return {
    opportunity_id: "o1", lead_deal_id: "d1", lead_thread_id: "t1",
    brand: { id: null, name: "Northpeak Apparel", logo_url: null, safe_logo_url: null, domain: null, is_person: false, research_confirmed: false, category: null, tier: null, image_url: null },
    kind: "deal", kind_label: null, qualification: "below_floor", poster: null, line: "$1,200 offered, under your floor for this work", stage: null,
    awaiting_response_from: null, started_at: null, last_activity_at: null,
    next: { action: "counter", label: "Counter", why: herReason, due: null, hers: true },
    ...over,
  } as unknown as BoardItem;
}

describe("her minimum never reaches the model from a board row", () => {
  it("the fixture really is her screen's sentence with the figure (guards against a vacuous pass)", () => {
    expect(herReason).toMatch(/minimum of \$1,750/);
  });

  it("floorFree drops only the sentence that pairs her minimum with a figure", () => {
    expect(floorFree(herReason)).toBe("They offered $1,200 for 3 social posts.");
    expect(floorFree("Their minimum of $1.5k each is too high. Ask about usage.")).toBe("Ask about usage.");
    expect(floorFree("Your floor is 900.")).toBeNull();
    // "Why it's here" naming her minimum for the deal's kind of work (no stored floor check)
    expect(floorFree(plainQualificationReason({ qualification: "workable", qualification_reason: "", qualification_floor: null } as any, {
      cash: 1500, minimum: { rateType: "ig_reel", minimum: 900, anySet: true, work: null },
    }))).toBe("They named a fee of $1,500.");
    expect(floorFree("Their ask: a 30 min video call.")).toBe("Their ask: a 30 min video call.");
    expect(floorFree("Worth one counter at your rate.")).toBe("Worth one counter at your rate.");
    expect(floorFree(null)).toBeNull();
  });

  it("rowFromItem / rowForModel: the next step keeps the offer, never the figure", () => {
    const row = rowFromItem(item());
    expect(row.next?.why).toBe("They offered $1,200 for 3 social posts.");
    const seen = JSON.stringify(rowForModel(row));
    expect(seen).not.toMatch(/1,?750/);
    // Nothing left: the step's own label stands in.
    const bare = rowFromItem(item({ next: { action: "counter", label: "Counter", why: "That's under your minimum of $1,750 each.", due: null, hers: true } as any }));
    expect(bare.next?.why).toBe("Counter");
  });
});
