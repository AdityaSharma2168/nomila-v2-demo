import { categoryLabel, clicksLine, detectedLine, dollars, formatPrice, moveId, pickMeta, shopRefusal } from "./shopLogic";

describe("shopLogic", () => {
  it("prices: currency when known, a plain amount when not, nothing without a price", () => {
    expect(formatPrice(12900, "USD")).toBe("$129.00");
    expect(formatPrice(999, null)).toBe("9.99");
    expect(formatPrice(null, "USD")).toBeNull();
    expect(formatPrice(-1, "USD")).toBeNull();
  });
  it("what was detected: her Amazon tag; every other network by name", () => {
    expect(detectedLine("amazon", "her-20")).toBe("Amazon · your tag her-20");
    expect(detectedLine("amazon", null)).toBe("Amazon");
    expect(detectedLine("shopify", null)).toBe("Shopify store");
    expect(detectedLine("unknown", null)).toBe("Shop link");
  });
  it("clicks: this week, else this month, else none yet", () => {
    expect(clicksLine(12, 30)).toBe("12 clicks this week");
    expect(clicksLine(1, 1)).toBe("1 click this week");
    expect(clicksLine(0, 3)).toBe("3 clicks this month");
    expect(clicksLine(0, 0)).toBe("No clicks yet");
  });
  it("categories read in plain words", () => {
    expect(categoryLabel("nutrition")).toBe("Food & drink");
    expect(categoryLabel(null)).toBeNull();
  });
});


describe("My Picks helpers", () => {
  it("moves one step; the ends stay put", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    const ids = ["a", "b"];
    expect(moveId(ids, "a", -1)).toBe(ids);
    expect(moveId(ids, "x", 1)).toBe(ids);
  });
  it("row meta: live with clicks, else the status", () => {
    expect(pickMeta("live", 2, 5)).toBe("Live · 2 clicks this week");
    expect(pickMeta("draft", 9, 9)).toBe("Draft");
  });
  it("dollars", () => {
    expect(dollars(65000)).toBe("$650");
    expect(dollars(65050)).toBe("$650.50");
  });
  it("reads the server's refusal back out of the thrown message", () => {
    expect(shopRefusal(new Error(`409: ${JSON.stringify({ code: "needs_confirmation", error: "check", warnings: [{ code: "exclusivity", text: "t" }] })}`)))
      .toEqual({ status: 409, code: "needs_confirmation", error: "check", warnings: [{ code: "exclusivity", text: "t" }], needs: undefined });
    expect(shopRefusal(new Error("500: oops"))).toEqual({ status: 500, code: null, error: "oops" });
    expect(shopRefusal(new Error("network"))).toBeNull();
  });
});
