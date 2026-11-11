/**
 * studio/segment — the mask for one crop, or null. Garment or subject; this file does not care.
 *
 * Sits between `runMaskedEdit` and the router. Small on purpose: the interesting work is the
 * geometry in studio/composite.ts and the vocabulary in studio/garmentVocab.ts and
 * studio/subjectVocab.ts, and this file is only the part that decides whether to spend and refuses
 * to let a failure become a failed edit.
 *
 * ─── ① NULL IS THE ORDINARY ANSWER. THIS FUNCTION NEVER THROWS ─────────────────────────────────
 *
 * Every failure here — either flag being off, no noun, an empty mask list, a timeout, a provider
 * error, a missing key — returns null. That is a deliberate inversion of the usual rule that a
 * failed provider call should surface, and the reason is what a throw would cost: `runMaskedEdit`
 * has already paid for the patch by the time a mask is asked for, so letting a $0.005 mask call
 * fail an edit that already spent dollars gets the arithmetic exactly backwards.
 *
 * ⚠️ WHAT NULL MEANS IS NOT THIS FILE'S DECISION, AND IT IS NOT ONE ANSWER ANY MORE. It used to be
 * "composite this region on its rectangle" for everyone. It now depends on the POLARITY, and the
 * choice is made in studio/composite.ts `pasteBack` where the rectangle actually is:
 *
 *   edit-inside      (garment)     → the region takes its rectangle. Graceful: her box was drawn
 *                                    around the garment, so the edit still lands roughly right.
 *   preserve-inside  (background)  → the region is REFUSED and nothing is pasted. The rectangle for
 *                                    a background change is the whole frame, so falling back would
 *                                    re-render the athlete herself.
 *
 * Which is why this file must not "helpfully" retry, substitute a noun, or degrade one polarity
 * into the other. It returns bytes or null, and the composite decides what null costs.
 *
 * ─── ② WHY THIS RUNS AT GENERATION TIME AND NOT IN THE PREVIEW ─────────────────────────────────
 *
 * `previewGeneration`'s contract is "no network, no spend, no writes", and studio/generate.ts's
 * whole re-derivation argument rests on it. So the mask is derived AFTER approval, inside the crop
 * loop, where the upright frame is already decoded and the crop bytes already exist.
 *
 * That is safe for the approval contract because a mask changes NOTHING the athlete approved: not
 * the task, not the model, not the crop, not the image size, not the quoted figure. It changes the
 * alpha of a paste. The thing she approved is what runs; it just stops short of her arm.
 */
import sharp from "sharp";
import { createLogger } from "../logger";
import {
  backgroundMaskEnabled,
  garmentMaskEnabled,
  segmentLongEdgePx,
} from "./config";
import { generate } from "./router";
import type { EditRegion } from "./brief";
import { maskGeometryFor, regionWithinCrop } from "./composite";
import type { CropRect, MaskPolarity, PlannedCrop } from "./composite";

const logger = createLogger("studio/segment");

export interface MaskAsk {
  /** The word handed to the segmenter. Closed-vocabulary on both arms. */
  noun: string;
  /** Which side of the returned mask the edit applies to. */
  polarity: MaskPolarity;
}

/**
 * What to ask the segmenter for on this crop, and which side of the answer the edit applies to.
 * Null when the regions do not agree on one coherent ask.
 *
 * A merged crop carries several rectangles, but `planCrops` only ever merges regions naming the
 * SAME target, so their nouns agree by construction. Taking the first is not a shortcut past a
 * disagreement; there is no disagreement to have. The `every` guards are here so that if the merge
 * rule is ever loosened this degrades to no mask rather than silently segmenting two socks as
 * whatever the first one happened to be — and, now, rather than segmenting a PERSON as a sock.
 */
export function nounFor(regions: EditRegion[]): MaskAsk | null {
  const first = regions[0];
  if (!first) return null;
  // Subject first: a region that names something to PRESERVE is answering a different question from
  // one that names something to edit, and a plan holding both is incoherent rather than ambiguous.
  if (first.subjectNoun) {
    const agreed = regions.every(
      (r) => r.subjectNoun === first.subjectNoun && !r.samNoun,
    );
    return agreed
      ? { noun: first.subjectNoun, polarity: "preserve-inside" }
      : null;
  }
  if (first.samNoun) {
    const agreed = regions.every(
      (r) => r.samNoun === first.samNoun && !r.subjectNoun,
    );
    return agreed ? { noun: first.samNoun, polarity: "edit-inside" } : null;
  }
  return null;
}

/**
 * The polarity a plan composites at, DERIVED FROM THE REGIONS AND NEVER FROM THE MASK RESULT.
 *
 * ⚠️ THIS HAS TO BE SEPARATE FROM `nounFor`, AND THE REASON IS THE REFUSAL. `nounFor` returns null
 * for a plan whose regions disagree, and `maskForCrop` returns null for every failure there is — so
 * if the composite learned the polarity from the mask, every background edit that failed to get a
 * mask would arrive at `pasteBack` looking exactly like an ordinary garment edit with no mask, and
 * take the rectangle. Which is the full re-render of her, silently.
 *
 * So the polarity is a property of what she asked for, known before any call is made and unchanged
 * by any failure. Any region naming a subject makes the whole plan an inversion — the safe
 * direction, since it can only ever turn a silent fallback into a visible refusal.
 */
export function polarityFor(regions: EditRegion[]): MaskPolarity {
  return regions.some((r) => r.subjectNoun) ? "preserve-inside" : "edit-inside";
}

/**
 * The crop, small enough to send as a data URI. See studio/config.ts segmentLongEdgePx for the
 * trade this constant makes and why it is the least-settled number in the feature.
 *
 * `withoutEnlargement` so a small crop is never blown up: it would cost body size to add no detail,
 * and the mask is resized back to crop space either way.
 */
async function probeBytes(cropBytes: Buffer): Promise<Buffer> {
  const edge = segmentLongEdgePx();
  return sharp(cropBytes, { failOn: "none" })
    .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

/**
 * The four ways a region ends up with no mask. Ordered by where they happen, not by severity.
 *
 *   off        the flag for this polarity is off. Nothing was asked.
 *   no_noun    nothing to ask FOR — `nounFor` returned null.
 *   not_found  we asked, and the segmenter returned nothing over this rectangle.
 *   error      the call THREW. A crash, and it must never again read as "disabled".
 */
export type MaskMiss = "off" | "no_noun" | "not_found" | "error";

export interface SegmentRequest {
  plan: PlannedCrop;
  /** The crop's own bytes — the SAME buffer the edit model is sent, before any downscale here. */
  cropBytes: Buffer;
  signal?: AbortSignal;
  /** For the cost log, so a mask call is attributable to the job that made it. */
  jobId?: string;
  /**
   * WHY A REGION GOT NO MASK, reported from the one place that knows.
   *
   * ⚠️ THE CALLER CANNOT WORK THIS OUT AND MUST NOT GUESS. A null in the returned array is four
   * different facts — the flag is off, nothing named a noun, the segmenter returned nothing over
   * this rectangle, or THE CALL THREW — and they want four different fixes. Collapsing them is not
   * hypothetical: `verdict` in composite.ts defaulted to "off", so a crash logged as though the
   * feature were disabled, and an inversion edit that died in sharp with `extract_area: bad extract
   * area` was read as a flag problem for four runs.
   *
   * A callback rather than a richer return type because the return type has ~24 call sites in
   * segment.test.ts alone; widening it would be churn in tests that are not about this, and the
   * reason is diagnostic — nothing branches on it.
   */
  onMiss?: (regionIndex: number, reason: MaskMiss) => void;
  /**
   * Whether the shape-mask source is consulted at all, THREADED RATHER THAN READ FROM THE
   * ENVIRONMENT — the same shape `parseDetections(raw, instruction, backgroundEnabled,
   * objectEnabled)` and `normalizeObjectNoun(raw, open)` already use, and for the same reason: a
   * behaviour has to be provable in jest without touching process.env.
   *
   * Defaults to the per-polarity flag, so omitting it is exactly today's behaviour. What it adds is
   * the ability to say "no mask" DELIBERATELY — which the env var could never express per request,
   * because it is process-wide. A caller that has chosen a path should not have to mutate global
   * state to get the geometry that path implies.
   */
  enabled?: boolean;
}

// ─── ONE PROBE PER REGION, ONE EDIT PER CROP ───────────────────────────────────────────────────
//
// `planCrops` merges same-target regions — two socks, two shoes — into ONE crop so they ride one
// paid edit call. That merge is right, and it is right for a reason that does not extend to
// segmentation: an edit call is ~$0.13 and a segmentation call is $0.005, twenty-seven times
// cheaper. Merging the expensive call is a saving; merging the cheap one bought about half a cent
// and cost a correctness bug.
//
// ⚠️ THE BUG IT COST, because it is not obvious from the geometry. One probe of the merged crop
// returns ONE instance mask — SAM answers with the sock it found, not both — and `pasteBack` then
// scores that single mask against BOTH region rectangles. On a real frame it read 0.000 against its
// own sock and 1.215 against the other one; the second was discarded for overreach, fell back to
// its RECTANGLE, and the rectangle re-rendered her leg. The mask was flawless (solidity 0.578,
// 0.49x its region's area, stopping cleanly at hem and shoe). Nothing was wrong with it except
// which rectangle it was being asked about.
//
// So the probe is per REGION. Each region's mask comes from a window centred on that region, which
// makes "this mask belongs to this region" true by construction rather than by a matching rule
// somebody has to keep correct. There is no uncovered region to have a policy for, because every
// region gets its own call.
//
// A single-region crop — most edits — probes its whole crop exactly as it always did, makes exactly
// one call, and produces exactly the same bytes. This is not a new path for the common case.

/** Half a region's extent per side, so SAM sees the garment in context rather than cropped to it. */
const PROBE_PAD_FACTOR = 0.5;
/** ...but never so tight that a small garment arrives with no surroundings at all. */
const MIN_PROBE_PAD_PX = 32;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CROP SPACE vs SEND SPACE — the boundary this module got wrong
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A rectangle in SEND space: the coordinates of the buffer `cropFrame` actually produced.
 *
 * ─── THE BUG THIS TYPE EXISTS TO MAKE UNREPRESENTABLE ──────────────────────────────────────────
 *
 * `probeWindowFor` answers in CROP space — `plan.crop`'s own coordinates. But `cropFrame`
 * (studio/composite.ts) does this:
 *
 *     sharp(frameBytes).extract(plan.crop)
 *     if (plan.downscaled) pipeline.resize(plan.send.width, plan.send.height, { fit: "fill" })
 *
 * so `req.cropBytes` is `plan.send`-sized whenever the crop is over MAX_PATCH_PIXELS. Extracting a
 * crop-space window from it asks for pixels that are not there. Measured, live: a whole-frame
 * background region on a 4000x6000 frame produced `crop=4000x6000  send=3344x5017`, and
 * `sharp.extract({0,0,4000,6000})` on a 3344x5017 buffer threw `extract_area: bad extract area` in
 * 1ms, before any network call. Every failing job was `downscaled: true`; no succeeding job ever
 * was — a garment crop is a small box that stays under the ceiling, while a background region is
 * whole-frame by construction (autoMask.ts forces [0,0,1000,1000]) so its crop IS the frame.
 *
 * ⚠️ IT IS A `MAX_PATCH_PIXELS` BUG, NOT A BACKGROUND BUG. Background only guarantees the
 * condition. A single-region garment edit on a crop over the ceiling throws identically, because
 * `probeWindowFor` returns the whole crop whenever `regions.length < 2`.
 *
 * ─── WHY A BRAND HERE AND NOT EVERYWHERE ───────────────────────────────────────────────────────
 *
 * `CropRect` already denotes FOUR different spaces in this codebase — frame (`plan.crop`, which is
 * extracted from the full frame), crop (`within`, `window`), send (this), and window-relative
 * (`bestMaskFor`'s third argument). Branding all four means choosing a brand at every boundary, and
 * getting one wrong reintroduces exactly this defect while LOOKING type-safe. So there is one brand,
 * at the boundary that actually failed: `windowInSendSpace` is the only producer and
 * `extractWindow` the only consumer, which makes "extract a crop-space rect from cropBytes" a
 * compile error rather than a comment somebody has to read.
 *
 * ⚠️ THE OTHER THREE SPACES ARE UNAUDITED AND OUT OF SCOPE. In particular `plan.crop` is FRAME
 * space and is passed to functions whose other rectangles are crop space. That may be harmless —
 * it is mostly read for its width/height — but nobody has checked, and the next person should not
 * have to rediscover that CropRect means four things.
 */
type SendRect = CropRect & { readonly __space: "send" };

/**
 * A crop-space window, in the coordinates of the buffer that exists.
 *
 * ⚠️ RIGHT-EDGE ANCHORED, NOT `round(width * sx)`, AND THAT IS THE WHOLE ARITHMETIC. Scaling the
 * width independently lets the rounding of the offset and the rounding of the extent disagree, so
 * the window creeps by a pixel as it moves down the frame — a slow-burning off-by-one that no
 * single case makes obvious. Mapping BOTH EDGES and subtracting cannot drift: the right edge lands
 * where the right edge belongs.
 *
 * It also makes the case that matters exact. For a whole-frame window, `left = 0` and
 * `left + width = crop.width`, so `right'` is `round(crop.width * send.width / crop.width)` =
 * `send.width` on the nose — the window maps onto the whole buffer with nothing left over, which is
 * precisely the case that was throwing.
 *
 * ⚠️ THE AXES SCALE INDEPENDENTLY. `planCrop` rounds width and height separately, so `sx` and `sy`
 * differ by a hair and one shared scale would be subtly wrong on one axis.
 *
 * ⚠️ AND IT IS THE IDENTITY WHEN NOTHING WAS DOWNSCALED. `send` equals `crop` then, so `sx = sy = 1`
 * and every value passes through unchanged. One path serves both cases — there is deliberately no
 * `if (plan.downscaled)` here, because a branch is a thing that can be taken wrongly.
 */
export function windowInSendSpace(
  window: CropRect,
  plan: PlannedCrop,
): SendRect {
  const sx = plan.send.width / plan.crop.width;
  const sy = plan.send.height / plan.crop.height;

  const left = Math.round(window.left * sx);
  const top = Math.round(window.top * sy);
  const right = Math.round((window.left + window.width) * sx);
  const bottom = Math.round((window.top + window.height) * sy);

  // Clamped to the buffer, and never to nothing: sharp rejects a zero-width extract as hard as an
  // oversized one, and a degenerate window is a smaller failure than a wrong one.
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(v, hi));
  const l = clamp(left, 0, Math.max(0, plan.send.width - 1));
  const t = clamp(top, 0, Math.max(0, plan.send.height - 1));
  return {
    left: l,
    top: t,
    width: clamp(right - l, 1, plan.send.width - l),
    height: clamp(bottom - t, 1, plan.send.height - t),
  } as SendRect;
}

/**
 * The ONLY place `cropBytes` is extracted from, and the reason `SendRect` is branded.
 *
 * Everything downstream of this call — `bestMaskFor`, `intoCropSpace` — resizes whatever it is
 * given `fit: "fill"` to the CROP-space window's dimensions, so none of it cares what size the
 * extract was. That is what makes this a one-line fix, and it is also what makes it dangerous: a
 * wrong rectangle here does not throw, it silently returns a mask of the wrong pixels which is then
 * pasted at the right coordinates. See the placement test in segment.test.ts.
 */
async function extractWindow(
  cropBytes: Buffer,
  rect: SendRect,
): Promise<Buffer> {
  return sharp(cropBytes, { failOn: "none" }).extract(rect).png().toBuffer();
}

/**
 * The window to segment for one region, in CROP space. Pure.
 *
 * Deliberately NOT the whole crop when a crop holds several regions: a window centred on this sock
 * is what makes the returned mask this sock's. It still carries context, so it can and often does
 * clip the neighbouring instance — which is why the mask is then chosen by overlap with the region
 * rather than by size (see `bestMaskFor`).
 */
export function probeWindowFor(
  plan: PlannedCrop,
  region: EditRegion,
): CropRect {
  const within = regionWithinCrop(plan, region);
  if (plan.regions.length < 2)
    return {
      left: 0,
      top: 0,
      width: plan.crop.width,
      height: plan.crop.height,
    };
  const padX = Math.max(
    MIN_PROBE_PAD_PX,
    Math.round(within.width * PROBE_PAD_FACTOR),
  );
  const padY = Math.max(
    MIN_PROBE_PAD_PX,
    Math.round(within.height * PROBE_PAD_FACTOR),
  );
  const left = Math.max(0, within.left - padX);
  const top = Math.max(0, within.top - padY);
  return {
    left,
    top,
    width: Math.min(
      plan.crop.width - left,
      within.width +
        padX * 2 +
        (within.left - padX < 0 ? within.left - padX : 0),
    ),
    height: Math.min(
      plan.crop.height - top,
      within.height +
        padY * 2 +
        (within.top - padY < 0 ? within.top - padY : 0),
    ),
  };
}

/**
 * Which of the returned masks is THIS region's: the one covering most of its rectangle.
 *
 * ⚠️ NOT "the largest", and the difference bites exactly where it matters. A probe window carries
 * context, so it frequently clips the neighbouring sock; on a frame where the neighbour is more
 * fully in view than the target, the largest mask is the WRONG one. Overlap with the region asks
 * the question actually being answered — which of these is the thing that rectangle names — and it
 * degenerates to "the only one" in the ordinary single-mask case.
 *
 * Null when nothing overlaps the region at all, which is a real answer: the segmenter found things
 * in the window, but none of them here.
 */
async function bestMaskFor(
  masks: Buffer[],
  window: CropRect,
  regionInWindow: CropRect,
): Promise<Buffer | null> {
  let best: Buffer | null = null;
  let bestOverlap = 0;
  for (const m of masks) {
    const raw = await sharp(m, { failOn: "none" })
      .resize(window.width, window.height, { fit: "fill" })
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer();
    let overlap = 0;
    for (
      let y = regionInWindow.top;
      y < regionInWindow.top + regionInWindow.height;
      y++
    ) {
      if (y < 0 || y >= window.height) continue;
      for (
        let x = regionInWindow.left;
        x < regionInWindow.left + regionInWindow.width;
        x++
      ) {
        if (x < 0 || x >= window.width) continue;
        if (raw[y * window.width + x] >= 128) overlap++;
      }
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = m;
    }
  }
  return best;
}

/**
 * SPILL AS A FRACTION OF THE HEADROOM THE MASK ACTUALLY HAD. Logged, never enforced — yet.
 *
 * ─── WHY `overreach` NEEDS A REPLACEMENT AND NOT A BIGGER LIMIT ────────────────────────────────
 *
 * `overreach` (studio/composite.ts) divides the spill past a region by the REGION's own size, but
 * what bounds the spill is the PADDING, and the padding is `max(MIN_CONTEXT_PAD_PX, w/2)`. So the
 * metric's reachable range collapses as the region grows, and the guard quietly stops existing:
 *
 *     region w      pad   max reachable overreach   can `> 0.5` ever fire?
 *           60      256                     4.267   yes
 *          140      256                     1.829   yes
 *          400      256                     0.640   yes
 *          511      256                    0.5010   yes
 *          512      256                    0.5000   NO — structurally impossible
 *          900      450                    0.5000   NO
 *         4000     2000                    0.5000   NO
 *
 * ⚠️ AND AT w=513 IT FIRES AGAIN, AT 0.5010, BECAUSE `Math.round(256.5)` IS 257. A guard whose
 * existence depends on whether half the region width rounds to 256 or 257 is worse than a dead
 * guard, because dead is at least predictable. Nobody reading this would guess that 512 is
 * structurally impossible and 513 is not.
 *
 * ⚠️ IT ALSO DEPENDS ON WHETHER A GARMENT SHARES A CROP, which is nothing to do with mask quality.
 * A region alone in its crop is probed against the whole crop (`MIN_CONTEXT_PAD_PX` 256); one
 * sharing a crop gets a padded window (`MIN_PROBE_PAD_PX` 32). Measured on the same 62px shoe:
 * alone, max reachable overreach 3.23; paired, 0.52 — the guard is near-dead for paired garments
 * at any size.
 *
 * And the other guard does not cover the gap: on a 4000px region a mask may cover ~2.5x the
 * region's AREA and still pass both `overreach` and `crop_fill`.
 *
 * ─── WHAT THIS MEASURES INSTEAD ────────────────────────────────────────────────────────────────
 *
 * The same spill, divided by the headroom that actually existed on that side — the distance from
 * the region's edge to the probe window's. Range [0, 1] at every region size and on both the solo
 * and paired paths, because it is normalised by the thing that bounds it. A mask sitting exactly on
 * its rectangle scores 0; one filling the window scores 1.
 *
 * ⚠️ NOT ENFORCED. It is logged beside `overreach` so a threshold can be set from data rather than
 * guessed, exactly as maskShapeStats was added before anything acted on it. Swapping enforcement to
 * an uncalibrated metric would trade a guard that silently never fires for one that might silently
 * over-reject — the same class of error pointed the other way.
 */
export function padSpillFor(
  bbox: { left: number; top: number; width: number; height: number },
  within: CropRect,
  window: CropRect,
): number {
  const sides: [number, number][] = [
    [within.left - bbox.left, within.left - window.left],
    [
      bbox.left + bbox.width - (within.left + within.width),
      window.left + window.width - (within.left + within.width),
    ],
    [within.top - bbox.top, within.top - window.top],
    [
      bbox.top + bbox.height - (within.top + within.height),
      window.top + window.height - (within.top + within.height),
    ],
  ];
  // A side with no headroom cannot be spilled into, so it contributes nothing rather than dividing
  // by zero. That happens when the region touches the window edge, which the frame clamp allows.
  return Math.max(
    0,
    ...sides.map(([spill, head]) => (head > 0 ? spill / head : 0)),
  );
}

/** One region's mask, translated from its window back into CROP space. */
async function intoCropSpace(
  mask: Buffer,
  plan: PlannedCrop,
  window: CropRect,
): Promise<Buffer> {
  const inWindow = await sharp(mask, { failOn: "none" })
    .resize(window.width, window.height, { fit: "fill" })
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  // Zero everywhere the window did not look. A region's mask must not claim pixels nobody segmented
  // for it — outside the window is "unknown", and unknown composites as the original.
  const full = Buffer.alloc(plan.crop.width * plan.crop.height, 0);
  for (let y = 0; y < window.height; y++) {
    inWindow.copy(
      full,
      (window.top + y) * plan.crop.width + window.left,
      y * window.width,
      (y + 1) * window.width,
    );
  }
  return sharp(full, {
    raw: { width: plan.crop.width, height: plan.crop.height, channels: 1 },
  })
    .png()
    .toBuffer();
}

/**
 * One mask per region of this crop, in the plan's own order, each in CROP space. Never throws.
 *
 * A null entry is the ordinary answer and means what it has always meant — no mask for that region
 * — with the cost of it decided by polarity in studio/composite.ts, not here. An all-null array is
 * the identity case: byte-for-byte what the composite did before masking existed.
 */
export async function masksForCrop(
  req: SegmentRequest,
): Promise<(Buffer | null)[]> {
  const none = req.plan.regions.map(() => null);
  const miss = (reason: MaskMiss) =>
    req.plan.regions.forEach((_, i) => req.onMiss?.(i, reason));

  const ask = nounFor(req.plan.regions);
  // No noun is the commonest null by far — a box she drew herself, a brief frozen before the field
  // existed, or a detection whose noun failed the whitelist. It costs nothing and is not worth a
  // log line per crop.
  if (!ask) {
    miss("no_noun");
    return none;
  }

  // ONE FLAG PER PATH, and they are independent. A deployment can run garment masks without
  // background edits or the reverse, and neither flag being off can turn the other's edit into
  // something it was not: off simply means no mask, and what "no mask" costs is decided by the
  // polarity, in pasteBack.
  const enabled =
    req.enabled ??
    (ask.polarity === "preserve-inside"
      ? backgroundMaskEnabled()
      : garmentMaskEnabled());
  if (!enabled) {
    miss("off");
    return none;
  }
  const noun = ask.noun;

  const out: (Buffer | null)[] = [];
  for (const [regionIndex, region] of req.plan.regions.entries()) {
    const started = Date.now();
    const window = probeWindowFor(req.plan, region);
    const within = regionWithinCrop(req.plan, region);
    try {
      // ⚠️ CONVERTED, NOT PASSED. `window` is CROP space and `req.cropBytes` is SEND space; they
      // are the same numbers only when nothing was downscaled. See `windowInSendSpace`.
      const windowBytes = await extractWindow(
        req.cropBytes,
        windowInSendSpace(window, req.plan),
      );
      const result = await generate(
        "image.segment",
        {
          // The noun IS the prompt for this task.
          //
          // ⚠️ THE "CLOSED VOCABULARY, THEREFORE SAFE TO LOG" ARGUMENT NO LONGER APPLIES AS WRITTEN,
          // and the weaker one that replaces it still holds. The edit arm is open now
          // (studio/objectVocab.ts): this word is model-chosen from the photograph rather than
          // picked off a list of seven. What bounds it is SHAPE — at most three words of lowercase
          // letters, spaces and hyphens — so it still cannot carry an email body, a brand message or
          // an instruction, which is what the original claim was actually protecting.
          //
          // It is logged below on that narrower basis: a bounded noun, in the athlete's own job
          // line, is the diagnostic that finds a vocabulary miss — a missing `samNoun` in this exact
          // field is how the object-edit gap was found at all. The preserve arm
          // (studio/subjectVocab.ts) is still closed and still literally one word.
          prompt: noun,
          // BYTES, never a url. studio/adapters/fal.ts refuses the url arm outright and explains
          // why; this is the call site that would otherwise be tempted to pass the signed frame url
          // it is sitting next to.
          references: [
            {
              kind: "bytes",
              bytes: await probeBytes(windowBytes),
              mimeType: "image/png",
            },
          ],
        },
        {
          signal: req.signal,
          // The join key a mask probe can know (PR 11): the job that is paying for it.
          attribution: { jobId: req.jobId ?? null },
        },
      );

      const candidates = result.assets
        .map((a) => a.bytes)
        .filter((b): b is Buffer => !!b);
      const chosen = await bestMaskFor(candidates, window, {
        left: within.left - window.left,
        top: within.top - window.top,
        width: within.width,
        height: within.height,
      });
      const inCrop = chosen
        ? await intoCropSpace(chosen, req.plan, window)
        : null;
      if (!inCrop) req.onMiss?.(regionIndex, "not_found");
      out.push(inCrop);

      // ─── THE CALIBRATION FIELDS ────────────────────────────────────────────────────────────
      //
      // Everything needed to set a padSpill threshold LATER without running this investigation
      // again. If any of these is missing we come back here to interpret our own data, so they
      // travel together or not at all: the region's size, the window it was probed in, the
      // headroom that bounded the spill, whether it shared a crop, and BOTH metrics side by side.
      //
      // `maxOverreach` is the one that exposes the dead zone directly — it is the largest value
      // `overreach` could possibly have taken here, so a row where it equals the limit is a row
      // where the guard could never have fired whatever the mask did.
      let calibration: Record<string, unknown> | undefined;
      if (inCrop) {
        const raw = await sharp(inCrop, { failOn: "none" })
          .greyscale()
          .raw()
          .toBuffer();
        const geo = maskGeometryFor(raw, req.plan.crop, within);
        if (geo.bbox) {
          const headroom = Math.max(
            within.left - window.left,
            window.left + window.width - (within.left + within.width),
          );
          calibration = {
            regionW: within.width,
            regionH: within.height,
            windowW: window.width,
            windowH: window.height,
            headroom,
            paired: req.plan.regions.length > 1,
            overreach: Number(geo.overreach.toFixed(3)),
            padSpill: Number(padSpillFor(geo.bbox, within, window).toFixed(3)),
            maxOverreach: Number((headroom / within.width).toFixed(3)),
          };
        }
      }

      logger.info(
        {
          jobId: req.jobId,
          noun,
          polarity: ask.polarity,
          label: region.label,
          ms: Date.now() - started,
          // How many SAM offered against how many were usable here. `returned > 1` is the case the
          // adapter used to hide by keeping masks[0]; `returned > 0 && !found` is a window that saw
          // things but none of them over this rectangle.
          returned: candidates.length,
          found: !!chosen,
          ...calibration,
        },
        chosen
          ? "mask returned"
          : ask.polarity === "preserve-inside"
            ? "segmenter found no subject over this region — it will be refused, not re-rendered"
            : "segmenter found nothing over this region — falling back to the rectangle",
      );
    } catch (err) {
      // The MESSAGE, never the error object — a serialized provider error can carry the request
      // body, and the request body is her photograph as base64.
      logger.warn(
        {
          jobId: req.jobId,
          noun,
          polarity: ask.polarity,
          label: region.label,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        },
        ask.polarity === "preserve-inside"
          ? "subject mask failed — this region will be refused, not re-rendered"
          : "garment mask failed — falling back to the rectangle",
      );
      // ⚠️ REPORTED AS `error`, NOT AS A MISSING MASK. This is the branch that read as "off" — a
      // throw and a disabled feature composited identically and logged identically, so a crash in
      // sharp looked like an environment problem all the way up.
      req.onMiss?.(regionIndex, "error");
      // ONE REGION'S FAILURE IS ONE REGION'S. The loop continues so a second sock is not lost to the
      // first one's timeout — same reasoning as runMaskedEdit's per-crop catch, one level down.
      out.push(null);
    }
  }
  return out;
}
