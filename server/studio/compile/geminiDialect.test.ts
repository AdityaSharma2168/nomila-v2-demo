/**
 * geminiDialect.test.ts — the Gemini 3 Pro Image dialect's own pieces (quality-scrappy piece 7): where each rule comes
 * from, the canvas sentence per kind of call, and the exact-text line. What each piece does to every real prompt is
 * compile/golden.test.ts's ("the Gemini image dialect over every golden"), with the mutations.
 */
import {
  DEFAULT_TEXT_FONT,
  GEMINI_IMAGE_RULES,
  canvasSentence,
  exactTextLine,
} from "./geminiDialect";

describe("where each rule comes from", () => {
  it("four are Google's, read first-hand; the fifth is ours and says so", () => {
    const from = Object.fromEntries(
      Object.entries(GEMINI_IMAGE_RULES).map(([k, r]) => [k, r.from]),
    );
    expect(from).toEqual({
      roles: "google",
      keep: "google",
      canvas: "google",
      text: "google",
      exactText: "ours",
    });
    for (const r of Object.values(GEMINI_IMAGE_RULES))
      if (r.from === "google") expect(r.source).toMatch(/^https:\/\//);
    expect(GEMINI_IMAGE_RULES.exactText.source).toContain("not Google's");
  });

  it("the default face is a widely known bold sans, not the captions' Outfit", () => {
    expect(DEFAULT_TEXT_FONT).toBe("Helvetica Bold");
  });
});

describe("canvasSentence", () => {
  it("a generate is told what to make; an edit, the shape it keeps; a masked edit, the crop's", () => {
    expect(canvasSentence("4:5", "generate")).toBe("A 4:5 portrait image.");
    expect(canvasSentence("2:3", "edit")).toBe(
      "Keep the photograph's 2:3 portrait shape.",
    );
    expect(canvasSentence("1:1", "crop")).toBe(
      "Keep this image's 1:1 square shape.",
    );
    expect(canvasSentence("16:9", "edit")).toBe(
      "Keep the photograph's 16:9 landscape shape.",
    );
  });

  it("no canvas pinned, or one that is not a ratio: nothing is said rather than a guess", () => {
    expect(canvasSentence(null, "edit")).toBeNull();
    expect(canvasSentence("portrait", "generate")).toBeNull();
    expect(canvasSentence("0:5", "edit")).toBeNull();
  });
});

describe("exactTextLine (rule 5, ours)", () => {
  it("states the words a headline adds, exactly and in the positive", () => {
    expect(exactTextLine([{ op: "DISPLAY_TEXT", change: "GET LOUD" }])).toBe(
      'Any text added to the image is exactly: "GET LOUD".',
    );
  });

  it("an ad names its logo after the words, so the line never contradicts the logo's own clause", () => {
    expect(
      exactTextLine([
        { op: "DISPLAY_TEXT", change: "RISE ABOVE" },
        { op: "CHANGE_BACKGROUND", change: "a pitch at dawn" },
        { op: "BRAND_MARK", change: "nike" },
      ]),
    ).toBe(
      'Any text added to the image is exactly: "RISE ABOVE", plus the nike logo.',
    );
  });

  it("her words keep their fence inside the quotes", () => {
    expect(
      exactTextLine([
        { op: "DISPLAY_TEXT", change: "GAME DAY", fenced: "GAME DAY" },
      ]),
    ).toBe(
      'Any text added to the image is exactly: "<external_content>GAME DAY</external_content>".',
    );
  });

  it("an edit that adds no words — a logo alone, a recolour — carries no line", () => {
    expect(exactTextLine([{ op: "BRAND_MARK", change: "nike" }])).toBeNull();
    expect(
      exactTextLine([{ op: "RECOLOR", change: "black and green" }]),
    ).toBeNull();
  });
});
