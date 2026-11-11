/**
 * still.ts — one of her photos, turned into a clip the stitch engine joins like any other.
 *
 *   her photo ──sharp──▶ an upright frame, inside the target box ──ffmpeg──▶ an N-second clip
 *
 * The engine (plan.ts) never learns a still existed: by the time it runs, a still is an mp4 in the
 * workspace, and it walks exactly the path every clip walks — probed, conformed, joined, captioned,
 * faded. That is why this is a pre-encode and not a looped image fed into the one filter graph: the
 * engine's argv builder is the most regression-prone file in the stitch, and probeMedia refuses a
 * file with no duration (probe.ts), which a photo is.
 *
 * ─── WHAT THE CLIP HAS TO MATCH, AND WHY IT IS NOT WHAT IT LOOKS LIKE ───────────────────────────
 *
 * Size, SAR, frame rate and pixel format would be fixed by the engine's own conform chain anyway
 * (plan.ts videoNormalizeChain); a still that got those wrong would still join. What the chain does
 * NOT touch is colour RANGE and MATRIX, and both were measured going wrong (ffmpeg 9.0.1,
 * 21 Sep 2026, through the real stitch()):
 *
 *   RANGE   A looped JPEG encodes FULL-range (`yuvj420p`, pc) even when told `format=yuv420p
 *           -pix_fmt yuv420p`. Placed after a clip whose range is untagged, that one still turned
 *           the WHOLE stitched output full-range — every segment, not just its own. Hence
 *           `out_range=tv` in the scale and `-color_range tv` on the stream.
 *   MATRIX  Left to default the still is BT.601; beside BT.709 clips its colours were off by up to
 *           6/255 on green and blue. Explicit BT.709: at most 3.
 *
 * With both, the engine's manifest reports the still as needing no conversion at all — every
 * normalization flag false. still.test.ts holds that.
 *
 * ─── WHY SHARP GOES FIRST ───────────────────────────────────────────────────────────────────────
 *
 *   ORIENTATION  ffmpeg 9.0.1 applies a JPEG's EXIF orientation itself; production runs Debian's
 *                ffmpeg 5.1, which was not measured. `sharp().rotate()` bakes the orientation into
 *                the pixels and drops the flag, so which ffmpeg runs no longer matters. A test on a
 *                laptop that passes WITHOUT this proves nothing about production — the laptop's
 *                ffmpeg would have rotated it anyway. (The same class of fault studio/orient.ts
 *                exists for on the generate path.)
 *   SIZE         `-loop 1` decodes the image again for every frame. A 24 MP photo held 8 s took 35 s
 *                to encode; fitted to 1080×1920 first, 1.9 s. Twelve unfitted stills would sit
 *                against the ten-minute ffmpeg budget. The fit is load-bearing, not tidy.
 *
 * Local CPU only — sharp and ffmpeg. No network, no provider, no model: a stitch is still $0.
 */
import { execFile } from "child_process";
import { stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";
import { withTimeout } from "../../lib/withTimeout";
import { assertLocalPath, fmt } from "./plan";
import type { StitchTarget } from "./types";
import { STILL_MOTIONS, type StillMotion } from "./stillMotion";

const execFileP = promisify(execFile);

/** A decode + rotate + resize of one photo. Bounded; if it has not finished by here, something is wrong. */
const FRAME_TIMEOUT_MS = 20_000;

type Frame = Pick<StitchTarget, "width" | "height" | "fps">;

/**
 * ─── HOW A HELD PHOTO MAY MOVE (C3, D2 — 22 Sep 2026) ───────────────────────────────────────────
 *
 * "dolly" (PR 6; "pan" before it) is a slow push-in: the frame ends PAN_PUSH_IN larger than it starts, linearly over the
 * hold, centred. Ken Burns at its quietest — enough life that a held photo does not read as a
 * slide, not enough to read as a shot of her moving; that is what an i2v is, and this is not one:
 * still $0, still her photo, nothing generated. Absent means dead still, exactly as before.
 *
 * The push-in is ffmpeg's `zoompan`, present since 2.x and on Debian's 5.1.9 (flip checklist §11
 * runs still.test.ts in that container). The frame is prepared at PAN_OVERSAMPLE × the target so
 * the zoom samples real pixels rather than a 1080-wide frame stretched to 2160 and cut back; and
 * the chain goes through rgb24 into zoompan and back out through ONE scale that sets limited range
 * and BT.709 — the two properties the header above measured going wrong on a still, held here by
 * the same test.
 */
// The wire names live in ./stillMotion (a leaf the planner can import); "pan" is read there as dolly.
export { STILL_MOTIONS, type StillMotion };
/** The frame ends this much larger than it starts. 8 % over a 2–8 s hold reads as life, not a zoom. */
export const PAN_PUSH_IN = 0.08;
/** The prepared frame's size, as a multiple of the target, when it will be pushed into. */
export const PAN_OVERSAMPLE = 2;

/**
 * ─── MOVES THAT GO SOMEWHERE (PR 5, A1 — 22 Sep 2026) ───────────────────────────────────────────
 *
 * "dolly" stays exactly D2's centred push-in — stored rows and the planner's image items said "pan"
 * and mean that. The three below each head for a POINT in the photo:
 *
 *   zoom   the frame closes in to ZOOM_TO while its centre travels from the middle to the point
 *   punch  the same close-in, to PUNCH_TO, done in PUNCH_SEC and then held — a snap on the peak
 *   sweep  a pan across the photo's long axis at a fixed size, travelling TOWARD the point's side
 *
 * The point is hers when she tapped one (`StillFocus`, fractions of the UPRIGHT photo — display
 * space, the space every thumbnail is in). Untapped, a zoom or punch heads for FRAMING_PRIOR, the
 * upper middle, and a sweep crosses from the left. That is a framing prior, not detection: nothing
 * here knows who is in the photo. It replaced libvips' attention crop, which found her in 0 of 8
 * of her photos (crowd, ball, floor, headline text, her shin — PR 5 A4 prep, 22 Sep 2026) while
 * the upper middle sat within ~0.1 of her face in all 8. A real person finder would be a model
 * call; it is not built.
 *
 * All three FILL the frame (a cover crop around the point) instead of D2's letterboxed fit: a move
 * that travels into black bars reads as a mistake. Easing is smoothstep, so neither end lurches.
 */
export const FOCUSED_MOTIONS = ["zoom", "sweep", "punch"] as const;
export type FocusedMotion = (typeof FOCUSED_MOTIONS)[number];
export const isFocusedMotion = (m: unknown): m is FocusedMotion =>
  (FOCUSED_MOTIONS as readonly unknown[]).includes(m);

/** A point in the upright photo, as fractions of its width and height (0..1). */
export interface StillFocus {
  x: number;
  y: number;
}

/** Where a zoom ends: 25 % in — a clear move toward her, not a crop of her face. */
export const ZOOM_TO = 1.25;
/** Where a punch lands. Harder than a zoom, because it has a fifth of a second to get there. */
export const PUNCH_TO = 1.3;
export const PUNCH_SEC = 0.2;
/** A sweep on a photo already the frame's shape has no room to travel, so it takes this much. */
export const SWEEP_ROOM_ZOOM = 1.15;
/** The furthest a sweep travels, in frame-widths — a panorama is crossed in part, around the point. */
export const SWEEP_MAX_SPAN = 2;
/** The upright photo is decoded once at up to this long edge: 2 × the target's long edge is enough. */
export const MOVE_SOURCE_MAX_EDGE = 3840;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Everything a focused move needs, decided before any pixel moves — pure, so the geometry is pinned
 * by a test without spawning anything.
 */
export interface StillMove {
  motion: FocusedMotion;
  /** What sharp cuts out of the upright photo, in its pixels. */
  extract: Rect;
  /** What that cut is resized to — the frame ffmpeg is handed. */
  frame: { width: number; height: number };
  /** zoom / punch: where the frame's centre ends, as fractions of `frame`. */
  toward: StillFocus;
  /** sweep: which axis it travels, and whether toward its far end (right / down). */
  sweep: { axis: "x" | "y"; forward: boolean };
  /** zoom / punch: how far in it ends. 1 on a sweep. */
  zoomTo: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The move, in the upright photo's pixels.
 *
 * The WINDOW is the largest rectangle of the target's shape inside the photo, placed so the point
 * is as central as the photo's edges allow. zoom / punch cut exactly that window and close in on the
 * point inside it; a sweep cuts the stretch of photo the window travels along (at most
 * SWEEP_MAX_SPAN windows, centred on the point) and slides across it.
 */
export function planStillMove(
  photo: { width: number; height: number },
  target: Pick<Frame, "width" | "height">,
  motion: FocusedMotion,
  focus: StillFocus,
): StillMove {
  const pw = photo.width;
  const ph = photo.height;
  const aspect = target.width / target.height;
  const fx = clamp(focus.x, 0, 1) * pw;
  const fy = clamp(focus.y, 0, 1) * ph;
  let winW = pw / ph > aspect ? ph * aspect : pw;
  let winH = winW / aspect;
  const frameW = target.width * PAN_OVERSAMPLE;
  const frameH = target.height * PAN_OVERSAMPLE;

  if (motion !== "sweep") {
    const left = clamp(Math.round(fx - winW / 2), 0, pw - Math.round(winW));
    const top = clamp(Math.round(fy - winH / 2), 0, ph - Math.round(winH));
    const extract = {
      left,
      top,
      width: Math.round(winW),
      height: Math.round(winH),
    };
    return {
      motion,
      extract,
      frame: { width: frameW, height: frameH },
      toward: {
        x: clamp((fx - left) / extract.width, 0, 1),
        y: clamp((fy - top) / extract.height, 0, 1),
      },
      sweep: { axis: "x", forward: true },
      zoomTo: motion === "punch" ? PUNCH_TO : ZOOM_TO,
    };
  }

  // A SWEEP. Travel along whichever axis the photo has room on; a photo already the frame's shape
  // has none, so the window shrinks to make some and crosses it sideways.
  const roomX = pw - winW;
  const roomY = ph - winH;
  const flush = Math.max(roomX / winW, roomY / winH) < 0.05;
  if (flush) {
    winW /= SWEEP_ROOM_ZOOM;
    winH /= SWEEP_ROOM_ZOOM;
  }
  const axis: "x" | "y" = flush || pw - winW >= ph - winH ? "x" : "y";
  const along = axis === "x" ? pw : ph;
  const win = axis === "x" ? winW : winH;
  const span = Math.min(along, win * SWEEP_MAX_SPAN);
  const f = axis === "x" ? fx : fy;
  const start = clamp(Math.round(f - span / 2), 0, Math.round(along - span));
  // The cross axis is one window, placed on the point like a zoom's.
  const crossAlong = axis === "x" ? ph : pw;
  const crossWin = axis === "x" ? winH : winW;
  const crossF = axis === "x" ? fy : fx;
  const crossStart = clamp(
    Math.round(crossF - crossWin / 2),
    0,
    Math.round(crossAlong - crossWin),
  );
  const extract =
    axis === "x"
      ? {
          left: start,
          top: crossStart,
          width: Math.round(span),
          height: Math.round(winH),
        }
      : {
          left: crossStart,
          top: start,
          width: Math.round(winW),
          height: Math.round(span),
        };
  // The frame keeps the window at exactly frameW × frameH, so the crop that slides across it is the
  // target's shape at the oversampled size with nothing stretched.
  const k = frameW / winW;
  return {
    motion,
    extract,
    frame:
      axis === "x"
        ? { width: Math.max(frameW, even(extract.width * k)), height: frameH }
        : { width: frameW, height: Math.max(frameH, even(extract.height * k)) },
    toward: { x: 0.5, y: 0.5 },
    // Toward the point's side: a point right of centre is swept to from the left.
    sweep: { axis, forward: (axis === "x" ? focus.x : focus.y) >= 0.5 },
    zoomTo: 1,
  };
}

/** smoothstep of `p` (an ffmpeg expression already clipped to 0..1) — gentle at both ends. */
const smooth = (p: string) => `(3*pow(${p},2)-2*pow(${p},3))`;

/**
 * The -vf chain for a focused move. zoom / punch run through zoompan (D2's filter); a sweep is a
 * `crop` whose x or y is evaluated per frame — its size never changes, and zoompan's window always
 * has the INPUT's shape, which a sweep's frame is not.
 */
export function moveFilter(
  move: StillMove,
  frames: number,
  target: Frame,
): string {
  const { width: w, height: h } = target;
  const fps = fmt(target.fps);
  const last = Math.max(1, frames - 1);
  const out = `scale=${w}:${h}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`;
  if (move.motion === "sweep") {
    const e = smooth(`clip(n/${last},0,1)`);
    const along = move.sweep.forward ? e : `(1-${e})`;
    const pos = (axis: "x" | "y") =>
      move.sweep.axis === axis
        ? `'(${axis === "x" ? "iw-ow" : "ih-oh"})*${along}'`
        : axis === "x"
          ? "'(iw-ow)/2'"
          : "'(ih-oh)/2'";
    return (
      `format=rgb24,crop=w=${w * PAN_OVERSAMPLE}:h=${h * PAN_OVERSAMPLE}:x=${pos("x")}:y=${pos("y")},` +
      out
    );
  }
  // A punch lands in PUNCH_SEC with an ease-out; a zoom takes the whole hold, smoothstepped.
  const e =
    move.motion === "punch"
      ? `(1-pow(1-clip(on/${Math.max(1, Math.round(PUNCH_SEC * target.fps))},0,1),3))`
      : smooth(`clip(on/${last},0,1)`);
  const z = `1+${fmt(move.zoomTo - 1)}*${e}`;
  // The window's centre travels from the frame's middle to the point, and never leaves the frame.
  const cx = `iw*(0.5+(${fmt(move.toward.x - 0.5)})*${e})`;
  const cy = `ih*(0.5+(${fmt(move.toward.y - 0.5)})*${e})`;
  return (
    `format=rgb24,zoompan=z='${z}':x='clip(${cx}-iw/zoom/2,0,iw-iw/zoom)':` +
    `y='clip(${cy}-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${w}x${h}:fps=${fps},` +
    out
  );
}

/**
 * The exact ffmpeg argv for one still — pure, so the flags that matter can be pinned by a test
 * without spawning anything. Every value in it is ours: the dimensions and rate come from the
 * target's NAME (spec.ts STITCH_TARGETS), the hold was bounded by the parser, and the paths are the
 * workspace's own.
 */
export function stillEncodeArgs(
  framePath: string,
  outputPath: string,
  stillSec: number,
  target: Frame,
  /** How the photo moves over its hold — a slow push-in — or nothing: dead still, as it always was. */
  motion?: StillMotion,
  /** A focused motion's plan (`planStillMove`) — required beside zoom / sweep / punch, and only there. */
  move?: StillMove,
): string[] {
  assertLocalPath(framePath, "still frame");
  assertLocalPath(outputPath, "still output");
  if (
    isFocusedMotion(motion) !== (move !== undefined) ||
    (move !== undefined && move.motion !== motion)
  ) {
    // Unreachable through encodeStill, which plans exactly when it must. A throw rather than a
    // quiet dead still: a move she chose and did not get is a different video, delivered as a success.
    throw new Error(`A ${motion ?? "still"} photo was handed the wrong plan`);
  }
  const { width: w, height: h } = target;
  const fps = fmt(target.fps);
  // The push-in: fit into an oversampled box, then zoompan renders one output frame per input
  // frame (`d=1` — `-loop 1` already supplies one per tick) with the zoom climbing linearly to
  // 1 + PAN_PUSH_IN by the last frame, centred. rgb24 in, and one scale out that sets limited
  // range and BT.709 — see the motion header.
  const frames = Math.max(1, Math.round(stillSec * target.fps));
  const vf = move
    ? moveFilter(move, frames, target)
    : motion === "dolly"
      ? `scale=${w * PAN_OVERSAMPLE}:${h * PAN_OVERSAMPLE}:force_original_aspect_ratio=decrease,` +
        `pad=${w * PAN_OVERSAMPLE}:${h * PAN_OVERSAMPLE}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgb24,` +
        `zoompan=z='1+${PAN_PUSH_IN}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps},` +
        `scale=${w}:${h}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`
      : // Fit and pad as the engine would (black, like its own bars) — and convert to LIMITED range
        // and BT.709 here, because the engine's conform chain never will. See the header.
        `scale=${w}:${h}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  return [
    "-y",
    "-nostdin",
    // One picture, repeated at the target's rate for exactly the hold.
    "-loop",
    "1",
    "-framerate",
    fps,
    "-t",
    fmt(stillSec),
    "-i",
    framePath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    // A notch above the engine's 23: the engine re-encodes this, so it is the first of two
    // generations. Lossless (-qp 0) was measured at 3.3x the bytes for no visible gain.
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-r",
    fps,
    // No audio track. The engine lays silence under any position without one (plan.ts), so a still
    // beside clips that sound still joins, and a timeline of only stills comes out silent.
    "-an",
    outputPath,
  ];
}

/**
 * Her photo as an upright frame that fits the target box — orientation baked in, never enlarged.
 *
 * `rotate()` WITH NO ARGUMENT is the EXIF-driven form (studio/orient.ts uses it for the same reason),
 * and the output carries no metadata, so nothing downstream can rotate it a second time. A photo
 * with transparency is laid on black — the colour of the pad around it.
 */
export async function prepareStillFrame(
  photoPath: string,
  framePath: string,
  target: Frame,
  /** The box the frame is fitted into, as a multiple of the target — PAN_OVERSAMPLE for a push-in. */
  oversample = 1,
  /** The set's look (A3): this photo's correction is measured here, from its own pixels. */
  look?: StillLook,
): Promise<{ width: number; height: number }> {
  const upright = () => sharp(photoPath, { failOn: "none" }).rotate();
  // Measure, grade and write under ONE bound, as before the look existed.
  const work = async () => {
    const grade = look
      ? { gains: await measureCorrection(upright()), look }
      : undefined;
    const frame = await applyGrade(
      upright()
        .resize(target.width * oversample, target.height * oversample, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#000000" }),
      grade,
    );
    return frame.jpeg({ quality: 92 }).toFile(framePath);
  };
  const info = await withTimeout(work(), FRAME_TIMEOUT_MS, "still frame");
  return { width: info.width, height: info.height };
}

/**
 * ─── ONE LOOK ACROSS THE SET (PR 5, A3 — 22 Sep 2026) ───────────────────────────────────────────
 *
 * Photos from different phones and days do not match: one is warm under tungsten, one blue in
 * shade, one a stop under. A look is applied to EVERY still in the stitch, in two layers:
 *
 *   correction  per photo, from its own pixels: gray-world white balance measured on its NEUTRAL
 *               pixels only (a pitch is saturated green and would be "corrected" magenta), and an
 *               exposure gain toward a common mid-grey. Clamped both ways — a correction that has to
 *               move a channel more than a third is guessing.
 *   look        the same for every photo: natural (correction alone), warm, cool, teal-orange,
 *               muted, black and white.
 *
 * Both land in sharp on the prepared frame — one per-channel `linear` and, for muted and black and
 * white, one `modulate` — so the cost is one image operation per photo, not one per video frame,
 * and no ffmpeg filter is involved. Clips are not graded here (card: that is the engine's chain).
 */
export const STILL_LOOKS = [
  "natural",
  "warm",
  "cool",
  "teal-orange",
  "muted",
  "mono",
] as const;
export type StillLook = (typeof STILL_LOOKS)[number];
export const isStillLook = (v: unknown): v is StillLook =>
  (STILL_LOOKS as readonly unknown[]).includes(v);

/** What one photo's grade is: its own correction gains and the set's look. */
export interface StillGrade {
  /** Per-channel multipliers, white balance × exposure, for THIS photo. */
  gains: [number, number, number];
  look: StillLook;
}

/** Per-channel multiply and add, and a saturation, for each look — applied after the correction. */
const LOOK_OPS: Record<
  StillLook,
  {
    a: [number, number, number];
    b: [number, number, number];
    saturation?: number;
  }
> = {
  natural: { a: [1, 1, 1], b: [0, 0, 0] },
  warm: { a: [1.06, 1, 0.9], b: [4, 0, -2] },
  cool: { a: [0.93, 1, 1.07], b: [-2, 0, 4] },
  // Shadows lifted toward teal, highlights pushed toward orange: an offset does the first, a gain
  // the second.
  "teal-orange": { a: [1.08, 1, 0.92], b: [-10, 3, 12] },
  muted: { a: [0.94, 0.94, 0.94], b: [10, 10, 10], saturation: 0.72 },
  mono: { a: [1, 1, 1], b: [0, 0, 0], saturation: 0 },
};

/** The size a photo is read at to measure its correction — enough for a mean, fast to decode. */
const GRADE_PROBE_EDGE = 256;
/** A correction never moves a channel further than this, either way. */
const GAIN_MIN = 0.75;
const GAIN_MAX = 1.33;
/** Where exposure is pulled toward: the mean luma of a well-exposed photo, 0..1. */
const TARGET_LUMA = 0.46;
const EXPOSURE_MIN = 0.85;
const EXPOSURE_MAX = 1.2;
/** A pixel counts as neutral below this saturation (after a first-pass balance). */
const NEUTRAL_SATURATION = 0.3;

/**
 * This photo's correction, from its own pixels — the gains that make its neutrals neutral and its
 * exposure the set's. Deterministic: the same photo always gets the same gains.
 */
export async function measureCorrection(
  photo: sharp.Sharp,
): Promise<[number, number, number]> {
  const { data, info } = await photo
    .clone()
    .resize(GRADE_PROBE_EDGE, GRADE_PROBE_EDGE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const ch = info.channels;
  const mean = (pick: (r: number, g: number, b: number) => boolean) => {
    const m = [0, 0, 0];
    let c = 0;
    for (let i = 0; i < n; i++) {
      const r = data[i * ch];
      const g = data[i * ch + 1];
      const b = data[i * ch + 2];
      if (!pick(r, g, b)) continue;
      m[0] += r;
      m[1] += g;
      m[2] += b;
      c++;
    }
    return { m: m.map((v) => v / Math.max(1, c)), c };
  };
  const balance = (m: number[]) => {
    const grey = (m[0] + m[1] + m[2]) / 3;
    return m.map((v) => clamp(grey / Math.max(1, v), GAIN_MIN, GAIN_MAX));
  };
  // First pass over everything; then again over what looks neutral once that pass is applied — so
  // a pitch, a kit or a sky does not pull the balance toward its complement.
  const first = balance(mean(() => true).m);
  const neutral = mean((r, g, b) => {
    const R = r * first[0];
    const G = g * first[1];
    const B = b * first[2];
    const hi = Math.max(R, G, B);
    const lo = Math.min(R, G, B);
    return hi > 25 && hi < 245 && (hi - lo) / hi < NEUTRAL_SATURATION;
  });
  const wb = neutral.c >= n * 0.05 ? balance(neutral.m) : first;
  // Exposure: after the balance, pull the mean luma toward the common mid-grey.
  const all = mean(() => true).m;
  const luma =
    (0.2126 * all[0] * wb[0] +
      0.7152 * all[1] * wb[1] +
      0.0722 * all[2] * wb[2]) /
    255;
  const exposure = clamp(
    TARGET_LUMA / Math.max(0.01, luma),
    EXPOSURE_MIN,
    EXPOSURE_MAX,
  );
  return wb.map((g) => Math.round(g * exposure * 1000) / 1000) as [
    number,
    number,
    number,
  ];
}

/**
 * The grade, applied to a frame's pipeline. Absent grade: the frame untouched.
 *
 * TWO PASSES when the look changes saturation, because sharp does not run operations in the order
 * they are called: it runs `modulate` BEFORE `linear`. Measured on a green photo under "mono": the
 * grey came out of modulate and the correction's unequal channel gains then coloured it again
 * (83/255 between channels). So the correction and look gains are rendered first, and saturation is
 * applied to that result.
 */
export async function applyGrade(
  img: sharp.Sharp,
  grade?: StillGrade,
): Promise<sharp.Sharp> {
  if (!grade) return img;
  const look = LOOK_OPS[grade.look];
  const gained = img.linear(
    [0, 1, 2].map((c) => grade.gains[c] * look.a[c]),
    look.b,
  );
  if (look.saturation === undefined) return gained;
  const { data, info } = await gained
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  }).modulate({ saturation: look.saturation });
}

/**
 * Where an untapped zoom or punch heads: the upper middle, where a standing subject's face sits in
 * a portrait of her. A sweep untapped crosses from the left toward the middle-right.
 */
export const FRAMING_PRIOR: StillFocus = { x: 0.5, y: 0.28 };
const SWEEP_PRIOR: StillFocus = { x: 0.5, y: 0.5 };

/**
 * Her photo as the frame a focused move runs over: upright, the move planned around the point (hers,
 * or the framing prior), cut and resized to exactly the plan's frame. Returns the plan, because the argv
 * is built from it — the point and the pixels cannot come from two different decisions.
 */
export async function prepareMovingFrame(
  photoPath: string,
  framePath: string,
  target: Frame,
  motion: FocusedMotion,
  focus?: StillFocus,
  /** The set's look (A3), measured on this photo's own pixels. */
  look?: StillLook,
): Promise<StillMove & { focus: StillFocus }> {
  const work = async () => {
    // One decode, oriented and bounded; everything after reads these pixels.
    const { data, info } = await sharp(photoPath, { failOn: "none" })
      .rotate()
      .resize(MOVE_SOURCE_MAX_EDGE, MOVE_SOURCE_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#000000" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const size = { width: info.width, height: info.height };
    const upright = () =>
      sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
      });
    const point = focus ?? (motion === "sweep" ? SWEEP_PRIOR : FRAMING_PRIOR);
    const move = planStillMove(size, target, motion, point);
    const grade = look
      ? { gains: await measureCorrection(upright()), look }
      : undefined;
    const graded = await applyGrade(
      upright()
        .extract(move.extract)
        .resize(move.frame.width, move.frame.height, { fit: "fill" }),
      grade,
    );
    await graded.jpeg({ quality: 92 }).toFile(framePath);
    return { ...move, focus: point };
  };
  return withTimeout(work(), FRAME_TIMEOUT_MS, "still frame");
}

/** What one encoded still left in the workspace. */
export interface EncodedStill {
  /** The clip — what the engine is handed for this position. */
  path: string;
  /** The frame and the clip together: what this position actually wrote into the tmpfs. */
  bytes: number;
}

/**
 * One still position, start to finish: frame, then clip. Files are named by POSITION, because the
 * same photo may be held twice for two different lengths.
 */
export async function encodeStill(
  photoPath: string,
  dir: string,
  position: number,
  stillSec: number,
  target: Frame,
  /** Hard kill for this encode — the runner hands it what is left of the ffmpeg budget. */
  timeoutMs: number,
  /** A slow push-in over the hold (D2), a move toward a point (A1), or nothing. */
  motion?: StillMotion,
  /** Her tapped point for a focused move; absent means the framing prior (FRAMING_PRIOR). */
  focus?: StillFocus,
  /** The set's look (A3); absent means the photo exactly as it is, as before. */
  look?: StillLook,
): Promise<EncodedStill> {
  const frame = join(dir, `still-${position}.jpg`);
  const clip = join(dir, `still-${position}.mp4`);
  let move: StillMove | undefined;
  if (isFocusedMotion(motion)) {
    move = await prepareMovingFrame(
      photoPath,
      frame,
      target,
      motion,
      focus,
      look,
    );
  } else {
    await prepareStillFrame(
      photoPath,
      frame,
      target,
      motion === "dolly" ? PAN_OVERSAMPLE : 1,
      look,
    );
  }
  try {
    await execFileP(
      "ffmpeg",
      stillEncodeArgs(frame, clip, stillSec, target, motion, move),
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (err: any) {
    const stderr = String(err?.stderr ?? "").trim();
    throw new Error(
      `ffmpeg still encode failed${err?.killed ? ` (killed after ${timeoutMs}ms)` : ""}: ${stderr.slice(-400) || String(err?.message ?? err)}`,
    );
  }
  const bytes = (await stat(frame)).size + (await stat(clip)).size;
  return { path: clip, bytes };
}
