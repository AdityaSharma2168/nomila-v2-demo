/**
 * negotiateLogic — pure-function unit tests (no React, no RN, no network).
 * Covers the money-safe primitives behind the Negotiate composer:
 *   - deal category → rate-floor key mapping
 *   - tone → draft-endpoint params
 *   - counter-input sanitation (never a fake number)
 *   - the three-number strip + counter-default rule
 *   - draft-point resolution (server terms vs. static starter set)
 *   - the counter instruction (backed figures only)
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/brief
 */

import {
  rateKeyForCategory,
  toneToDraftParams,
  sanitizeCounterInput,
  resolveThreeNumbers,
  resolveDraftPoints,
  buildCounterInstruction,
  formatMoney,
  STATIC_STARTER_POINTS,
} from "./negotiateLogic";

describe("rateKeyForCategory", () => {
  it("maps content categories to socialPost (the headline per-post anchor)", () => {
    expect(rateKeyForCategory("PAID")).toBe("socialPost");
    expect(rateKeyForCategory("GIFTING")).toBe("socialPost");
    expect(rateKeyForCategory("EDITORIAL")).toBe("socialPost");
  });
  it("maps MEDIA to appearance", () => {
    expect(rateKeyForCategory("MEDIA")).toBe("appearance");
  });
});

describe("toneToDraftParams", () => {
  it("always negotiates; only the style differs", () => {
    expect(toneToDraftParams("friendly")).toEqual({ style: "friendly", reply_intent: "negotiate" });
    expect(toneToDraftParams("professional")).toEqual({ style: "professional", reply_intent: "negotiate" });
  });
});

describe("sanitizeCounterInput", () => {
  it("strips currency formatting to a positive integer", () => {
    expect(sanitizeCounterInput("$1,200")).toBe(1200);
    expect(sanitizeCounterInput("850")).toBe(850);
  });
  it("returns null for empty / zero / garbage (never a fake number)", () => {
    expect(sanitizeCounterInput("")).toBeNull();
    expect(sanitizeCounterInput("0")).toBeNull();
    expect(sanitizeCounterInput("abc")).toBeNull();
  });
});

describe("resolveThreeNumbers", () => {
  it("defaults the counter to the suggested mid", () => {
    expect(resolveThreeNumbers(500, 835)).toEqual({ floor: 500, suggested: 835, counterDefault: 835 });
  });
  it("falls back to the floor when there is no suggested rate", () => {
    expect(resolveThreeNumbers(500, null)).toEqual({ floor: 500, suggested: null, counterDefault: 500 });
  });
  it("uses the suggested mid even when there is no floor", () => {
    expect(resolveThreeNumbers(null, 835)).toEqual({ floor: null, suggested: 835, counterDefault: 835 });
  });
  it("invents nothing when neither figure is backed", () => {
    expect(resolveThreeNumbers(null, null)).toEqual({ floor: null, suggested: null, counterDefault: null });
  });
  it("rejects non-positive / non-finite inputs", () => {
    expect(resolveThreeNumbers(0, -5)).toEqual({ floor: null, suggested: null, counterDefault: null });
    expect(resolveThreeNumbers(NaN, Infinity)).toEqual({ floor: null, suggested: null, counterDefault: null });
  });
});

describe("resolveDraftPoints", () => {
  it("uses scored negotiate terms when present, truncating long chip labels", () => {
    const pts = resolveDraftPoints(["Raise the rate", "Confirm the usage license and full term in writing"]);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ id: "t0", chip: "Raise the rate", term: "Raise the rate" });
    expect(pts[1].chip.endsWith("…")).toBe(true);
    expect(pts[1].term).toBe("Confirm the usage license and full term in writing");
  });
  it("caps at 4 terms", () => {
    expect(resolveDraftPoints(["a", "b", "c", "d", "e"])).toHaveLength(4);
  });
  it("falls back to the static starter set when there are no usable terms", () => {
    expect(resolveDraftPoints([])).toBe(STATIC_STARTER_POINTS);
    expect(resolveDraftPoints(null)).toBe(STATIC_STARTER_POINTS);
    expect(resolveDraftPoints(["   ", ""])).toBe(STATIC_STARTER_POINTS);
  });
  it("prefers draftPoints over negotiateTerms, then falls back to negotiateTerms", () => {
    // draftPoints present → wins
    const withBoth = resolveDraftPoints(["Point A"], ["Term B"]);
    expect(withBoth.map((p) => p.term)).toEqual(["Point A"]);
    // draftPoints empty/absent → negotiateTerms used
    const termsOnly = resolveDraftPoints([], ["Term B"]);
    expect(termsOnly.map((p) => p.term)).toEqual(["Term B"]);
    expect(resolveDraftPoints(null, null)).toBe(STATIC_STARTER_POINTS);
  });
});

describe("buildCounterInstruction", () => {
  it("returns an empty instruction when there is no counter (never invents a rate)", () => {
    expect(buildCounterInstruction(null, 500)).toBe("");
  });
  it("states the counter and, when set, the floor guard rail", () => {
    const withFloor = buildCounterInstruction(850, 500);
    expect(withFloor).toContain("$850");
    expect(withFloor).toContain("$500");
    expect(withFloor.toLowerCase()).toContain("do not go below");
  });
  it("omits the floor clause when there is no floor", () => {
    const noFloor = buildCounterInstruction(850, null);
    expect(noFloor).toContain("$850");
    expect(noFloor.toLowerCase()).not.toContain("below");
  });
});

describe("formatMoney", () => {
  it("formats whole dollars with US grouping", () => {
    expect(formatMoney(1000)).toBe("$1,000");
    expect(formatMoney(835.4)).toBe("$835");
  });
});
