/**
 * deckFacts.test.ts — the Nomi Card's fact hygiene: same-meaning claims collapse (never across years, never distinct
 * honours), uniqueness claims need a fact that makes them, the audience chart comes from one source, and the media
 * filters keep reposts, burned-in text and brand-led content off the card.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("./followers", () => ({ readFollowers: async () => ({ counts: {}, asOf: null }) }));
jest.mock("../lib/models", () => ({ GEMINI: { flash: "s", pro: "s" }, genai: () => ({}) }));
jest.mock("../lib/mediaStore", () => ({ readObject: async () => null, signedUrl: async () => "" }));

import { audienceBreakdownFrom, dedupeClaims, sameClaim, unbackedUniqueness } from "./deckFacts";
import { hasBurnedInText, isPromotional } from "./mediaSearch";

describe("record: same-meaning claims collapse", () => {
  const ranked = [
    { name: "First Indian-American to represent US at FIFA World Cup (U-17 co-captain)", year: 2022 },
    { name: "Co-captained United States team at 2022 FIFA U-17 Women's World Cup", year: 2022 },
    { name: "First Indian-American player to represent US at FIFA World Cup", year: 2022 },
    { name: "First player of Indian descent to represent the U.S. at any FIFA World Cup tournament", year: 2022 },
    { name: "Ohio Valley Conference U18/19 Player of the Year", year: 2022 },
    { name: "Second-team All-ACC", year: 2024 },
    { name: "First-team All-ACC", year: 2025 },
  ];
  it("keeps the first of each group, in order, then the distinct milestones", () => {
    expect(dedupeClaims(ranked).map((a) => a.name)).toEqual([
      ranked[0].name, ranked[4].name, ranked[5].name, ranked[6].name,   // the co-captaincy is in the marquee line already
    ]);
  });
  it("never collapses the same honour in different years, or different honours", () => {
    expect(sameClaim({ name: "ACC Tournament champion", year: 2024 }, { name: "ACC Tournament champion", year: 2025 })).toBe(false);
    expect(sameClaim({ name: "All-America fourth team", year: 2024 }, { name: "All-ACC second team", year: 2024 })).toBe(false);
  });
});

describe("uniqueness claims need a fact", () => {
  const facts = ["Reported as the first player of Indian descent to represent the US at a FIFA tournament."];
  it("drops an 'only' claim no fact makes, keeps a 'first' claim a fact makes", () => {
    expect(unbackedUniqueness("She is the only voice telling this story.", facts)).toBe(true);
    expect(unbackedUniqueness("The first through the door, still holding it open.", facts)).toBe(false);
    expect(unbackedUniqueness("The first to wear it all season.", ["Named team captain."])).toBe(true);
    expect(unbackedUniqueness("A captain's season, worn honestly.", [])).toBe(false);
  });
});

describe("audience: one source", () => {
  it("orders ages, ranks genders, splits platforms from follower counts", () => {
    const b = audienceBreakdownFrom(
      { age: [{ key: "25-34", pct: 23 }, { key: "13-17", pct: 16 }, { key: "18-24", pct: 30 }], gender: [{ key: "U", pct: 35 }, { key: "F", pct: 38 }, { key: "M", pct: 27 }] },
      { instagram: 21733, tiktok: 15434, youtube: null },
    );
    expect(b.ages.map((a) => a.label)).toEqual(["13-17", "18-24", "25-34"]);
    expect(b.genders[0]).toEqual({ label: "Women", pct: 38 });
    expect(b.platforms.map((p) => p.label)).toEqual(["Instagram", "TikTok"]);
    expect(b.platforms[0].pct + b.platforms[1].pct).toBe(100);
  });
  it("is empty, not invented, without data", () => {
    expect(audienceBreakdownFrom(undefined, {})).toEqual({ ages: [], genders: [], platforms: [] });
  });
});

describe("media filters", () => {
  it("spots burned-in text in the tagger's own words, current or previous tagging", () => {
    expect(hasBurnedInText({ description: "A swimmer with a text overlay 'pov: double days'." })).toBe(true);
    expect(hasBurnedInText({ description: "Team celebration.", prev: { reason: "contains text overlays that should be removed" } })).toBe(true);
    expect(hasBurnedInText({ description: "The athlete mid-stride on the field." })).toBe(false);
  });
  it("spots brand-led content", () => {
    expect(isPromotional({ description: "A promotional video featuring the athlete and jewelry." })).toBe(true);
    expect(isPromotional({ shot_type: "text_graphic", description: "Graphic." })).toBe(true);
    expect(isPromotional({ description: "The athlete in her team kit, smiling." })).toBe(false);
  });
});

import { cachedFrameText, FRAME_TEXT_PROMPT } from "./frameText";
describe("frame text cache", () => {
  it("reads the cached answer only for the same frame", () => {
    const meta = { frame_text: { path: "a/b.jpg", burned_in_text: true } };
    expect(cachedFrameText(meta, "a/b.jpg")).toBe(true);
    expect(cachedFrameText(meta, "a/other.jpg")).toBeNull();
    expect(cachedFrameText(null, "a/b.jpg")).toBeNull();
    expect(FRAME_TEXT_PROMPT).toMatch(/Ignore text that is part of the real scene/);
  });
});
