/**
 * brandBook/palette — her look, measured from her own photos: a handful of colours that recur across them. No model:
 * every photo is shrunk, its pixels are bucketed, and the most common buckets that carry colour win, kept apart from
 * each other so the palette is not five shades of one jersey. One deep neutral closes the set (the colour type sits on).
 *
 * Pure apart from `paletteFromImages`, which only decodes. Nothing here names an athlete, sport, school or brand.
 */
import sharp from "sharp";

export type Rgb = [number, number, number];

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function hsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
}

/**
 * Grass and pitch greens: the field behind her, not her colour. A sports photo is often half turf, so without this the
 * palette's strongest colour is the pitch (20 Oct 2026: a book's "look" led with turf green). Yellow-green to green hues
 * at grass saturation and lightness; a deep forest or a teal stays.
 */
export function isGrassGreen(rgb: Rgb): boolean {
  const { h, s, l } = hsl(rgb);
  return h >= 70 && h <= 150 && s >= 0.2 && l >= 0.2 && l <= 0.7;
}
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The palette from raw RGB pixels (one array per photo, 3 bytes a pixel). Every photo counts equally, so one big
 * photo cannot paint the whole set. At most `max` colours; empty when nothing usable came in.
 */
export function paletteFromPixels(photos: Uint8Array[], max = 5): string[] {
  const buckets = new Map<number, { n: number; sum: [number, number, number] }>();
  for (const px of photos) {
    const pixels = Math.floor(px.length / 3);
    if (!pixels) continue;
    const w = 1 / pixels;
    for (let i = 0; i < pixels; i++) {
      const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const cur = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] as [number, number, number] };
      cur.n += w; cur.sum[0] += r * w; cur.sum[1] += g * w; cur.sum[2] += b * w;
      buckets.set(key, cur);
    }
  }
  const all = [...buckets.values()].map((b) => ({ n: b.n, rgb: [b.sum[0] / b.n, b.sum[1] / b.n, b.sum[2] / b.n] as Rgb }))
    .sort((a, b) => b.n - a.n);
  const colourful = all.filter((c) => { const { s, l } = hsl(c.rgb); return s >= 0.28 && l >= 0.18 && l <= 0.82 && !isGrassGreen(c.rgb); });
  const picked: Rgb[] = [];
  for (const c of colourful) {
    if (picked.length >= max - 1) break;
    if (picked.every((p) => dist(p, c.rgb) >= 70)) picked.push(c.rgb);
  }
  // One deep neutral to close: the most common dark, low-colour bucket (what type would sit on).
  const deep = all.find((c) => { const { s, l } = hsl(c.rgb); return l < 0.22 && s < 0.35; });
  if (deep && picked.length) picked.push(deep.rgb);
  return picked.map(hex);
}

/** Decode up to a few photos (buffers) and measure them. Failed decodes are skipped. */
export async function paletteFromImages(buffers: Buffer[], max = 5): Promise<string[]> {
  const px: Uint8Array[] = [];
  for (const buf of buffers.slice(0, 6)) {
    try {
      const { data } = await sharp(buf, { failOn: "none" }).rotate().resize(48, 48, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      px.push(new Uint8Array(data));
    } catch { /* not a picture we can read */ }
  }
  return paletteFromPixels(px, max);
}
