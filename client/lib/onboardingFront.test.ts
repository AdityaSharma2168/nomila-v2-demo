/**
 * onboardingFront.test — the sport grid's pure rules: "Other" as a search (filterSports), the typed sport it would add
 * (sportToAdd, only when the words match no tile), adding it (addSport), the picks with no tile (picksOutside), Mila's
 * eight chat chips (COMMON_SPORTS, all from the one list), and the existing pick rules they build on.
 */
import { SPORTS } from "../../shared/sports";
import { COMMON_SPORTS, SPORT_TILES, addSport, filterSports, picksOutside, sportByLabel, sportMark, sportToAdd, sportsToSave, toggleSport } from "./onboardingFront";

jest.mock("./query-client", () => ({ getApiUrl: () => "http://localhost" }));

describe("Other as a search", () => {
  it("an empty search shows every tile, in the list's order", () => {
    expect(filterSports("")).toEqual([...SPORT_TILES]);
    expect(filterSports("   ")).toEqual([...SPORT_TILES]);
  });

  it("filters by a case-insensitive substring of the label, spacing ignored", () => {
    expect(filterSports("vol")).toEqual(["Volleyball", "Beach volleyball"]);
    expect(filterSports("  SWIM ")).toEqual(["Swimming", "Artistic swimming"]);
    expect(filterSports("track  and")).toEqual(["Track and field"]);
    expect(filterSports("ultimate")).toEqual([]);
  });

  it("offers to add the words only when they match no tile", () => {
    expect(sportToAdd("vol")).toBe("");
    expect(sportToAdd("golf")).toBe("");
    expect(sportToAdd("")).toBe("");
    expect(sportToAdd("  Ultimate   frisbee ")).toBe("Ultimate frisbee");
    expect(sportToAdd("x".repeat(100))).toHaveLength(80);
  });

  it("adding appends the typed sport, never twice, and a tile's own name is that tile", () => {
    expect(addSport(["Soccer"], "Ultimate frisbee")).toEqual(["Soccer", "Ultimate frisbee"]);
    expect(addSport(["Soccer", "Ultimate frisbee"], "ultimate frisbee")).toEqual(["Soccer", "Ultimate frisbee"]);
    expect(addSport([], "  golf ")).toEqual(["Golf"]);
    expect(addSport([], "Ultimate")).toEqual(sportsToSave([], "Ultimate"));
  });

  it("an added sport is a pick like any other: first is main, toggling it off promotes the next", () => {
    const p = addSport([], "Ultimate frisbee");
    expect(sportMark(p, "Ultimate frisbee")).toBe("main");
    const q = toggleSport([...p, "Soccer"], "Ultimate frisbee");
    expect(sportMark(q, "Soccer")).toBe("main");
  });
});

describe("picks with no tile", () => {
  it("the grid shows typed sports as pills; the chat also shows full-list picks", () => {
    expect(picksOutside(["Soccer", "Ultimate frisbee"])).toEqual(["Ultimate frisbee"]);
    expect(picksOutside(["Soccer", "Golf", "Ultimate frisbee"], COMMON_SPORTS)).toEqual(["Golf", "Ultimate frisbee"]);
    expect(picksOutside(["soccer"], COMMON_SPORTS)).toEqual([]);
  });
});

describe("Mila's chat chips", () => {
  it("are eight sports from the one list, each with its icon", () => {
    expect(COMMON_SPORTS).toHaveLength(8);
    for (const s of COMMON_SPORTS) expect(sportByLabel(s)?.icon).toBeTruthy();
    expect(COMMON_SPORTS.every((s) => SPORTS.some((x) => x.label === s))).toBe(true);
  });

  it("sportByLabel finds a tile ignoring case; a typed sport has none", () => {
    expect(sportByLabel("track and field")?.id).toBe("track_field");
    expect(sportByLabel("Ultimate frisbee")).toBeUndefined();
  });
});
