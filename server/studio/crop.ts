/**
 * studio/crop — the window a CROP cuts, planned from the frozen source's own dimensions (PR 19, S-7; ADI-R19-S).
 *
 * Pure, so the quote and the run plan the same window from the same brief: the quote prices it ($0), the run's adapter
 * (studio/adapters/local.ts) cuts exactly it and refuses anything else. The window math is video/firstFrame.ts's
 * `windowFor` and `parseAspect`, reused.
 *
 *   an aspect   the largest window of that shape inside the UPRIGHT photo, centred — never wider or taller than the
 *               photo (R-10: reformat is crop only; extend is faded)
 *   zoom        the photo's own shape, ZOOM_KEEP of each side, centred (R-11: a tighter reframe is a crop)
 *
 * ⚠️ CENTRED, NOT "ON HER", SAID PLAINLY. A window placed on her needs her position, and the only face finder in the repo
 * is a model call (firstFrame.ts says the same); sharp's saliency pick happens only at the cut, so no quote could plan
 * it. So a crop is centred, and the preview's card says what it will cut.
 */
import type { SourceAsset } from "./brief";
import type { CropValue } from "./imageOps";
import type { CropWindow } from "./types";
import { parseAspect, windowFor } from "./video/firstFrame";

/** How much of each side a "zoom in" keeps. */
export const ZOOM_KEEP = 0.8;

const CENTRE = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

/**
 * The photo's size upright. The brief's source dimensions ALREADY are: `SourceAsset.width` is the DISPLAY width,
 * after EXIF orientation (brief.ts). Read as they are — swapping them for orientations 5–8 here would turn a
 * sideways-stored portrait twice. The adapter checks the same upright size off the bytes before it cuts.
 */
export function uprightSizeOf(source: Pick<SourceAsset, "width" | "height">): {
  width: number;
  height: number;
} | null {
  // An unmeasured source has nothing to plan against; the route refuses one before this is reached.
  return source.width && source.height
    ? { width: source.width, height: source.height }
    : null;
}

/** The window a crop of this photo cuts, or null when the value is not one a crop takes. */
export function plannedCropWindow(
  source: Pick<SourceAsset, "width" | "height">,
  value: string,
): CropWindow | null {
  const up = uprightSizeOf(source);
  if (!up) return null;
  const at = { uprightWidth: up.width, uprightHeight: up.height };
  if ((value as CropValue) === "zoom") {
    const width = Math.round(up.width * ZOOM_KEEP);
    const height = Math.round(up.height * ZOOM_KEEP);
    return {
      left: Math.round((up.width - width) / 2),
      top: Math.round((up.height - height) / 2),
      width,
      height,
      ...at,
    };
  }
  const target = parseAspect(value);
  if (target === null) return null;
  return { ...windowFor(up.width, up.height, target, CENTRE), ...at };
}
