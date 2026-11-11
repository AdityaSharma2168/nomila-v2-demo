/**
 * captions.test.ts — what a caption may say, and the closed sets around it.
 *
 * Whether each allowed character actually DRAWS is captionRender.test.ts's job; this suite pins the
 * rule itself, so the two cannot drift apart without one of them going red.
 */
import {
  CAPTION_CHARS_EXCLUDED,
  CAPTION_COLORS,
  DEFAULT_CAPTION_COLOR,
  isCaptionColor,
  CAPTION_MAX_CHARS,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  CAPTION_TEXT_RULE,
  captionCatalog,
  isCaptionCodePoint,
  isCaptionPosition,
  isCaptionStyle,
  normalizeCaptionText,
} from "./captions";

describe("what a caption may say", () => {
  it("passes accented names and ordinary punctuation — the rule is the font, not ASCII", () => {
    for (const ok of [
      "Game day",
      "Peña & Muñoz — it's 3:1!",
      "Šarić, Łukasz, Ångström",
      "“Quoted” … and ‘again’",
      "€50 • 100% #1 @home",
    ]) {
      expect(normalizeCaptionText(ok)).toBe(ok);
    }
  });

  it("refuses an emoji, another alphabet, and a Latin letter Outfit has no glyph for", () => {
    for (const bad of ["go 🔥 now", "日本語", "Привет", "ĉu", "5 µm"]) {
      expect(normalizeCaptionText(bad)).toBeNull();
    }
  });

  it("composes a decomposed accent instead of refusing it", () => {
    // "n" + U+0303 is what some keyboards and every copy-paste from a PDF produce. NFC makes it the
    // single ñ the font has; without it a name she typed correctly is a 400.
    expect(normalizeCaptionText("Peña")).toBe("Peña");
  });

  it("counts CODE POINTS, and the limit is the number in the sentence she is shown", () => {
    expect(normalizeCaptionText("a".repeat(CAPTION_MAX_CHARS))).not.toBeNull();
    expect(normalizeCaptionText("a".repeat(CAPTION_MAX_CHARS + 1))).toBeNull();
    expect(CAPTION_TEXT_RULE).toContain(`${CAPTION_MAX_CHARS} characters`);
  });

  it("keeps two lines, trims each, and refuses a third or a blank one in the middle", () => {
    expect(normalizeCaptionText("  first \r\n second  ")).toBe("first\nsecond");
    expect(normalizeCaptionText("\n\nonly\n")).toBe("only");
    expect(normalizeCaptionText("a\nb\nc")).toBeNull();
    expect(normalizeCaptionText("a\n\nb")).toBeNull();
  });

  it("refuses nothing-to-draw and not-a-string, so an empty caption is never stored", () => {
    for (const bad of ["", "   ", "\n", "\t", null, undefined, 7, {}, ["x"]]) {
      expect(normalizeCaptionText(bad)).toBeNull();
    }
    // A tab is a control character, not spacing she can see the width of.
    expect(normalizeCaptionText("a\tb")).toBeNull();
  });

  it("is closed under uppercasing, because one preset uppercases", () => {
    // The reason µ is excluded: it has a glyph, and its uppercase (Greek Μ) does not. If this goes
    // red after a range is widened, the new character is only drawable in SOME styles.
    const leaks: string[] = [];
    for (let cp = 0x20; cp <= 0x20ac; cp++) {
      if (!isCaptionCodePoint(cp)) continue;
      for (const up of String.fromCodePoint(cp).toUpperCase()) {
        if (!isCaptionCodePoint(up.codePointAt(0)!)) {
          leaks.push(String.fromCodePoint(cp));
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(CAPTION_CHARS_EXCLUDED.has(0xb5)).toBe(true);
  });
});

describe("the closed sets", () => {
  it("declares exactly the positions and styles the client offers", () => {
    expect(Object.keys(CAPTION_POSITIONS).sort()).toEqual([
      "bottom",
      "middle",
      "top",
    ]);
    expect(Object.keys(CAPTION_STYLES).sort()).toEqual([
      "bold",
      "boxed",
      "clean",
    ]);
  });

  it("answers false for a near-miss and for an inherited key", () => {
    for (const bad of ["Top", "TOP", "", null, 0, "toString", "__proto__"]) {
      expect(isCaptionPosition(bad)).toBe(false);
      expect(isCaptionStyle(bad)).toBe(false);
    }
  });

  it("declares exactly the colours the client offers, and white is the one that is never stored", () => {
    expect(Object.keys(CAPTION_COLORS)).toEqual([
      "white",
      "black",
      "yellow",
      "pink",
    ]);
    expect(DEFAULT_CAPTION_COLOR).toBe("white");
    for (const bad of ["White", "#FFFFFF", "red", "", null, "toString"]) {
      expect(isCaptionColor(bad)).toBe(false);
    }
  });

  it("marks a colour dark exactly when it IS dark — the flag decides which way the contrast goes", () => {
    // `dark` flips the shadow and the plate. A colour mislabelled here is black words on a black
    // plate, so the flag is checked against the hex it describes rather than trusted.
    for (const [name, c] of Object.entries(CAPTION_COLORS)) {
      const [r, g, b] = [1, 3, 5].map((i) =>
        parseInt(c.hex.slice(i, i + 2), 16),
      );
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      expect([name, luminance < 0.4]).toEqual([name, c.dark]);
    }
  });

  it("hands the client names, labels and geometry — and nothing that is a path", () => {
    const cat = captionCatalog();
    expect(cat.positions.map((p) => p.name).sort()).toEqual([
      "bottom",
      "middle",
      "top",
    ]);
    expect(cat.styles.map((s) => s.name).sort()).toEqual([
      "bold",
      "boxed",
      "clean",
    ]);
    expect(cat.rule).toBe(CAPTION_TEXT_RULE);
    // What a new caption starts as is one of the names it could be set to — never a third thing.
    expect(isCaptionPosition(cat.defaults.position)).toBe(true);
    expect(isCaptionStyle(cat.defaults.style)).toBe(true);
    expect(cat.defaults.color).toBe(DEFAULT_CAPTION_COLOR);
    expect(cat.colors.map((c) => c.name)).toEqual(Object.keys(CAPTION_COLORS));
    // A swatch for the picker. The wire still carries the NAME — see the spec suite.
    expect(cat.colors.every((c) => /^#[0-9A-F]{6}$/.test(c.hex))).toBe(true);
    expect(JSON.stringify(cat)).not.toMatch(/\.ttf|node_modules|\//);
  });
});
