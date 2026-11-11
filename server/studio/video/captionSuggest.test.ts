/**
 * captionSuggest.test.ts — a caption by rule: deterministic, bounded by the stitch spec's own rule, and
 * never generic (PR 15, R-5).
 */
import { captionFrom, suggestCaption } from "./captionSuggest";
import { CAPTION_MAX_CHARS, normalizeCaptionText } from "./captions";

const SENTENCES = [
  "She walks off the court at golden hour, the crowd behind her.",
  "Slow push-in on the boots — laces first, then the badge.",
  "A deserted stadium at dawn; floodlights still on.",
  "Game day: the tunnel, the noise, the walk out",
  "the gym, empty, before anyone else is in",
  "Peña & Muñoz — it's 3:1!",
  "A single sentence with no punctuation that keeps going and going far past the sixty character line the stitch allows",
  "Averyveryveryveryveryveryveryveryveryveryveryveryveryveryveryveryverylongword without a space early",
  "Ok",
  "   ",
  "🔥 fire emoji opener, the crowd goes wild tonight",
  '"Quoted opener," she said',
];

describe("captionFrom — the leading clause of one sentence", () => {
  it("takes the clause before the first sentence end or hard break, capitalised", () => {
    expect(captionFrom(SENTENCES[0])).toBe(
      "She walks off the court at golden hour",
    );
    expect(captionFrom(SENTENCES[1])).toBe("Slow push-in on the boots");
    expect(captionFrom(SENTENCES[2])).toBe("A deserted stadium at dawn");
    expect(captionFrom('"Quoted opener she said," and left.')).toBe(
      "Quoted opener she said",
    );
  });

  it("a label of two words or fewer is not a caption — a clause cut short by a colon or a comma included", () => {
    expect(captionFrom("Ok")).toBeNull();
    expect(captionFrom("The gym.")).toBeNull();
    expect(captionFrom("   ")).toBeNull();
    expect(captionFrom(SENTENCES[3])).toBeNull(); // "Game day"
    expect(captionFrom(SENTENCES[4])).toBeNull(); // "The gym"
    expect(captionFrom(SENTENCES[11])).toBeNull(); // "Quoted opener"
  });

  /**
   * ⚠️ MUTATION: skip the cut (return the clause whole past the cap) — "a caption suggestion exceeds
   * CAPTION_MAX_CHARS" reds by name below, through `normalizeCaptionText` returning null for it.
   */
  it("a caption suggestion exceeds CAPTION_MAX_CHARS — never: a long clause is cut at a word and ends on an ellipsis", () => {
    const out = captionFrom(SENTENCES[6]);
    expect(out).not.toBeNull();
    expect(Array.from(out!).length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(out!.endsWith("…")).toBe(true);
    expect(out).toBe(
      "A single sentence with no punctuation that keeps going and…",
    );
  });

  it("a word too long to cut inside the cap gives nothing rather than a broken word", () => {
    expect(captionFrom(SENTENCES[7])).toBeNull();
  });

  it("what the font cannot draw is not suggested — an emoji opener is null, not stripped", () => {
    expect(captionFrom(SENTENCES[10])).toBeNull();
  });

  it("P-caption: every non-null answer passes the stitch spec's own rule, and the same input gives the same answer", () => {
    for (const s of SENTENCES) {
      const a = captionFrom(s);
      for (let i = 0; i < 100; i++) expect(captionFrom(s)).toBe(a);
      if (a !== null) {
        expect(normalizeCaptionText(a)).toBe(a);
        expect(Array.from(a).length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
        expect(a.includes("\n")).toBe(false);
      }
    }
  });
});

describe("suggestCaption — the board's suggestion", () => {
  it("is the first non-empty row sentence's clause; blank leading rows are skipped", () => {
    expect(suggestCaption({ feel: ["", "  ", SENTENCES[0]] })).toEqual({
      suggestion: "She walks off the court at golden hour",
    });
  });

  /** ⚠️ Adi's D-3: never a generic caption. The objective alone is NOT words. */
  it("with no sentence there is no suggestion — the objective never becomes a caption", () => {
    expect(suggestCaption({ feel: [], objective: "grow-following" })).toEqual({
      suggestion: null,
    });
    expect(suggestCaption({ feel: ["", " "], objective: "recap" })).toEqual({
      suggestion: null,
    });
  });

  it("refuses a body that is not a sentence list, in the music suggestion's words", () => {
    expect(suggestCaption({})).toHaveProperty("error");
    expect(suggestCaption({ feel: "one" })).toHaveProperty("error");
    expect(suggestCaption({ feel: [1] })).toHaveProperty("error");
    expect(suggestCaption({ feel: ["x"], objective: 3 })).toEqual({
      error: "objective is a name",
    });
  });
});
