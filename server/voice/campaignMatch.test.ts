/**
 * campaignMatch.test.ts — the strict matching rule, on its own.
 *
 * No database, no network. The rule is a pure function over strings, and the
 * decisions that make it SAFE (an empty content set never matches, "deal" and
 * "campaign" are scaffolding rather than identity) are decisions about this
 * function — so they are pinned here rather than through the resolver.
 *
 * The live case throughout is the one that motivated the work: an athlete asking
 * about "a FIFA World Cup campaign" for a deal stored under the brand name
 * "Tec-Do", whose campaign nouns live only in the thread's subject and summary.
 */

import { contentWords, haystackOf, matchesAll } from "./campaignMatch";

// The three sources the resolver unions, as they actually appear in prod on
// deal 4062c52d (brand "Tec-Do"). Only the summary carries "FIFA".
const TECDO_SUBJECT = "POPMART x You — World Cup Final content";
const TECDO_SUMMARY =
  "POPMART wants a FIFA World Cup Final reaction video, filming July 17-18.";

// The decoy, real: brand "Poke World Cup" (deal b36c29b3). Its summary carries
// "World Cup" and NOT "FIFA", which is what makes it a tie for one phrasing and
// not the other.
const POKE_SUMMARY = "Poke World Cup wants a tournament recap post.";

describe("contentWords — what counts as identity", () => {
  it("keeps the nouns that name a campaign", () => {
    expect(contentWords("FIFA World Cup")).toEqual(["fifa", "world", "cup"]);
  });

  it("drops the scaffolding an athlete actually speaks", () => {
    // The live utterance. "deals", "about", "a" and "campaign" are how a person
    // asks the question; none of them identify anything.
    expect(
      contentWords("are there any deals about a FIFA World Cup campaign?"),
    ).toEqual(["fifa", "world", "cup"]);
  });

  it("treats punctuation and casing as noise", () => {
    expect(contentWords("the reaction-video deal")).toEqual([
      "reaction",
      "video",
    ]);
  });

  it("keeps digits, which can be the whole identity", () => {
    expect(contentWords("the F1 campaign")).toEqual(["f1"]);
  });

  it("drops single characters, which carry no identity", () => {
    // "POPMART x World Cup" — the x is a separator, not a word. ("you", in the
    // real subject line, is dropped separately as a pronoun.)
    expect(contentWords("POPMART x World Cup")).toEqual([
      "popmart",
      "world",
      "cup",
    ]);
  });

  it("returns nothing for a phrase that is ALL scaffolding", () => {
    // THE LOAD-BEARING GUARD. "the deal" must never be a search that matches
    // every deal the athlete has — see the matchesAll test below.
    expect(contentWords("the deal")).toEqual([]);
    expect(contentWords("that campaign")).toEqual([]);
    expect(contentWords("   ")).toEqual([]);
  });
});

describe("haystackOf — the union across sources", () => {
  it("tokenizes every source into one set", () => {
    const hay = haystackOf([TECDO_SUBJECT, TECDO_SUMMARY]);
    expect(hay.has("world")).toBe(true);
    expect(hay.has("cup")).toBe(true);
    // Only the summary has this one. The union is the point.
    expect(hay.has("fifa")).toBe(true);
  });

  it("ignores null and undefined sources", () => {
    const hay = haystackOf([null, undefined, "World Cup"]);
    expect(hay.has("world")).toBe(true);
    expect(hay.size).toBe(2);
  });

  it("splits on punctuation so a hyphenated phrase still tokenizes", () => {
    const hay = haystackOf(["reaction-video campaign"]);
    expect(hay.has("reaction")).toBe(true);
    expect(hay.has("video")).toBe(true);
  });
});

describe("matchesAll — strict, all content words present", () => {
  const tecdo = haystackOf([TECDO_SUBJECT, TECDO_SUMMARY]);
  const poke = haystackOf([POKE_SUMMARY]);

  it("resolves the live case uniquely", () => {
    const words = contentWords(
      "are there any deals about a FIFA World Cup campaign?",
    );
    expect(matchesAll(words, tecdo)).toBe(true);
    // The decoy has "World Cup" but not "FIFA", so strict matching separates
    // them. This is the whole argument for strict over loose.
    expect(matchesAll(words, poke)).toBe(false);
  });

  it("ties on the looser phrasing, which is what ambiguity is for", () => {
    const words = contentWords("the World Cup deal");
    expect(matchesAll(words, tecdo)).toBe(true);
    expect(matchesAll(words, poke)).toBe(true);
  });

  it("requires EVERY content word, not any", () => {
    // "Olympics" is nowhere in either haystack, so adding it must kill a match
    // that would otherwise land.
    expect(matchesAll(contentWords("World Cup Olympics"), tecdo)).toBe(false);
  });

  it("matches on a single specific word", () => {
    expect(matchesAll(contentWords("the reaction video deal"), tecdo)).toBe(
      true,
    );
  });

  it("NEVER matches on an empty content set", () => {
    // The guard that stops "the deal" from selecting all 185 of an athlete's
    // deals and reporting the first one as the answer.
    expect(matchesAll([], tecdo)).toBe(false);
    expect(matchesAll(contentWords("the deal"), tecdo)).toBe(false);
  });

  it("never matches against an empty haystack", () => {
    expect(matchesAll(contentWords("FIFA World Cup"), haystackOf([null]))).toBe(
      false,
    );
  });

  it("is whole-token, not substring", () => {
    // "cup" must not be satisfied by "cupcake" — a substring rule would make
    // short content words match almost anything.
    const cupcake = haystackOf(["cupcake sponsorship"]);
    expect(matchesAll(contentWords("cup"), cupcake)).toBe(false);
  });
});
