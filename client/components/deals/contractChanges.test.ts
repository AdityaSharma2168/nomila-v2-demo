/**
 * The block that says what a contract is about to replace.
 *
 * The trap this is written against: the deal's figures arrive in integer cents from the
 * resolver, and the form holds dollars. Compare them in the wrong unit and every single
 * unchanged figure reports as changed — which turns the whole block into noise and teaches
 * her to ignore it, which is worse than not having it.
 *
 * The gorjana case is the one that matters most, because her emails and her contract
 * AGREE. Nothing should look like it moved.
 */

import { contractChanges, type CurrentTerms, type FormTerms } from "./contractChanges";

const deal = (over: Partial<CurrentTerms> = {}): CurrentTerms => ({
  cashCents: 750_000, productCents: 650_000,
  termStart: null, termEnd: null,
  periodCount: 1, installmentCount: 0,
  ...over,
});

const form = (over: Partial<FormTerms> = {}): FormTerms => ({
  cash: 7500, product: 6500, termStart: "", termEnd: "", periodCount: 1,
  ...over,
});

describe("what a contract changes about a deal she already has", () => {
  it("shows nothing for a deal that has nothing to replace", () => {
    expect(contractChanges(null, form())).toEqual([]);
  });

  it("gorjana: the contract confirms the figures, so nothing reads as changed", () => {
    // $7,500 cash and $6,500 product, agreeing on both sides. 750000 cents vs 7500 dollars
    // is the exact comparison that reports false differences when the units are crossed.
    const rows = contractChanges(deal(), form());
    expect(rows.every((r) => !r.changed)).toBe(true);
    expect(rows.find((r) => r.key === "This year's cash")?.now).toBe("$7,500");
  });

  it("still LISTS the figures it confirms", () => {
    // Showing only differences leaves her checking the rest herself to see what moved.
    const keys = contractChanges(deal(), form()).map((r) => r.key);
    expect(keys).toContain("This year's cash");
    expect(keys).toContain("Product");
  });

  it("marks a real change, with the old figure struck through", () => {
    const rows = contractChanges(deal(), form({ cash: 9000 }));
    const cash = rows.find((r) => r.key === "This year's cash")!;
    expect(cash.changed).toBe(true);
    expect(cash.was).toBe("$7,500");
    expect(cash.now).toBe("$9,000");
  });

  it("calls a figure the deal never had an addition, not a change", () => {
    const rows = contractChanges(deal({ productCents: null }), form());
    const p = rows.find((r) => r.key === "Product")!;
    expect(p.was).toBeNull();      // the screen renders this as "added"
    expect(p.changed).toBe(true);
  });

  it("omits a figure neither side has ever had", () => {
    const rows = contractChanges(deal({ productCents: null }), form({ product: null }));
    expect(rows.map((r) => r.key)).not.toContain("Product");
  });

  it("does not silently drop a figure she has cleared", () => {
    // She deleted the cash box. That is a change from $7,500 to nothing, and she must see
    // it — a blank that quietly keeps the old value is the worst outcome here.
    const rows = contractChanges(deal(), form({ cash: null }));
    const cash = rows.find((r) => r.key === "This year's cash")!;
    expect(cash.changed).toBe(true);
    expect(cash.was).toBe("$7,500");
    expect(cash.now).toBe("—");
  });

  it("reports a term the deal never carried", () => {
    const rows = contractChanges(deal(), form({ termStart: "2026-08-12", termEnd: "2027-08-11" }));
    const t = rows.find((r) => r.key === "Term")!;
    expect(t.was).toBeNull();
    expect(t.now).toBe("2026-08-12 – 2027-08-11");
    expect(t.changed).toBe(true);
  });

  it("leaves the term row out when neither side has one", () => {
    expect(contractChanges(deal(), form()).map((r) => r.key)).not.toContain("Term");
  });

  it("flags the schedule growing from one lump to several years", () => {
    // The change least visible in the figures and most worth naming: adidas arriving as
    // four contract years where the deal held a single amount.
    const rows = contractChanges(deal(), form({ periodCount: 4 }));
    const s = rows.find((r) => r.key === "Periods")!;
    expect(s.was).toBe("1");
    expect(s.now).toBe("4");
    expect(s.changed).toBe(true);
  });

  it("says nothing about the schedule when its shape is unchanged", () => {
    expect(contractChanges(deal(), form()).map((r) => r.key)).not.toContain("Periods");
  });

  it("formats money as she would write it, never abbreviated", () => {
    // usdShort turns 750000 into "$7.5K", which is right on a card and wrong beside a
    // field she is editing — she cannot tell whether $7.5K matches what she typed.
    const rows = contractChanges(deal({ cashCents: 12_345_600 }), form({ cash: 123_456 }));
    expect(rows[0].now).toBe("$123,456");
    expect(rows[0].changed).toBe(false);
  });
});
