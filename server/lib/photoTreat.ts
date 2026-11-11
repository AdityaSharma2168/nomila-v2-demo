/**
 * photoTreat — make a cast photo sit in a premium document (brand book, Nomi Card, public page). Every op is sharp/libvips
 * on our own CPU: $0 per document. Settings come from the 20 Oct photo-treatment test (scratchpad/pt/treat.cjs).
 *
 *   crop     face-aware: the slot's aspect, her face on the upper third, never cutting her head; centre-top without a face
 *   grade    one grade per look — "luxe" (a touch warmer, softer saturation, lifted blacks, fine grain, soft vignette) or
 *            "campaign" (neutral: gentle contrast, no tint, no grain)
 *   tonal    ink-to-gold duotone, darkened and softly blurred — the photo BEHIND a big line of type
 *   cutout   her, from a cached body mask, on the look's ink ground with a soft contact shadow (cover only; behind
 *            PHOTO_CUTOUT_V1, and only when a mask exists — else the caller uses the tonal version)
 *
 * Results are cached in the bucket per (source, treatment, size): a derived path that exists is never re-made, so a
 * document rebuild re-renders nothing. Never upscales more than 1.5× (a small source makes a smaller output; the app
 * scales it). Everything here degrades to "use the original": a failure never blocks a document.
 */
import crypto from "crypto";
import sharp from "sharp";
import type { FaceBox } from "./visionTag";
import { headObject, readObject, saveBuffer } from "./mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("photoTreat");

export type PhotoLook = "luxe" | "campaign";
export type Treatment = "photo" | "tonal" | "cutout";

/** Slot shapes on a phone page (width × height at full size). */
export const SLOT_SIZES = {
  cover: [1080, 1620],     // 2:3
  statement: [1080, 1920], // 9:16 — full screen behind type
  gallery: [1080, 1350],   // 4:5
  band: [1080, 700],       // ~3:2 — a photo band over a data / record screen (Nomi Card); same face-aware crop
} as const;
export type SlotShape = keyof typeof SLOT_SIZES;

/** Never enlarge a source more than this to fill a slot. */
export const MAX_UPSCALE = 1.5;
/** Cache version: bump when a treatment's look changes so old derivatives are not reused. */
const VERSION = "v1";

export interface CropBox { left: number; top: number; width: number; height: number }

/**
 * The crop of aspect w:h inside an image of iw × ih. With her face: as large as the frame allows, centred on her face
 * horizontally and placing it on the upper third — so a head is never cut. Without: full width or height, centred
 * horizontally and biased to the top (heads are usually high in a frame). Pure.
 */
export function cropBoxFor(iw: number, ih: number, w: number, h: number, face?: FaceBox | null): CropBox {
  const ar = w / h;
  let cw = iw, ch = Math.round(cw / ar);
  if (ch > ih) { ch = ih; cw = Math.round(ch * ar); }
  let left: number, top: number;
  if (face && face.w > 0 && face.h > 0) {
    const fx = (face.x + face.w / 2) * iw, fy = (face.y + face.h / 2) * ih;
    left = Math.round(fx - cw / 2);
    top = Math.round(fy - ch / 3);
    // Her whole face stays inside, with a little headroom above it.
    const faceTop = face.y * ih, faceBottom = (face.y + face.h) * ih;
    if (top > faceTop - 0.04 * ch) top = Math.round(faceTop - 0.04 * ch);
    if (top + ch < faceBottom) top = Math.round(faceBottom - ch);
  } else {
    left = Math.round((iw - cw) / 2);
    top = Math.round((ih - ch) * 0.2);
  }
  left = Math.max(0, Math.min(iw - cw, left));
  top = Math.max(0, Math.min(ih - ch, top));
  return { left, top, width: cw, height: ch };
}

/** Output size for a crop: the slot size, shrunk so the crop is never enlarged more than MAX_UPSCALE. Pure. */
export function outputSize(crop: CropBox, w: number, h: number): [number, number] {
  const scale = Math.min(1, (crop.width * MAX_UPSCALE) / w);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

const INK: Record<PhotoLook, [number, number, number]> = { luxe: [21, 17, 13], campaign: [14, 14, 16] };
const GOLD: [number, number, number] = [233, 199, 130];

function vignetteSvg(W: number, H: number, strength: number): Buffer {
  return Buffer.from(`<svg width="${W}" height="${H}"><defs><radialGradient id="g" cx="50%" cy="45%" r="75%">`
    + `<stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="${strength}"/>`
    + `</radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
}

async function grain(W: number, H: number, amount: number): Promise<Buffer> {
  const n = Buffer.alloc(W * H);
  for (let i = 0; i < n.length; i++) n[i] = 128 + Math.round((Math.random() - 0.5) * amount * 2);
  return sharp(n, { raw: { width: W, height: H, channels: 1 } }).toColourspace("srgb").png().toBuffer();
}

/** Luminance mapped between two colours (shadow → highlight). */
async function duotone(img: sharp.Sharp, dark: [number, number, number], light: [number, number, number]): Promise<sharp.Sharp> {
  const grey = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = grey.info;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < grey.data.length; i += channels, j += 3) {
    const t = grey.data[i] / 255;
    out[j] = Math.round(dark[0] + (light[0] - dark[0]) * t);
    out[j + 1] = Math.round(dark[1] + (light[1] - dark[1]) * t);
    out[j + 2] = Math.round(dark[2] + (light[2] - dark[2]) * t);
  }
  return sharp(out, { raw: { width, height, channels: 3 } });
}

/** The look's grade on an already-cropped, already-sized image. */
async function graded(img: sharp.Sharp, look: PhotoLook, W: number, H: number): Promise<sharp.Sharp> {
  if (look === "campaign") return sharp(await img.linear(1.04, -4).modulate({ saturation: 0.98 }).toBuffer());
  const base = await img
    .recomb([[1.06, 0.03, 0], [0.02, 1.0, 0], [0, 0.02, 0.9]])
    .modulate({ saturation: 0.86, brightness: 1.0 })
    .linear(0.94, 10)
    .gamma(1.05)
    .toBuffer();
  return sharp(base).composite([
    { input: await grain(W, H, 14), blend: "soft-light" },
    { input: vignetteSvg(W, H, 0.5), blend: "multiply" },
  ]);
}

export interface TreatInput {
  /** The source image's bytes (any format sharp reads). */
  buf: Buffer;
  shape: SlotShape;
  treatment: Treatment;
  look: PhotoLook;
  face?: FaceBox | null;
  /** Her body mask (white = her), same framing as the source — needed for "cutout". */
  mask?: Buffer | null;
}

/** Render one treatment to JPEG bytes. Throws only on an unreadable image (the caller keeps the original). */
export async function renderTreatment(t: TreatInput): Promise<{ buf: Buffer; width: number; height: number }> {
  const meta = await sharp(t.buf).rotate().metadata();
  // .rotate() honours EXIF orientation; width/height in metadata are pre-rotation, so swap for 90° orientations.
  const turned = (meta.orientation ?? 1) >= 5;
  const iw = (turned ? meta.height : meta.width) ?? 0, ih = (turned ? meta.width : meta.height) ?? 0;
  if (!iw || !ih) throw new Error("unreadable image");
  const [SW, SH] = SLOT_SIZES[t.shape];
  const base = () => sharp(t.buf).rotate();

  if (t.treatment === "cutout") {
    if (!t.mask) throw new Error("cutout needs a mask");
    const [W, H] = [SW, SH];
    const full = await base().resize(1600, 1600, { fit: "inside" }).toBuffer({ resolveWithObject: true });
    const mask = await sharp(t.mask).resize(full.info.width, full.info.height).toColourspace("b-w").toBuffer();
    const herGraded = t.look === "luxe"
      ? sharp(full.data).recomb([[1.06, 0.03, 0], [0.02, 1.0, 0], [0, 0.02, 0.9]]).modulate({ saturation: 0.86 }).linear(0.94, 10)
      : sharp(full.data);
    // Grade first (materialised), THEN join the mask: sharp runs joinChannel before recomb in one pipeline.
    const gradedRgb = await herGraded.removeAlpha().png().toBuffer();
    const her = await sharp(gradedRgb).joinChannel(mask).png().toBuffer();
    const fitted = await sharp(her).trim({ threshold: 1 }).resize(Math.round(W * 0.92), Math.round(H * 0.86), { fit: "inside", withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
    const shadow = await sharp(fitted.data).extractChannel(3).linear(0.45, 0).blur(28).toColourspace("b-w").toBuffer();
    const [r, g, b] = INK[t.look];
    const shadowRgba = await sharp({ create: { width: fitted.info.width, height: fitted.info.height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).joinChannel(shadow).png().toBuffer();
    const x = Math.round((W - fitted.info.width) / 2), y = H - fitted.info.height - Math.round(H * 0.04);
    const layers: sharp.OverlayOptions[] = [
      { input: vignetteSvg(W, H, 0.35), blend: "over" },
      { input: shadowRgba, left: Math.max(0, x + 18), top: Math.max(0, y + 22) },
      { input: fitted.data, left: Math.max(0, x), top: Math.max(0, y) },
    ];
    if (t.look === "luxe") layers.push({ input: await grain(W, H, 10), blend: "soft-light" });
    const out = await sharp({ create: { width: W, height: H, channels: 3, background: { r, g, b } } }).composite(layers).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    return { buf: out, width: W, height: H };
  }

  const crop = cropBoxFor(iw, ih, SW, SH, t.face);
  const [W, H] = outputSize(crop, SW, SH);
  const cropped = base().extract(crop).resize(W, H);

  if (t.treatment === "tonal") {
    const toned = await (await duotone(cropped.blur(6).modulate({ brightness: 0.7 }), INK[t.look], t.look === "luxe" ? [150, 125, 92] : [150, 150, 158])).png().toBuffer();
    const out = await sharp(toned).composite([{ input: vignetteSvg(W, H, 0.65), blend: "multiply" }]).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { buf: out, width: W, height: H };
  }

  const out = await (await graded(cropped, t.look, W, H)).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return { buf: out, width: W, height: H };
}

/** The cached derivative's base path (without extension) for a source + treatment. Deterministic. Pure. */
export function derivedBase(sourcePath: string, shape: SlotShape, treatment: Treatment, look: PhotoLook, faceKey = ""): string {
  const h = crypto.createHash("sha1").update(`${sourcePath}|${shape}|${treatment}|${look}|${faceKey}|${VERSION}`).digest("hex").slice(0, 20);
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "derived";
  return `${dir}/treated/${h}`;
}

/** Where a photo's body mask is cached (written by the mask script; read by "cutout"). Pure. */
export function maskPath(sourcePath: string): string {
  const h = crypto.createHash("sha1").update(sourcePath).digest("hex").slice(0, 20);
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "derived";
  return `${dir}/masks/${h}.png`;
}

/**
 * The treated photo's bucket path, made once and cached. On any failure returns the ORIGINAL path — a document never
 * loses a photo because a treatment failed.
 */
export async function treatedPath(sourcePath: string, opts: { shape: SlotShape; treatment: Treatment; look: PhotoLook; face?: FaceBox | null }): Promise<string> {
  const faceKey = opts.face ? [opts.face.x, opts.face.y, opts.face.w, opts.face.h].map((n) => n.toFixed(3)).join(",") : "";
  const base = derivedBase(sourcePath, opts.shape, opts.treatment, opts.look, faceKey);
  const dest = `${base}.jpg`;
  try {
    if (await headObject(dest)) return dest;
    const src = await readObject(sourcePath, 40_000_000);
    if (!src) return sourcePath;
    let mask: Buffer | null = null;
    if (opts.treatment === "cutout") {
      mask = (await readObject(maskPath(sourcePath), 20_000_000).catch(() => null))?.buf ?? null;
      if (!mask) return sourcePath;
    }
    const out = await renderTreatment({ buf: src.buf, shape: opts.shape, treatment: opts.treatment, look: opts.look, face: opts.face, mask });
    const saved = await saveBuffer(out.buf, base, "image/jpeg");
    return "gcs_path" in saved ? saved.gcs_path : sourcePath;
  } catch (e: any) {
    logger.warn({ sourcePath, treatment: opts.treatment, error: String(e?.message ?? e).slice(0, 160) }, "photo treatment failed — original kept");
    return sourcePath;
  }
}

/** Does a stored mask exist for this photo? */
export async function hasMask(sourcePath: string): Promise<boolean> {
  return !!(await headObject(maskPath(sourcePath)).catch(() => null));
}

/**
 * A "busy" background: lots of fine edges across the frame (crowds, banners, nets). Mean of a Laplacian over a small
 * greyscale copy — cheap. Used only to decide whether a cover would look better cut out.
 */
export async function isBusy(buf: Buffer, threshold = BUSY_EDGE): Promise<boolean> {
  const small = sharp(buf).rotate().resize(256, 256, { fit: "inside" }).greyscale();
  const edges = await small.convolve({ width: 3, height: 3, kernel: [0, -1, 0, -1, 4, -1, 0, -1, 0] }).raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < edges.length; i++) sum += edges[i];
  return sum / edges.length >= threshold;
}
export const BUSY_EDGE = 14;

/** The cut-out is on only where PHOTO_CUTOUT_V1 is "true" (dev); masks are made by scripts/media/makeCoverMasks.py. */
export function cutoutEnabled(): boolean {
  return process.env.PHOTO_CUTOUT_V1?.trim().toLowerCase() === "true";
}
