/**
 * firstFrame.ts — the frame a clip starts from, cut to the shape the clip will be.
 *
 * ─── THE GAP THIS CLOSES ───────────────────────────────────────────────────────────────────────
 *
 * Every identity result this product has was measured on a frame the harness had ALREADY cut to the
 * clip's shape: `studioVideoBakeoff.ts` centre-cropped to 720x1280 before anything was sent, and
 * V2b's 3/3 hold is a hold on those frames (docs/probes/video-bakeoff.md). The product path never
 * did that. It hands the model her photograph as stored — typically 2:3 — beside a request for
 * 9:16, and what the model does with the disagreement is its own business: pad it, stretch it, or
 * re-compose the opening frame, which is a re-render of her face before the clip has started.
 *
 * So the measured path and the shipped path differed in the one input the model conditions on
 * hardest. This makes them the same.
 *
 * ─── ⚠️  "FACE-PRESERVING" IS A SALIENCY CROP, NOT A FACE DETECTOR. SAID PLAINLY. ──────────────
 *
 * The only face finder in the repo is `qa/face.ts`, and it is a model call. Putting it here would
 * add spend to the run leg that no quote covers, on a path whose rule is that the quote is the run.
 * What this uses instead is sharp's `attention` strategy — luminance, saturation and SKIN TONE —
 * which costs nothing and is deterministic. It is a good guess at where she is and it is not a
 * promise. `focus` is the seam for a real box: a caller that HAS one (a stored face box, a funded
 * probe) passes it and saliency is not consulted.
 *
 * ⚠️ A PORTRAIT SOURCE BARELY NEEDS EITHER. 2:3 to 9:16 keeps the full height and 84% of the
 * width, so the only question is a horizontal nudge. The case where the choice of window really
 * matters is a LANDSCAPE photograph, which keeps under a third of its width — and that is the case
 * to look at first if a crop ever comes back wrong.
 *
 * ─── NOT MEASURED ──────────────────────────────────────────────────────────────────────────────
 *
 * That this improves identity is a GUESS — the recon ranks it first because it is the largest
 * difference between the two paths, not because a cell has shown it. The probe that would show it
 * (A: as stored, B: this) is designed and unfunded.
 */
import sharp from "sharp";
import type { ImageRef } from "../types";
import { orderBySlot } from "../refOrder";

/** A region to keep in view, as fractions of the upright image. */
export interface FocusBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FramedBytes {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** False when the image already had the clip's shape and went through untouched. */
  cropped: boolean;
}

/**
 * How far off the clip's shape a frame may be and still go as it is. 1% is under a pixel row on a
 * 720-wide frame's worth of rounding; re-encoding her photograph to fix that would cost a JPEG
 * generation and buy nothing.
 */
const ASPECT_TOLERANCE = 0.01;

/** Same quality `personReference` re-encodes at, for the same reason: a request body, not an archive. */
const FRAME_QUALITY = 88;

/** "9:16" → 0.5625. Null for anything that is not two positive numbers, which the caller treats as "leave it". */
export function parseAspect(aspect: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/**
 * The largest window of the target shape, placed so `focus` is as centred as the image allows.
 * Pure, so the placement is testable without decoding a pixel.
 */
export function windowFor(
  width: number,
  height: number,
  target: number,
  focus: FocusBox,
): { left: number; top: number; width: number; height: number } {
  const current = width / height;
  const w = current > target ? Math.round(height * target) : width;
  const h = current > target ? height : Math.round(width / target);
  const cx = (focus.x + focus.width / 2) * width;
  const cy = (focus.y + focus.height / 2) * height;
  return {
    left: Math.round(clamp(cx - w / 2, 0, width - w)),
    top: Math.round(clamp(cy - h / 2, 0, height - h)),
    width: w,
    height: h,
  };
}

/**
 * Cut an image to the clip's aspect.
 *
 * Upright first — a flagged portrait measured sideways would be cut along the wrong axis, which is
 * the `personReference` lesson again. Never enlarges and never pads: the output is a WINDOW of her
 * photograph, so every pixel in it is one she took.
 */
export async function cropToAspect(
  input: Buffer,
  aspect: string | undefined,
  focus?: FocusBox,
): Promise<FramedBytes | null> {
  const target = parseAspect(aspect);
  if (target === null) return null;

  const upright = await sharp(input)
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const { width, height, format } = upright.info;
  const mimeType = format === "png" ? "image/png" : "image/jpeg";
  if (Math.abs(width / height - target) / target <= ASPECT_TOLERANCE) {
    return { bytes: upright.data, mimeType, width, height, cropped: false };
  }

  const encode = (s: sharp.Sharp) =>
    format === "png" ? s.png() : s.jpeg({ quality: FRAME_QUALITY });

  if (focus) {
    const box = windowFor(width, height, target, focus);
    const out = await encode(sharp(upright.data).extract(box)).toBuffer({
      resolveWithObject: true,
    });
    return {
      bytes: out.data,
      mimeType,
      width: out.info.width,
      height: out.info.height,
      cropped: true,
    };
  }

  const current = width / height;
  const w = current > target ? Math.round(height * target) : width;
  const h = current > target ? height : Math.round(width / target);
  const out = await encode(
    sharp(upright.data).resize(w, h, {
      fit: "cover",
      position: sharp.strategy.attention,
    }),
  ).toBuffer({ resolveWithObject: true });
  return {
    bytes: out.data,
    mimeType,
    width: out.info.width,
    height: out.info.height,
    cropped: true,
  };
}

export interface FramedReferences {
  references: ImageRef[];
  /** What happened, for the log. Dimensions only — never bytes, never a url. */
  note:
    | { outcome: "cropped"; width: number; height: number }
    | { outcome: "already-shaped" | "no-frame" | "no-aspect" | "not-bytes" };
}

/**
 * The clip's references with its FIRST FRAME cut to the clip's shape.
 *
 * ⚠️ WHICH ONE IS THE FRAME IS THE ADAPTER'S DECISION, AND THIS ASKS IT THE SAME WAY. Both video
 * adapters send `orderBySlot(references)[0]` as the first frame, so that is the one picked here —
 * a second rule for "the frame" would be a second answer that could disagree with what is sent.
 * Every other reference is returned untouched, in its original position.
 *
 * A frame that is still a URL is left alone. That is `personReference`'s fallback arm (the fetch or
 * sharp failed and it sent the stored url, as it did before packs); fetching it again here to crop
 * it would retry the thing that just failed.
 */
export async function frameForClip(
  references: readonly ImageRef[],
  aspect: string | undefined,
): Promise<FramedReferences> {
  const refs = [...references];
  const frame = orderBySlot(refs)[0];
  if (!frame) return { references: refs, note: { outcome: "no-frame" } };
  if (parseAspect(aspect) === null)
    return { references: refs, note: { outcome: "no-aspect" } };
  if (frame.kind !== "bytes")
    return { references: refs, note: { outcome: "not-bytes" } };

  const framed = await cropToAspect(frame.bytes, aspect);
  if (!framed || !framed.cropped)
    return { references: refs, note: { outcome: "already-shaped" } };

  refs[refs.indexOf(frame)] = {
    ...frame,
    bytes: framed.bytes,
    mimeType: framed.mimeType,
  };
  return {
    references: refs,
    note: { outcome: "cropped", width: framed.width, height: framed.height },
  };
}
