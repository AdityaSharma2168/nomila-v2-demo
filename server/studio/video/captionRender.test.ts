/**
 * captionRender.test.ts — real satori, real sharp, real pixels.
 *
 * Nothing here is mocked, for the reason stitch.test.ts gives: every interesting failure of this
 * module is one only the real renderer produces — a glyph the font lacks, a band hanging off the
 * frame, a style that changes nothing.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { captionBandGeometry, renderCaptionBand } from "./captionRender";
import {
  CAPTION_CHAR_RANGES,
  CAPTION_COLORS,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  isCaptionCodePoint,
  type Caption,
  type CaptionColor,
  type CaptionPosition,
  type CaptionStyle,
} from "./captions";
import { STITCH_TARGETS } from "./spec";
import {
  CAPTION_FONTS,
  CAPTION_FONT_HOLES,
  DEFAULT_CAPTION_FONT,
  type CaptionFontId,
} from "../fonts/fonts";

const PORTRAIT = STITCH_TARGETS.portrait;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const cap = (over: Partial<Caption> = {}): Caption => ({
  text: "Game day",
  position: "bottom",
  style: "clean",
  ...over,
});

/** A colour as a caption stores it: white is ABSENT, never spelled out. */
const tint = (name: CaptionColor): Partial<Caption> =>
  name === "white" ? {} : { color: name };

/** Rows of the band that contain any non-transparent pixel, and how many pixels do. */
async function ink(png: Buffer) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let pixels = 0;
  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 0) {
        pixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    pixels,
    minX,
    maxX,
    minY,
    maxY,
    width: info.width,
    height: info.height,
  };
}

describe("the band", () => {
  it("is the frame's width, an even height, and sits inside the frame in every shape", () => {
    for (const frame of Object.values(STITCH_TARGETS)) {
      for (const position of Object.keys(
        CAPTION_POSITIONS,
      ) as CaptionPosition[]) {
        const g = captionBandGeometry(frame, position);
        expect(g.width).toBe(frame.width);
        expect(g.height % 2).toBe(0);
        expect(g.y % 2).toBe(0);
        expect(g.y).toBeGreaterThanOrEqual(0);
        expect(g.y + g.height).toBeLessThanOrEqual(frame.height);
      }
    }
  });

  it("puts top above middle above bottom", () => {
    const y = (p: CaptionPosition) => captionBandGeometry(PORTRAIT, p).y;
    expect(y("top")).toBeLessThan(y("middle"));
    expect(y("middle")).toBeLessThan(y("bottom"));
  });

  it("is a PNG of exactly the size it says, transparent except where the words are", async () => {
    const band = await renderCaptionBand(cap(), PORTRAIT);
    const seen = await ink(band.png);
    expect([seen.width, seen.height]).toEqual([band.width, band.height]);
    expect(band.width).toBe(1080);
    expect(seen.pixels).toBeGreaterThan(1_000);
    // Mostly transparent — it is words, not a plate across the frame.
    expect(seen.pixels).toBeLessThan(band.width * band.height * 0.5);
  });
});

describe("fitting the words to the band", () => {
  /** Ink on the band's first or last row is a letter cut in half by the edge. */
  const clipped = (seen: Awaited<ReturnType<typeof ink>>) =>
    seen.minY <= 0 || seen.maxY >= seen.height - 1;

  it("draws a short caption at the preset's full size", async () => {
    const band = await renderCaptionBand(cap(), PORTRAIT);
    expect(band.fontPx).toBe(captionBandGeometry(PORTRAIT, "bottom").fontPx);
  });

  it("SHRINKS a long caption to two lines instead of cutting a third line off", async () => {
    // Measured: these 56 characters are two lines at full size in `clean` (71px), and only fit two
    // at 51px once `bold` has uppercased and widened them. So the same words prove both halves —
    // nothing shrinks that does not need to, and what needs to does.
    const text = "Senior night under the lights and we got the win at home";
    const base = captionBandGeometry(PORTRAIT, "bottom").fontPx;

    const clean = await renderCaptionBand(cap({ text }), PORTRAIT);
    const bold = await renderCaptionBand(
      cap({ text, style: "bold" }),
      PORTRAIT,
    );
    expect(clean.fontPx).toBe(base);
    expect(bold.fontPx).toBeLessThan(base);

    for (const band of [clean, bold]) {
      const seen = await ink(band.png);
      expect(clipped(seen)).toBe(false);
      // Two lines of ink, with the band's air around them — not three filling it.
      expect(seen.maxY - seen.minY).toBeLessThan(band.fontPx * 3.1);
    }
  });

  it("never clips the worst case the parser admits — sixty W's — in any shape or style", async () => {
    const text = "W".repeat(30) + "\n" + "W".repeat(30);
    for (const frame of Object.values(STITCH_TARGETS)) {
      for (const style of Object.keys(CAPTION_STYLES) as CaptionStyle[]) {
        const band = await renderCaptionBand(cap({ text, style }), frame);
        const seen = await ink(band.png);
        const { padX } = captionBandGeometry(frame, "bottom");
        expect(clipped(seen)).toBe(false);
        // The shadow's blur may reach a little past the glyphs; half the margin is the bound.
        expect(seen.minX).toBeGreaterThan(padX / 2);
        expect(seen.maxX).toBeLessThan(band.width - padX / 2);
      }
    }
  });

  it("breaks a single word longer than the line rather than running it off the frame", async () => {
    const band = await renderCaptionBand(
      cap({ text: "W".repeat(60) }),
      PORTRAIT,
    );
    const seen = await ink(band.png);
    expect(seen.maxX).toBeLessThan(band.width - 1);
    expect(clipped(seen)).toBe(false);
  });
});

describe("what is drawn", () => {
  it("is the same bytes for the same caption — so the stored spec determines the pixels", async () => {
    const a = await renderCaptionBand(cap({ text: "Peña — 3:1" }), PORTRAIT);
    const b = await renderCaptionBand(cap({ text: "Peña — 3:1" }), PORTRAIT);
    expect(sha(a.png)).toBe(sha(b.png));
  });

  it("draws three DIFFERENT pictures for the three styles", async () => {
    // The weakest way to break a preset is for it to expand to the same thing as another. Three
    // assertions that each pass alone would not catch that; comparing them does.
    const shas = await Promise.all(
      (Object.keys(CAPTION_STYLES) as CaptionStyle[]).map(async (style) =>
        sha((await renderCaptionBand(cap({ style }), PORTRAIT)).png),
      ),
    );
    expect(new Set(shas).size).toBe(3);
  });

  it("gives the boxed style a plate — far more ink than the words alone", async () => {
    const clean = await ink((await renderCaptionBand(cap(), PORTRAIT)).png);
    const boxed = await ink(
      (await renderCaptionBand(cap({ style: "boxed" }), PORTRAIT)).png,
    );
    expect(boxed.pixels).toBeGreaterThan(clean.pixels * 1.5);
  });

  it("draws a DIFFERENT picture for every colour, and white when none is given", async () => {
    const draw = async (color?: CaptionColor) =>
      sha(
        (await renderCaptionBand(cap(color ? tint(color) : {}), PORTRAIT)).png,
      );
    const shas = await Promise.all(
      (Object.keys(CAPTION_COLORS) as CaptionColor[]).map((c) => draw(c)),
    );
    expect(new Set(shas).size).toBe(Object.keys(CAPTION_COLORS).length);
    expect(await draw()).toBe(shas[0]); // absent IS white
  });

  it("paints the WORDS the colour she chose", async () => {
    // Read off the pixels: the most common fully-opaque colour in a plate-less band is the text.
    for (const [name, c] of Object.entries(CAPTION_COLORS)) {
      const band = await renderCaptionBand(
        cap(tint(name as CaptionColor)),
        PORTRAIT,
      );
      const { data } = await sharp(band.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 255) continue;
        const hex = `#${[data[i], data[i + 1], data[i + 2]]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase()}`;
        counts.set(hex, (counts.get(hex) ?? 0) + 1);
      }
      const commonest = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      // Within a few levels per channel, not exact: the rasteriser lands near-black #0D0B08 on
      // #0D0D0D (measured). Two levels is not a different colour; a wrong NAME is off by hundreds.
      const channels = (hex: string) =>
        [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const off = Math.max(
        ...channels(commonest).map((v, k) => Math.abs(v - channels(c.hex)[k])),
      );
      expect([name, off <= 6]).toEqual([name, true]);
    }
  });

  it("flips the plate LIGHT under dark words — black on a black plate is a rectangle", async () => {
    const plateOf = async (color?: CaptionColor) => {
      const band = await renderCaptionBand(
        cap({ style: "boxed", ...(color ? tint(color) : {}) }),
        PORTRAIT,
      );
      // The plate is translucent and the words are opaque, so the commonest PARTLY transparent
      // pixel is the plate's.
      const { data } = await sharp(band.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const counts = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0 || data[i + 3] === 255) continue;
        counts.set(data[i], (counts.get(data[i]) ?? 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1])[0][0]; // red channel of the plate
    };
    expect(await plateOf()).toBeLessThan(60); // white words: dark plate
    expect(await plateOf("yellow")).toBeLessThan(60);
    expect(await plateOf("black")).toBeGreaterThan(200); // black words: light plate
  });

  it("uppercases for the style that says so, and for no other", async () => {
    const render = async (text: string, style: CaptionStyle) =>
      sha((await renderCaptionBand(cap({ text, style }), PORTRAIT)).png);
    expect(await render("game day", "bold")).toBe(
      await render("GAME DAY", "bold"),
    );
    expect(await render("game day", "clean")).not.toBe(
      await render("GAME DAY", "clean"),
    );
  });

  it("draws a second line as a second line", async () => {
    const one = await ink(
      (await renderCaptionBand(cap({ text: "first second" }), PORTRAIT)).png,
    );
    const two = await ink(
      (await renderCaptionBand(cap({ text: "first\nsecond" }), PORTRAIT)).png,
    );
    // Same words; broken in two they are narrower.
    expect(two.maxX - two.minX).toBeLessThan(one.maxX - one.minX);
  });
});

describe("every character a caption may contain has a glyph", () => {
  // MEASURED, not assumed. Outfit draws a missing glyph as a box, and the box is the same box for
  // every missing character — so "renders identically to a character we know is missing" is the
  // test. 日 is that character: captions.ts refuses it, and this is why.
  const SMALL = { width: 240, height: 240 };
  const draw = async (ch: string, style: CaptionStyle) =>
    sha((await renderCaptionBand(cap({ text: `x${ch}x`, style }), SMALL)).png);

  it.each(["clean", "bold"] as CaptionStyle[])(
    "in the %s weight, typed and as that style would draw it",
    async (style) => {
      const tofu = await draw("日", style);
      // The control: a second missing character really does draw the same box. Without this the
      // loop below could pass because the comparison never matches ANYTHING.
      expect(await draw("🔥", style)).toBe(tofu);

      const boxes: string[] = [];
      for (const [lo, hi] of CAPTION_CHAR_RANGES) {
        for (let cp = lo; cp <= hi; cp++) {
          if (cp === 0x20 || !isCaptionCodePoint(cp)) continue;
          const ch = String.fromCodePoint(cp);
          if ((await draw(ch, style)) === tofu) {
            boxes.push(
              `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${ch}`,
            );
          }
        }
      }
      expect(boxes).toEqual([]);
    },
  );
});

describe("a caption set in a catalogued font (PR 8)", () => {
  const SMALL = { width: 240, height: 240 };
  const fonts = Object.keys(CAPTION_FONTS) as CaptionFontId[];
  const withFont = (
    font: CaptionFontId,
    over: Partial<Caption> = {},
  ): Caption =>
    cap({
      ...over,
      ...(font === DEFAULT_CAPTION_FONT
        ? {}
        : { font: font as Exclude<CaptionFontId, "outfit"> }),
    });

  it("is drawn in the font it names — every font's band differs from Outfit's for the same words", async () => {
    for (const style of ["clean", "bold"] as CaptionStyle[]) {
      const outfit = sha(
        (await renderCaptionBand(withFont("outfit", { style }), PORTRAIT)).png,
      );
      for (const font of fonts.filter((f) => f !== DEFAULT_CAPTION_FONT)) {
        const band = sha(
          (await renderCaptionBand(withFont(font, { style }), PORTRAIT)).png,
        );
        expect([font, style, band === outfit]).toEqual([font, style, false]);
      }
    }
  });

  it.each(["clean", "bold"] as CaptionStyle[])(
    "in the %s weight, every font draws every allowed character except its measured holes — and each hole IS a box",
    async (style) => {
      for (const font of fonts) {
        const draw = async (ch: string) =>
          sha(
            (
              await renderCaptionBand(
                withFont(font, { text: `x${ch}x`, style }),
                SMALL,
              )
            ).png,
          );
        const tofu = await draw("日");
        expect([font, await draw("🔥")]).toEqual([font, tofu]);

        // A hole is measured as typed OR as an uppercasing style draws it. So it should be a box
        // when the style uppercases, or when it is not merely the lowercase of a hole (ĳ draws as
        // typed; only its uppercase Ĳ is missing).
        const holes = new Set(CAPTION_FONT_HOLES[font]);
        const uppercases = CAPTION_STYLES[style].uppercase;
        const shouldBox = (ch: string, cp: number) =>
          holes.has(cp) &&
          (uppercases ||
            ch.toUpperCase() === ch ||
            !holes.has(ch.toUpperCase().codePointAt(0)!));
        const wrong: string[] = [];
        for (const [lo, hi] of CAPTION_CHAR_RANGES) {
          for (let cp = lo; cp <= hi; cp++) {
            if (cp === 0x20 || !isCaptionCodePoint(cp)) continue;
            const ch = String.fromCodePoint(cp);
            const isBox = (await draw(ch)) === tofu;
            if (isBox !== shouldBox(ch, cp)) {
              wrong.push(
                `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${ch} ${isBox ? "is a box" : "draws"}`,
              );
            }
          }
        }
        expect([font, wrong]).toEqual([font, []]);
      }
    },
  );
});
