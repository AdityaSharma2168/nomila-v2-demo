/**
 * goalLogic.test — the capital a goal's domain moves (the typographic goal tile's mini ring) and the horizon her
 * sheets record. Generic goals; no athlete, sport or school.
 */
import { goalCapital, herHorizon } from "./goalLogic";

describe("goal capital", () => {
  it("the domain's capital", () => {
    expect(goalCapital("audience")).toBe("audience");
    expect(goalCapital("content")).toBe("audience");
    expect(goalCapital("owned_venture")).toBe("commercial");
    expect(goalCapital("impact")).toBe("brand");
    expect(goalCapital("relationships")).toBe("performance");
    expect(goalCapital("something_new")).toBe("brand");
  });
});

describe("words", () => {
  it("the horizon she chose", () => {
    expect(herHorizon("multi_year")).toEqual({ kind: "period", period: "multi_year", why: "she chose this horizon" });
  });
});
