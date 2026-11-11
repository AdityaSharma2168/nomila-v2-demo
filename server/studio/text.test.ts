/**
 * text.test — semantic caps for model-filled fields: a cap lands on a word, never inside one.
 * ⚠️ MUTATION (text.ts): `s.slice(0, max)` in capWords — the first case reds by name.
 */
import { capTitle, capWords } from "./text";

describe("capWords", () => {
  it("a cap lands on a word, never inside one — and a head that ends exactly on a word keeps it", () => {
    const s =
      "the blur of deliberate preparation before anyone else has arrived at the ground";
    expect(capWords(s, 60)).toBe(
      "the blur of deliberate preparation before anyone else has",
    );
    // 60 characters exactly to "…at the": the next character is a space, so "the" stays.
    const exact =
      "high-speed tactical problem solving under floodlights at the far end";
    expect(capWords(exact, 60)).toBe(
      "high-speed tactical problem solving under floodlights at the",
    );
    expect(capWords(s, 60).length).toBeLessThanOrEqual(60);
    expect(capWords(s, 60)).not.toMatch(/\S-$/);
  });

  it("leaves what fits alone, collapses whitespace, and drops the punctuation a cut leaves dangling", () => {
    expect(capWords("  one   touch,  slowed down ", 200)).toBe(
      "one touch, slowed down",
    );
    expect(
      capWords("calm, focused, and — above all — quiet, deliberate", 24),
    ).toBe("calm, focused, and");
  });

  it("one very long token stands rather than vanishing", () => {
    expect(capWords("supercalifragilisticexpialidocious-ness", 12)).toBe(
      "supercalifra",
    );
  });

  it("a quote cut this way is still a verbatim substring of its source", () => {
    const corpus =
      "The tone should be understated, precise, and quietly confident. Avoid hype language.";
    const cut = capWords(corpus, 40);
    expect(corpus.includes(cut)).toBe(true);
    expect(cut).toBe("The tone should be understated, precise");
  });
});

describe("capTitle", () => {
  it("an over-long title first loses a trailing justification in parentheses, then cuts at a word", () => {
    expect(
      capTitle(
        "rapid-fire iterative repetition (fits her 'fast paced' ask and the brief's understated tone)",
        60,
      ),
    ).toBe("rapid-fire iterative repetition");
    expect(
      capTitle(
        "high-speed tactical problem solving under floodlights at the far end of the pitch (fits",
        60,
      ),
    ).toBe("high-speed tactical problem solving under floodlights at the");
  });

  it("a short title keeps its parenthetical — the aside goes only when the title is over the cap", () => {
    expect(capTitle("one touch (slowed down)", 60)).toBe(
      "one touch (slowed down)",
    );
  });
});
