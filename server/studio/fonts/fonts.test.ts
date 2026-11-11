/**
 * fonts.test.ts — every typeface on offer is a file we ship, at a weight we pinned, under a
 * licence that is written down in the repo.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { CAPTION_STYLES, isCaptionCodePoint } from "../video/captions";
import {
  CAPTION_FONTS,
  CAPTION_FONT_HOLES,
  CAPTION_WEIGHTS,
  DEFAULT_CAPTION_FONT,
  fontCannotDraw,
  fontFaceFor,
  isCaptionFontId,
  type CaptionFontId,
  type FontDefinition,
} from "./fonts";

const fonts = Object.entries(CAPTION_FONTS as Record<string, FontDefinition>);
const pkgJson = JSON.parse(
  readFileSync(join(__dirname, "../../../package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const packageDir = (pkg: string) =>
  dirname(require.resolve(`${pkg}/package.json`));

describe("a catalogued font ships with its licence", () => {
  it("comes from a package whose LICENSE_FONT is beside the fonts", () => {
    // Why big-shoulders-display is not here. Named per entry, so the one that breaks is the one read.
    for (const [id, f] of fonts) {
      expect([
        id,
        existsSync(join(packageDir(f.package), "LICENSE_FONT")),
      ]).toEqual([id, true]);
    }
  });

  it("has the same licence text committed in the repo, byte for byte", () => {
    for (const [id, f] of fonts) {
      const committed = readFileSync(join(__dirname, f.licenseFile));
      const shipped = readFileSync(join(packageDir(f.package), "LICENSE_FONT"));
      expect([id, committed.equals(shipped)]).toEqual([id, true]);
      expect([
        id,
        committed
          .toString("utf8")
          .includes("SIL OPEN FONT LICENSE Version 1.1"),
      ]).toEqual([id, true]);
    }
  });

  it("comes from a runtime dependency, so the container has it under --omit=dev", () => {
    for (const [id, f] of fonts) {
      expect([id, f.package in pkgJson.dependencies]).toEqual([id, true]);
      expect([id, f.package in (pkgJson.devDependencies ?? {})]).toEqual([
        id,
        false,
      ]);
    }
  });
});

describe("weights are pinned for what the renderer asks for", () => {
  it("covers exactly the weights the caption styles use — no more, no fewer", () => {
    const requested = [
      ...new Set(Object.values(CAPTION_STYLES).map((s) => s.weight)),
    ].sort();
    expect([...CAPTION_WEIGHTS].sort()).toEqual(requested);
    for (const [id, f] of fonts) {
      expect([id, Object.keys(f.faces).map(Number).sort()]).toEqual([
        id,
        requested,
      ]);
    }
  });

  it("resolves every face to a TrueType file whose name states the weight we claim", () => {
    for (const [id, f] of fonts) {
      for (const w of CAPTION_WEIGHTS) {
        const face = fontFaceFor(id as CaptionFontId, w);
        expect([id, w, face.file.startsWith(`${f.package}/`)]).toEqual([
          id,
          w,
          true,
        ]);
        const bytes = readFileSync(require.resolve(face.file));
        // satori reads TTF/OTF/WOFF, not WOFF2. 0x00010000 or "true" is TrueType.
        const magic = bytes.subarray(0, 4);
        const ttf =
          magic.equals(Buffer.from([0, 1, 0, 0])) ||
          magic.toString("latin1") === "true";
        expect([id, w, ttf]).toEqual([id, w, true]);
        expect([id, w, face.file.includes(`_${face.weight}`)]).toEqual([
          id,
          w,
          true,
        ]);
      }
    }
  });

  it("gives a one-face family the same file for both requests, on purpose", () => {
    expect(fontFaceFor("anton", 600)).toEqual(fontFaceFor("anton", 800));
    expect(fontFaceFor("instrument-serif", 600)).toEqual(
      fontFaceFor("instrument-serif", 800),
    );
    // And a family that has both weights is not collapsed by accident.
    expect(fontFaceFor("barlow-condensed", 600).weight).toBe(600);
    expect(fontFaceFor("barlow-condensed", 800).weight).toBe(800);
  });

  it("keeps Outfit on the two faces captionRender.ts loads today", () => {
    expect(fontFaceFor("outfit", 600).file).toBe(
      "@expo-google-fonts/outfit/600SemiBold/Outfit_600SemiBold.ttf",
    );
    expect(fontFaceFor("outfit", 800).file).toBe(
      "@expo-google-fonts/outfit/800ExtraBold/Outfit_800ExtraBold.ttf",
    );
  });
});

describe("the glyph holes (PR 8)", () => {
  it("lists a hole set for every font, and the default font has none", () => {
    expect(Object.keys(CAPTION_FONT_HOLES).sort()).toEqual(
      Object.keys(CAPTION_FONTS).sort(),
    );
    expect(DEFAULT_CAPTION_FONT).toBe("outfit");
    expect(CAPTION_FONT_HOLES[DEFAULT_CAPTION_FONT]).toEqual([]);
  });

  it("only lists characters a caption may contain — a hole outside the allowlist means nothing", () => {
    for (const [id, holes] of Object.entries(CAPTION_FONT_HOLES)) {
      for (const cp of holes) {
        expect([id, cp, isCaptionCodePoint(cp)]).toEqual([id, cp, true]);
      }
    }
  });

  it("names each character the font cannot draw once, in the order she typed it", () => {
    expect(fontCannotDraw("instrument-serif", "½ and ½ ± ok")).toEqual([
      "½",
      "±",
    ]);
    expect(fontCannotDraw("outfit", "½ and ± ok")).toEqual([]);
  });
});

describe("the list", () => {
  it("is the approved six, each with at least one vibe", () => {
    expect(Object.keys(CAPTION_FONTS).sort()).toEqual(
      [
        "anton",
        "barlow-condensed",
        "bodoni-moda",
        "instrument-serif",
        "jost",
        "outfit",
      ].sort(),
    );
    for (const [id, f] of fonts)
      expect([id, f.vibes.length > 0]).toEqual([id, true]);
  });

  it("answers false for a near-miss and an inherited key", () => {
    for (const bad of [
      "Outfit",
      "big-shoulders-display",
      "",
      null,
      "toString",
    ]) {
      expect(isCaptionFontId(bad)).toBe(false);
    }
  });
});
