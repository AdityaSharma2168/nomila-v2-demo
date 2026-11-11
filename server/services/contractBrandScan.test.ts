/**
 * Naming the brand on a contract without a model.
 *
 * The cases below are the real ones. Her adidas contract is signed by "adidas America,
 * Inc." and her gorjana contract by "GORJANA & GRIFFIN, LLC"; her brand rows say "adidas"
 * and "gorjana". Matching the first to the second needs fuzzy logic and gets it wrong —
 * measured across her 175 brands, a 0.5 trigram threshold paired `ccsu edu` with `sjsu
 * edu` and `care` with `lucy care`.
 *
 * Searching the document for names she already has has no such problem, and these tests
 * pin the two properties that make it safe: whole-word matching, and a floor on how short
 * a brand name can be before it stops being evidence.
 */

// mentionedBrands is pure, but its module imports db for the query half. Stubbed rather
// than started: a string matcher should not need a database to be tested.
jest.mock("../db", () => ({ db: {} }));

import { mentionedBrands } from "./contractBrandScan";

const BRANDS = [
  { id: 164, name: "gorjana" },
  { id: 52,  name: "adidas" },
  { id: 91,  name: "care" },          // real row; four letters and a substring of much
  { id: 30,  name: "on" },            // real row; two letters, below the floor
  { id: 77,  name: "lululemon" },
  { id: 88,  name: "U.S. Soccer" },   // punctuation, which must survive escaping
];

// The opening of her actual signed agreement.
const GORJANA_TEXT = `
ATHLETE ENDORSEMENT AGREEMENT
This Influencer/Athlete Endorsement Agreement ("Agreement") is made and entered into as of
August 12, 2026 (the "Effective Date"), by and between GORJANA & GRIFFIN, LLC, a Delaware
limited liability company dba GORJANA jewelry (the "Company"), on the one hand, and the
athlete whose name appears below ("Talent"). Talent shall wear the gorjana Endorsed
Products exclusively in public and at all competitions.
`;

describe("naming the brand from the document itself", () => {
  it("finds the brand she already has behind the legal entity name", () => {
    // The document says "GORJANA & GRIFFIN, LLC". Her row says "gorjana". No normalisation
    // gets from one to the other safely — but the document says "gorjana" too.
    const hits = mentionedBrands(GORJANA_TEXT, BRANDS);
    expect(hits[0].brand_id).toBe(164);
    expect(hits[0].name).toBe("gorjana");
    expect(hits[0].mentions).toBeGreaterThanOrEqual(3);
  });

  it("ranks by how often the document leans on a name, not by name length", () => {
    const text = "A one-off mention of adidas. " + "gorjana ".repeat(12);
    const hits = mentionedBrands(text, BRANDS);
    expect(hits[0].name).toBe("gorjana");
    expect(hits[1].name).toBe("adidas");
  });

  it("breaks a tie on whichever is named first — parties appear up front", () => {
    const hits = mentionedBrands("adidas and lululemon", BRANDS);
    expect(hits.map((h) => h.name)).toEqual(["adidas", "lululemon"]);
  });

  it("matches whole words only, so a short brand cannot hide inside a longer one", () => {
    // "care" is a real brand row. Without word boundaries it matches healthcare, careful,
    // caregiver — and a contract mentioning "healthcare coverage" would be filed under it.
    const hits = mentionedBrands("Talent is responsible for healthcare and careful conduct.", BRANDS);
    expect(hits).toHaveLength(0);
  });

  it("still finds a short brand when the document really does name it", () => {
    const hits = mentionedBrands("This agreement is with care, a skincare company.", BRANDS);
    expect(hits.map((h) => h.name)).toContain("care");
  });

  it("ignores names too short to be evidence", () => {
    // "on" is a real brand (On Running) and appears in every contract ever written.
    const hits = mentionedBrands("The parties agree on the terms set out on Schedule A.", BRANDS);
    expect(hits.map((h) => h.name)).not.toContain("on");
  });

  it("treats punctuation in a brand name as literal, not as a pattern", () => {
    // "U.S. Soccer" contains regex metacharacters. Unescaped, "." matches any character
    // and the name would match "UXS! Soccer" — or throw.
    expect(mentionedBrands("Sponsored by U.S. Soccer.", BRANDS).map((h) => h.name)).toContain("U.S. Soccer");
    expect(mentionedBrands("Sponsored by UXSY Soccer.", BRANDS).map((h) => h.name)).not.toContain("U.S. Soccer");
  });

  it("is case-insensitive — contracts shout their party names", () => {
    expect(mentionedBrands("GORJANA & GRIFFIN, LLC", BRANDS)[0].brand_id).toBe(164);
    expect(mentionedBrands("Gorjana", BRANDS)[0].brand_id).toBe(164);
  });

  it("says nothing rather than guessing when the brand is new to her", () => {
    // The honest outcome for a first contract with a brand she has never worked with.
    // The screen then offers "a new deal" instead of a wrong suggestion.
    expect(mentionedBrands("An agreement with Oakley, Inc.", BRANDS)).toEqual([]);
  });

  it("reports where the first mention sits, so a passing reference can be judged", () => {
    const hits = mentionedBrands("x".repeat(400) + " gorjana", BRANDS);
    expect(hits[0].first_at).toBeGreaterThan(300);
  });

  it("survives a brand row with an empty or missing name", () => {
    const odd = [{ id: 1, name: null }, { id: 2, name: "   " }, { id: 164, name: "gorjana" }];
    expect(mentionedBrands("gorjana", odd).map((h) => h.brand_id)).toEqual([164]);
  });
});
