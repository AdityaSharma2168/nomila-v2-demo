/**
 * fonts.ts — the typefaces a caption may be set in, and the grant we rely on for each.
 *
 * ─── A CATALOGUE, NOT A RENDER CHANGE ───────────────────────────────────────────────────────────
 *
 * Nothing reads this yet. studio/video/captionRender.ts still sets every caption in Outfit and
 * loads its two faces itself. This file exists so the Board's font pick (wired after PR 5) chooses
 * from a closed list whose files, weights and licences are already settled — rather than guessing
 * a weight a family does not have and falling back to whatever satori does with a missing face.
 *
 * ─── WHERE THE BYTES COME FROM ──────────────────────────────────────────────────────────────────
 *
 * The `@expo-google-fonts/*` packages, which are already in `dependencies` (the app ships them),
 * so they are present under `npm install --omit=dev` in the container — the same reasoning, and
 * the same `require.resolve`, captionRender.ts uses for Outfit today. No new dependency, no font
 * files committed.
 *
 * Every family is SIL OFL 1.1. The package carries the licence as `LICENSE_FONT` beside the font
 * folders; a copy of each is committed at ./licenses/<id>.OFL.txt, and the suite asserts the two
 * are byte-identical — so the grant is in the repo, and a package upgrade that changes it is seen.
 * `@expo-google-fonts/big-shoulders-display` is in dependencies too and is NOT here: its package
 * ships no licence file.
 *
 * ─── WEIGHTS ARE PINNED, PER CAPTION WEIGHT ─────────────────────────────────────────────────────
 *
 * A caption style asks for 600 or 800 (studio/video/captions.ts, `CaptionStyleDefinition.weight`).
 * Families do not all have those: Anton and Instrument Serif have one face each. So every entry
 * says, for each weight the renderer can request, exactly which file it gets. A one-face family
 * answers both with the same file — a decision written down, not a fallback discovered.
 */
import type { CaptionStyleDefinition } from "../video/captions";

/** The weight a caption style requests. The keys every entry's `faces` must cover. */
export type CaptionWeight = CaptionStyleDefinition["weight"];
export const CAPTION_WEIGHTS = [
  600, 800,
] as const satisfies readonly CaptionWeight[];

export const FONT_LICENSES = ["OFL-1.1"] as const;
export type FontLicense = (typeof FONT_LICENSES)[number];

/** Closed vocabulary, so a later recommender can match feel words to faces as it does to tracks. */
export const FONT_VIBES = [
  "house",
  "clean",
  "hype",
  "sport",
  "bold",
  "editorial",
  "warm",
  "reflective",
] as const;
export type FontVibe = (typeof FONT_VIBES)[number];

export interface FontFace {
  /** The face's real weight — which may differ from the weight the caption asked for. */
  weight: number;
  /** Package-relative path to the .ttf, resolved with require.resolve at run time. */
  file: string;
}

export interface FontDefinition {
  /** The family name satori is told. */
  family: string;
  /** The npm package the files come from. Must be in `dependencies`. */
  package: string;
  license: FontLicense;
  /** Repo-relative to this directory; byte-identical to the package's LICENSE_FONT. */
  licenseFile: string;
  vibes: readonly FontVibe[];
  /** For each weight a caption can request, the face it gets. */
  faces: Record<CaptionWeight, FontFace>;
}

const face = (
  pkg: string,
  dir: string,
  file: string,
  weight: number,
): FontFace => ({
  weight,
  file: `${pkg}/${dir}/${file}`,
});

export const CAPTION_FONTS = {
  outfit: {
    family: "Outfit",
    package: "@expo-google-fonts/outfit",
    license: "OFL-1.1",
    licenseFile: "licenses/outfit.OFL.txt",
    vibes: ["house", "clean"],
    // Exactly the two faces captionRender.ts loads today.
    faces: {
      600: face(
        "@expo-google-fonts/outfit",
        "600SemiBold",
        "Outfit_600SemiBold.ttf",
        600,
      ),
      800: face(
        "@expo-google-fonts/outfit",
        "800ExtraBold",
        "Outfit_800ExtraBold.ttf",
        800,
      ),
    },
  },
  anton: {
    family: "Anton",
    package: "@expo-google-fonts/anton",
    license: "OFL-1.1",
    licenseFile: "licenses/anton.OFL.txt",
    vibes: ["hype", "sport", "bold"],
    // One face. It is a heavy condensed display cut at 400, so both requests get it.
    faces: {
      600: face(
        "@expo-google-fonts/anton",
        "400Regular",
        "Anton_400Regular.ttf",
        400,
      ),
      800: face(
        "@expo-google-fonts/anton",
        "400Regular",
        "Anton_400Regular.ttf",
        400,
      ),
    },
  },
  "barlow-condensed": {
    family: "Barlow Condensed",
    package: "@expo-google-fonts/barlow-condensed",
    license: "OFL-1.1",
    licenseFile: "licenses/barlow-condensed.OFL.txt",
    vibes: ["sport", "clean"],
    faces: {
      600: face(
        "@expo-google-fonts/barlow-condensed",
        "600SemiBold",
        "BarlowCondensed_600SemiBold.ttf",
        600,
      ),
      800: face(
        "@expo-google-fonts/barlow-condensed",
        "800ExtraBold",
        "BarlowCondensed_800ExtraBold.ttf",
        800,
      ),
    },
  },
  jost: {
    family: "Jost",
    package: "@expo-google-fonts/jost",
    license: "OFL-1.1",
    licenseFile: "licenses/jost.OFL.txt",
    vibes: ["clean", "warm"],
    faces: {
      600: face(
        "@expo-google-fonts/jost",
        "600SemiBold",
        "Jost_600SemiBold.ttf",
        600,
      ),
      800: face(
        "@expo-google-fonts/jost",
        "800ExtraBold",
        "Jost_800ExtraBold.ttf",
        800,
      ),
    },
  },
  "bodoni-moda": {
    family: "Bodoni Moda",
    package: "@expo-google-fonts/bodoni-moda",
    license: "OFL-1.1",
    licenseFile: "licenses/bodoni-moda.OFL.txt",
    vibes: ["editorial"],
    faces: {
      600: face(
        "@expo-google-fonts/bodoni-moda",
        "600SemiBold",
        "BodoniModa_600SemiBold.ttf",
        600,
      ),
      800: face(
        "@expo-google-fonts/bodoni-moda",
        "800ExtraBold",
        "BodoniModa_800ExtraBold.ttf",
        800,
      ),
    },
  },
  "instrument-serif": {
    family: "Instrument Serif",
    package: "@expo-google-fonts/instrument-serif",
    license: "OFL-1.1",
    licenseFile: "licenses/instrument-serif.OFL.txt",
    vibes: ["editorial", "reflective", "warm"],
    // One face (plus its italic, not used). Both requests get the 400.
    faces: {
      600: face(
        "@expo-google-fonts/instrument-serif",
        "400Regular",
        "InstrumentSerif_400Regular.ttf",
        400,
      ),
      800: face(
        "@expo-google-fonts/instrument-serif",
        "400Regular",
        "InstrumentSerif_400Regular.ttf",
        400,
      ),
    },
  },
} as const satisfies Record<string, FontDefinition>;

export type CaptionFontId = keyof typeof CAPTION_FONTS;

export const isCaptionFontId = (v: unknown): v is CaptionFontId =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(CAPTION_FONTS, v);

/** The face to load for a font and a caption style's weight. */
export const fontFaceFor = (
  id: CaptionFontId,
  weight: CaptionWeight,
): FontFace => (CAPTION_FONTS[id] as FontDefinition).faces[weight];

/** Absent on a caption means this. Never stored, so "the default font" has one representation. */
export const DEFAULT_CAPTION_FONT = "outfit" satisfies CaptionFontId;

/**
 * Characters the caption allowlist admits that a font draws as a BOX — as typed, or as the
 * uppercasing style would draw them. MEASURED (2026-09-22) the way captionRender.test measures
 * Outfit: rendered beside a character known to be missing, and compared. The suite re-measures every
 * font against this list in both directions, so it cannot drift from what the files actually draw.
 *
 * A caption set in a font is refused if it contains one of that font's holes, by name — the
 * general allowlist stays the same for every font, so a stored caption with no font is unaffected.
 */
export const CAPTION_FONT_HOLES: Readonly<
  Record<CaptionFontId, readonly number[]>
> = {
  outfit: [],
  anton: [],
  // Ĳ and, uppercased by the bold style, ĳ.
  "barlow-condensed": [0x132, 0x133],
  jost: [],
  "bodoni-moda": [],
  // ¤ ¦ ¬ ± ² ³ ¹ ¼ ½ ¾
  "instrument-serif": [
    0xa4, 0xa6, 0xac, 0xb1, 0xb2, 0xb3, 0xb9, 0xbc, 0xbd, 0xbe,
  ],
};

/** The characters of `text` the font cannot draw, each once, in the order she typed them. */
export function fontCannotDraw(id: CaptionFontId, text: string): string[] {
  const holes = new Set(CAPTION_FONT_HOLES[id]);
  return [
    ...new Set(Array.from(text).filter((ch) => holes.has(ch.codePointAt(0)!))),
  ];
}
