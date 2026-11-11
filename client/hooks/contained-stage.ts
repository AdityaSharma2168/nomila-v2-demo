/**
 * contained-stage — where a photo actually lands inside its container, and the box maths that
 * depends on it. PURE: no react, no react-native, so jest can run it without a renderer.
 *
 * ─── WHY THIS IS SHARED RATHER THAN WRITTEN TWICE ──────────────────────────────────────────────
 *
 * `resizeMode="contain"` letterboxes: a portrait photo in a square stage is drawn as a column with
 * bars either side, and the rect the PHOTO occupies is not the rect the CONTAINER occupies. Regions
 * are stored as fractions of the photo (studio/geometry.ts), so anything drawn over them has to
 * divide by the photo's rect. Divide by the container's instead and every box comes out stretched
 * across and displaced sideways.
 *
 * MaskEditor got this right. The read-only preview in screens/studio/MakeItScreen.tsx reimplemented
 * it as `left: ${r.left * 100}%` of a square stage and got it wrong, so on a 1008x1476 frame every
 * box was drawn 1/0.683 = 1.46x too wide and shifted left by an amount that grew with `left`. The
 * visible result was two sock boxes that had drifted apart with a strip of sock stranded in the gap
 * between them — while the boxes the SERVER held were tight (measured IoU 0.926 against a
 * segmentation mask). The picture was wrong; the edit was fine.
 *
 * So the maths lives in one place. A second correct copy would have been a third opportunity to
 * drift, which is how the first one happened.
 *
 * ⚠️ DISPLAY ONLY, AND THAT IS LOAD-BEARING. Nothing here is trusted for geometry: fractions are
 * what cross the wire, the server multiplies them against the real frame's own bytes, and a wrong
 * ratio here costs a box that looks wrong to her while she is drawing it — a self-correcting error
 * rather than a silent one.
 */

/**
 * The floor. A stage shorter than this is not something a finger can draw a sleeve on.
 *
 * Below the bounds the photo fills the stage exactly, because the stage is given the PHOTO'S OWN
 * aspect ratio and there is then nothing left for `contain` to letterbox. The bounds are the only
 * reason bars can appear at all: a 9:16 story would otherwise run off the bottom of the screen, and
 * a panorama would collapse to a strip too short to draw in.
 */
export const STAGE_MIN_H = 220;
/**
 * The ceiling, as an absolute and as a share of the window — whichever is smaller.
 *
 * Two bounds because they fail in different directions. The fraction is what keeps the photo from
 * eating a short screen; the absolute is what stops a tall desktop window from turning a portrait
 * into a poster the athlete has to scroll past to reach the controls under it.
 */
export const STAGE_MAX_ABS_H = 520;
export const STAGE_MAX_WINDOW_FRACTION = 0.55;
/** Before `Image.getSize` answers there is no ratio to honour, so the stage takes a neutral height. */
export const STAGE_FALLBACK_H = 320;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The stage's height, computed rather than declared. PURE.
 *
 * It was `aspectRatio` on the style plus `maxHeight` in the stylesheet, and leaving the clamp to the
 * layout engine is what let a portrait grow past the bound: `aspect-ratio` and `max-height` are
 * resolved differently by Yoga and by CSS, so the ceiling was not reliably the ceiling. Deriving the
 * number makes it the same on both surfaces and makes it readable.
 *
 * Width is unaffected — it comes from the parent — so setting a height cannot feed back into the
 * measurement this is derived from.
 */
export function stageHeightFor(frameW: number | null, ratio: number | null, windowHeight: number): number {
  if (!ratio || !frameW) return STAGE_FALLBACK_H;
  const ceiling = Math.min(STAGE_MAX_ABS_H, windowHeight * STAGE_MAX_WINDOW_FRACTION);
  return Math.max(STAGE_MIN_H, Math.min(ceiling, frameW / ratio));
}

/**
 * The rect the image actually occupies inside its container, after `contain` letterboxing. PURE.
 *
 * With no ratio yet the container IS the rect — which is the honest answer rather than a guess, and
 * it degrades to the pre-letterbox behaviour instead of inventing an offset.
 */
export function containedRect(frame: { w: number; h: number } | null, ratio: number | null): Rect | null {
  if (!frame) return null;
  if (!ratio) return { x: 0, y: 0, w: frame.w, h: frame.h };
  const boxRatio = frame.w / frame.h;
  return ratio > boxRatio
    ? {
        x: 0,
        y: (frame.h - frame.w / ratio) / 2,
        w: frame.w,
        h: frame.w / ratio,
      } // letterbox top/bottom
    : {
        x: (frame.w - frame.h * ratio) / 2,
        y: 0,
        w: frame.h * ratio,
        h: frame.h,
      }; // pillarbox left/right
}

/**
 * A region's fractions → the pixel rect to draw, inside the photo. PURE.
 *
 * The one line the preview did not have. `drawn.x` comes off first; without it a fraction is being
 * measured against the container, bars and all.
 */
export function regionToPixels(
  region: { left: number; top: number; width: number; height: number },
  drawn: Rect,
): { left: number; top: number; width: number; height: number } {
  return {
    left: drawn.x + region.left * drawn.w,
    top: drawn.y + region.top * drawn.h,
    width: region.width * drawn.w,
    height: region.height * drawn.h,
  };
}
