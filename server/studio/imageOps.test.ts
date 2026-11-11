/**
 * studio/imageOps (PR 19) — the readers' vocabularies, pinned to the style vocabulary they copy, and the edges of the
 * two closed maps. $0, pure. The readers' routing is pinned through `route` in classify.imageOps.test.ts.
 */
import { CAMERA_PHRASES, LIGHTING_PHRASES } from "./compile/style";
import {
  AD_WORDS_COPY,
  CAMERA_ANGLES,
  LIGHT_MEMBERS,
  normalizeWords,
  readCamera,
  readRelight,
  readsQuotedAdd,
  readVague,
} from "./imageOps";
import { AD_WORDS } from "./interpret/menu";

describe("the member lists are the style vocabulary's", () => {
  it("LIGHT_MEMBERS is every lighting member compile/style.ts phrases", () => {
    expect([...LIGHT_MEMBERS].sort()).toEqual(
      Object.keys(LIGHTING_PHRASES).sort(),
    );
  });
  it("every camera angle is a camera member compile/style.ts phrases", () => {
    for (const a of CAMERA_ANGLES)
      expect(CAMERA_PHRASES[a]).toEqual(expect.any(String));
  });
});

describe("the readers answer for the whole sentence or not at all", () => {
  it("a lighting word needs the word lighting: 'make it golden hour' is a look, not a relight", () => {
    expect(readRelight("make it golden hour")).toBeNull();
    expect(
      readRelight("change the lighting to golden hour and remove the cone"),
    ).toBeNull();
    expect(readRelight("Please change the lighting to golden hour.")).toBe(
      "golden_hour",
    );
  });
  it("a shot size is not an angle: tighter is a crop, wider is faded extend", () => {
    expect(readCamera("make it a wide shot")).toBeNull();
    expect(readCamera("make it a close up")).toBeNull();
  });
  it("'make it cooler' is a look, never vague", () => {
    expect(readVague("make it cooler")).toBe(false);
    expect(readVague("make it pop")).toBe(true);
  });
});

describe("the closed maps (R-7)", () => {
  it("maps whole words only, and keeps every other byte", () => {
    expect(normalizeWords("Make the Jersy RD, please!")).toBe(
      "Make the jersey red, please!",
    );
    // Not an edit distance: "rod" and "reds" are not red, "jerseys" is not touched.
    expect(normalizeWords("the rod and the reds and my jerseys")).toBe(
      "the rod and the reds and my jerseys",
    );
  });
  it("leaves 'shades' alone, as objectVocab does on purpose", () => {
    expect(normalizeWords("add shades")).toBe("add shades");
  });
});

describe("the quoted add (R-25)", () => {
  it("reads quoted words after an add verb, and never an apostrophe inside a word", () => {
    expect(readsQuotedAdd("add 'shop now' at the bottom")).toBe(true);
    expect(readsQuotedAdd('add "SWIPE UP" at the bottom')).toBe(true);
    expect(readsQuotedAdd("don't add it, it's fine")).toBe(false);
    expect(readsQuotedAdd("add a ball, it's next to me")).toBe(false);
  });
});

describe("the ad words are the interpreter's own (ADI-R19-W3)", () => {
  it("AD_WORDS_COPY is interpret/menu.ts's AD_WORDS, character for character", () => {
    expect(AD_WORDS_COPY.source).toBe(AD_WORDS.source);
    expect(AD_WORDS_COPY.flags).toBe(AD_WORDS.flags);
  });
});
