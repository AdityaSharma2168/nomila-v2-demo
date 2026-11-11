/**
 * shared/remotionProps.ts — the contract between the API and the motion renderer (media/remotion, a Cloud Run service).
 *
 * The API builds these props with GCS_REF strings for media-bucket objects. Before the call it checks every ref belongs
 * to this athlete (or to the product's shared music / atmosphere) and swaps each for a short-lived signed READ URL, so
 * the renderer holds no bucket access of its own: it fetches those URLs (storage.googleapis.com only), serves the bytes
 * to its own browser, and PUTs the outputs to signed WRITE URLs. Every composition is 1080×1920 at REMOTION_FPS.
 *
 * Pure: no imports, no I/O. Nothing here names an athlete, sport, school or brand.
 */

export const REMOTION_FPS = 30;
export const REMOTION_WIDTH = 1080;
export const REMOTION_HEIGHT = 1920;

/** The prefix that marks a media-bucket object inside props. */
export const GCS_REF = "gcs:";
export const gcsRef = (path: string): string => `${GCS_REF}${path}`;

export const COMPOSITIONS = ["BrandBookReel", "TitleCard", "Countdown"] as const;
export type CompositionId = (typeof COMPOSITIONS)[number];

export type ReelScene = {
  /** Her photo (a GCS_REF). */
  image: string;
  /** The small label over the line ("THE BIG IDEA"). */
  kicker: string;
  /** The crafted line. */
  text: string;
}

export type BrandBookReelProps = {
  firstName: string;
  scenes: ReelScene[];
  /** Her palette, measured from her photos (hex). The first usable colour is the accent. */
  palette: string[];
  /** A licence-checked music bed (a GCS_REF), or null for silence. */
  music: string | null;
  sceneSec: number;
  transitionSec: number;
  /** The closing card's seconds (her name over her accent). */
  outroSec: number;
}

export type TitleCardProps = {
  text: string;
  /** The first shot, dimmed behind the words (a GCS_REF), or null for the accent ground. */
  background: string | null;
  palette: string[];
  seconds: number;
}

export type CountdownProps = {
  days: number;
  moment: string;
  background: string | null;
  palette: string[];
  seconds: number;
}

export type CompositionProps = {
  BrandBookReel: BrandBookReelProps;
  TitleCard: TitleCardProps;
  Countdown: CountdownProps;
};

const DEFAULT_ACCENT = "#E84591";

/**
 * A colour from her palette readable as an accent on dark ground; the brand pink when none is. Greens and yellow-greens
 * (hue 60–170°) are skipped: a palette measured from sports photos is led by the pitch, court or grass behind her, and
 * that is the venue's colour, not hers.
 */
export function accentFrom(palette: readonly string[] | null | undefined): string {
  for (const raw of palette ?? []) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(raw).trim());
    if (!m) continue;
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const sat = max === 0 ? 0 : (max - min) / max;
    const d = max - min;
    const hue = d === 0 ? 0 : max === r ? (60 * ((g - b) / d) + 360) % 360 : max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240;
    if (hue >= 60 && hue <= 170) continue;
    if (lum > 0.12 && lum < 0.85 && sat > 0.3) return `#${m[1].toUpperCase()}`;
  }
  return DEFAULT_ACCENT;
}

/** Frames in a reel: scenes overlap by the transition, then the outro (which also fades in). */
export function reelFrames(p: Pick<BrandBookReelProps, "scenes" | "sceneSec" | "transitionSec" | "outroSec">, fps = REMOTION_FPS): number {
  const scene = Math.round(p.sceneSec * fps);
  const trans = Math.round(p.transitionSec * fps);
  const outro = Math.round(p.outroSec * fps);
  const n = p.scenes.length;
  if (n === 0) return Math.max(1, outro);
  return n * scene + outro - n * trans;
}

/** The line's size: shorter lines set bigger. Same breakpoints as the still overlay. */
export function lineSize(text: string): number {
  const len = text.length;
  return len > 90 ? 58 : len > 70 ? 66 : len > 40 ? 78 : 92;
}

/** Frames for a fixed-length card. */
export const cardFrames = (seconds: number, fps = REMOTION_FPS): number => Math.max(1, Math.round(seconds * fps));

/**
 * The values of every prop the compositions hand to <Img> / <Audio> as a src, in order (nulls and missing included).
 * The only props the headless browser loads: the API requires each to be a GCS_REF, the renderer a signed storage URL.
 * A new media prop must be added here. Pure.
 */
export function mediaSlotsIn(composition: CompositionId, props: unknown): unknown[] {
  const p = (props ?? {}) as Record<string, any>;
  if (composition === "BrandBookReel") {
    const scenes: unknown[] = Array.isArray(p.scenes) ? p.scenes : [];
    return [...scenes.map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>).image : s)), p.music];
  }
  return [p.background];
}

/** Every GCS_REF inside a props object, in order, deduped. Pure (walks plain data). */
export function gcsRefsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith(GCS_REF) && !out.includes(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) gcsRefsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) gcsRefsIn(v, out);
  }
  return out;
}

const PROBE_HOST = "render.invalid";

/**
 * Would a browser load this string from another host? Decided by the WHATWG URL parser (the one Chromium uses) against
 * a local page, not a regex: it strips tabs, newlines and leading control characters, accepts backslashes and a missing
 * `//` after `https:`, so "https:evil.com", "\u0001//evil.com" and "h\tttps://evil.com" all count. Words are not URLs:
 * "Note: 7pm" parses as an unknown scheme and "game day" as a local path. Pure.
 */
export function loadsFromNetwork(s: string): boolean {
  let u: URL;
  try { u = new URL(s, `http://${PROBE_HOST}/`); } catch { return false; }
  if (u.protocol === "http:" || u.protocol === "https:") return u.hostname !== PROBE_HOST;
  return u.protocol === "file:" || u.protocol === "ftp:" || u.protocol === "ws:" || u.protocol === "wss:";
}

/** Every string a browser would load from the network (loadsFromNetwork), in order, deduped. Pure. */
export function urlsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (loadsFromNetwork(value) && !out.includes(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) urlsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) urlsIn(v, out);
  }
  return out;
}

/** The props with every string that is a key of `map` replaced by its value (GCS_REFs or URLs; others left). Pure. */
export function replaceRefs<T>(value: T, map: Readonly<Record<string, string>>): T {
  if (typeof value === "string") return (Object.prototype.hasOwnProperty.call(map, value) ? map[value] : value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => replaceRefs(v, map)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replaceRefs(v, map)])) as T;
  }
  return value;
}
