/**
 * sportVocab.test.ts — the question "did her sentence name a sport?", pinned.
 *
 * ⚠️ EVERY EXPECTATION BELOW IS HAND-WRITTEN, AND THAT IS THE POINT. A suite that iterates
 * SPORT_NOUNS and asserts each entry resolves cannot see a DELETION — shrink the list and it
 * iterates fewer times and reports green. `GARMENT_NOUNS` lost "socks" that way and all 884 tests
 * passed (docs/runbooks/verifying-a-guard-bites.md). The membership block names its words out loud
 * so removing one goes red.
 */
import { namesSport, SPORT_NOUNS } from "./sportVocab";

describe("namesSport — the sentence answered the question", () => {
  it("finds the sport when it modifies the artifact — the live failing case", () => {
    expect(namesSport("create an adidas basketball ad featuring me")).toBe("basketball");
    expect(namesSport("create an adidas soccer ad featuring me")).toBe("soccer");
  });

  it("is case- and position-insensitive", () => {
    expect(namesSport("A SOCCER POSTER")).toBe("soccer");
    expect(namesSport("make me a poster, soccer")).toBe("soccer");
  });

  it("reads equipment as naming the sport — documented, not accidental", () => {
    // Only reachable on a generate (buildPrompt renders the register for mode "generate" alone),
    // where the picture being made really is a soccer picture. See the module header.
    expect(namesSport("a poster with a soccer ball at my feet")).toBe("soccer");
  });
});

describe("namesSport — the sentence did NOT answer it", () => {
  it("returns null for a direction with no sport, so the profile still fills the gap", () => {
    expect(namesSport("create an adidas ad featuring me")).toBeNull();
    expect(namesSport("Grow her audience with something that reads as hers, not as an ad")).toBeNull();
    expect(namesSport("put me on a rooftop at dusk")).toBeNull();
  });

  it("returns null for empty and non-string input rather than throwing", () => {
    expect(namesSport("")).toBeNull();
    expect(namesSport("   ")).toBeNull();
    expect(namesSport(null)).toBeNull();
    expect(namesSport(undefined)).toBeNull();
    expect(namesSport(42)).toBeNull();
  });

  it("will not match a sport inside a longer word", () => {
    // Word boundaries are what keep "squashed" out. Without them this returns "squash" and the
    // athlete's real sport is dropped from a brief that never mentioned one.
    expect(namesSport("the can looks squashed")).toBeNull();
    expect(namesSport("golfing")).toBeNull();
    expect(namesSport("footballer")).toBeNull();
  });
});

describe("namesSport — which sport, when several could match", () => {
  it("prefers the longer sport over the shorter one inside it", () => {
    // Scanning in list order would answer "volleyball" and "hockey" here. Both are the wrong half
    // of the sport she named, and the caller suppresses a profile field on the answer.
    expect(namesSport("a beach volleyball poster")).toBe("beach volleyball");
    expect(namesSport("a field hockey poster")).toBe("field hockey");
    expect(namesSport("an ice hockey poster")).toBe("ice hockey");
    expect(namesSport("a flag football poster")).toBe("flag football");
    expect(namesSport("a track and field poster")).toBe("track and field");
  });

  it("takes the first sport by POSITION when two different sports appear", () => {
    expect(namesSport("a soccer ad, not a basketball one")).toBe("soccer");
    expect(namesSport("a basketball ad, not a soccer one")).toBe("basketball");
  });
});

describe("SPORT_NOUNS membership — written out so a deletion cannot pass", () => {
  it("carries the words the observed cases depend on", () => {
    expect(SPORT_NOUNS).toContain("soccer");
    expect(SPORT_NOUNS).toContain("basketball");
    expect(SPORT_NOUNS).toContain("football");
    expect(SPORT_NOUNS).toContain("volleyball");
    expect(SPORT_NOUNS).toContain("beach volleyball");
    expect(SPORT_NOUNS).toContain("hockey");
    expect(SPORT_NOUNS).toContain("field hockey");
    expect(SPORT_NOUNS).toContain("track and field");
  });

  it("holds every multi-word sport, which is what the longest-first sort exists for", () => {
    const multiWord = SPORT_NOUNS.filter((s) => s.includes(" "));
    expect([...multiWord].sort()).toEqual([
      "beach volleyball",
      "cross country",
      "field hockey",
      "flag football",
      "ice hockey",
      "track and field",
      "water polo",
    ]);
  });

  it("is lowercase and free of duplicates — matching folds case, so a stray capital is dead weight", () => {
    for (const s of SPORT_NOUNS) expect(s).toBe(s.toLowerCase().trim());
    expect(new Set(SPORT_NOUNS).size).toBe(SPORT_NOUNS.length);
  });
});
