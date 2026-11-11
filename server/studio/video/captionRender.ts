/**
 * captionRender.ts — a caption, as the PNG ffmpeg will overlay.
 *
 *   caption (names + her text) + the output frame  →  a transparent PNG, one BAND tall
 *
 * See studio/video/captions.ts for why this exists at all instead of `drawtext`. What is worth
 * saying here is what the file is:
 *
 *  - A BAND, NOT A FRAME. The PNG is the frame's full width and only as tall as the caption needs.
 *    `overlay` blends every pixel of its second input on every frame, and a 1080x1920 RGBA plate
 *    that is 90% transparent is 90% wasted blend. The band's top edge is returned as `y` and
 *    plan.ts places it.
 *  - GLYPHS AS PATHS. satori lays the text out against the font buffer we hand it and emits
 *    outlines, so sharp rasterises shapes and never resolves a font. That is what makes this
 *    independent of fontconfig — the runtime image is node:20-slim and has no fonts installed —
 *    and what makes the same input produce the same bytes (asserted in the suite).
 *  - NO I/O BUT THE FONT. The caller writes the buffer into the stitch workspace; this module
 *    neither knows nor cares where that is.
 *
 * The font is read from an `@expo-google-fonts/*` package in `dependencies` (the app ships them),
 * so it is present under `npm install --omit=dev` in the container. WHICH font and which file is
 * studio/fonts/fonts.ts's answer (PR 8): the caption names a font or none (Outfit), and the style's
 * 600/800 is resolved to that font's pinned face. `require.resolve` rather than
 * a relative path: the server bundle is built with `--packages=external`, so node_modules is
 * resolved at run time from wherever server_dist sits.
 */
import { readFileSync } from "fs";
import satori from "satori";
import sharp from "sharp";
import {
  CAPTION_COLORS,
  CAPTION_GEOMETRY,
  CAPTION_LIGHT_PLATE,
  DEFAULT_CAPTION_COLOR,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  type Caption,
} from "./captions";
import {
  CAPTION_FONTS,
  DEFAULT_CAPTION_FONT,
  fontFaceFor,
  type CaptionFontId,
  type CaptionWeight,
} from "../fonts/fonts";
import { finishingEnabled } from "../config";
import { createLogger } from "../../logger";

const logger = createLogger("studio-caption-render");

/**
 * REELS' SAFE ZONES, on a 1080x1920 frame (quality-scrappy piece 6, ADI-QS-GO R4): Instagram's own interface covers
 * the top ~250 px (the header), the right ~120 px (the action rail) and the bottom of the frame (caption, audio line,
 * the tab bar). R4 sets the bottom at 25 % — y ≤ 1440 on 1920 — not the 35 % first proposed.
 *
 * ⚠️ A COMPROMISE PENDING ADI'S DEVICE CHECK, recorded as such (ledger, R4). Portrait only; Middle never moves; Top
 * moves down to clear the header; Bottom moves UP to clear the bottom band on every portrait caption (P6c′).
 */
export const REELS_SAFE_ZONE = {
  basis: { width: 1080, height: 1920 },
  topPx: 250,
  rightPx: 120,
  bottomShare: 0.25,
} as const;
/** Read once per process. ~55 KB each; a stitch with twelve captions must not read it twelve times. */
const fontCache = new Map<string, Buffer>();
function fontFor(id: CaptionFontId, weight: CaptionWeight): Buffer {
  const file = fontFaceFor(id, weight).file;
  let data = fontCache.get(file);
  if (!data) {
    data = readFileSync(require.resolve(file));
    fontCache.set(file, data);
  }
  return data;
}

export interface CaptionBand {
  png: Buffer;
  /** The band's size in OUTPUT pixels. `width` is always the frame's. */
  width: number;
  height: number;
  /** Where the band's top edge sits in the output frame. Always inside it. */
  y: number;
}

/** Even, because the band is composited into a yuv420p frame whose chroma is sampled 2x2. */
const even = (n: number) => 2 * Math.round(n / 2);

/**
 * The band's geometry for a frame — pure, and exported so plan-level tests and the client's
 * preview maths can be checked against the same numbers without rendering anything.
 */
export function captionBandGeometry(
  frame: { width: number; height: number },
  position: Caption["position"],
  /**
   * quality-scrappy piece 6 (STUDIO_FINISHING): keep the band inside Reels' safe zones on a PORTRAIT frame. Absent —
   * every caller before the finishing pass, and every square or landscape frame — the geometry it always was.
   */
  opts: { safe?: boolean } = {},
): {
  fontPx: number;
  width: number;
  height: number;
  y: number;
  padX: number;
  /** The right-hand padding, when the safe zone widens it past `padX`. Absent: `padX` on both sides. */
  padRight?: number;
  /** Where the band would have sat, when the safe zone moved it. Absent: it did not move. */
  movedFromY?: number;
} {
  const g = CAPTION_GEOMETRY;
  const fontPx = Math.round(
    Math.min(frame.width, frame.height) * g.fontOverShortEdge,
  );
  const height = Math.min(even(fontPx * g.bandOverFont), frame.height);
  const centre = CAPTION_POSITIONS[position].centreY * frame.height;
  // Clamped so a band can never hang off the frame, whatever a future centreY says.
  const y = Math.max(
    0,
    Math.min(frame.height - height, even(centre - height / 2)),
  );
  const padX = Math.round(frame.width * g.sideMargin);
  const base = { fontPx, width: frame.width, height, y, padX };
  if (!opts.safe || frame.height <= frame.width) return base;

  // The zone, scaled from its 1080x1920 basis to this frame.
  const z = REELS_SAFE_ZONE;
  const top = even((z.topPx * frame.height) / z.basis.height);
  const floor = even(frame.height * (1 - z.bottomShare) - height);
  const safeY = floor < top ? y : Math.max(top, Math.min(floor, y));
  const padRight = Math.max(
    padX,
    Math.round((z.rightPx * frame.width) / z.basis.width),
  );
  return {
    ...base,
    y: safeY,
    ...(padRight !== padX ? { padRight } : {}),
    ...(safeY !== y ? { movedFromY: y } : {}),
  };
}

/**
 * The font sizes tried, as fractions of the preset's, largest first.
 *
 * ─── WHY A CAPTION SHRINKS INSTEAD OF WRAPPING A THIRD TIME ─────────────────────────────────────
 *
 * The band is two lines tall. Sixty characters of ordinary words at full size is THREE lines, and a
 * third line does not wrap — it is cut off by the band's edge, top and bottom, mid-letter. (Caught
 * by the suite before it was ever seen: thirty W's ran to the last pixel column of the frame.)
 *
 * So the words are laid out, MEASURED, and tried again one step smaller until they fit. Measured
 * rather than estimated from character counts because Outfit is proportional: thirty i's and thirty
 * W's differ by a factor of four.
 *
 * The last step is the floor, and it is used even if two lines are still not reached — which only
 * the pathological input does (sixty W's on a plate is three lines at 32px). At that size even
 * that is ~200 rows of a 256-row band, so the floor can run to a third line but never to a clip.
 * Both halves are asserted in the suite against the worst case the parser admits.
 *
 * Deterministic: same caption, same frame, same step, same bytes.
 */
export const CAPTION_FIT_STEPS = [1, 0.85, 0.72, 0.6, 0.45] as const;

function bandSvg(
  caption: Caption,
  geo: ReturnType<typeof captionBandGeometry>,
  fontPx: number,
  canvasHeight: number,
): Promise<string> {
  const style = CAPTION_STYLES[caption.style];
  const fontId = caption.font ?? DEFAULT_CAPTION_FONT;
  const family = CAPTION_FONTS[fontId].family;
  const text = style.uppercase ? caption.text.toUpperCase() : caption.text;
  const color = CAPTION_COLORS[caption.color ?? DEFAULT_CAPTION_COLOR];
  // The contrast goes the opposite way to the words — see CAPTION_COLORS.
  const plate = style.plate
    ? color.dark
      ? CAPTION_LIGHT_PLATE
      : style.plate
    : null;
  const shadow = color.dark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.65)";

  // satori takes React-ELEMENT-SHAPED objects; `key: null` is what makes a literal one, so the
  // server draws a caption without importing React to do it.
  const words = {
    type: "div",
    key: null,
    props: {
      style: {
        display: "flex",
        maxWidth: "100%",
        textAlign: "center",
        whiteSpace: "pre-wrap",
        // A word longer than the line BREAKS rather than running off the frame.
        wordBreak: "break-word",
        color: color.hex,
        fontFamily: family,
        fontWeight: style.weight,
        fontSize: fontPx,
        lineHeight: CAPTION_GEOMETRY.lineHeight,
        // Light words over footage she did not choose for legibility: a plate, or a shadow.
        ...(plate
          ? {
              backgroundColor: plate,
              borderRadius: Math.round(fontPx * 0.35),
              padding: `${Math.round(fontPx * 0.28)}px ${Math.round(fontPx * 0.5)}px`,
            }
          : {
              textShadow: `0 ${Math.max(2, Math.round(fontPx * 0.04))}px ${Math.round(
                fontPx * 0.18,
              )}px ${shadow}`,
            }),
      },
      children: text,
    },
  };

  return satori(
    {
      type: "div",
      key: null,
      props: {
        style: {
          display: "flex",
          width: geo.width,
          height: canvasHeight,
          alignItems: "center",
          justifyContent: "center",
          paddingLeft: geo.padX,
          // The safe zone's right edge, when there is one (quality-scrappy piece 6) — the words wrap short of the rail.
          paddingRight: geo.padRight ?? geo.padX,
        },
        children: words,
      },
    },
    {
      width: geo.width,
      height: canvasHeight,
      fonts: [
        {
          // Declared at the weight the style asks for, so satori uses exactly this face — the
          // pinned file, which for a one-face family is its 400 (fonts.ts).
          name: family,
          data: fontFor(fontId, style.weight),
          weight: style.weight,
          style: "normal",
        },
      ],
    },
  );
}

/**
 * The most ink two lines can make at a size: the lines, a plate's padding, a shadow's blur.
 *
 * ⚠️  THE FIT IS "TWO LINES", NOT "INSIDE THE BAND". The band is 3.6 fonts tall so that two lines
 * sit in it with air around them — which means THREE lines also fit inside it unclipped, and four
 * at a smaller size fill it edge to edge (measured: ink on rows 4–255 of 256). Testing against the
 * band's height accepted both. Two lines is the design; this is what holds it.
 *
 * Always under the band's height (3.06 < 3.6), so passing this is also never clipping.
 */
const twoLinesTall = (fontPx: number) =>
  Math.ceil(fontPx * (2 * CAPTION_GEOMETRY.lineHeight + 0.7));

/** How tall the drawn words are, in rows that hold any ink at all. */
async function inkHeight(svg: string): Promise<number> {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  let first = -1;
  let last = -1;
  for (let y = 0; y < info.height; y++) {
    const row = data.subarray(y * info.width, (y + 1) * info.width);
    if (row.some((a) => a > 0)) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return first < 0 ? 0 : last - first + 1;
}

export async function renderCaptionBand(
  caption: Caption,
  frame: { width: number; height: number },
  /**
   * `safe` true keeps the band inside Reels' safe zones whatever STUDIO_FINISHING says — the post-kit preview render
   * always asks (agent/postKit/render). Absent: the flag decides, as it always did.
   */
  opts: { safe?: boolean } = {},
): Promise<CaptionBand & { fontPx: number }> {
  // The safe zones only under STUDIO_FINISHING — read HERE, where both the runner and the caption-preview route draw,
  // so the preview she positions against is the band that is burned in.
  const geo = captionBandGeometry(frame, caption.position, {
    safe: opts.safe ?? finishingEnabled(),
  });
  if (geo.movedFromY !== undefined)
    logger.info(
      { position: caption.position, fromY: geo.movedFromY, toY: geo.y, frame },
      "caption moved into Reels' safe zone",
    );

  // Measured on a canvas tall enough that nothing is cut off, so an overflow is SEEN as height
  // rather than hidden by the very clipping it is looking for.
  const tall = geo.height * 4;
  let fontPx = geo.fontPx;
  for (const step of CAPTION_FIT_STEPS) {
    fontPx = Math.round(geo.fontPx * step);
    const drawn = await inkHeight(await bandSvg(caption, geo, fontPx, tall));
    if (drawn <= twoLinesTall(fontPx)) break;
  }

  const svg = await bandSvg(caption, geo, fontPx, geo.height);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, width: geo.width, height: geo.height, y: geo.y, fontPx };
}
