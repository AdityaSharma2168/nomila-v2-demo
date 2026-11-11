/**
 * studio/compile/aspect — the canvas a request pins: `inputs.aspectRatio`, on every path.
 */
import type { BriefDeliverable, CreativeBrief } from "../brief";
import type { PlannedCrop } from "../composite";

/** Art-direction defaults per deliverable. Only applied when generating — an edit takes the frame's. */
const ASPECT: Partial<Record<BriefDeliverable, string>> = {
  post: "4:5",
  carousel: "4:5",
  story: "9:16",
  reel: "9:16",
  clip: "9:16",
  ad: "1:1",
};

/**
 * The ratios the image model will accept, with their numeric values.
 *
 * Read off `ImageConfig.aspectRatio` in @google/genai 2.7.0: *"Supported values are 1:1, 2:3, 3:2,
 * 3:4, 4:3, 9:16, 16:9, and 21:9."* It is a CLOSED SET — an edit cannot ask for "3024:4032", so the
 * frame's real ratio has to be snapped to the nearest thing the model takes.
 *
 * (Note that 4:5 — which ASPECT above emits for a post — is not on this list. That predates this
 * work, `vertex.ts` records it as accepted in practice, and the generate path is unchanged here.
 * Flagged rather than touched.)
 */
const SUPPORTED_ASPECTS: readonly (readonly [string, number])[] = [
  ["1:1", 1],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["3:4", 3 / 4],
  ["4:3", 4 / 3],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["21:9", 21 / 9],
];

/**
 * The supported ratio closest to a real frame.
 *
 * Compared in LOG space, because ratio error is multiplicative: 3:2 and 2:3 are the same distance
 * from square, and a linear comparison would treat the wide side as further away and quietly bias
 * every portrait frame toward a squarer canvas.
 */
export function nearestAspect(
  width: number,
  height: number,
): string | undefined {
  if (!width || !height) return undefined;
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  let best = SUPPORTED_ASPECTS[0];
  let bestErr = Infinity;
  for (const candidate of SUPPORTED_ASPECTS) {
    const err = Math.abs(Math.log(ratio / candidate[1]));
    if (err < bestErr) {
      bestErr = err;
      best = candidate;
    }
  }
  return best[0];
}

/**
 * What shape to ask the model for.
 *
 * ─── AN EDIT MUST STATE ITS SHAPE, AND UNTIL NOW IT DID NOT ─────────────────────────────────────
 *
 * This is the fix for the rotated edit output. The old rule was `mode === "generate"` only, on the
 * reasoning that "an edit inherits the frame" — which is true of the REFERENCE we send and false of
 * the OUTPUT we get back. `:generateContent` composes a new image every time; with no
 * `imageConfig.aspectRatio` it picks its own canvas, and for a portrait source it frequently picks
 * a landscape one and lays the scene into it sideways. Nothing downstream could put that right: the
 * returned PNG carries no orientation metadata and no record of what the model did, so there is no
 * transform to invert (see assertEditKeptItsShape in studio/generate.ts).
 *
 * Stating the source's own ratio removes the choice instead of trying to undo it afterwards. It is
 * the same field the generate path already proved reaches the wire (studio/adapters/vertex.test.ts).
 *
 * An UNMEASURED source yields undefined rather than a guess — the request then behaves exactly as
 * it did before, and the shape guard is still behind it.
 */
export function aspectFor(
  brief: CreativeBrief,
  crop?: PlannedCrop | null,
): string | undefined {
  if (brief.job.mode === "generate") return ASPECT[brief.job.deliverable];
  // THE CANVAS MUST BE THE SHAPE OF WHAT THE MODEL IS LOOKING AT.
  //
  // A masked edit shows it a CROP, and a crop is rarely the frame's shape — a square region on a 2:3
  // photograph pads to a square. Asking for the FRAME's ratio here while sending that crop is a
  // straightforward request for the wrong shape: the patch comes back 2:3, and pasteBack's
  // fit:"fill" resize back to the crop's own dimensions then SQUASHES it. Nothing errors; the edited
  // region is simply distorted, which is the kind of wrong that only shows up by looking.
  if (crop) return nearestAspect(crop.send.width, crop.send.height);
  const src = brief.job.source;
  return src?.width && src?.height
    ? nearestAspect(src.width, src.height)
    : undefined;
}
