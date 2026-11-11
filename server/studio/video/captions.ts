/**
 * captions.ts — the words a stitch can burn onto a clip, and the closed sets that shape them.
 *
 * ─── WHY HER TEXT NEVER REACHES ffmpeg ──────────────────────────────────────────────────────────
 *
 * The obvious tool is `drawtext`, and it is the wrong one here twice over. It needs libfreetype,
 * which the ffmpeg on a developer Mac (Homebrew) is built WITHOUT — so a drawtext stitch would red
 * studio/video/stitch.test.ts, which drives the real binary, on the machine that runs it most. And
 * it puts her words inside a filter graph, where `:` `'` `%` and `\` are all syntax.
 *
 * So a caption is RENDERED TO A PNG (studio/video/captionRender.ts, satori + sharp, the brand font
 * read from the package that already ships it) and ffmpeg only ever sees a local image path and
 * the `overlay` filter. Her text is never an argv element and never a filter-graph token — not
 * escaped correctly, but ABSENT.
 *
 * ─── A NAME TRAVELS, NEVER A NUMBER ─────────────────────────────────────────────────────────────
 *
 * The same argument studio/video/spec.ts makes for `target` and `bed`: position and style are
 * NAMES from the sets below, the stored spec holds the names, and the geometry is expanded at run
 * time. A preset whose size turns out wrong is corrected in one place and every queued row picks
 * it up. An unknown name is a 400 at the door, never a silent default — a default is how a pill
 * becomes decoration.
 *
 * ─── WHAT A CAPTION MAY SAY IS WHAT THE FONT CAN DRAW ───────────────────────────────────────────
 *
 * Measured, not assumed (2026-09-20): Outfit renders Latin with accents — "Peña & Muñoz — it's
 * 3:1!" is clean — and renders an emoji or a CJK character as a TOFU BOX. So the rule is not "no
 * emoji", it is "only characters this font has a glyph for", and the allowlist below is explicit
 * ranges so the suite can render every one of them and fail on a box. The refusal says what IS
 * allowed.
 *
 * A caption may also name a FONT (PR 8, studio/fonts/fonts.ts) — absent means Outfit. The allowlist
 * above is the same for every font; a font that lacks one of its characters refuses that character
 * by name (`CAPTION_FONT_HOLES`), so a stored caption with no font is judged exactly as before.
 */

import {
  CAPTION_FONTS,
  DEFAULT_CAPTION_FONT,
  type CaptionFontId,
} from "../fonts/fonts";

/** Where the band sits, as the fraction of the frame's HEIGHT its centre is at. */
export const CAPTION_POSITIONS = {
  top: { label: "Top", centreY: 0.14 },
  middle: { label: "Middle", centreY: 0.5 },
  bottom: { label: "Bottom", centreY: 0.82 },
} as const satisfies Record<string, { label: string; centreY: number }>;

export type CaptionPosition = keyof typeof CAPTION_POSITIONS;

export interface CaptionStyleDefinition {
  /** What she sees on the pill. */
  label: string;
  /** Outfit weight. Each one used must have its .ttf loaded by captionRender.ts. */
  weight: 600 | 800;
  /** Rendered as typed when false. */
  uppercase: boolean;
  /**
   * A plate behind LIGHT words, or null for a shadow only. Dark words get `CAPTION_LIGHT_PLATE`
   * instead — a style says whether there is a plate, the colour says which way it has to contrast.
   */
  plate: string | null;
}

/**
 * A few presets, not free-form fonts. Every one is legible over footage she has not chosen for
 * legibility: light words carry a shadow or sit on a plate, never bare.
 */
export const CAPTION_STYLES = {
  clean: {
    label: "Clean",
    weight: 600,
    uppercase: false,
    plate: null,
  },
  boxed: {
    label: "Boxed",
    weight: 600,
    uppercase: false,
    plate: "rgba(13,11,8,0.78)",
  },
  bold: {
    label: "Bold",
    weight: 800,
    uppercase: true,
    plate: null,
  },
} as const satisfies Record<string, CaptionStyleDefinition>;

export type CaptionStyle = keyof typeof CAPTION_STYLES;

/**
 * What colour the words are. A NAME from a closed set, like everything else about a caption — not a
 * hex off the wire, which would be a free-form value reaching an SVG attribute, and would let her
 * pick a colour nobody checked for legibility.
 *
 * ─── `dark` IS NOT DECORATION ───────────────────────────────────────────────────────────────────
 *
 * Every caption is drawn over footage she did not choose for legibility, so the words always carry
 * contrast of their own: a shadow, or a plate. WHICH WAY that contrast has to go depends on the
 * words. White on a dark plate; black on a dark plate is a black rectangle. So a dark colour flips
 * both — light shadow, light plate — and that is decided here, once, rather than per style.
 */
export const CAPTION_COLORS = {
  white: { label: "White", hex: "#FFFFFF", dark: false },
  black: { label: "Black", hex: "#0D0B08", dark: true },
  yellow: { label: "Yellow", hex: "#FFD60A", dark: false },
  pink: { label: "Pink", hex: "#E84591", dark: false },
} as const satisfies Record<
  string,
  { label: string; hex: string; dark: boolean }
>;

export type CaptionColor = keyof typeof CAPTION_COLORS;

/** Absent means this. Never stored, so "the default colour" has one representation. */
export const DEFAULT_CAPTION_COLOR = "white" satisfies CaptionColor;

/** Behind dark words, where a style has a plate at all. */
export const CAPTION_LIGHT_PLATE = "rgba(255,255,255,0.86)";

export const isCaptionColor = (v: unknown): v is CaptionColor =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(CAPTION_COLORS, v);

/**
 * Geometry as FRACTIONS of the output frame, so one set of numbers serves all three shapes and the
 * client can draw its preview from the same ones (GET /studio/stitch/options carries them — the
 * client hardcodes none of this, for the reason stitchLogic.ts gives about limits).
 */
export const CAPTION_GEOMETRY = {
  /** Font size over frame HEIGHT for portrait/square; see `fontPx`. */
  fontOverShortEdge: 0.066,
  /** The band's height over the font size — room for two lines and the plate's padding. */
  bandOverFont: 3.6,
  /** Side margin over frame WIDTH. */
  sideMargin: 0.07,
  lineHeight: 1.18,
} as const;

/**
 * What a new caption starts as. Served, not hardcoded in the client: the first pill lit is a
 * product choice, and it belongs beside the sets it is chosen from. Bottom and clean because that
 * is where a caption is on every surface she will post this to.
 */
export const CAPTION_DEFAULTS = {
  position: "bottom",
  style: "clean",
} as const satisfies { position: CaptionPosition; style: CaptionStyle };

export const CAPTION_MAX_CHARS = 60;
export const CAPTION_MAX_LINES = 2;

export interface Caption {
  text: string;
  position: CaptionPosition;
  style: CaptionStyle;
  /** Absent means white. Stored only when it is not. */
  color?: Exclude<CaptionColor, typeof DEFAULT_CAPTION_COLOR>;
  /** Absent means Outfit. Stored only when it is not (PR 8). */
  font?: Exclude<CaptionFontId, typeof DEFAULT_CAPTION_FONT>;
}

export const isCaptionPosition = (v: unknown): v is CaptionPosition =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(CAPTION_POSITIONS, v);

export const isCaptionStyle = (v: unknown): v is CaptionStyle =>
  typeof v === "string" &&
  Object.prototype.hasOwnProperty.call(CAPTION_STYLES, v);

/**
 * Every character a caption may contain, as explicit ranges — see the header. Exported so the
 * render suite can walk it and prove each one draws as a glyph rather than a box.
 *
 *   U+0020–007E  ASCII printable
 *   U+00A1–00FF  Latin-1 (¡ ¿ é ñ ü …), minus U+00AD soft hyphen, which draws nothing
 *   U+0100–017F  Latin Extended-A (ā č ł ő ş ž …)
 *   and the typographic punctuation a phone keyboard inserts on its own: ‘ ’ “ ” – — … •  €
 */
export const CAPTION_CHAR_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa1, 0xac],
  [0xae, 0xff],
  [0x100, 0x17f],
  [0x2013, 0x2014],
  [0x2018, 0x2019],
  [0x201c, 0x201d],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x20ac, 0x20ac],
];

/**
 * Holes in those ranges, MEASURED by rendering all 325 (2026-09-20, both weights, identical result):
 *
 *   - 29 Latin Extended-A code points Outfit has no glyph for — the Esperanto circumflexes, the
 *     breves, ĸ ŀ ŉ ţ ŧ ũ ſ. They draw as the same box an emoji does.
 *   - U+00B5 µ, which HAS a glyph but uppercases to a Greek Μ (U+039C) that does not, and one of
 *     the presets uppercases. Nobody captions a clip in micro-units; refusing it keeps "allowed"
 *     closed under every style instead of making the answer depend on the pill she picks.
 *
 * captionRender.test.ts renders every allowed character, as typed and uppercased, and fails on a
 * box — so swapping the font or widening a range cannot quietly reopen this.
 */
export const CAPTION_CHARS_EXCLUDED: ReadonlySet<number> = new Set([
  0xb5, 0x108, 0x109, 0x114, 0x115, 0x11c, 0x11d, 0x124, 0x125, 0x128, 0x129,
  0x12c, 0x12d, 0x134, 0x135, 0x138, 0x13f, 0x140, 0x149, 0x14e, 0x14f, 0x15c,
  0x15d, 0x162, 0x163, 0x166, 0x167, 0x168, 0x169, 0x17f,
]);

export const isCaptionCodePoint = (cp: number) =>
  !CAPTION_CHARS_EXCLUDED.has(cp) &&
  CAPTION_CHAR_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

/** The one sentence every text refusal uses. It says what IS allowed, and is honest about the rest. */
export const CAPTION_TEXT_RULE =
  `Captions can use letters (accents included), numbers and punctuation — up to ` +
  `${CAPTION_MAX_CHARS} characters on at most ${CAPTION_MAX_LINES} lines. ` +
  `Emoji and other alphabets aren't supported yet.`;

/**
 * Her text, normalised, or null when it cannot be drawn.
 *
 * Normalised means: NFC (so "n" + combining tilde becomes the single ñ the font has), CRLF to LF,
 * each line trimmed. What is stored is what is rendered — nothing is re-normalised at run time, so
 * the frozen spec IS the caption.
 *
 * Length is counted in CODE POINTS, not UTF-16 units, so the number in the sentence above is the
 * number she can count.
 */
export function normalizeCaptionText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lines = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim());
  // Blank lines at either end are typing, not intent; one in the middle is a third line.
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0 || lines.length > CAPTION_MAX_LINES) return null;
  if (lines.some((l) => l === "")) return null;

  const text = lines.join("\n");
  const points = Array.from(text);
  if (points.length > CAPTION_MAX_CHARS) return null;
  for (const ch of points) {
    if (ch === "\n") continue;
    if (!isCaptionCodePoint(ch.codePointAt(0)!)) return null;
  }
  return text;
}

/** What the picker and the client preview are built from. Names, labels and geometry — no paths. */
export const captionCatalog = () => ({
  maxChars: CAPTION_MAX_CHARS,
  maxLines: CAPTION_MAX_LINES,
  rule: CAPTION_TEXT_RULE,
  positions: Object.entries(CAPTION_POSITIONS).map(([name, p]) => ({
    name,
    label: p.label,
    centreY: p.centreY,
  })),
  styles: Object.entries(CAPTION_STYLES).map(([name, s]) => ({
    name,
    label: s.label,
    weight: s.weight,
    uppercase: s.uppercase,
    plate: s.plate,
  })),
  colors: Object.entries(CAPTION_COLORS).map(([name, c]) => ({
    name,
    label: c.label,
    // The hex travels so the picker can show a swatch. It is for DISPLAY: the wire carries the name.
    hex: c.hex,
  })),
  // The typefaces (PR 8). Names and families only — the files and weights stay on the server.
  fonts: Object.entries(CAPTION_FONTS).map(([name, f]) => ({
    name,
    label: f.family,
    vibes: [...f.vibes],
  })),
  geometry: CAPTION_GEOMETRY,
  defaults: {
    ...CAPTION_DEFAULTS,
    color: DEFAULT_CAPTION_COLOR,
    font: DEFAULT_CAPTION_FONT,
  },
});
