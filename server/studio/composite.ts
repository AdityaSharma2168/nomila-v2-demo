/**
 * studio/composite — the paste-back. The step that makes an edit an EDIT rather than a re-render.
 *
 * ─── WHY THIS EXISTS: THE MODEL NEVER PRESERVES PIXELS ──────────────────────────────────────────
 *
 * Three live probes settled it, and none of them is a matter of prompting harder:
 *
 *   maskless text-only edit          a full re-render at 1/22 resolution (848x1264 from 6000x4000)
 *   masked edit at imageSize:4K      still a full re-render — 9% of pixels outside the mask survived
 *   masked COMPOSITE at 4000x6000    the original, with only the marked region changed
 *
 * Every hosted image model — Nano included — runs the whole frame through an encode/denoise/decode
 * round trip. The round trip is lossy EVERYWHERE, not just under the mask, so pixels the model was
 * never asked to touch come back different. That is structural, it is published, and the published
 * fix is exactly this: composite the model's output into the original outside the changed region.
 *
 * So "the rest is untouched" is OUR arithmetic, not the provider's behaviour. That is the good news
 * rather than the bad: a property we compute is a property jest can prove, where a property the
 * provider supplies is one that drifts silently with the next model update.
 *
 * ─── THE SHAPE ──────────────────────────────────────────────────────────────────────────────────
 *
 *   full-res original (upright — studio/orient.ts guarantees it before anything gets here)
 *          │
 *     ① per REGION: grow by context padding, clamp to the frame, downscale if over the patch ceiling
 *     ② sharp(frame).extract(crop)                                    → what the model sees
 *          │
 *          ▼   image.edit(cropBytes, label)  — the CROP IS THE MASK, see below
 *     ③ patch, resized back to the crop's own source-pixel dimensions
 *     ④ composite ONLY the region rectangle onto the untouched original, FEATHERED at its edge,
 *        then removeAlpha()
 *          ▼
 *     the original, with only the marked rectangles changed
 *
 * ─── ① THE CROP IS THE MASK ─────────────────────────────────────────────────────────────────────
 *
 * There is no alpha channel anywhere in this path and none is needed. The model can only change what
 * it can see, and it cannot see outside the crop — so everything outside is preserved by
 * construction rather than by instruction. This is the piece that replaces the prose mask
 * (`CHANGE ONLY: <label> (at x,y, WxH)` in studio/preview.ts), which asked the model to respect a
 * boundary and was obeyed 9% of the time.
 *
 * Google's own binary-mask endpoint would have been the obvious alternative. `MaskReferenceImage`
 * and `EDIT_MODE_INPAINT_REMOVAL` are still typed in the installed @google/genai and they are dead
 * code: the only model that served them, imagen-3.0-capability-001, retired on 30 June 2026, and
 * Google's stated migration is to the very :generateContent re-render path this module exists to
 * work around. Checked, not assumed. Do not be tempted by those types.
 *
 * ─── ④ PASTE BACK PER REGION, NEVER PER CROP. THIS IS THE WHOLE GUARANTEE ───────────────────────
 *
 * The crop is PADDED, so it contains a ring of pixels the model saw and re-rendered but was never
 * asked to change. That ring carries the round-trip drift. Compositing the whole patch would import
 * that drift into a halo around every edit — invisible in review, permanent in the file.
 *
 * Compositing only the REGION rectangle means the padded ring is used for context and then thrown
 * away, and the property becomes: pixels outside the regions are the original's, by construction.
 *
 * ─── ⑤ THE EDGE IS FEATHERED, AND THAT IS A DELIBERATE TRADE ───────────────────────────────────
 *
 * A hard paste makes the region boundary a STEP, and a step is where a continuous feature breaks.
 * Measured on a synthetic 6000x4000 frame carrying a dead-straight crossbar through the region: a
 * model that redrew that bar just 3px low inside the crop produced a 3.00px discontinuity at both
 * edges of the rectangle — the original's bar outside, the model's bar inside, meeting at a right
 * angle. Nothing about the arithmetic was wrong; the paste was exact. It is exactness ACROSS a
 * disagreement that reads as a bend.
 *
 * So the region's own edge now ramps: alpha 0 at the rectangle's boundary rising to 255 over
 * `featherRadiusFor(region)` pixels INWARD. A step becomes a cross-fade. It does not make the
 * model's drift correct — that is what the continuity clause in buildPrompt's crop arm is for — it
 * stops the drift from announcing itself as a hard line.
 *
 * THE RAMP IS INWARD, NEVER OUTWARD, and that is the whole reason the guarantee below survives.
 * Straddling the boundary would bleed the model's round-trip drift into pixels she never marked,
 * which is precisely what ④ exists to prevent. Inward-only costs the ramp's width of the EDIT and
 * costs the original nothing.
 *
 * `pasteBack` takes `{ feather: false }` to restore the hard paste exactly as it was. It is not the
 * default and nothing in the product passes it today; it is there so a future strict mode has a
 * code path rather than a rewrite.
 *
 * What the feather does NOT fix is a rigid straight line running THROUGH the region — see the known
 * limit on featherRadiusFor. That one is measured, understood and accepted.
 *
 * ─── WHAT "UNCHANGED" HONESTLY MEANS ────────────────────────────────────────────────────────────
 *
 * Say PIXEL-identical, never BYTE-identical, and know which one this delivers where. The feather
 * moved ONE line of this table, and it is the line about the inside:
 *
 *   the composited BUFFER, outside the regions   EXACTLY the original's pixels. Zero difference.
 *                                                UNCHANGED BY THE FEATHER, because the ramp lives
 *                                                inside the rectangle. Still our arithmetic, still
 *                                                exact, still proven in composite.test.ts against
 *                                                an adversarial patch.
 *   inside a region, beyond the ramp             EXACTLY the patch. `featherRadiusFor` px in from
 *                                                the rectangle's edge and deeper.
 *   inside a region, within the ramp             ← THE PART THAT IS NEW. A linear blend of the two,
 *                                                weighted by distance to the edge. NOT the patch and
 *                                                NOT the original. Nothing may claim otherwise.
 *   a PNG or WebP output                         the buffer above, exactly — those encoders are
 *                                                lossless here.
 *   a JPEG output                                the buffer above, re-encoded. MEASURED on a 24MP
 *                                                frame: max delta 4/255 at the top rung. That is
 *                                                the container, not the model.
 *
 * The JPEG number is not a shrug. Re-encoding at sharp's DEFAULTS moves a pixel by up to 116/255 —
 * a visible artifact — and almost all of that is CHROMA SUBSAMPLING rather than quality: at q92 the
 * measured max delta is 55 with 4:2:0 and 22 with 4:4:4. So 4:4:4 is load-bearing on this path and
 * is not a quality preference. JPEG_LADDER below carries the measurements.
 *
 * ─── PURE ARITHMETIC IS SEPARATED FROM THE sharp IO, ON PURPOSE ─────────────────────────────────
 *
 * `planCrops` is a pure function of two numbers and a list of boxes — no sharp, no IO, no clock —
 * for the same reason studio/geometry.ts is: the arithmetic the whole feature rests on has to be
 * provable in jest without a harness. The sharp calls below are deliberately thin wrappers with no
 * decisions in them.
 *
 * `sharp` is NOT a new dependency and this is NOT the first place it is load-bearing: studio/orient
 * .ts already runs it in-request on the source frame of every rotated edit. Same library, same lane,
 * same code path.
 */
import sharp from "sharp";
import { withTimeout } from "../lib/withTimeout";
import {
  backgroundMaskEnabled,
  garmentMaskEnabled,
  maskErodePx,
  maskMaxCropFill,
  maskMaxOverreach,
  segmentLongEdgePx,
} from "./config";
import { createLogger } from "../logger";
import type { EditRegion } from "./brief";
// TYPE-ONLY, so the segment.ts -> composite.ts import stays the only real edge between them.
import type { MaskMiss } from "./segment";

const logger = createLogger("studio/composite");

// ─── Constants, every one of them a starting figure with its reasoning attached ─────────────────

/**
 * How much bigger than the region the crop is, in each dimension.
 *
 * An image model needs surrounding context to match lighting, grain and texture; a crop taken to the
 * region's own edges produces a visible seam because the model has nothing to match against. 2 means
 * the crop is twice the region's width and twice its height — half a region's worth of context on
 * each side.
 *
 * A V1 FIGURE, to be tuned on real frames. It costs nothing to be generous: the padding is context
 * the model sees and we then throw away, so a larger pad trades input tokens for a better seam and
 * never trades away the guarantee.
 */
export const CONTEXT_PAD_FACTOR = 2;

/**
 * The floor on that padding, per side, in source pixels.
 *
 * A proportional pad alone collapses on a small region: a 60px logo would get 30px of context, which
 * is nothing to match a surface against. 256 per side (512 across) is the floor at which a patch has
 * a real neighbourhood to reconstruct from.
 */
export const MIN_CONTEXT_PAD_PX = 256;

/**
 * The largest crop we will send, in pixels of AREA — and it is an area rather than a long edge
 * because that is how the model's own size knob behaves.
 *
 * `imageSize: "4K"` does not cap the long edge at 4096. It caps the AREA at about 4096², and
 * distributes it by aspect ratio: a 4000x6000 frame at 4K came back 3392x5056, which is 17.1
 * megapixels against a nominal 16.8. Measured on the live project, not read off a table.
 *
 * So this is 4096² — the most the largest size can return. A crop bigger than this cannot come back
 * at its own resolution no matter what we ask for, and the patch would be an upscale pasted into a
 * sharp photograph. Above it we downscale the crop on the way OUT and upscale the patch on the way
 * BACK, which loses detail inside the region only and never touches the guarantee (see planCrop).
 */
export const MAX_PATCH_PIXELS = 4096 * 4096;

/**
 * JPEG re-encode settings, in preference order, with the measured cost of each.
 *
 * MEASURED on a detailed synthetic 24MP frame (4000x6000, 7.5 MB at q92 4:2:0), diffing every
 * subpixel outside the composited region against the original:
 *
 *   quality  chroma   max delta   output size
 *   100      4:4:4        4        20.3 MB
 *    95      4:4:4       14        10.5 MB
 *    90      4:4:4       ~20        ~9 MB
 *   ── for contrast, what we are NOT doing ──
 *    92      4:2:0       55         7.4 MB      ← subsampling, not quality, is the damage
 *   sharp's default                116                     (the first probe's result)
 *
 * WHY A LADDER RATHER THAN ONE SETTING. mediaStore caps a stored object at 25 MB, and q100 4:4:4 on
 * a REAL 24MP camera frame lands near or over that — the synthetic above is more compressible than a
 * real photograph. A single setting would therefore fail the primary use case (a full-res edit of a
 * phone photo) with "over the media size cap" rather than degrading. So the encoder steps down until
 * the result fits, deterministically, and logs which rung it used.
 *
 * The cap itself is shared code and is NOT changed here — see the note on encodeToFit.
 */
export const JPEG_LADDER: readonly {
  quality: number;
  chromaSubsampling: "4:4:4";
}[] = [
  { quality: 100, chromaSubsampling: "4:4:4" },
  { quality: 95, chromaSubsampling: "4:4:4" },
  { quality: 90, chromaSubsampling: "4:4:4" },
];

/**
 * How far a returned PATCH may drift from the shape of the crop it was given.
 *
 * ─── THE OLD GUARD MOVED HERE, BECAUSE THE OLD FAILURE MOVED ────────────────────────────────────
 *
 * studio/generate.ts refuses an edit whose OUTPUT is a different shape from the frame — the
 * sideways-return guard. On the composited path that check has become structurally unreachable: the
 * output is the original with rectangles pasted into it, so it has the frame's shape by
 * construction, and the guard passes without ever being able to fail.
 *
 * That is not the same thing as the danger being gone. It moved DOWN a level. A patch that comes
 * back transposed relative to its crop is not rotated by the resize below — it is SQUASHED, because
 * `fit: "fill"` forces it to the crop's exact dimensions. The result is a correctly-placed,
 * correctly-sized region containing a distorted picture, which no dimension check upstream can see.
 *
 * So the shape assertion lives here now, against the crop rather than the frame. 0.15 matches the
 * threshold generate.ts uses and is set to catch a TRANSPOSE and nothing else: a model returning a
 * slightly different rounding of the same ratio is normal and must pass.
 *
 * ─── WHY 0.15 CANNOT BE TIGHTENED WITHOUT MOVING SOMETHING ELSE FIRST ───────────────────────────
 *
 * This number is ABOVE the worst error we induce ourselves, and that is not an accident to be fixed
 * here. `aspectFor` in studio/compile/aspect.ts snaps the crop's real ratio to the closed set the
 * image model accepts (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9). The widest gap in that set is
 * 3:4→1:1 and 1:1→4:3, so a crop landing midway is asked for at a canvas 15.47% off its own shape —
 * measured, not estimated. A 6000x4000 frame with a 760x760 region whose crop CLAMPS at the top
 * edge lands at 1520x1240 and is asked for as 4:3: 8.77% of anisotropy, comfortably inside 0.15.
 *
 * Tightening this guard would therefore start refusing our OWN request, which is a refusal the
 * athlete cannot act on. The anisotropy is only destructive if the provider preserves the scene's
 * proportions inside the canvas it was given rather than filling it; if it fills, pasteBack's
 * fit:"fill" undoes the stretch exactly (measured: 0.51px over a 1520px crop, sub-pixel). Which of
 * those the provider does is not known from any artifact we keep, because the PATCH IS NOT STORED.
 * Do not narrow this constant until that has been observed on a real return.
 */
export const MAX_PATCH_ASPECT_DRIFT = 0.15;

/**
 * How wide the blend ramp at a region's edge is, as a fraction of the region's SHORTER side.
 *
 * PROPORTIONAL, NOT A FIXED PIXEL COUNT, and that is the whole point of the constant. A 200px
 * necklace and a 2000px background do not want the same ramp: 20px is a third of the necklace and a
 * hairline on the background. One number that suits both does not exist, so this is a fraction and
 * the pixels fall out of the region.
 *
 * 3% is a starting figure and it is deliberately narrow. The ramp is where the edit CROSS-FADES,
 * which means it is also where two versions of a texture are visible at once — too wide and grass
 * or netting inside the region goes soft near its edge, which is the failure the seam was traded
 * for. 3% of a 760px region is 23px: several times any drift a model has produced on this path, and
 * a thin band of a large region.
 */
export const FEATHER_FRACTION = 0.03;

/** A one-pixel ramp is a hard edge with extra steps. Below this there is no point pretending. */
export const MIN_FEATHER_PX = 2;

/**
 * The blend ramp for one region, in source pixels. Pure — the same reason planCrop is.
 *
 * The quarter-of-the-shorter-side ceiling is STRUCTURAL rather than aesthetic: two opposite ramps
 * that meet in the middle leave a region with no interior that is actually the edit, and the athlete
 * would have paid for a generation that got averaged away. At 3% it only ever binds on a region near
 * MIN_REGION_PX (8), where a quarter is 2 and the floor is 2 as well.
 *
 * ─── KNOWN LIMIT: A HIGH-CONTRAST STRAIGHT LINE RUNNING THROUGH THE REGION ─────────────────────
 *
 * A rigid line that CROSSES the edit rectangle — a goalpost crossbar, a railing, a horizon — can
 * come back displaced by roughly 1-2% of the crop. The feather removes the SEAM; it does not
 * straighten the line, and where the displacement is close to the feather radius the cross-fade
 * shows two positions of the line at once: a soft double rather than a hard step.
 *
 * THIS IS THE MODEL REDRAWING, NOT OUR GEOMETRY, and that was established by measurement rather
 * than by reasoning. On the live case (a 432x456 region on a 4000x6000 frame, crop 944x968 asked as
 * 1:1, 2.54% of aspect quantization) the bar inside the rectangle moved 13px UP and ~8px sideways,
 * with no shear gradient between the region's upper and lower halves and a residual error of 2.7-16
 * MAE after the best rigid alignment. Aspect quantization predicts the opposite sign (+4px DOWN),
 * exactly zero horizontal, and a shear that is measurably absent — so it is ruled out three ways,
 * and letterboxing the crop instead of stretching it would fix nothing. Outside the rectangle the
 * same measurement reads dx=0, dy=0, MAE 0.09: the paste-back itself is exact.
 *
 * Note the arithmetic that makes the double visible rather than invisible: 3% of 432 is 13px, and
 * the displacement was 13px. The ramp and the error were the same size. WIDENING THE FEATHER DOES
 * NOT HELP — it lengthens the ghost instead of shortening it.
 *
 * ACCEPTED, not chased. A rigid line passing through the region is close to worst-case for a
 * crop-composite and is rare in real edits; the feather is a clear win on everything else. Do not
 * re-diagnose this, and do not reach for the geometry: it has been looked at.
 */
export function featherRadiusFor(region: {
  width: number;
  height: number;
}): number {
  const shorter = Math.min(region.width, region.height);
  const ceiling = Math.floor(shorter / 4);
  const proportional = Math.round(shorter * FEATHER_FRACTION);
  return Math.max(0, Math.min(Math.max(proportional, MIN_FEATHER_PX), ceiling));
}

/**
 * The erode depth for one region, bounded so a small region cannot be eaten alive.
 *
 * ⚠️ THE CEILING HERE IS ALL BUT UNREACHABLE, AND THE COMMENT THAT USED TO SIT ON IT SAID
 * OTHERWISE. It claimed the quarter-of-the-shorter-side ceiling stopped "a constant sized for a
 * jersey" from eating a 60px sock. It does not: a quarter of 60 is 15, and the constant was 2, so
 * the ceiling never bound and the erode was FLAT at every real region size. For it to bind at an
 * erode of 2 the region has to be under 8px — and studio/geometry.ts MIN_REGION_PX rejects those
 * before they reach here. The protection was decorative and the flat 2px inset it let through is
 * half of why a small garment came back with an outline around it.
 *
 * It is kept, and it is real now, because `maskEdgeFor` applies it to the whole BAND rather than to
 * the erode alone — see there.
 */
export function maskErodeFor(
  region: { width: number; height: number },
  erodePx: number,
): number {
  const ceiling = Math.floor(Math.min(region.width, region.height) / 4);
  return Math.max(0, Math.min(erodePx, ceiling));
}

// ─── THE MASK EDGE IS NOT THE RECTANGLE EDGE, AND MUST NOT BE SIZED LIKE ONE ───────────────────
//
// `featherRadiusFor` sizes the RECTANGLE's ramp, and 3% of the region is right for that job: the
// rectangle's edge cuts straight through continuous content — grass, a wall, a thigh — and the only
// thing hiding the join is a wide cross-fade.
//
// A MASK edge is the opposite kind of boundary. It follows a real object: garment against ground.
// The two sides are SUPPOSED to look different. A wide ramp there hides no seam; it smears the
// garment into what is behind it.
//
// Handing the mask `featherRadiusFor(region)` — which is what this did — made the artifact change
// shape with the region instead of staying fixed, and both ends of that were reported as bugs:
//
//   region       ramp  erode  band   what it looked like
//   180x110         3      2     5   40% of the transition is a hard hole punched 2px inside the
//   (a shoe)                         shoe, so the OLD shoe rims the new one — "a weird outline".
//   900x1100       27      2    29   a 29px halo where the jersey meets the background.
//   4000x6000     120      2   122   a 122px smear. Unusable at any subject boundary.
//
// So the mask gets its own ramp, sized by the only thing that actually blurs a mask edge: how far
// the boundary can have MOVED between the resolution it was drawn at and the one it is used at.

/**
 * The antialias itself — the width a real object edge occupies in a photograph.
 *
 * This is the part of the ramp that is not uncertainty. Below 2 there is no gradient at all:
 * `maskAlpha` only produces intermediate values strictly between `erode` and `erode + ramp`, so a
 * 1px ramp is a hard step with extra arithmetic, exactly as MIN_FEATHER_PX says of the rectangle.
 */
export const MASK_ANTIALIAS_PX = 2;

/**
 * The ramp must be at least this many times the erode.
 *
 * ─── THE RAMP HAS TWO JOBS AND SIZING IT FOR ONLY THE FIRST SHIPPED A VISIBLE SEAM ─────────────
 *
 * Job one is absorbing the boundary's position uncertainty, which is what `MAX_MASK_EDGE_UNCERTAINTY_PX`
 * and `MASK_ANTIALIAS_PX` are measured for. Job two is HIDING THE ERODE'S OWN PLATEAU, and it was
 * missed.
 *
 * `maskAlpha` pins alpha to 0 for the first `erode` pixels inside the mask — that is the fringe
 * being discarded, and those pixels composite as the ORIGINAL garment. A ramp much wider than the
 * plateau makes them the quiet start of a long fade. A ramp barely wider than it makes them a
 * crisp line of the original colour, and on a black jersey against skin that line is exactly the
 * "dark rim at the sleeve" this constant exists to prevent.
 *
 * MEASURED, on a jersey-scale sleeve edge, dark original against a lighter edit:
 *
 *   erode 2, ramp 27   30 30 36 44 50 58 65 72 79 86 93 100 …   max step  8/px   invisible
 *   erode 2, ramp  4   30 30 77 125 172 220 220 …               max step 48/px   a visible line
 *   erode 2, ramp  6   (this constant)                          max step 43/px   a fade again
 *
 * Note what the naive metric said: the second row shows LESS of the original than the first (a
 * 1px darker-than-half band against 13px) and looks far worse. BAND WIDTH IS THE WRONG MEASURE.
 * Edge SHARPNESS — the largest alpha step between neighbouring pixels — is the one that predicts
 * whether a seam is visible, and it is what the tests on this now assert.
 *
 * At 3 the plateau is never more than a quarter of the transition. Small garments already
 * satisfied it (erode 1, ramp 3) and are unchanged by it, which is the point: this repairs the
 * large-garment end without touching the end that motivated narrowing the ramp at all.
 */
export const MASK_RAMP_TO_ERODE = 3;

/**
 * Ceiling on the derived uncertainty.
 *
 * Measured, not guessed: the probe round trip (crop → `segmentLongEdgePx` → back to crop space
 * through `fit: "fill"`, then `distanceToOutside`'s 128 threshold) puts the recovered boundary a
 * mean 0.5-1.0px and a WORST 2.4px from the truth, and that worst case was at a 5.9x upscale — a
 * whole-frame crop, the largest this path can produce. Lanczos keeps the antialiased grey ramp and
 * the 128 threshold reads its 50% crossing, which is why the error grows far slower than the scale.
 * 3 is that worst case rounded up.
 */
export const MAX_MASK_EDGE_UNCERTAINTY_PX = 3;

/**
 * How much the mask is enlarged between the resolution it was DRAWN at and the resolution it is
 * USED at. Never below 1.
 *
 * Two downscales stack on this path and both have to be counted or the uncertainty is understated:
 *
 *   ① the SEND downscale. `cropFrame` resizes to `plan.send` when the crop is over MAX_PATCH_PIXELS,
 *     and studio/generate.ts hands the segmenter that same buffer — so a downscaled crop was already
 *     smaller than `plan.crop` before the segmenter ever saw it.
 *   ② the PROBE downscale. studio/segment.ts `probeBytes` fits that to `segmentLongEdgePx`, and does
 *     it `withoutEnlargement`, so a crop already under the probe edge is passed through untouched —
 *     which is why a shoe crop (622x582) has an upscale of exactly 1 and a whole frame has 5.9.
 *
 * The mask then comes back to `plan.crop` in one `fit: "fill"` (pasteBack), so the total is the
 * crop's long edge over the probe's.
 */
export function maskUpscaleFor(
  plan: PlannedCrop,
  probeLongEdge: number,
): number {
  const sent = plan.downscaled ? plan.send : plan.crop;
  const sentLong = Math.max(sent.width, sent.height);
  // ⚠️ A MALFORMED PROBE EDGE MUST NOT REACH THE ARITHMETIC. `segmentLongEdgePx` is
  // `Number(process.env...)`, so a typo in the env makes it NaN — and NaN here does not throw, it
  // propagates through the erode and the ramp into `maskAlpha`, where every comparison is false,
  // every alpha rounds to 0, and the region silently keeps the ORIGINAL. A config typo would look
  // exactly like "the edit did nothing", with no error anywhere. Falling back to `sentLong` reads
  // the unusable value as "we do not know that it was downscaled", which is the honest assumption
  // and is bounded either way by MAX_MASK_EDGE_UNCERTAINTY_PX.
  const probe =
    Number.isFinite(probeLongEdge) && probeLongEdge > 0
      ? probeLongEdge
      : sentLong;
  // `withoutEnlargement`: the probe is the smaller of the two, never the larger.
  const probeLong = Math.max(1, Math.min(sentLong, probe));
  const cropLong = Math.max(plan.crop.width, plan.crop.height);
  return Math.max(1, cropLong / probeLong);
}

/**
 * The mask boundary's position uncertainty, in crop pixels. 1 at native resolution, 3 at worst.
 *
 * `sqrt` rather than the raw scale because the error is NOT one probe pixel per probe pixel — the
 * resample preserves sub-pixel edge position in its grey ramp. Against the measurement above
 * (1.0px at 1.0x, 2.0px at 2.15x, 2.4px at 5.86x) `ceil(sqrt(scale))` gives 1, 2, 3: it tracks the
 * measured curve and never sits under it, which is the direction that matters.
 *
 * `ceil` means this is three bands rather than a curve, and they read as what they are: 1 when the
 * crop was never resampled at all (scale exactly 1), 2 up to a 4x upscale, 3 beyond it. A crop one
 * pixel over `segmentLongEdgePx` therefore steps 1 → 2, which is coarse and deliberately so — any
 * resampling at all costs a pixel of certainty about where the boundary was, and rounding that down
 * is the direction that puts a hard step back at the garment edge.
 */
export function maskEdgeUncertaintyFor(
  plan: PlannedCrop,
  probeLongEdge: number,
): number {
  const scale = maskUpscaleFor(plan, probeLongEdge);
  return Math.min(Math.ceil(Math.sqrt(scale)), MAX_MASK_EDGE_UNCERTAINTY_PX);
}

/**
 * The mask's own erode and ramp for one region. The fix for the seam, in one function.
 *
 * ERODE = the uncertainty. It exists to discard the thin fringe of background the segmenter leaves
 * inside a garment boundary, and that fringe IS the boundary error — the same quantity measured
 * from the other side. So it shrinks to 1px on a crop that was never downscaled, which is where a
 * small garment lives, instead of the flat 2px that put a rim of the original shoe around the
 * edited one.
 *
 * RAMP = the uncertainty plus the antialias. It stays within a few pixels at every region size,
 * which is the whole point: 4-8px instead of 5 → 122.
 *
 * ⚠️ THE CEILING IS ON THE BAND, NOT ON THE ERODE. `erode + ramp` is what is actually inset from
 * the garment's edge, so that is what must not swallow a small region. This is the ceiling
 * `maskErodeFor` was documented as providing and never did — on the band it genuinely binds, at
 * regions under about 32px.
 *
 * ⚠️ STILL ONLY SUBTRACTS. Both numbers are insets measured INWARD from the mask's own boundary by
 * `distanceToOutside`. Neither can move a pixel from outside the mask to inside it, so the
 * invariant above `distanceToOutside` is untouched by this — it is not re-argued here because it is
 * not re-traded here.
 */
/**
 * The erode to use when nobody named one — 0 on a boundary we trust, the uncertainty when we do not.
 *
 * ─── WHY 0 AT 1px, AND WHY NOT 0 EVERYWHERE ────────────────────────────────────────────────────
 *
 * The erode discards a fringe of background the segmenter leaves inside a garment boundary. It has
 * been reduced once already for exactly this reason — 2px to 1px, to remove "the rim of the original
 * that read as an outline" (see garmentMask.test.ts). It did not finish the job.
 *
 * Measured on a real frame, mean change magnitude by depth inside the SAM contour (synthetic patch,
 * no edit call — see maskErodePx in studio/config.ts for the spill half of the same probe):
 *
 *                      1px in    2px     3px    deep interior
 *     erode 1             0.5     4.3    10.4      32.3   (fabric)
 *     erode 0             7.4    12.1    19.0      33.7
 *     erode 1             0.6    11.9    25.5      43.6   (hair)
 *     erode 0            19.6    30.6    43.8      44.2
 *
 * At erode 1 the outermost ring receives essentially NO edit — that ring is the rim. Erode 0 lifts
 * it 15x on fabric and 33x on hair, monotonically, and spill outside the contour stayed at exactly
 * 0.000% at every value: this direction has no safety surface at all.
 *
 * ⚠️ RATIOS BETWEEN DEPTH BANDS ARE THE SIGNAL. The magnitudes come from a synthetic hue-shift
 * standing in for a model patch; nothing should be tuned against the absolute numbers.
 *
 * ⚠️ AND THE SYNTHETIC METHOD IS TRUSTWORTHY, WHICH IS WORTH KNOWING BEFORE SPENDING. It forecast
 * the outer ring reaching 22% of interior change at erode 0; a real image.edit call on a frame with
 * a reported rim gave 22.7%, with spill 0.00% both ways. Geometry questions should be answered with
 * the free probe. Pay for a generation only when the question is about model OUTPUT, which a
 * hue-shift genuinely cannot stand in for.
 *
 * ⚠️ ABOVE 1px THE DERIVATION IS KEPT, AND THAT IS NOT TIMIDITY — IT IS THE UNMEASURED CASE.
 * `uncertainty` exceeds 1 only when the probe was DOWNSCALED, which is the whole-frame path. At 1px
 * "erode 0" means trusting the contour as it came back, which the probe above supports. At 3px it
 * would mean trusting a boundary the system itself says may be off by three pixels, in the
 * direction of pixels nobody asked to edit — and on a downscaled whole-frame probe what is adjacent
 * is very often skin. Same asymmetry that governs every other choice in this file: under-coverage
 * is a visible rim, over-coverage on an uncertain boundary edits something next to the target.
 *
 * ⚠️ THE DOWNSCALED CASE IS UNMEASURED. The probe ran on a 480x640 frame with no probe downscale,
 * so it says nothing about uncertainty 2 or 3. To settle it, run the same depth-band method on a
 * frame large enough to force a downscale, with a mask whose boundary is adjacent to skin, and
 * compare the 1px band against the interior at the derived erode and at 0. Until then that path
 * keeps the behaviour it has rather than quietly inheriting this one.
 */
function defaultErodeFor(uncertainty: number, polarity: MaskPolarity): number {
  // ⚠️ ─── THE ERODE MEANS OPPOSITE THINGS ON THE TWO POLARITIES ────────────────────────────────
  //
  // Discovered by this change breaking backgroundMask.test.ts, not by reading the code.
  //
  //   edit-inside      the mask is the GARMENT, so the erode shrinks the edit away from the
  //                    garment's edge — and what it leaves behind is the rim of original fabric
  //                    this whole change exists to remove.
  //   preserve-inside  the mask is HER, and it is INVERTED before use, so the erode shrinks the
  //                    edit away from HER outline. What it leaves behind is a margin of original
  //                    background hugging her edge, which is protective.
  //
  // Same number, same code path, opposite consequence. Reducing it fixes a cosmetic rim on one arm
  // and removes a safety margin on the other, where the pixels next to the boundary are her hair
  // and her skin. The probe that justifies erode 0 measured EDIT-INSIDE masks only (a tank top and
  // hair, both as things to change), so it says nothing about the inversion arm at all.
  //
  // So the inversion arm keeps the derived erode. Same asymmetry as everywhere else here:
  // under-coverage is a visible rim, over-coverage on a boundary adjacent to a person is editing
  // her.
  if (polarity === "preserve-inside") return uncertainty;
  return uncertainty <= 1 ? 0 : uncertainty;
}

export function maskEdgeFor(
  region: { width: number; height: number },
  plan: PlannedCrop,
  probeLongEdge: number,
  erodeOverride?: number,
  /**
   * Which side of the mask the edit lands on. Defaults to the garment arm, which is every caller
   * that predates the split — see `defaultErodeFor` for why the two cannot share a default.
   */
  polarity: MaskPolarity = "edit-inside",
): { erode: number; ramp: number } {
  const uncertainty = maskEdgeUncertaintyFor(plan, probeLongEdge);
  const erode = maskErodeFor(
    region,
    erodeOverride ?? defaultErodeFor(uncertainty, polarity),
  );
  const ceiling = Math.floor(Math.min(region.width, region.height) / 4);
  // Wide enough to absorb the boundary uncertainty, AND wide enough to hide the erode's plateau —
  // whichever binds. See MASK_RAMP_TO_ERODE for what sizing it on the first alone looked like.
  // ─── THE FLOOR IS WHAT IS LEFT OF THE RIM ONCE THE ERODE IS GONE. MEASURED. ────────────────
  //
  // The reported seam is a ring of ORIGINAL garment around the edited one. Probed on a real frame
  // by mean change magnitude at each depth inside the SAM contour (synthetic patch, no edit call):
  //
  //                      1px in    2px     3px    deep interior
  //     erode default       0.5     4.3    10.4      32.3        ← the outer ring is untouched
  //     erode 0             7.4    12.1    19.0      33.7        ← most of it comes back
  //
  // ⚠️ THE RATIOS BETWEEN BANDS ARE THE SIGNAL. The magnitudes come from a synthetic hue-shift
  // standing in for a model patch, so no threshold should ever be tuned against these numbers.
  //
  // Two halves, exactly as maskErodePx claims: the erode is one, and THIS FLOOR is the other. It
  // does not move with the erode — at erode 0 `wanted` is still max(1 + 2, 0) = 3 — so the outer
  // 3px stays a cross-fade however far the erode is reduced.
  //
  // ⚠️ ─── THE FLOOR IS ALREADY AT ITS MINIMUM. THIS WAS INVESTIGATED AND REJECTED. ───────────
  //
  // An earlier note here said to narrow this floor before growing the mask. That was the right
  // ORDER and the wrong conclusion, because it assumed there was room to narrow. There is not.
  //
  // The suite pins the maximum alpha step between neighbouring pixels at 85
  // (`ceil(255 / MASK_RAMP_TO_ERODE)`), and that bound is a PINNED REGRESSION rather than a
  // preference: a jersey sleeve measured 48/px of pixel value against 8/px before it, and that
  // seam is what the ramp was widened to fix. Measured profiles across the boundary:
  //
  //     ramp=3   [0,  85, 170, 255, ...]   max step  85   passes the bound
  //     ramp=2   [0, 128, 255, ...]        max step 128   VIOLATES it
  //     ramp=1   [0, 255, ...]             max step 255   a hard step, which
  //                                                       MASK_ANTIALIAS_PX exists to prevent
  //
  // ⚠️ SO THE 23% / 42% / 59% OUTER BANDS ARE NOT SLACK. Anyone reading those numbers will see
  // headroom; they are the PRICE of not reintroducing the jersey-sleeve seam. The only narrowing
  // available is 3 → 2 and it breaks a bound set by a real artifact. The residual rim is what it
  // is, and dilation — the other option — is worse: 8px on a hair mask tinted the athlete's
  // fingertips and 20px tinted her whole hand.
  //
  // ─── WHY NARROWING CANNOT LEAK, AS A PROPERTY RATHER THAN A READING ────────────────────────
  //
  // Spill measured 0 at ramp 0, 1, 2, 3 and 6, at both erode 0 and erode 1. That is not a lucky
  // measurement, it is the shape of `maskAlpha`: `distanceToOutside` is 0 for every pixel OUTSIDE
  // the mask, and the function returns alpha 0 whenever `d <= erode`. For any erode >= 0 that
  // covers every outside pixel, so the ramp is only ever evaluated INSIDE. No ramp value can put
  // ink outside the contour.
  //
  // ─── AND THE RAMP IS NOT THE ERODE: IT IS NOT SAFETY-RELEVANT ON EITHER ARM ────────────────
  //
  // Checked deliberately, because the erode turned out to mean opposite things on the two
  // polarities and it seemed likely this would too. It does not, and the difference is worth
  // recording so nobody assumes symmetry in either direction:
  //
  //   On preserve-inside the 1px band off her outline reads alpha 0 at EVERY ramp value — that
  //   band is held by the ERODE. Narrowing the ramp edits no more of her.
  //
  // What differs is quality, and the two arms want opposite widths:
  //
  //   edit-inside      NARROW. The boundary is garment against ground, two real opaque edges; a
  //                    wide ramp smears the garment into what is behind it.
  //   preserve-inside  WIDE. The boundary is HER, and her outline includes hair, which is
  //                    genuinely semi-transparent across several pixels. A step there reads as a
  //                    cutout — measured: at ramp 1 the new background is already at 154/255 two
  //                    pixels off her outline, against 51 at ramp 3.
  //
  // ─── AND AN OFFSET RAMP CANNOT HELP EITHER. THE CEILING IS ARITHMETIC. ─────────────────────
  //
  // The obvious remaining idea is to start the ramp at a floor alpha rather than at zero — 64→255
  // over 3px — so the boundary pixel carries 25% of the edit instead of almost none. It does not
  // work, and the reason generalises past that one proposal.
  //
  // ⚠️ THE STEP THAT MATTERS IS AT THE BOUNDARY, NOT ACROSS THE RAMP, AND THAT IS WHAT MAKES THE
  // ARITHMETIC NON-OBVIOUS. Sizing a floor by the gradient it produces (64→255 over 3px = 64/px,
  // comfortably under 85) misses the step from 0 OUTSIDE to the floor at the first inside pixel.
  // That one is the largest, and it is precisely what the bound is about. A floor does not lower
  // the maximum step; it manufactures a bigger one exactly at the edge — the hard line the ramp
  // exists to prevent. Measured: floor 64 → [0, 128, 191, 255], max step 128.
  //
  // The first inside pixel is `floor + (255 - floor) / ramp`, so `<= 85` solves to:
  //
  //     ramp=3   largest admissible floor    0.0   → only floor 0. Today's design is UNIQUE.
  //     ramp=4   largest admissible floor   28.3
  //     ramp=6   largest admissible floor   51.0
  //
  // And every admissible configuration lands that first pixel at exactly 85 — so NO configuration
  // can put more than 85/255 (33%) of the edit on the boundary pixel while satisfying the bound.
  // The outer band is capped by arithmetic rather than by anyone's choice. That is the ceiling on
  // how much of this rim is removable at all, and it is why the search stopped here.
  //
  // Spill did stay 0 at floor 0, 64 and 128, exactly as the property above predicts — the remap
  // preserves alpha 0 wherever `d <= erode`. Worth stating because the natural worry on the
  // inversion arm is that a floor starts generating background at 25% right at her outline: it
  // does not. The erode band is still 0, so her outline is held whatever the floor. The proposal
  // dies on the edit-inside step bound, not on safety.
  //
  // ⚠️ AND ANY SUCH PARAMETER MUST BE RELATIVE TO THE MASK'S OWN PERIMETER, NEVER A PIXEL CONSTANT.
  // Perimeter complexity decides what a radius costs: hair has far more boundary per unit area than
  // fabric, so the same growth buys proportionally more contact with whatever is across it. That is
  // why one global radius was clean on a tank strap and leaking on hair at the same time.
  const wanted = Math.max(
    uncertainty + MASK_ANTIALIAS_PX,
    erode * MASK_RAMP_TO_ERODE,
  );
  const ramp = Math.max(0, Math.min(wanted, ceiling - erode));
  return { erode, ramp };
}

/**
 * The ramp itself: one alpha byte per pixel of the region rectangle, 0 at the edge → 255 at `radius`
 * pixels in and everywhere deeper.
 *
 * Distance is to the NEAREST edge, measured from the pixel's CENTRE (`+ 0.5`), so the outermost row
 * and column come out at `0.5 / radius` rather than at a true zero. That half-pixel is the
 * difference between a ramp that starts at the original and one that starts a pixel inside it —
 * which is exactly the hard line this exists to remove.
 */
function featherAlpha(width: number, height: number, radius: number): Buffer {
  const alpha = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const dy = Math.min(y + 0.5, height - 0.5 - y);
    for (let x = 0; x < width; x++) {
      const d = Math.min(x + 0.5, width - 0.5 - x, dy);
      alpha[y * width + x] = d >= radius ? 255 : Math.round((d / radius) * 255);
    }
  }
  return alpha;
}

// ─── The garment mask: SAM's shape, made safe to paste with ────────────────────────────────────
//
// ⚠️ READ THIS BEFORE CHANGING ANYTHING BELOW ───────────────────────────────────────────────────
//
// THE MASK ONLY EVER SUBTRACTS. The pasted area is `region_rect ∩ mask`, never the mask alone. That
// one sentence is the entire safety argument for this feature and it is worth being explicit about
// what it buys:
//
//   · The athlete approved a RECTANGLE — she drew it, or she was shown a loose-area warning about
//     it (studio/geometry.ts looseNoteFor). A mask that could paste outside it would edit pixels no
//     warning ever described and no approval ever covered.
//   · pasteBack's existing guarantee — "outside the regions is the original's" — is UNCHANGED, not
//     traded. It gets strictly stronger: outside the garment SHAPE is now also the original's.
//   · The fallback needs no separate code path, because a uniform 255 mask IS the rectangle. When
//     no mask is available the alpha is exactly `featherAlpha` and the composite is byte-for-byte
//     what it was before this feature existed. Failing to a rectangle is not a degraded mode, it is
//     the identity case of the same arithmetic.
//
// Do not "improve" this by letting a confident mask paste past its rectangle. The rectangle is the
// consent boundary; the mask is only allowed to be more conservative than it.

/**
 * Chebyshev distance, per pixel, to the nearest pixel OUTSIDE the mask. Exact, two passes.
 *
 * ─── WHY A DISTANCE TRANSFORM RATHER THAN AN ERODE FOLLOWED BY A BLUR ──────────────────────────
 *
 * The obvious implementation is two steps — shrink the mask by N pixels, then soften the result —
 * and it needs two different kernels and gets the interaction between them wrong at corners. One
 * distance field gives both for free and gives them the same geometry `featherAlpha` already uses
 * (distance to the nearest edge), so the mask ramp and the rectangle ramp are measured the same way
 * and can be compared with a plain `min`.
 *
 * ⚠️ THE BUFFER'S OWN BORDER IS NOT "OUTSIDE", AND THAT IS LOAD-BEARING. A garment that runs to the
 * edge of its region rectangle — the ordinary case, since the rectangle is drawn tight around it —
 * must NOT be eroded away from that edge here. The rectangle's own edge is already handled by
 * `featherAlpha`, and the two are combined once by `min`. Seeding the border as outside would inset
 * the same edge twice: a visible double-soft band exactly where a cropped garment meets its box.
 */
export function distanceToOutside(
  mask: Buffer,
  width: number,
  height: number,
): Int32Array {
  const BIG = width + height + 1;
  const d = new Int32Array(width * height);

  // Forward: top-left neighbourhood. Out-of-buffer neighbours are simply not read, which is what
  // makes the border "inside" rather than "outside" — see the warning above.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] < 128) {
        d[i] = 0;
        continue;
      }
      let best = BIG;
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[i - width - 1]);
        best = Math.min(best, d[i - width]);
        if (x + 1 < width) best = Math.min(best, d[i - width + 1]);
      }
      if (x > 0) best = Math.min(best, d[i - 1]);
      d[i] = best === BIG ? BIG : best + 1;
    }
  }
  // Backward: bottom-right neighbourhood.
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y + 1 < height) {
        if (x > 0) best = Math.min(best, d[i + width - 1] + 1);
        best = Math.min(best, d[i + width] + 1);
        if (x + 1 < width) best = Math.min(best, d[i + width + 1] + 1);
      }
      if (x + 1 < width) best = Math.min(best, d[i + 1] + 1);
      d[i] = best;
    }
  }
  return d;
}

/**
 * A binary mask → the alpha it should composite with: eroded by `erode`, then ramped over `ramp`.
 *
 * Alpha is 0 out to `erode` pixels inside the mask's own boundary — that is the fringe the probes
 * showed at the garment edge, discarded — and reaches 255 at `erode + ramp`. Between them it is
 * linear, so the blend happens ENTIRELY INSIDE the garment and no background pixel ever receives a
 * fraction of the edit. An erode can only shrink, so this can never turn a safe mask into a leaking
 * one; that direction is closed by construction rather than by a check.
 */
export function maskAlpha(
  mask: Buffer,
  width: number,
  height: number,
  erode: number,
  ramp: number,
): Buffer {
  const d = distanceToOutside(mask, width, height);
  const out = Buffer.alloc(width * height);
  const full = erode + Math.max(ramp, 0);
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (v <= erode) {
      out[i] = 0;
      continue;
    }
    if (v >= full) {
      out[i] = 255;
      continue;
    }
    // `- erode` so the ramp starts at the eroded boundary rather than at the original one.
    out[i] = Math.round(((v - erode) / (full - erode)) * 255);
  }
  return out;
}

// ─── INVERSION: THE SAME MASK PATH, ONE BIT FLIPPED ────────────────────────────────────────────
//
// A garment edit segments the garment and edits INSIDE it. A background edit segments the PERSON
// and edits everything else in the rectangle. That is the whole difference, and it is deliberately
// expressed as one flip of the alpha rather than as a second composite path: every guarantee below
// — only-subtracts, the leak guard, min() with the rectangle ramp, maskEdgeFor's boundary sizing —
// is the same code doing the same thing to a mask that means the opposite.
//
// ⚠️ THE ONLY-SUBTRACTS INVARIANT SURVIVES THIS, AND IT IS WORTH BEING PRECISE ABOUT WHY. The
// invariant is not "the mask is small". It is:
//
//     pasted area  ⊆  region_rect
//
// Garment: pasted = rect ∩ mask. Background: pasted = rect ∩ ¬mask. BOTH are subsets of the
// rectangle she approved, because the inversion happens on a buffer that has ALREADY been cropped
// to that rectangle — there is no representation in which an inverted pixel outside it exists. The
// mask still only ever removes area from the rectangle; inversion changes WHICH area, never how
// much of the frame is eligible.
//
// What DOES change is the direction the erode points. On a garment the erode eats into the garment,
// leaving a rim of the original garment. Inverted, it eats into the BACKGROUND, leaving a rim of
// the original background hugging her outline — the conservative direction, since the thing being
// protected is the athlete and the pixels nearest her stay hers.

/** Which side of the mask the edit applies to. `edit-inside` is the garment path and the default. */
export type MaskPolarity = "edit-inside" | "preserve-inside";

/**
 * A mask → the same mask meaning the opposite thing.
 *
 * `255 - v` rather than a binary flip, so an antialiased boundary stays antialiased. A binary
 * invert would harden the edge to a step at exactly the moment maskEdgeFor is trying to measure how
 * soft it should be, and `distanceToOutside`'s 128 threshold reads the flipped ramp symmetrically.
 */
export function invertMask(mask: Buffer): Buffer {
  const out = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
  return out;
}

/** Where a mask actually sits, and how much of its crop it claims. Pure — the leak guard's inputs. */
export interface MaskGeometry {
  /** Tight box around the mask, in the buffer's own space. Null when the mask is empty. */
  bbox: CropRect | null;
  /** Share of the whole crop the mask covers. LEAK GUARD ②. */
  fillOfCrop: number;
  /**
   * How far the mask runs past its region rectangle, as a fraction of that rectangle's own extent,
   * taken as the WORST of the four sides. Zero when the mask sits inside its box. LEAK GUARD ①.
   */
  overreach: number;
}

/**
 * Measure a mask against the rectangle it is supposed to be refining.
 *
 * `within` is the region's offset INSIDE the crop (regionWithinCrop), because that is the space the
 * mask arrives in — the crop is what was segmented, not the frame and not the bare region.
 */
export function maskGeometryFor(
  mask: Buffer,
  crop: { width: number; height: number },
  within: CropRect,
): MaskGeometry {
  let minX = crop.width,
    minY = crop.height,
    maxX = -1,
    maxY = -1,
    on = 0;
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      if (mask[y * crop.width + x] < 128) continue;
      on++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const area = crop.width * crop.height;
  if (maxX < 0) return { bbox: null, fillOfCrop: 0, overreach: 0 };

  const bbox = {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
  const overreach = Math.max(
    0,
    (within.left - bbox.left) / within.width,
    (bbox.left + bbox.width - (within.left + within.width)) / within.width,
    (within.top - bbox.top) / within.height,
    (bbox.top + bbox.height - (within.top + within.height)) / within.height,
  );
  return { bbox, fillOfCrop: on / area, overreach };
}

/**
 * The shape of a mask, as the three numbers that say WHY it was rejected. Pure.
 *
 * `maskLeakReason` says a mask was rejected; it cannot say what was wrong with it, and it conflates
 * three failures that want opposite fixes — see the block at the log site.
 *
 * Derived rather than threaded through `MaskGeometry`, because `fillOfCrop` is already
 * maskPx/cropArea against a crop whose dimensions the caller has: the pixel count comes back
 * exactly, and adding it to the interface would be a second way of saying the same thing that every
 * existing construction site would then have to keep in sync.
 */
export function maskShapeStats(
  geo: MaskGeometry,
  crop: { width: number; height: number },
  region: { width: number; height: number },
): { bbox: string | null; solidity: number | null; maskVsRegion: number } {
  const maskPx = geo.fillOfCrop * crop.width * crop.height;
  const regionArea = region.width * region.height;
  return {
    bbox: geo.bbox
      ? `${geo.bbox.width}x${geo.bbox.height}@${geo.bbox.left},${geo.bbox.top}`
      : null,
    /** Mask pixels over the area of their own bounding box. Low means scattered. */
    solidity: geo.bbox
      ? Number((maskPx / (geo.bbox.width * geo.bbox.height)).toFixed(3))
      : null,
    /** Mask pixels over the REGION's area. Above 1 the mask is bigger than what it refines. */
    maskVsRegion: regionArea > 0 ? Number((maskPx / regionArea).toFixed(2)) : 0,
  };
}

/**
 * Should this mask be thrown away for its rectangle? The reason, or null to use the mask.
 *
 * ⚠️ SAM'S OWN CONFIDENCE SCORE IS DELIBERATELY NOT AN INPUT HERE, AND MUST NOT BECOME ONE. It was
 * measured decoupled from correctness on exactly this task: a 0.716 mask was near-perfect and a
 * 0.800 mask leaked. Gating on it would reject good masks and admit the bad one. The two signals
 * below are geometric, which is the thing that actually differs between a garment and a garment
 * that has annexed the wall behind it.
 *
 * ① OVERREACH is generous on purpose (studio/config.ts maskMaxOverreach). The crop carries context
 *   padding, so a CORRECT mask routinely continues past a tight detection box — a jersey whose box
 *   stops at the waist is the ordinary case, not the failure.
 *
 * ② CROP FILL catches what overreach structurally cannot: the mask that has stopped describing a
 *   garment at all. A garment that legitimately continues still leaves most of its crop unmasked.
 */
export function maskLeakReason(
  g: MaskGeometry,
  limits: { maxOverreach: number; maxCropFill: number },
): string | null {
  if (!g.bbox) return "empty";
  if (g.overreach > limits.maxOverreach) return "overreach";
  if (g.fillOfCrop > limits.maxCropFill) return "crop_fill";
  return null;
}

/**
 * How much bigger the union may be than the regions inside it, before a merge stops being worth it.
 *
 * ⚠️ THIS IS THE GUARD THAT MATTERS, AND AN AREA CAP ALONE IS NOT ENOUGH. Two 200x200 boxes 2500px
 * apart on a 4000x6000 frame union to 3.7 MEGAPIXELS — comfortably under any sane share of the
 * frame, and still a re-render of 3.7MP to change 0.08MP of it. The absolute cap below waves that
 * through; this one does not, because the thing that makes a merge good is that the union is mostly
 * the regions rather than mostly the gap between them.
 *
 * At 4: two socks side by side union to ~1.3x their own area and merge. Two shoes across the frame
 * union to ~47x and do not. Measured against the fixtures in composite.test.ts, which carry both.
 */
const MERGE_MAX_WASTE = 4;

/**
 * The absolute backstop: how large the union may get as a share of the frame, however tight it is.
 *
 * Set at studio/geometry.ts's LOOSE_REGION_AREA (0.25) deliberately, and it is the same claim: past
 * a quarter of the frame a box has stopped being a mask and started being a re-render. A merge that
 * produced a box geometry.ts would warn about would be this module manufacturing the exact thing the
 * warning exists to discourage — so the merger refuses at the line the warning draws. It catches the
 * case the ratio cannot: many large adjacent regions, each merge individually efficient.
 */
const MERGE_MAX_AREA = 0.25;

/** Same cap studio/orient.ts refuses at: the raw pixel buffer, not the file, is what must fit. */
const MAX_FRAME_BYTES = Number(
  process.env.STUDIO_MAX_ORIENT_BYTES ?? 40 * 1024 * 1024,
);

/** Mirrors mediaStore's MEDIA_MAX_BYTES. Read, never written — this module does not move the cap. */
const STORE_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);

/** Decode + composite + encode of a 24MP frame is CPU-bound and bounded. Same posture as orient.ts. */
const COMPOSITE_TIMEOUT_MS = 45_000;

// ─── The pure arithmetic ────────────────────────────────────────────────────────────────────────

export interface Frame {
  width: number;
  height: number;
}

/** A rectangle in the SOURCE frame's own pixel space. The only space this module works in. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlannedCrop {
  /**
   * What actually changes inside this crop. Frame-space pixels, straight off the brief.
   *
   * ⚠️ A LIST, AND IT USED TO BE ONE. Regions that name the SAME TARGET — two socks, both getting
   * "adidas socks" — are merged into one crop and one call when their union stays tight (see
   * planCrops). Everything downstream is per-RECTANGLE regardless: `pasteBack` composites each entry
   * separately and feathers each one on its own edge, so the guarantee that pixels outside the
   * regions are the original's is unchanged by the merge. What the merge changes is the number of
   * times we pay and wait, which is the bound that matters (studio/config.ts maxEditCalls).
   *
   * Never empty.
   */
  regions: EditRegion[];
  /** What the model sees, frame-space. Always contains `region`. */
  crop: CropRect;
  /**
   * The dimensions the crop is sent at. Equal to `crop`'s unless the crop is over MAX_PATCH_PIXELS,
   * in which case it is the largest same-aspect size that fits.
   */
  send: { width: number; height: number };
  /** True when `send` is smaller than `crop` — detail is lost INSIDE this region, and only inside it. */
  downscaled: boolean;
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * One region → the crop that will be sent for it.
 *
 * ─── NEVER ONE UNION BOX OVER EVERYTHING ────────────────────────────────────────────────────────
 *
 * A single crop around ALL the regions is the obvious implementation and it refuses the exact case
 * this feature was designed for. Two 300x300 logos in opposite corners of a 4000x6000 frame produce
 * a union box of 18.6 megapixels — which is to say the whole photograph, which is the re-render we
 * are leaving.
 *
 * A BOUNDED union is a different thing, and `planCrops` does take it: regions naming the same TARGET
 * merge into one crop while their union stays under MERGE_MAX_AREA of the frame, so two socks share
 * a call and two shoes across the frame do not. The paste-back guarantee is per-RECTANGLE either
 * way — a merged crop yields several rectangles out of one patch and the pixels between them are
 * discarded with the padding — so nothing about the property changes. The call count is bounded by
 * `maxEditCalls()` in studio/config.ts, which is where the wall-clock argument lives.
 *
 * ─── OVER THE CEILING WE DOWNSCALE, WE DO NOT REFUSE ────────────────────────────────────────────
 *
 * studio/geometry.ts WARNS at 25% of frame area and never blocks. A hard crop ceiling would refuse
 * somewhere around 8%, so there would be a band where she is told the mask is fine and then refused
 * — two individually-correct thresholds meeting badly, which is the worst kind of seam because
 * neither component looks wrong on its own.
 *
 * So an oversized crop is downscaled to fit and the patch is scaled back on the way in. The cost is
 * borne entirely INSIDE the region she asked to change; every pixel outside is still the original's,
 * because the paste-back operates in frame space regardless of what was sent. Degraded and honest,
 * rather than refused.
 */
export function planCrop(regions: EditRegion[], frame: Frame): PlannedCrop {
  const box = unionOf(regions);
  // Half the union's worth of context per side gives a crop CONTEXT_PAD_FACTOR times its size.
  const padX = Math.max(
    MIN_CONTEXT_PAD_PX,
    Math.round((box.width * (CONTEXT_PAD_FACTOR - 1)) / 2),
  );
  const padY = Math.max(
    MIN_CONTEXT_PAD_PX,
    Math.round((box.height * (CONTEXT_PAD_FACTOR - 1)) / 2),
  );

  // Clamp each EDGE to the frame and derive the extent from the two clamped edges. Clamping an
  // origin and a width independently can push the far edge past the frame by a pixel; deriving the
  // width from two clamped edges cannot. Same rule studio/geometry.ts follows when it rounds.
  const left = clamp(box.left - padX, 0, frame.width);
  const top = clamp(box.top - padY, 0, frame.height);
  const right = clamp(box.left + box.width + padX, 0, frame.width);
  const bottom = clamp(box.top + box.height + padY, 0, frame.height);
  const crop: CropRect = {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };

  const pixels = crop.width * crop.height;
  if (pixels <= MAX_PATCH_PIXELS) {
    return {
      regions,
      crop,
      send: { width: crop.width, height: crop.height },
      downscaled: false,
    };
  }
  // Same aspect, largest area that fits. `max(1, …)` because a pathologically thin crop could
  // otherwise round an axis to zero, and a zero-width request is a provider error rather than a
  // degraded edit.
  const scale = Math.sqrt(MAX_PATCH_PIXELS / pixels);
  return {
    regions,
    crop,
    send: {
      width: Math.max(1, Math.round(crop.width * scale)),
      height: Math.max(1, Math.round(crop.height * scale)),
    },
    downscaled: true,
  };
}

/** The smallest frame-space rectangle containing every one of them. */
export function unionOf(regions: EditRegion[]): CropRect {
  const left = Math.min(...regions.map((r) => r.left));
  const top = Math.min(...regions.map((r) => r.top));
  const right = Math.max(...regions.map((r) => r.left + r.width));
  const bottom = Math.max(...regions.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The crops a set of regions will be sent as. Order is preserved so a patch can be matched back to
 * the plan that made it.
 *
 * ─── SAME TARGET, ONE CROP, WHERE THEY ARE ACTUALLY NEAR EACH OTHER ─────────────────────────────
 *
 * Regions sharing a LABEL share a directive — on the auto-mask path the label IS the per-target
 * directive (studio/autoMask.ts), so two socks both read "adidas socks". Sending them as two calls
 * pays twice to say the same sentence about the same target. Merged, they are one crop, one call,
 * one patch, and `pasteBack` still composites the two rectangles separately.
 *
 * ⚠️ MERGING IS CONDITIONAL, AND THE CONDITION IS THE WHOLE SAFETY ARGUMENT. The union of two boxes
 * grows to contain the gap between them, so merging distant regions rebuilds exactly the union crop
 * this module exists to refuse: two shoes at opposite edges of a 4000x6000 frame union to most of
 * the photograph, which is the re-render, not an edit. So a merge is taken only while the union
 * stays under MERGE_MAX_AREA of the frame, and regions that fail it keep their own crops and their
 * own calls. Two socks 300px apart merge; two shoes across the frame do not.
 *
 * Greedy and order-preserving rather than optimal. An optimal packing would occasionally save one
 * call and would make which regions share a crop depend on a search — and the preview and the
 * generate leg must plan the SAME crops from the same brief or the quote and the spend are for
 * different jobs (studio/preview.ts editCropsFor). Deterministic beats optimal here.
 */
export function planCrops(regions: EditRegion[], frame: Frame): PlannedCrop[] {
  const frameArea = frame.width * frame.height;
  const budget = frameArea * MERGE_MAX_AREA;

  // Group by label, preserving first-appearance order so the output is stable and reviewable.
  const groups: EditRegion[][] = [];
  const byLabel = new Map<string, EditRegion[]>();
  for (const r of regions) {
    const existing = byLabel.get(r.label);
    if (existing) {
      existing.push(r);
      continue;
    }
    const fresh = [r];
    byLabel.set(r.label, fresh);
    groups.push(fresh);
  }

  const plans: PlannedCrop[] = [];
  for (const group of groups) {
    // Greedy run: keep absorbing while the union stays inside the budget, else start a new crop.
    let run: EditRegion[] = [];
    for (const region of group) {
      const candidate = [...run, region];
      const union = unionOf(candidate);
      const unionArea = union.width * union.height;
      // The gap has to earn its place: a union that is mostly space between the regions is a
      // re-render of that space, paid for and risked to change the rectangles at its corners.
      const covered = candidate.reduce((n, r) => n + r.width * r.height, 0);
      const wasteful = unionArea > covered * MERGE_MAX_WASTE;
      if (run.length && (wasteful || unionArea > budget)) {
        plans.push(planCrop(run, frame));
        run = [region];
        continue;
      }
      run = candidate;
    }
    if (run.length) plans.push(planCrop(run, frame));
  }
  return plans;
}

/**
 * Where the region sits INSIDE its own crop. The offset the patch is sliced at.
 *
 * Pure, and separate from the compositing, because an off-by-one here moves the edit and is the kind
 * of thing that must be readable as arithmetic rather than inferred from an output image.
 */
export function regionWithinCrop(
  plan: PlannedCrop,
  region: EditRegion = plan.regions[0],
): CropRect {
  return {
    left: region.left - plan.crop.left,
    top: region.top - plan.crop.top,
    width: region.width,
    height: region.height,
  };
}

/** Every region's offset inside its own crop, in the plan's own order. */
export function regionsWithinCrop(plan: PlannedCrop): CropRect[] {
  return plan.regions.map((r) => regionWithinCrop(plan, r));
}

// ─── The sharp IO — thin wrappers, no decisions ─────────────────────────────────────────────────

/** The crop's bytes, at the dimensions `plan.send` says to send. PNG so nothing is lost on the way out. */
export async function cropFrame(
  frameBytes: Buffer,
  plan: PlannedCrop,
): Promise<Buffer> {
  if (frameBytes.length > MAX_FRAME_BYTES) {
    throw new Error(
      `source frame is ${frameBytes.length} bytes, over the ${MAX_FRAME_BYTES} composite cap`,
    );
  }
  let pipeline = sharp(frameBytes, { failOn: "none" }).extract(plan.crop);
  if (plan.downscaled)
    pipeline = pipeline.resize(plan.send.width, plan.send.height, {
      fit: "fill",
    });
  // PNG, not JPEG: this buffer is an INPUT to a paid model call, and starting it with a generation
  // of JPEG loss would be paying to edit a slightly worse photograph than she owns.
  return withTimeout(
    pipeline.png().toBuffer(),
    COMPOSITE_TIMEOUT_MS,
    "source frame crop",
  );
}

/**
 * WHY THERE IS NO MASK HERE — three different facts that used to log as one word.
 *
 * `verdict` defaulted to `"off"`, so every region that composited on its rectangle reported as
 * though the FEATURE were disabled. "the flag is off", "nothing named a noun to segment" and "we
 * asked and the segmenter returned nothing over this rectangle" are three different problems with
 * three different fixes, and they were indistinguishable in the log.
 *
 * ⚠️ THAT IS NOT A COSMETIC COMPLAINT. It cost four runs on the background path: three of them were
 * spent chasing a flag that was correct the whole time, because `mask: ["refused_off"]` says the
 * feature is off and the feature was on. The word was wrong, and it was wrong in the direction that
 * sends you to the environment instead of to the detection response.
 *
 *   off        the flag for THIS polarity is off. Nothing was asked.
 *   no_noun    nothing to ask FOR — no `samNoun`, no `subjectNoun`, or regions that disagree
 *              (`nounFor` returns null). This is the vocabulary miss, and on the preserve arm it is
 *              the one that means detection did not return a background-scoped entry.
 *   not_found  we asked, and the segmenter gave nothing over this rectangle. See segment.ts, which
 *              distinguishes "found nothing" (info) from "the call failed" (warn) at the point
 *              where it still knows which.
 *
 * ⚠️ IT IS REPORTED, NOT RE-DERIVED, AND THAT IS THE WHOLE POINT. An earlier version inferred the
 * reason here from the flag plus a threaded "did we ask" boolean. That separated three cases and
 * silently mislabelled the fourth: a segmentation call that THREW composited identically to one
 * that was never made, so `extract_area: bad extract area` — a crash, in 1ms, before any network
 * call — logged as `refused_off` and read as a disabled feature. Four runs went into the
 * environment before anyone read the exception.
 *
 * So `masksForCrop` says which of the four happened at the point where it still knows, and this
 * reads its answer. Inference at a distance is what produced the wrong word.
 *
 * The flag reading survives only as the fallback for a caller that reports nothing, which keeps
 * older callers on the behaviour they had.
 */
function noMaskReason(
  miss: MaskMiss | null | undefined,
  polarity: MaskPolarity,
): string {
  if (miss) return miss;
  const flagOn =
    polarity === "preserve-inside"
      ? backgroundMaskEnabled()
      : garmentMaskEnabled();
  return flagOn ? "not_found" : "off";
}

/**
 * THE SHARE OF THE FRAME A REGION MAY COVER AND STILL BE COMPOSITED AS AN ORDINARY EDIT.
 *
 * ─── WHY THIS EXISTS: SIX JOBS THAT REPORTED SUCCESS AND REPLACED THE ATHLETE ──────────────────
 *
 * A background edit is an INVERSION — `subjectNoun` makes the region `preserve-inside`, and the
 * refusal below fires when its mask is missing. But `polarityFor` reads the noun, and detection
 * drops the noun at a real rate. A whole-frame region with NO noun is `edit-inside` by default, so
 * it trips nothing: it looks like an ordinary rectangle edit that happens to cover the picture, and
 * a rectangle edit composites the patch over everything.
 *
 * Measured on 83 real regions from one athlete: SIX were whole-frame, edit-inside, and nounless.
 * Every one reported `succeeded`. Every one re-rendered her. One of them said, in her own words,
 * "dont change any other elements of the photo".
 *
 *     666b4386  100.0%  "change the background in this picture to a soccer stadium"
 *     a2cd9f61  100.0%  "replace the background to be a soccer stadium."
 *     001bc917  100.0%  "Place this exact person on an outdoor running track, keep her face…"
 *     be5588d9  100.0%  "Turn this photo into a premium adidas advertisement. Keep this exact person…"
 *     581cc06d  100.0%  "replace the background of this image… dont change any other elements"
 *     b20a7554   90.8%  "change the background of this to a sold out stadium…"
 *
 * ─── THE PRINCIPLE, WHICH GENERALISES PAST THIS GUARD ──────────────────────────────────────────
 *
 * ⚠️ A DESTRUCTIVE OUTCOME MUST BE EXPLICITLY REQUESTED, NEVER REACHED BY A FIELD BEING ABSENT.
 * This is the same rule that makes GENERATE unreachable rather than merely discouraged
 * (studio/classify.ts, `allowedOps`): the unsafe answer is not something to be discouraged, it is
 * something that must not be representable. Here the unsafe answer was reached by `subjectNoun`
 * being MISSING — an omission, upstream, in a field nothing downstream could check. So the check is
 * moved to something that cannot go missing: the geometry.
 *
 * ─── THE NUMBER, AND WHY IT IS NOT A GUESS ─────────────────────────────────────────────────────
 *
 * Measured across those 83 regions:
 *
 *     largest LEGITIMATE object region     19.3%  of frame area  (a jersey; then a sports bra and
 *                                                 a jacket at ~18%)
 *     smallest DANGEROUS region            90.8%  of frame area
 *
 * A 4.7x gap with nothing in between, so any threshold from ~25% to ~85% separates them. 50% sits
 * 2.6x above the legitimate maximum and 1.8x below the dangerous minimum.
 *
 * ⚠️ AREA, NEVER WIDTH OR HEIGHT. That same legitimate jersey is 50.2% of the frame's WIDTH, so a
 * width-based rule at any plausible value clips a real garment edit while still admitting the
 * catastrophic case. It is exactly the sort of constant that looks reasonable and is wrong.
 *
 * ⚠️ AND NOT `=== 1.0`. `b20a7554` covered 90.8%, so an exact-whole-frame test misses it.
 */
export const MAX_EDIT_INSIDE_FRAME_SHARE = 0.5;

/**
 * Does this region cover so much of the frame that editing INSIDE it is a re-render?
 *
 * Pure, and deliberately knows nothing about nouns, polarity or masks — that is the entire point.
 * Every other guard on this path asks a question about a field that detection may not have filled
 * in. This one asks a question about pixels, which are always there.
 */
export function coversMostOfFrame(
  region: { width: number; height: number },
  frame: { width: number; height: number },
): boolean {
  const frameArea = frame.width * frame.height;
  if (frameArea <= 0) return false;
  return (
    (region.width * region.height) / frameArea >= MAX_EDIT_INSIDE_FRAME_SHARE
  );
}

export interface CompositeInput {
  plan: PlannedCrop;
  /**
   * WHY each region has no mask, indexed alongside `masks`. Diagnostic only — nothing branches on
   * it. See `MaskMiss` in segment.ts, and `noMaskReason` below for why it is reported rather than
   * inferred here. Optional: omitting it degrades the verdict to the flag reading.
   */
  maskMisses?: (MaskMiss | null)[];
  /** What the model returned for this crop. Any size — it is resized back to the crop's own. */
  patchBytes: Buffer;
  /**
   * ONE MASK PER REGION, in the plan's own order. Optional, and a null entry is the ordinary case
   * rather than a gap — see the header block above `distanceToOutside`.
   *
   * ⚠️ PER REGION, NOT PER CROP, AND THAT IS THE FIX FOR THE PAIRED-GARMENT BUG. It was one mask
   * for the whole crop, which is fine until `planCrops` merges two socks into one crop: the
   * segmenter answers with ONE instance, and that single mask then gets scored against BOTH
   * rectangles. On a real frame it read overreach 0.000 against its own sock and 1.215 against the
   * other one, so the second was discarded for "overreach", fell back to its RECTANGLE, and the
   * rectangle re-rendered her leg. The mask was correct; the pairing was not.
   *
   * Indexing by region makes the pairing structural: a mask is the mask OF the region at its index,
   * and there is no arrangement of this array in which it belongs to a different one.
   *
   * ANY SIZE, and each takes the SAME resize the patch does, for the same reason: the segmenter is
   * sent a downscaled crop (studio/config.ts segmentLongEdgePx) exactly as the model may be, and
   * both come back to crop space through one `fit: "fill"` so they cannot drift apart. A mask that
   * was resized differently from its patch would be a mask of a slightly different photograph.
   */
  masks?: (Buffer | null)[];
  /**
   * Which side of `maskBytes` the edit applies to. Defaults to `edit-inside`, so every existing
   * caller is unchanged and the garment path is byte-for-byte what it was.
   *
   * ⚠️ THIS ALSO SELECTS THE FALLBACK, AND THAT IS THE POINT RATHER THAN A SIDE EFFECT — see the
   * rule above the mask decision in `pasteBack`.
   */
  maskPolarity?: MaskPolarity;
}

export interface PasteBackOptions {
  /**
   * Blend the patch into the original over a ramp at each region's edge instead of pasting hard.
   *
   * DEFAULTS TO TRUE, and nothing in the product passes false today. The hard path is kept — not
   * deleted — because "outside the regions is the original AND inside them is the patch, both
   * exactly" is a real property somebody may want back for a provenance or unretouched mode. It
   * simply is not the right default while the thing being judged is whether an edit looks like an
   * edit. See ⑤ in the header.
   */
  feather?: boolean;
}

export interface CompositeResult {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** Which JPEG rung was used, for the log. Null for a lossless output. */
  jpegQuality: number | null;
  /**
   * Per region, in the plan's own order: "off" (no mask offered), "used", the leak reason a mask was
   * discarded for ("empty" | "overreach" | "crop_fill"), or `refused_<reason>` when an inversion
   * region was SKIPPED rather than composited — see the mask-type-dependent fallback rule below.
   *
   * ⚠️ A `refused_*` ENTRY IS A TARGET THAT DID NOT CHANGE, and studio/generate.ts reads this array
   * to tell her which one. There is exactly one entry per region including the skipped ones, and
   * that alignment is what lets a verdict name a target — do not start omitting entries.
   *
   * Returned rather than only logged because a mask that is silently discarded and a mask that was
   * applied produce THE SAME OUTPUT on the easy cases — a garment that fills its rectangle composites
   * identically either way. That makes "the mask path ran" untestable from the pixels alone, and a
   * test that cannot tell the two apart passes whether or not the feature works. This field is what
   * lets garmentMask.test.ts assert which path it actually exercised.
   */
  maskVerdicts: string[];
  /**
   * The SHAPE of every mask that was actually used, in region order.
   *
   * These fields existed only on the discard path, so a composite that succeeded recorded nothing
   * but the word "used" — and every later question about mask quality had to re-derive them out of
   * band against a saved mask. Surfaced here rather than only logged because a returned value is
   * assertable in a test; it rides the per-composite log line as well.
   *
   * Shorter than `maskVerdicts`: only used masks appear.
   */
  maskStats: ReturnType<typeof maskShapeStats>[];
}

/**
 * The paste-back. The original's pixels everywhere except inside the regions.
 *
 * The patch is resized to the crop's own SOURCE dimensions first, so the extract and the composite
 * both happen in frame space. That is what makes a downscaled send harmless to the guarantee: the
 * scaling is undone before anything is pasted, and the paste is always a frame-space rectangle at a
 * frame-space offset.
 *
 * ─── removeAlpha() IS LOAD-BEARING, NOT TIDINESS ────────────────────────────────────────────────
 *
 * `sharp.composite()` PROMOTES THE PIPELINE TO RGBA. Without the removeAlpha below, every edited
 * asset silently gains an alpha channel its source never had — changing the file size, and changing
 * what studio/imageSize.ts, the media pipeline and every downstream consumer see.
 *
 * This is not theoretical. The first run of the paste-back proof reported 23,313,432 of 23,313,600
 * pixels differing at max delta 255 — a near-total FALSE mismatch, caused entirely by comparing a
 * 4-channel output against a 3-channel source at stride 3. Which is why composite.test.ts asserts
 * channel and dimension parity BEFORE it diffs a single pixel: a proof that assumes buffer geometry
 * can report a confident falsehood in either direction.
 */
export async function pasteBack(
  originalBytes: Buffer,
  patches: CompositeInput[],
  opts: PasteBackOptions = {},
): Promise<CompositeResult> {
  const feather = opts.feather ?? true;
  if (originalBytes.length > MAX_FRAME_BYTES) {
    throw new Error(
      `source frame is ${originalBytes.length} bytes, over the ${MAX_FRAME_BYTES} composite cap`,
    );
  }
  const meta = await sharp(originalBytes).metadata();
  const format = meta.format;
  if (!meta.width || !meta.height || !format) {
    throw new Error(
      "could not read the source frame's dimensions for the composite",
    );
  }

  const overlays = [];
  const radii: number[] = [];
  /** Per region: the mask verdict, for the log. "off" | "used" | a leak reason. */
  const maskVerdicts: string[] = [];
  const limits = {
    maxOverreach: maskMaxOverreach(),
    maxCropFill: maskMaxCropFill(),
  };
  const erodeOverride = maskErodePx();
  const probeLongEdge = segmentLongEdgePx();
  /** Per region: the mask's own `erode+ramp`, so a seam complaint can be read against it. */
  const maskEdges: string[] = [];
  /** Per USED mask: its shape. Empty when every region composited on its rectangle. */
  const maskStats: ReturnType<typeof maskShapeStats>[] = [];

  for (const { plan, patchBytes, masks, maskPolarity, maskMisses } of patches) {
    const polarity: MaskPolarity = maskPolarity ?? "edit-inside";
    await assertPatchKeptItsShape(patchBytes, plan);

    // Each region's mask, in CROP space — the same shape and the same resize the patch takes below.
    // Single channel: with `apply_mask: false` the segmenter returns a black-and-white silhouette,
    // so only luminance means anything and the alpha band is dropped rather than guessed at.
    //
    // ⚠️ IF THAT ASSUMPTION IS WRONG, IT FAILS LOUDLY IN THE LOG AND SAFELY IN THE PIXELS. Were the
    // silhouette to arrive encoded in the ALPHA channel of an otherwise-black RGBA image instead,
    // `removeAlpha` would discard the only channel carrying it and leave an all-black buffer — which
    // the leak guard reads as `empty` and falls back on. So the first run with the flag on degrades
    // to today's behaviour rather than pasting something wrong, and the signature is unmistakable:
    // EVERY region logging `mask: "empty"`. If that is what the log says, read the channel layout
    // before touching anything else here.
    const masksInCrop: (Buffer | null)[] = [];
    for (const [i, maskBytes] of plan.regions.map(
      (_, i) => [i, masks?.[i] ?? null] as const,
    )) {
      if (!maskBytes) {
        masksInCrop.push(null);
        continue;
      }
      try {
        masksInCrop.push(
          await sharp(maskBytes, { failOn: "none" })
            .resize(plan.crop.width, plan.crop.height, { fit: "fill" })
            .removeAlpha()
            .greyscale()
            .raw()
            .toBuffer(),
        );
      } catch (err) {
        // An unreadable mask is not a failed edit. It is a region that takes its rectangle, which is
        // the same outcome as never having asked for one — so this is a warn and not a throw.
        logger.warn(
          {
            region: plan.regions[i]?.label,
            error: err instanceof Error ? err.message : String(err),
          },
          "could not read the garment mask — compositing this region on its rectangle",
        );
        masksInCrop.push(null);
      }
    }
    // Resized ONCE per patch, then sliced per region. A merged crop carries several rectangles out
    // of one model call, and each is extracted and feathered on its own — the padded ring, and every
    // pixel BETWEEN two merged regions, is discarded exactly as it always was. That is what keeps
    // "outside the regions is the original's" true after the merge: sharing a crop is not sharing a
    // rectangle, and only rectangles are ever pasted.
    const restored = await sharp(patchBytes, { failOn: "none" })
      .resize(plan.crop.width, plan.crop.height, { fit: "fill" })
      .png()
      .toBuffer();

    for (const [regionIndex, region] of plan.regions.entries()) {
      const maskInCrop = masksInCrop[regionIndex] ?? null;
      const within = regionWithinCrop(plan, region);
      const radius = feather ? featherRadiusFor(region) : 0;
      radii.push(radius);

      // ─── THE MASK DECISION, PER REGION ────────────────────────────────────────────────────
      //
      // Per REGION and not per crop, because merged regions share a crop but not a rectangle
      // (planCrops), and a mask that leaks around one sock must not cost the other one its shape.
      let regionMask: Buffer | null = null;
      let verdict = noMaskReason(maskMisses?.[regionIndex], polarity);
      if (maskInCrop) {
        const geo = maskGeometryFor(maskInCrop, plan.crop, within);
        const leak = maskLeakReason(geo, limits);
        if (leak) {
          verdict = leak;
          logger.info(
            {
              label: region.label,
              reason: leak,
              overreach: Number(geo.overreach.toFixed(3)),
              fillOfCrop: Number(geo.fillOfCrop.toFixed(3)),
              // ─── THE THREE NUMBERS THAT SAY *WHY* A MASK WAS REJECTED ────────────────────
              //
              // overreach and fillOfCrop say a mask was rejected; they cannot say what was wrong
              // with it, and the three failures they conflate want opposite fixes:
              //
              //   solidity LOW              a scattered mask — real fragments, stray blobs
              //                             inflating the bbox. Wants fragment cleanup.
              //   solidity NORMAL,
              //   maskVsRegion > 1          an over-inclusive mask — the sock plus the leg.
              //                             Wants a tighter noun or a better segmenter.
              //   solidity NORMAL,
              //   maskVsRegion < 1,
              //   overreach HIGH            a CLEAN mask of the wrong instance. Two socks merged
              //                             into one crop, one mask returned, scored against both
              //                             rectangles — one scores 0.00 and one scores 1.2.
              //                             Wants the mask matched to the region it overlaps.
              //
              // Without these, all three read identically in the log and the only way to tell them
              // apart is to re-run the frame and dump the mask by hand, which is exactly what this
              // field set exists to make unnecessary. Measured, not theoretical: the third case
              // above is a real run, and it was diagnosed by dumping pixels because the log could
              // not distinguish it from the first.
              ...maskShapeStats(geo, plan.crop, region),
            },
            "garment mask discarded — compositing this region on its rectangle",
          );
        } else {
          // Cropped to the region rectangle FIRST, then turned into alpha. Doing it in this order is
          // what makes "the mask can only subtract" true in code and not merely in the comment: the
          // buffer that reaches the compositor is the size of the rectangle, so there is no
          // representation in which a pixel outside it could be pasted.
          const maskRect = Buffer.alloc(within.width * within.height);
          for (let y = 0; y < within.height; y++) {
            const src = (within.top + y) * plan.crop.width + within.left;
            maskInCrop.copy(
              maskRect,
              y * within.width,
              src,
              src + within.width,
            );
          }
          // ⚠️ THE MASK'S RAMP IS ITS OWN, NOT THE RECTANGLE'S. It used to be `radius` — the
          // rectangle's 3%-of-the-region cross-fade — and that is the seam bug: see the block above
          // `MASK_ANTIALIAS_PX` for the two shapes it took at the two ends of the size range.
          //
          // `feather: false` still zeroes it, and that is deliberate rather than incidental. That
          // option claims "inside the regions is the patch, exactly" (see PasteBackOptions), and a
          // ramp is precisely what makes a boundary pixel neither the patch nor the original. The
          // ERODE still applies either way: shrinking WHICH pixels are pasted keeps every pasted
          // pixel exact, so it costs that claim nothing while still removing the fringe.
          // ⚠️ INVERTED HERE — AFTER the crop to the rectangle, and that ordering is the
          // only-subtracts proof. `maskRect` is already exactly the rectangle's size, so ¬mask is
          // taken within the rectangle and cannot name a pixel outside it. Inverting `maskInCrop`
          // instead and cropping afterwards would compute the same pixels while making the
          // guarantee an argument about two steps rather than a property of one buffer.
          const shaped =
            polarity === "preserve-inside" ? invertMask(maskRect) : maskRect;
          const edge = maskEdgeFor(
            region,
            plan,
            probeLongEdge,
            erodeOverride,
            polarity,
          );
          regionMask = maskAlpha(
            shaped,
            within.width,
            within.height,
            edge.erode,
            feather ? edge.ramp : 0,
          );
          maskEdges.push(`${edge.erode}+${feather ? edge.ramp : 0}`);
          verdict = "used";
          // ─── THE GEOMETRY OF A MASK THAT WAS USED, RECORDED RATHER THAN DISCARDED ─────────
          //
          // These fields were produced ONLY when a mask was thrown away, which makes every question
          // about the masks we actually use unanswerable after the fact. Not hypothetical: a
          // mask-geometry investigation had to re-derive `solidity` and `fillOfCrop` out of band
          // against a saved mask, because a successful composite recorded nothing but "used".
          //
          // ⚠️ COLLECTED, NOT LOGGED HERE, and deliberately so. A per-region `logger.debug` would be
          // invisible in production, where the level is `info` — the data would still be missing at
          // exactly the moment someone asks for it. This rides the per-composite `info` line
          // alongside `maskVerdicts` and `maskEdgePx`, where every other per-region mask fact
          // already lives, AND lands on `CompositeResult`, which is what makes it assertable in a
          // test rather than only greppable in a log.
          maskStats.push(maskShapeStats(geo, plan.crop, region));
        }
      }

      // ─── THE FALLBACK RULE IS MASK-TYPE-DEPENDENT. THIS IS THE ASYMMETRY. ──────────────────
      //
      // Everywhere else in this feature a mask that cannot be used degrades to its rectangle, and
      // that is graceful: the rectangle is a box she drew around a garment, so the edit still lands
      // roughly where she asked and the worst case is a re-rendered arm.
      //
      // For an INVERSION mask it is catastrophic, because the rectangle for a background change is
      // essentially the whole frame. "Fall back to the rectangle" there means re-rendering the
      // entire photograph INCLUDING THE ATHLETE — which is precisely the full-re-render this path
      // exists to replace, shipped silently under the name of a successful edit. A refused edit is
      // a retry; a re-rendered likeness is a degraded photograph of her that nobody is told about.
      //
      // So the region is SKIPPED — no overlay, no paste, those pixels stay the original's, which is
      // the strongest outcome available — and the verdict says `refused_*` so studio/generate.ts can
      // tell her by name which target did not change.
      if (polarity === "preserve-inside" && verdict !== "used") {
        maskVerdicts.push(`refused_${verdict}`);
        logger.warn(
          { label: region.label, reason: verdict },
          "no subject mask for an inversion edit — refusing this region rather than re-rendering her",
        );
        continue;
      }

      // ─── THE STRUCTURAL BACKSTOP: A WHOLE-FRAME EDIT-INSIDE REGION IS A RE-RENDER ───────────
      //
      // The refusal above only fires for a region ALREADY IDENTIFIED as an inversion, and what
      // identifies it is `subjectNoun` — a field detection drops. This one asks nothing of any
      // field: a region covering half the frame or more, composited inside its own rectangle,
      // replaces the photograph whatever it is called. See MAX_EDIT_INSIDE_FRAME_SHARE for the six
      // jobs that reached this state and reported success.
      //
      // ⚠️ IT REFUSES WITH NO MASK ONLY. A region this size WITH a usable mask is a legitimate
      // masked edit — the mask is what confines it, so the geometry is no longer the whole story.
      // The dangerous shape is precisely "this big AND falling back to the rectangle".
      //
      // ⚠️ AND IT REFUSES RATHER THAN REDIRECTING. By the time a composite runs, the patch has
      // already billed, so the honest options are refuse or re-render her. There is no third one,
      // and re-rendering her is the outcome this exists to prevent. She is told before paying by
      // the blocking gap in studio/preview.ts; this is the layer that holds when the preview was
      // frozen before that gap existed, or was never called.
      if (
        polarity === "edit-inside" &&
        !regionMask &&
        coversMostOfFrame(region, { width: meta.width, height: meta.height })
      ) {
        maskVerdicts.push(`refused_whole_frame_${verdict}`);
        logger.warn(
          {
            label: region.label,
            reason: verdict,
            regionW: region.width,
            regionH: region.height,
            frameW: meta.width,
            frameH: meta.height,
            share: Number(
              (
                (region.width * region.height) /
                (meta.width * meta.height)
              ).toFixed(3),
            ),
          },
          "whole-frame region with no mask on the edit-inside arm — refusing rather than re-rendering the frame",
        );
        continue;
      }
      maskVerdicts.push(verdict);

      let pipeline = sharp(restored, { failOn: "none" })
        // Only the region. The padded ring — which the model also re-rendered — is discarded here,
        // and discarding it is the guarantee.
        .extract(within)
        // srgb + removeAlpha so the slice's channel count is predictable regardless of what the
        // provider returned (it has returned both PNG-with-alpha and JPEG on this project).
        .toColourspace("srgb")
        .removeAlpha();
      // ensureAlpha rather than interleaving RGB into RGBA by hand: it makes the channel count 4 by
      // construction, so the write below cannot land on the wrong stride if a future colourspace
      // change moves it. Only then is the alpha band overwritten with the ramp.
      // A mask needs an alpha band even when feathering is off — the mask IS an alpha.
      if (radius > 0 || regionMask) pipeline = pipeline.ensureAlpha();
      const slice = await pipeline.raw().toBuffer({ resolveWithObject: true });

      if (radius > 0 || regionMask) {
        const ch = slice.info.channels;
        // ─── min(), NOT multiply ─────────────────────────────────────────────────────────────
        //
        // Two INDEPENDENT constraints, not two attenuations: "inside the garment" and "inside the
        // rectangle she approved". `min` applies whichever binds and leaves the other alone, which
        // is what the two ramps mean. Multiplying would compound them wherever both are partial —
        // the common case being a garment clipped by its own box, where the mask ramp and the
        // rectangle ramp overlap along the whole shared edge and the product darkens a band that
        // neither constraint asked to darken. `min` also makes the fallback exact: with no mask the
        // result is `featherAlpha` unchanged, and with a mask that fills its rectangle it is the
        // mask unchanged.
        const rect =
          radius > 0 ? featherAlpha(within.width, within.height, radius) : null;
        for (let i = 0; i < within.width * within.height; i++) {
          const a =
            regionMask && rect
              ? Math.min(regionMask[i], rect[i])
              : regionMask
                ? regionMask[i]
                : rect![i];
          slice.data[i * ch + (ch - 1)] = a;
        }
      }

      overlays.push({
        input: slice.data,
        raw: {
          width: within.width,
          height: within.height,
          channels: slice.info.channels as 1 | 2 | 3 | 4,
        },
        left: region.left,
        top: region.top,
      });
    }
  }

  const composited = sharp(originalBytes, { failOn: "none" })
    .composite(overlays)
    .removeAlpha();
  const { bytes, jpegQuality } = await withTimeout(
    encodeToFit(composited, format),
    COMPOSITE_TIMEOUT_MS,
    "edit composite",
  );

  logger.info(
    {
      width: meta.width,
      height: meta.height,
      format,
      calls: patches.length,
      regions: patches.reduce((n, p) => n + p.plan.regions.length, 0),
      downscaled: patches.filter((p) => p.plan.downscaled).length,
      // The ramp per region, so a seam complaint can be read against the width it was blended over.
      featherPx: feather ? radii : "off",
      // The MASK's own edge per region as `erode+ramp`, which is a different number from featherPx
      // and the one that matters at a garment boundary. Logged separately because the two used to be
      // the same value and confusing them is what the seam fix was.
      maskEdgePx: maskEdges,
      // Per region: "off" (no mask offered), "used", or WHY one was thrown away. This is the line
      // that says whether the feature is actually doing anything on real frames, and it is the only
      // place a leak-guard threshold can be tuned from — see studio/config.ts maskMaxOverreach.
      mask: maskVerdicts,
      // The geometry of the masks that were USED. `mask` above says which path each region took;
      // this says what the successful ones actually looked like, which is the half that was missing.
      maskShape: maskStats,
      jpegQuality,
      outBytes: bytes.length,
    },
    feather
      ? "edit composited into the full-res original, feathered at the region edges"
      : "edit HARD-composited into the full-res original",
  );
  return {
    bytes,
    mimeType: `image/${format}`,
    width: meta.width,
    height: meta.height,
    jpegQuality,
    maskVerdicts,
    maskStats,
  };
}

/**
 * Refuse a patch that is not the shape of the crop it was given. See MAX_PATCH_ASPECT_DRIFT.
 *
 * Measured from the patch's OWN bytes, because the adapters report width/height off their inputs
 * rather than off the response — the same reason generate.ts measures its own returns.
 */
async function assertPatchKeptItsShape(
  patchBytes: Buffer,
  plan: PlannedCrop,
): Promise<void> {
  const meta = await sharp(patchBytes, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) {
    // Unmeasurable is not the same as wrong, and the resize below will fail loudly on a buffer sharp
    // genuinely cannot read. Refusing on something we did not look at would be worse.
    logger.warn(
      { region: plan.regions[0]?.label },
      "could not measure the returned patch — shape not verified",
    );
    return;
  }
  const want = plan.crop.width / plan.crop.height;
  const got = meta.width / meta.height;
  const drift = Math.abs(got - want) / want;
  if (drift <= MAX_PATCH_ASPECT_DRIFT) return;

  logger.warn(
    {
      cropW: plan.crop.width,
      cropH: plan.crop.height,
      patchW: meta.width,
      patchH: meta.height,
      drift,
    },
    "returned patch is not the shape of its crop — refusing rather than squashing it into place",
  );
  throw new Error(
    `the edited region came back ${meta.width}x${meta.height} for a ${plan.crop.width}x${plan.crop.height} crop, ` +
      "which would be stretched to fit",
  );
}

/**
 * Encode, preserving the source's format, at the highest fidelity that still fits the store's cap.
 *
 * ─── WHY THE CAP IS READ AND NOT RAISED ─────────────────────────────────────────────────────────
 *
 * `mediaStore.saveBuffer` takes a `maxBytes` override, so raising the ceiling for this path is one
 * argument away — and it is deliberately not taken. The cap is shared infrastructure and every
 * stored object in the product answers to it; a full-res edit weighing 40MB is a real storage and
 * download cost for the athlete, and that trade is not this module's to make unilaterally. Stepping
 * the quality down is a decision contained entirely inside the edit path.
 *
 * PNG and WebP encode LOSSLESSLY, which makes the guarantee exact for those sources — and means
 * there is no rung to step down to. A lossless 24MP PNG measured 59.9 MB against a 25 MB cap, so
 * that case refuses with something a person can read rather than silently becoming a JPEG: changing
 * the format of her photograph to make it fit is a bigger surprise than being told it did not.
 */
async function encodeToFit(
  pipeline: sharp.Sharp,
  format: string,
): Promise<{ bytes: Buffer; jpegQuality: number | null }> {
  if (format === "jpeg" || format === "jpg") {
    let last: Buffer | null = null;
    for (const rung of JPEG_LADDER) {
      const bytes = await pipeline.clone().jpeg(rung).toBuffer();
      if (bytes.length <= STORE_MAX_BYTES)
        return { bytes, jpegQuality: rung.quality };
      last = bytes;
      logger.info(
        { quality: rung.quality, bytes: bytes.length, cap: STORE_MAX_BYTES },
        "edit output over the store cap — stepping down",
      );
    }
    // Every rung was too big. Hand back the smallest one and let storeAsset produce the refusal —
    // this module does not own the store's answer, and inventing a fourth rung here would be
    // guessing at a quality nobody has measured.
    return {
      bytes: last!,
      jpegQuality: JPEG_LADDER[JPEG_LADDER.length - 1].quality,
    };
  }
  if (format === "png")
    return { bytes: await pipeline.png().toBuffer(), jpegQuality: null };
  if (format === "webp")
    return {
      bytes: await pipeline.webp({ lossless: true }).toBuffer(),
      jpegQuality: null,
    };
  // studio/imageSize.ts only measures jpeg/png/webp, so an edit cannot reach here with anything
  // else. Refusing names the real reason rather than producing a silently reformatted asset.
  throw new Error(
    `cannot composite into a ${format} frame — only jpeg, png and webp are supported`,
  );
}
