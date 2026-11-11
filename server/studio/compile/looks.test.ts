/**
 * looks.test.ts — what each look sends the model (compile/looks.ts, style vocabulary V.2).
 *
 * The seven new phrases are pinned word for word by the goldens (golden.test.ts, the "look —" fixtures);
 * this pins the mapping: her word → her look's phrase, main's fifteen → themselves, and anything else →
 * itself. Every word and phrase is written out by hand (docs/runbooks/verifying-a-guard-bites.md).
 */
import { LOOK_PHRASES, lookPhrase } from "./looks";

describe("lookPhrase — her word, sent as her look's phrase", () => {
  it("sends each of main's fifteen words as itself — every look prompt compiled before is byte-identical", () => {
    for (const w of [
      "black and white",
      "b&w",
      "monochrome",
      "sepia",
      "golden hour",
      "colour grade",
      "color grade",
      "grading",
      "film look",
      "vintage look",
      "warmer",
      "cooler",
      "brighter",
      "darker",
      "more contrast",
    ]) {
      expect({ w, sent: lookPhrase(w) }).toEqual({ w, sent: w });
    }
  });

  it("sends a new word for one of main's looks as main's own word", () => {
    expect(lookPhrase("retro")).toBe("vintage look");
    expect(lookPhrase("vintage")).toBe("vintage look");
    expect(lookPhrase("higher contrast")).toBe("more contrast");
    expect(lookPhrase("high contrast")).toBe("more contrast");
  });

  it("sends every word for a new look as that look's one phrase", () => {
    const cases: [string, string][] = [
      ["moodier", LOOK_PHRASES.moodier],
      ["moody", LOOK_PHRASES.moodier],
      ["dramatic", LOOK_PHRASES.dramatic],
      ["softer", LOOK_PHRASES.softer],
      ["soft", LOOK_PHRASES.softer],
      ["muted", LOOK_PHRASES.muted],
      ["faded", LOOK_PHRASES.muted],
      ["vibrant", LOOK_PHRASES.vibrant],
      ["punchy", LOOK_PHRASES.vibrant],
      ["punchier", LOOK_PHRASES.vibrant],
      ["cinematic", LOOK_PHRASES.cinematic],
      ["editorial", LOOK_PHRASES.editorial],
    ];
    expect(cases.map(([w]) => [w, lookPhrase(w)])).toEqual(cases);
    // Each opens with the look's name, so the model reads the word she chose before what it means.
    expect(LOOK_PHRASES.moodier.startsWith("moodier — ")).toBe(true);
    expect(LOOK_PHRASES.cinematic).toContain("across the full frame");
  });

  it("sends a change no look knows as itself, as the template always did", () => {
    expect(lookPhrase("teal and orange")).toBe("teal and orange");
    expect(lookPhrase(null)).toBe("null");
  });
});
