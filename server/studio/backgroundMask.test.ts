/**
 * studio/backgroundMask — background-as-edit: the inversion path.
 *
 * ⚠️ THE PROOF THIS SUITE EXISTS FOR IS "THE ATHLETE SURVIVED". Everything else here — the
 * refusal, the polarity default, the erode direction — is scaffolding around one claim: when the
 * edit is the background, the pixels of the PERSON that come out are the pixels of the person that
 * went in, exactly, and nothing the segmenter or the edit model does can change that.
 *
 * So the frame and the patch are made maximally different (a flat 40 original against a flat 200
 * patch) and the assertions are on exact byte values, not on "close enough". A cross-fade, a stray
 * channel promotion or an off-by-one in the inversion all show up as a value that is neither 40 nor
 * 200, and there is no encoder tolerance in which those hide.
 */
import sharp from "sharp";
import {
  planCrop,
  pasteBack,
  regionWithinCrop,
  invertMask,
  maskEdgeFor,
  type PlannedCrop,
} from "./composite";
import { segmentLongEdgePx } from "./config";
import type { EditRegion } from "./brief";

jest.setTimeout(120_000);

const ORIGINAL = 40;
const PATCH = 200;

/** A whole-frame region, which is what a background edit always produces (autoMask.ts). */
const wholeFrame = (w: number, h: number, over: Partial<EditRegion> = {}): EditRegion => ({
  label: "a stadium at night",
  left: 0, top: 0, width: w, height: h,
  subjectNoun: "person",
  ...over,
});

async function flatFrame(w: number, h: number, value: number): Promise<Buffer> {
  return sharp(Buffer.alloc(w * h * 3, value), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
async function flatPatch(plan: PlannedCrop, value: number): Promise<Buffer> {
  const raw = Buffer.alloc(plan.crop.width * plan.crop.height * 3, value);
  return sharp(raw, { raw: { width: plan.crop.width, height: plan.crop.height, channels: 3 } }).png().toBuffer();
}
async function maskBytesFor(plan: PlannedCrop, on: (x: number, y: number) => boolean): Promise<Buffer> {
  const { width, height } = plan.crop;
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = on(x, y) ? 255 : 0;
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
const decode = (b: Buffer) => sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const at = (d: { data: Buffer; info: { width: number; channels: number } }, x: number, y: number) =>
  d.data[(y * d.info.width + x) * d.info.channels];

/** A person-shaped silhouette: a torso column down the middle of the frame. */
const PERSON = { left: 400, right: 600, top: 200, bottom: 900 };
const inPerson = (x: number, y: number) =>
  x >= PERSON.left && x < PERSON.right && y >= PERSON.top && y < PERSON.bottom;

// ─── ① THE PROOF ───────────────────────────────────────────────────────────────────────────────

describe("inversion preserves the person — the whole point of the feature", () => {
  it("every pixel inside the subject mask is EXACTLY the original's, and the background is the edit", async () => {
    const r = wholeFrame(1000, 1000);
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    const person = await maskBytesFor(plan, inPerson);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [person], maskPolarity: "preserve-inside" }]);
    expect(out.maskVerdicts).toEqual(["used"]);
    const d = await decode(out.bytes);

    // Deep inside her: untouched. Sampled across the silhouette rather than at one point, because a
    // single sample would pass against a mask that happened to be right in one place.
    for (const [x, y] of [[500, 300], [450, 550], [590, 880], [410, 210], [500, 700]]) {
      expect(at(d, x, y)).toBe(ORIGINAL);
    }
    // Deep in the background: fully the edit.
    for (const [x, y] of [[50, 50], [950, 950], [200, 500], [800, 300], [500, 60]]) {
      expect(at(d, x, y)).toBe(PATCH);
    }
  });

  it("preserves her EXACTLY, counted over the whole silhouette rather than sampled", async () => {
    const r = wholeFrame(1000, 1000);
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    const person = await maskBytesFor(plan, inPerson);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [person], maskPolarity: "preserve-inside" }]);
    const d = await decode(out.bytes);

    // Every pixel of the silhouette, inset by the transition band so the count is about the
    // inversion and not about the ramp — the ramp's own width is asserted separately below.
    const edge = maskEdgeFor(r, plan, segmentLongEdgePx());
    const inset = edge.erode + edge.ramp + 1;
    let checked = 0;
    for (let y = PERSON.top + inset; y < PERSON.bottom - inset; y++) {
      for (let x = PERSON.left + inset; x < PERSON.right - inset; x++) {
        if (at(d, x, y) !== ORIGINAL) {
          throw new Error(`the athlete was modified at ${x},${y}: ${at(d, x, y)} (expected ${ORIGINAL})`);
        }
        checked++;
      }
    }
    // The loop must actually have run — an inset that swallowed the silhouette would pass vacuously.
    expect(checked).toBeGreaterThan(100_000);
  });

  it("cannot touch a pixel outside the region rectangle, inverted or not", async () => {
    // The only-subtracts invariant, restated for the inverted case: pasted = rect ∩ ¬mask, and ¬ is
    // taken on a buffer already cropped to rect. A region SMALLER than the frame makes that
    // testable — if inversion escaped its rectangle, it would escape here.
    const r: EditRegion = { label: "backdrop", left: 200, top: 200, width: 400, height: 400, subjectNoun: "person" };
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    // A mask that is on only in one corner, so its inverse covers most of the crop and would spill
    // generously past the rectangle if the rectangle were not the boundary.
    const person = await maskBytesFor(plan, (x, y) => x < 40 && y < 40);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [person], maskPolarity: "preserve-inside" }]);
    const d = await decode(out.bytes);
    for (const [x, y] of [[0, 0], [199, 500], [601, 500], [500, 199], [500, 601], [999, 999], [150, 150]]) {
      expect(at(d, x, y)).toBe(ORIGINAL);
    }
  });

  it("leaves the rim nearest her as the ORIGINAL background, not the edit", async () => {
    // The erode points into the background once inverted, so the pixels closest to her outline stay
    // hers. That is the conservative direction and it is the one worth pinning: the alternative
    // would creep the new background INTO her edge.
    const r = wholeFrame(1000, 1000);
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    const person = await maskBytesFor(plan, inPerson);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [person], maskPolarity: "preserve-inside" }]);
    const d = await decode(out.bytes);
    const edge = maskEdgeFor(r, plan, segmentLongEdgePx());

    const y = 550;
    // Just outside her left edge, within the erode: still the original background.
    expect(at(d, PERSON.left - 1, y)).toBe(ORIGINAL);
    // Past the whole band: fully the new background.
    expect(at(d, PERSON.left - (edge.erode + edge.ramp) - 2, y)).toBe(PATCH);
  });
});

// ─── ② THE REFUSAL, WHICH IS THE OTHER HALF OF THE SAFETY ARGUMENT ─────────────────────────────

describe("a subject mask that cannot be used REFUSES — it never falls back to the rectangle", () => {
  it("skips the region entirely when no mask was offered, leaving the original untouched", async () => {
    const r = wholeFrame(1000, 1000);
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);

    const out = await pasteBack(frame, [{ plan, patchBytes, maskPolarity: "preserve-inside" }]);
    expect(out.maskVerdicts).toEqual(["refused_off"]);

    // NOT "mostly unchanged" — the whole frame, byte for byte. Falling back to the rectangle here
    // would have re-rendered her, and a whole-frame rectangle means the entire photograph.
    const d = await decode(out.bytes);
    for (const [x, y] of [[500, 550], [50, 50], [950, 950], [500, 60]]) expect(at(d, x, y)).toBe(ORIGINAL);
  });

  it("refuses rather than falls back when the leak guard rejects the mask", async () => {
    const r = wholeFrame(1000, 1000);
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    // An empty mask: the segmenter found nothing. On the garment path this takes the rectangle.
    const empty = await maskBytesFor(plan, () => false);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [empty], maskPolarity: "preserve-inside" }]);
    expect(out.maskVerdicts).toEqual(["refused_empty"]);
    const d = await decode(out.bytes);
    expect(at(d, 500, 550)).toBe(ORIGINAL);
    expect(at(d, 50, 50)).toBe(ORIGINAL);
  });

  it("the SAME failure on the garment path still falls back to the rectangle", async () => {
    // The asymmetry, asserted as an asymmetry rather than described in a comment: one input, two
    // polarities, two different and deliberate outcomes.
    const r: EditRegion = { label: "adidas jersey", left: 300, top: 300, width: 400, height: 400, samNoun: "jersey" };
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, PATCH);
    const empty = await maskBytesFor(plan, () => false);

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [empty], maskPolarity: "edit-inside" }]);
    expect(out.maskVerdicts).toEqual(["empty"]);
    const d = await decode(out.bytes);
    expect(at(d, 500, 500)).toBe(PATCH); // the rectangle was pasted
  });
});

// ─── ③ THE DEFAULT, so nothing that existed before this feature moves ──────────────────────────

describe("polarity defaults to the garment path", () => {
  it("a patch with no maskPolarity composites exactly as it did before inversion existed", async () => {
    const r: EditRegion = { label: "adidas jersey", left: 300, top: 300, width: 400, height: 400, samNoun: "jersey" };
    const frame = await flatFrame(1000, 1000, ORIGINAL);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, PATCH);
    const garment = await maskBytesFor(
      plan,
      (x, y) => x >= within.left + 50 && x < within.left + 200 && y >= within.top + 50 && y < within.top + 200,
    );

    const implicit = await pasteBack(frame, [{ plan, patchBytes, masks: [garment] }]);
    const explicit = await pasteBack(frame, [{ plan, patchBytes, masks: [garment], maskPolarity: "edit-inside" }]);
    expect(implicit.maskVerdicts).toEqual(["used"]);
    expect(implicit.bytes.equals(explicit.bytes)).toBe(true);
  });
});

// ─── ④ invertMask itself ───────────────────────────────────────────────────────────────────────

describe("invertMask", () => {
  it("flips the level rather than binarizing, so an antialiased edge stays antialiased", () => {
    const m = Buffer.from([0, 64, 127, 128, 200, 255]);
    expect([...invertMask(m)]).toEqual([255, 191, 128, 127, 55, 0]);
  });

  it("is its own inverse", () => {
    const m = Buffer.from([0, 17, 128, 254, 255]);
    expect(invertMask(invertMask(m)).equals(m)).toBe(true);
  });

  it("does not modify the buffer it was given", () => {
    const m = Buffer.from([0, 255]);
    invertMask(m);
    expect([...m]).toEqual([0, 255]);
  });
});
