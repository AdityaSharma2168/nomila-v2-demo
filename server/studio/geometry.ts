/**
 * studio/geometry — the one place a drawn box becomes pixels.
 *
 * THE PROBLEM THIS SOLVES. The athlete marks a region on a photo rendered at whatever size her
 * screen allows; the frame the model actually receives is the full-resolution original (the spike's
 * frames are 4000x6000 and 6000x4000). A box measured in display pixels and handed over as if it
 * were original pixels lands somewhere else entirely — and because the mask is consumed as language
 * rather than as an alpha channel (see buildPrompt in studio/preview.ts), nothing downstream can
 * notice. The re-render then moves features that should not move, which is precisely the failure
 * the spike ran into with a loose ball-crop.
 *
 * THE FIX IS THE WIRE FORMAT, NOT THE ARITHMETIC. The client sends FRACTIONS of the image's own
 * extent (0..1), never pixels. A fraction is scale-invariant by construction, so device pixel
 * ratio, `resizeMode="contain"` letterboxing, a thumbnail standing in for the original, and aspect
 * ratio all drop out — there is no scale factor for the two sides to disagree about. This module
 * multiplies those fractions by dimensions the SERVER derived from the object's own bytes
 * (studio/imageSize.ts), because `media_assets.width/height` is NULL for ingested media and merely
 * client-asserted for uploads.
 *
 * Pure. No db, no gcs, no clock. That is deliberate: this is the arithmetic the whole feature
 * rests on, so it must be provable in jest without a harness.
 */
import type { EditRegion } from "./brief";
import { normalizeObjectNoun } from "./objectVocab";
import { normalizeSubjectNoun } from "./subjectVocab";

/** What the client is allowed to send: fractions of the source frame, plus what to change there. */
export interface RegionFraction {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * The concrete noun for the segmenter, when something named one — a garment, a ball, any object
   * she can name. See EditRegion.samNoun, and studio/objectVocab.ts for what it may and may not be.
   *
   * ⚠️ UNTRUSTED ON BOTH PATHS. This type is the CLIENT wire format as well as the shape
   * studio/autoMask.ts produces, so this field arrives from a request body as readily as from a
   * model. `mapRegions` validates it against the closed vocabulary rather than passing it through —
   * see the note there. Nothing else in this file needs to know it exists.
   */
  samNoun?: string;
  /**
   * The subject noun for an inversion mask — see EditRegion.subjectNoun. Untrusted on both paths
   * exactly as `samNoun` is, and validated in `mapRegions` against studio/subjectVocab.ts.
   */
  subjectNoun?: string;
}

/**
 * At most six distinct NAMED THINGS per edit.
 *
 * SEMANTIC, and this is the limit that answers what she actually asked for. Each target becomes its
 * own directive competing for the model's attention, and six is where a sentence stops being an
 * edit and starts being a restyle.
 *
 * It is enforced on the AUTO-MASK path only (studio/autoMask.ts), where a target is a thing the
 * model named out of her instruction. A hand-drawn box carries no target — she pointed at pixels —
 * so that path is bounded by MAX_REGIONS and the call cap alone.
 *
 * ⚠️ THIS IS NOT THE EFFECTIVE CEILING TODAY, AND IT MUST NOT BE READ AS ONE. Different targets
 * never share a crop — merging happens WITHIN a target, because a crop can only carry one directive
 * — so N targets is at least N provider calls. `maxEditCalls()` (studio/config.ts) is 4, so a
 * five- or six-target edit passes this guard and is then refused by the call cap a step later,
 * before it spends. Raising this number alone buys one more target (3 → 4), not three more. The two
 * have to move together, and the call cap moves on measured latency — see its note.
 */
export const MAX_TARGETS = 6;

/**
 * At most twelve region boxes per edit.
 *
 * ⚠️ THIS IS NO LONGER THE CALL COUNT, AND THE DIFFERENCE IS THE WHOLE POINT OF THE SPLIT.
 *
 * It used to be 3, and it used to be one call per region, so one number meant three things at once:
 * how many things she may change, how many boxes may be detected, and how much a job may spend.
 * "Change my uniform, socks and shoes" is THREE targets and SEVEN boxes (two socks, two shoes,
 * jersey and shorts), and it refused on a number that was never about targets.
 *
 * The three bounds are now separate and each guards its own thing:
 *
 *   MAX_TARGETS (6)        what she may change      — semantic, autoMask
 *   MAX_REGIONS (12)       detection noise          — HERE
 *   maxEditCalls() (4)     spend and wall-clock     — studio/config.ts, THE binding one
 *
 * Same-target regions merge into one crop where their union stays tight (composite.planCrops), so
 * twelve boxes is commonly four calls or fewer. This number exists to stop a runaway detection from
 * reaching the merger at all; it is not a spend control and must never be read as one.
 */
export const MAX_REGIONS = 12;

/**
 * Below this, in ORIGINAL pixels on either axis, a region is a mis-tap rather than an intent.
 * Rejected outright — silently editing an 3x2 pixel box would "succeed" and change nothing.
 */
export const MIN_REGION_PX = 8;

/**
 * The floor for a region DETECTED from her sentence when the edit will run native (guard scope, G.2,
 * 2026-09-10): one pixel — a box, not a line. The route passes it (routes/studio.ts, resolveSource).
 *
 * ⚠️ MIN_REGION_PX IS A MASKED-PATH AND HAND-DRAWN RULE, and it was firing on native jobs. Its two
 * reasons — a mis-tap, and a crop so small that editing inside it "succeeds" and changes nothing — are
 * about a box she DREW and a CROP that is sent. A native edit is one full-frame call; the region's
 * geometry is never sent (only a recolour's label is read, for its colour). So "change my earrings in
 * the first picture…" was refused as "too small" by a rule about something that job never does.
 *
 * The floor still holds, unchanged, for a box she drew and for every region with STUDIO_NATIVE_EDIT
 * off — both run masked. And editCropsFor keeps its own MIN_REGION_PX backstop on the crop it would
 * send (studio/preview.ts), so a region that ever reached the masked path would still refuse there.
 */
export const NATIVE_REGION_MIN_PX = 1;

/**
 * Where the "this box is getting loose" warning appears, as a share of the frame's area.
 *
 * A V1 GUESS, TO BE TUNED ONCE THIS HAS RUN ON REAL FRAMES. Deliberately NOT set at the point
 * where problems begin: the spike moved features on a ~780px crop of a 4000x6000 frame, which is
 * around 3% of the area, and a warning at 3% would fire on virtually every legitimate tight edit
 * and be learned as noise within a day. 25% is a different claim — not "this will fail" but "the
 * box is now big enough that she is re-rendering a chunk of the photo and should reconsider". The
 * live percentage readout in the mask editor does the moment-to-moment steering; this threshold is
 * only where explicit warning text appears. It never blocks: she can always proceed.
 */
export const LOOSE_REGION_AREA = 0.25;

/** The same claim for several regions at once — a set that covers half the frame is not a mask. */
export const LOOSE_TOTAL_AREA = 0.5;

/** No matter how many things she names, past this the edit really is a re-render. */
export const LOOSE_TOTAL_CEILING = 0.75;

/**
 * The total-area budget, scaled by how many distinct things she asked to change.
 *
 * A FLAT 0.5 CRIED WOLF ON THE HAPPY PATH. One target covering half the frame is loose; three
 * targets — a uniform, socks and shoes on a full-body shot — legitimately sum past it while every
 * individual box stays tight, and a warning that fires on the ordinary multi-target case is learned
 * as noise within a day. That is worse than no warning, because it also devalues the single-region
 * warning next to it, which is the one that catches a genuinely loose box.
 *
 * So the budget grows with the target count and stops at LOOSE_TOTAL_CEILING, past which the claim
 * is true again regardless of how much she named. The per-region LOOSE_REGION_AREA check is
 * UNCHANGED and still fires on one loose box inside an otherwise reasonable set — that guard is
 * doing different work and is not relaxed here.
 */
export function looseTotalFor(targetCount: number): number {
  return Math.min(LOOSE_TOTAL_CEILING, LOOSE_TOTAL_AREA * Math.max(1, targetCount));
}

export interface Frame {
  width: number;
  height: number;
}

export type RegionError = { message: string; field: string };

export interface MappedRegions {
  regions: EditRegion[];
  /** Set when the marked area is large enough to be worth saying out loud. Never blocking. */
  looseNote: string | null;
}

/** Labels ride into the prompt verbatim, so they are bounded here rather than at the call site. */
export const MAX_LABEL_LEN = 60;

const isFraction = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

const pct = (share: number) => `${Math.round(share * 100)}%`;

/**
 * Fractions -> original pixels, validated against the frame the server measured.
 *
 * OUT OF BOUNDS IS REJECTED, NOT CLAMPED. Clamping would quietly change which part of the photo
 * the edit touches while still returning success, which is the same silent-wrong-mask failure the
 * fraction wire format exists to prevent. If the numbers do not describe a box inside the frame,
 * the answer is a refusal she can read.
 */
export function mapRegions(
  input: RegionFraction[],
  frame: Frame,
  /**
   * The pixel floor on either axis. MIN_REGION_PX unless the caller knows the regions will never be
   * cropped — a detected region on a native edit, NATIVE_REGION_MIN_PX. See there.
   */
  opts: { minRegionPx?: number } = {},
): MappedRegions | RegionError {
  const floor = opts.minRegionPx ?? MIN_REGION_PX;
  if (!Array.isArray(input) || input.length === 0) {
    return {
      message: "Mark the part of the photo you want changed.",
      field: "regions",
    };
  }
  if (input.length > MAX_REGIONS) {
    return {
      message: `Up to ${MAX_REGIONS} regions per edit.`,
      field: "regions",
    };
  }
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return {
      message: "Couldn't read that photo's dimensions.",
      field: "sourceAssetId",
    };
  }

  const regions: EditRegion[] = [];
  let totalArea = 0;
  let largestArea = 0;

  for (let i = 0; i < input.length; i++) {
    const r = input[i];
    const at = `regions[${i}]`;

    const label = typeof r?.label === "string" ? r.label.trim() : "";
    if (!label) {
      return {
        message: "Say what should change in each region you marked.",
        field: `${at}.label`,
      };
    }
    if (label.length > MAX_LABEL_LEN) {
      return {
        message: `Keep each label under ${MAX_LABEL_LEN} characters.`,
        field: `${at}.label`,
      };
    }

    if (
      !isFraction(r.left) ||
      !isFraction(r.top) ||
      !isFraction(r.width) ||
      !isFraction(r.height)
    ) {
      return { message: "That region isn't a valid box.", field: at };
    }
    if (r.width === 0 || r.height === 0) {
      return { message: "That region has no area.", field: at };
    }
    // Checked in FRACTION space, before rounding, so a box that overflows the frame is refused on
    // what she actually drew rather than on a rounded restatement of it.
    if (r.left + r.width > 1 || r.top + r.height > 1) {
      return { message: "That region falls outside the photo.", field: at };
    }

    // Round the edges, then derive the extent from them. Rounding left and width independently can
    // push right past the frame by a pixel; deriving width from two rounded edges cannot.
    const left = Math.round(r.left * frame.width);
    const top = Math.round(r.top * frame.height);
    const right = Math.round((r.left + r.width) * frame.width);
    const bottom = Math.round((r.top + r.height) * frame.height);
    const width = right - left;
    const height = bottom - top;

    if (width < floor || height < floor) {
      return {
        message: `That region is too small to edit — draw a box at least ${floor} pixel${floor === 1 ? "" : "s"} on each side.`,
        field: at,
      };
    }
    // Belt and braces: the fraction check above should make this unreachable. If rounding ever
    // makes it reachable, refusing is still right.
    if (right > frame.width || bottom > frame.height) {
      return { message: "That region falls outside the photo.", field: at };
    }

    const area = (width * height) / (frame.width * frame.height);
    totalArea += area;
    largestArea = Math.max(largestArea, area);

    // ─── THE NOUN IS WHITELISTED HERE, WHERE BOTH PATHS MEET ────────────────────────────────
    //
    // This is the only line in the file that treats a field as untrusted from the CLIENT as well as
    // from a model, and it is deliberately not in autoMask.ts's parser. A parser only sees the
    // model's answer; a box she drew herself arrives straight from a request body and never passes
    // through it. Validating in one place and not the other would leave a request body able to put
    // arbitrary text into a third-party prompt attached to an athlete's photograph.
    //
    // An unrecognised noun is DROPPED, never refused: the region is still a perfectly good edit, it
    // just takes its rectangle. Refusing would turn a vocabulary gap into a failed edit.
    //
    // ⚠️ THE EDIT-SIDE VOCABULARY IS OPEN NOW (studio/objectVocab.ts) AND THIS LINE IS WHY THAT IS
    // STILL SAFE. It was a closed garment list, and a closed list cannot contain "person" — so the
    // one thing that must never reach `edit-inside` was excluded by accident rather than by rule.
    // `normalizeObjectNoun` carries that exclusion explicitly, and it has to be enforced HERE as
    // well as in autoMask's parser for the reason this block already gives: a box she drew herself
    // arrives straight from a request body and never passes through that parser.
    const samNoun = normalizeObjectNoun(r.samNoun);
    const subjectNoun = normalizeSubjectNoun(r.subjectNoun);
    // ─── BOTH NOUNS IS NOT A CHOICE TO MAKE, IT IS A REGION TO DROP THEM FROM ────────────────
    //
    // "edit inside the jersey" and "preserve inside the person" cannot both describe one rectangle.
    // Picking either one would run a real segmentation, pass the leak guard, and change the wrong
    // half of the photograph with nothing anywhere reporting a problem. Dropping both leaves a
    // region that takes its rectangle — which is the same graceful state an unrecognised garment
    // noun produces, and on the background path studio/generate.ts refuses it rather than
    // re-rendering her.
    const both = !!samNoun && !!subjectNoun;
    regions.push({
      label, left, top, width, height,
      ...(samNoun && !both ? { samNoun } : {}),
      ...(subjectNoun && !both ? { subjectNoun } : {}),
    });
  }

  // DISTINCT LABELS, NOT REGION COUNT. On the auto-mask path a label IS the per-target directive
  // (studio/autoMask.ts), so two socks sharing "adidas socks" are one target; on the hand-drawn path
  // she typed a label per box and they are as distinct as she made them. Either way this counts the
  // things being changed rather than the rectangles it took to point at them.
  const targetCount = new Set(regions.map((r) => r.label)).size;

  return {
    regions,
    looseNote: looseNoteFor(largestArea, totalArea, regions.length, targetCount),
  };
}

/**
 * The warning text, or null. Separated out so the thresholds are testable on their own.
 *
 * `count` is rectangles (what the total area was summed over); `targetCount` is things she asked to
 * change (what the budget scales with). They differ whenever a target took more than one box, which
 * is the ordinary multi-target case — see looseTotalFor.
 */
export function looseNoteFor(
  largestArea: number,
  totalArea: number,
  count: number,
  targetCount: number = count,
): string | null {
  if (largestArea > LOOSE_REGION_AREA) {
    return (
      `The region you marked covers about ${pct(largestArea)} of the photo. An edit that large ` +
      `re-renders more than it preserves — a tighter box keeps the rest of the shot exactly as it is.`
    );
  }
  if (count > 1 && totalArea > looseTotalFor(targetCount)) {
    return (
      `Your regions cover about ${pct(totalArea)} of the photo between them. That is closer to a ` +
      `re-render than a retouch — tighter boxes keep the rest of the shot exactly as it is.`
    );
  }
  return null;
}
