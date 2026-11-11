/**
 * garmentMask.test.ts — the SHAPE mask on the edit path.
 *
 * Three properties carry this feature, and each has a test here whose failure means something
 * specific rather than "masking broke":
 *
 *   ① THE FALLBACK IS THE IDENTITY CASE. No mask, and a mask that is uniformly on, must produce
 *      byte-identical output. If that ever stops being true, "a failed mask degrades to today's
 *      behaviour, never worse" has stopped being true with it, and that sentence is the entire
 *      safety argument for shipping this.
 *
 *   ② THE MASK ONLY SUBTRACTS. A mask can never cause a pixel outside its region rectangle to
 *      change. The rectangle is what the athlete approved; the mask is only allowed to be more
 *      conservative than it.
 *
 *   ③ min, NOT multiply. The two alphas are independent constraints. The test point below is
 *      chosen so the two rules give measurably different answers, and it asserts that they do —
 *      a test that could pass under either rule would prove nothing.
 *
 * Fixtures are synthetic and generated in-test. No athlete pixels anywhere.
 *
 * ─── WHY THE FLAT FRAME / FLAT PATCH TRICK ─────────────────────────────────────────────────────
 *
 * With a frame of 0 and a patch of 255, `out = 255·(a/255) + 0·(1−a/255) = a`. The decoded pixel
 * value IS the alpha byte, read directly with no inference and no resampler to model. Everywhere
 * else in this directory texture is the point; here it would be the opposite.
 */
import sharp from "sharp";
import {
  planCrop,
  planCrops,
  pasteBack,
  regionWithinCrop,
  featherRadiusFor,
  distanceToOutside,
  maskAlpha,
  maskErodeFor,
  maskEdgeFor,
  maskUpscaleFor,
  maskEdgeUncertaintyFor,
  MASK_ANTIALIAS_PX,
  MAX_MASK_EDGE_UNCERTAINTY_PX,
  MASK_RAMP_TO_ERODE,
  maskGeometryFor,
  maskLeakReason,
  maskShapeStats,
  type PlannedCrop,
} from "./composite";
import type { EditRegion } from "./brief";
import { segmentLongEdgePx } from "./config";

jest.setTimeout(120_000);

const LIMITS = { maxOverreach: 0.5, maxCropFill: 0.85 };

const region = (over: Partial<EditRegion> = {}): EditRegion => ({
  label: "adidas jersey",
  left: 300,
  top: 300,
  width: 400,
  height: 400,
  ...over,
});

async function flatFrame(w: number, h: number, value: number): Promise<Buffer> {
  return sharp(Buffer.alloc(w * h * 3, value), {
    raw: { width: w, height: h, channels: 3 },
  })
    .png()
    .toBuffer();
}

async function flatPatch(plan: PlannedCrop, value: number): Promise<Buffer> {
  const raw = Buffer.alloc(plan.crop.width * plan.crop.height * 3, value);
  return sharp(raw, {
    raw: { width: plan.crop.width, height: plan.crop.height, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** A single-channel mask at the crop's own size, painted by a predicate in CROP coordinates. */
async function maskBytesFor(
  plan: PlannedCrop,
  on: (x: number, y: number) => boolean,
): Promise<Buffer> {
  const { width, height } = plan.crop;
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[y * width + x] = on(x, y) ? 255 : 0;
  }
  return sharp(raw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

const decode = (b: Buffer) =>
  sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const at = (
  d: { data: Buffer; info: { width: number; channels: number } },
  x: number,
  y: number,
) => d.data[(y * d.info.width + x) * d.info.channels];

// ─── ① The fallback is the identity case ───────────────────────────────────────────────────────

describe("the fallback is not a second code path — it is the identity case", () => {
  // ⚠️ EVERY TEST HERE ASSERTS WHICH PATH IT TOOK, AND THAT IS NOT BELT-AND-BRACES ───────────────
  //
  // A mask that is APPLIED and a mask that is DISCARDED produce the same bytes on exactly the cases
  // an identity test wants to use — a garment filling its rectangle composites identically either
  // way. So `expect(bytes).toEqual(bytes)` passes whether or not the mask path ran at all, and the
  // first version of this suite had a test doing precisely that: it fed a mask covering the whole
  // crop, which the leak guard rejects on fill, and called the resulting match proof that the alpha
  // collapses to the rectangle. It proved nothing of the kind. `maskVerdicts` is what makes the two
  // distinguishable, so it is asserted alongside the bytes every time.
  it("a mask that fills its region composites byte-for-byte the same as no mask at all", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, 200);
    const fillsRegion = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left &&
        x < within.left + within.width &&
        y >= within.top &&
        y < within.top + within.height,
    );

    const withoutMask = await pasteBack(frame, [{ plan, patchBytes }]);
    const withMask = await pasteBack(frame, [
      { plan, patchBytes, masks: [fillsRegion] },
    ]);

    // The mask really was applied — not quietly thrown away, which would make the match meaningless.
    expect(withMask.maskVerdicts).toEqual(["used"]);
    expect(withoutMask.maskVerdicts).toEqual(["off"]);
    // BYTES, not pixels. A pixel-level comparison would let an encoder difference hide inside
    // "close enough", and the claim here is exact.
    expect(withMask.bytes.equals(withoutMask.bytes)).toBe(true);
  });

  it("a mask covering the whole crop is rejected, and falls back", async () => {
    // NOT an identity proof — this one is about the guard. A mask that has taken the entire crop is
    // the garment≈background failure, and the fallback is what makes that survivable.
    //
    // The verdict is "overreach" rather than "crop_fill" because overreach is evaluated FIRST and a
    // crop-spanning mask trips both. Pinned as the reason it actually gives, not the one the shape
    // suggests: a test asserting the tidier-sounding answer would be asserting the wrong mechanism.
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, 200);
    const allOn = await maskBytesFor(plan, () => true);

    const withoutMask = await pasteBack(frame, [{ plan, patchBytes }]);
    const withUniform = await pasteBack(frame, [
      { plan, patchBytes, masks: [allOn] },
    ]);

    expect(withUniform.maskVerdicts).toEqual(["overreach"]);
    expect(withUniform.bytes.equals(withoutMask.bytes)).toBe(true);
  });

  it("an unreadable mask falls back rather than failing the composite", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, 200);

    const withoutMask = await pasteBack(frame, [{ plan, patchBytes }]);
    const withGarbage = await pasteBack(frame, [
      { plan, patchBytes, masks: [Buffer.from("this is not an image")] },
    ]);
    // Unreadable is indistinguishable from never-offered by design: both are "off".
    expect(withGarbage.maskVerdicts).toEqual(["off"]);
    expect(withGarbage.bytes.equals(withoutMask.bytes)).toBe(true);
  });
});

// ─── ② The mask only ever subtracts ────────────────────────────────────────────────────────────

describe("the mask can only subtract from the rectangle, never add to it", () => {
  it("a mask covering the WHOLE crop still changes nothing outside the region", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const patchBytes = await flatPatch(plan, 200);
    // Deliberately the leak case in shape but not in verdict — trimmed just enough to pass the
    // guard, so what is under test here is the geometry and not the guard rejecting it for us.
    const within = regionWithinCrop(plan);
    const generous = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left - 20 &&
        x < within.left + within.width + 20 &&
        y >= within.top - 20 &&
        y < within.top + within.height + 20,
    );

    const out = await pasteBack(frame, [
      { plan, patchBytes, masks: [generous] },
    ]);
    expect(out.maskVerdicts).toEqual(["used"]);
    const d = await decode(out.bytes);

    // One pixel outside the region on each side, where the generous mask WOULD have reached.
    expect(at(d, r.left - 5, r.top + 10)).toBe(40);
    expect(at(d, r.left + r.width + 5, r.top + 10)).toBe(40);
    expect(at(d, r.left + 10, r.top - 5)).toBe(40);
    expect(at(d, r.left + 10, r.top + r.height + 5)).toBe(40);
  });

  it("a half mask leaves the unmasked half of the region untouched", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, 200);
    // The left half of the region only.
    const half = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left &&
        x < within.left + within.width / 2 &&
        y >= within.top &&
        y < within.top + within.height,
    );

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [half] }]);
    expect(out.maskVerdicts).toEqual(["used"]);
    const d = await decode(out.bytes);

    // Deep inside the masked half: fully the patch.
    expect(at(d, r.left + 60, r.top + 200)).toBe(200);
    // Deep inside the UNMASKED half of the same rectangle: still exactly the original.
    expect(at(d, r.left + 350, r.top + 200)).toBe(40);
  });
});

// ─── ③ min, not multiply ───────────────────────────────────────────────────────────────────────

describe("the two alphas combine with min, not by multiplying", () => {
  it("at a pixel where both ramps are partial, the result is the smaller — not the product", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 0);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, 255);
    const radius = featherRadiusFor(r);

    // A mask edge running PARALLEL to the rectangle's left edge and 4px inside it, so both ramps
    // are live in the same band. Everything else in the rectangle is on.
    const EDGE = 4;
    const mask = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left + EDGE &&
        x < within.left + within.width &&
        y >= within.top &&
        y < within.top + within.height,
    );

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [mask] }]);
    expect(out.maskVerdicts).toEqual(["used"]);
    const d = await decode(out.bytes);

    // Recompute both alphas with the same pure functions the composite uses, rather than hardcoding
    // — the test is about how they COMBINE, and pinning their individual values here would make it
    // fail for unrelated reasons the moment a ramp constant moves.
    const rectRow = Buffer.alloc(within.width * within.height);
    for (let y = 0; y < within.height; y++) {
      for (let x = 0; x < within.width; x++)
        rectRow[y * within.width + x] = x >= EDGE ? 255 : 0;
    }
    // The MASK's edge is its own — `maskEdgeFor`, not the rectangle's `radius`. Recomputed from the
    // same function the composite calls so this stays a test about how the two alphas COMBINE.
    const edge = maskEdgeFor(r, plan, segmentLongEdgePx());
    const m = maskAlpha(
      rectRow,
      within.width,
      within.height,
      edge.erode,
      edge.ramp,
    );

    // PX sits where BOTH ramps are still partial. It was 8, which worked while the mask carried the
    // rectangle's 12px ramp; the mask's own ramp is 4px wide now, so 8 is past it and the point
    // stopped discriminating — the guard below caught exactly that. 5 is inside both.
    const PX = 5,
      PY = 200;
    const i = PY * within.width + PX;
    const dy = Math.min(PY + 0.5, within.height - 0.5 - PY);
    const dist = Math.min(PX + 0.5, within.width - 0.5 - PX, dy);
    const rectA = dist >= radius ? 255 : Math.round((dist / radius) * 255);

    const expectedMin = Math.min(m[i], rectA);
    const wouldBeProduct = Math.round((m[i] * rectA) / 255);

    // THE TEST POINT MUST DISCRIMINATE. If these ever coincide the assertion below is vacuous and
    // would pass under the rule it exists to rule out, so that is asserted first.
    expect(expectedMin).not.toBe(wouldBeProduct);
    expect(at(d, r.left + PX, r.top + PY)).toBe(expectedMin);
  });
});

describe("the hard-paste mode keeps its exactness claim", () => {
  it("applies the mask with NO ramp when feathering is off", async () => {
    // `feather: false` claims "inside the regions is the patch, exactly". A ramp would make the
    // boundary pixels neither the patch nor the original, which is the one thing that mode exists
    // to rule out. The mask still SHAPES the paste — it just does so with a hard edge.
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, 200);
    const half = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left &&
        x < within.left + within.width / 2 &&
        y >= within.top &&
        y < within.top + within.height,
    );

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [half] }], {
      feather: false,
    });
    expect(out.maskVerdicts).toEqual(["used"]);
    const d = await decode(out.bytes);

    // Every pixel across the mask's own boundary is one or the other, never a blend of the two.
    const mid = Math.round(r.top + r.height / 2);
    for (let x = r.left + 190; x < r.left + 210; x++) {
      expect([40, 200]).toContain(at(d, x, mid));
    }
  });
});

// ─── The pure pieces ───────────────────────────────────────────────────────────────────────────

describe("distanceToOutside", () => {
  it("does not treat the buffer's own border as outside", () => {
    // The load-bearing case: a garment running to the edge of its rectangle must not be eroded
    // there, because the rectangle's own edge is already handled by featherAlpha and min() combines
    // them. Seeding the border as outside would inset the same edge twice.
    const all = Buffer.alloc(10 * 10, 255);
    const d = distanceToOutside(all, 10, 10);
    expect(Math.min(...Array.from(d))).toBeGreaterThan(4);
  });

  it("measures chessboard distance to the nearest off pixel", () => {
    const m = Buffer.alloc(9 * 9, 255);
    m[4 * 9 + 4] = 0; // one hole in the middle
    const d = distanceToOutside(m, 9, 9);
    expect(d[4 * 9 + 4]).toBe(0);
    expect(d[4 * 9 + 5]).toBe(1);
    expect(d[4 * 9 + 6]).toBe(2);
    expect(d[(4 + 1) * 9 + 5]).toBe(1); // diagonal is distance 1, not 2
  });
});

describe("maskAlpha — erode then ramp, entirely inside the garment", () => {
  it("is zero out to the erode depth and full at erode + ramp", () => {
    const w = 40,
      h = 40;
    const m = Buffer.alloc(w * h);
    for (let y = 10; y < 30; y++)
      for (let x = 10; x < 30; x++) m[y * w + x] = 255;
    const a = maskAlpha(m, w, h, 2, 4);

    expect(a[15 * w + 10]).toBe(0); // the mask's own boundary — eaten by the erode
    expect(a[15 * w + 11]).toBe(0); // still inside the erode depth
    expect(a[15 * w + 16]).toBe(255); // well past erode + ramp
    const mid = a[15 * w + 14];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
  });

  it("never puts a non-zero alpha on a pixel that was outside the mask", () => {
    const w = 30,
      h = 30;
    const m = Buffer.alloc(w * h);
    for (let y = 10; y < 20; y++)
      for (let x = 10; x < 20; x++) m[y * w + x] = 255;
    const a = maskAlpha(m, w, h, 2, 6);
    for (let i = 0; i < m.length; i++) if (m[i] < 128) expect(a[i]).toBe(0);
  });
});

// ─── The seam fix: the mask edge is sized by the MASK, not by the rectangle ────────────────────

describe("maskUpscaleFor counts both downscales", () => {
  const plan = (
    crop: [number, number],
    send: [number, number],
    downscaled: boolean,
  ): PlannedCrop => ({
    regions: [region()],
    crop: { left: 0, top: 0, width: crop[0], height: crop[1] },
    send: { width: send[0], height: send[1] },
    downscaled,
  });

  it("is exactly 1 when the crop is already under the probe edge — withoutEnlargement", () => {
    // A shoe's crop is 622x582. It is never blown up to 1024, so nothing is lost and the mask comes
    // back at native resolution. This is why a small garment gets the SMALLEST edge, not the largest.
    expect(maskUpscaleFor(plan([622, 582], [622, 582], false), 1024)).toBe(1);
  });

  it("is the crop's long edge over the probe edge for a large crop", () => {
    expect(
      maskUpscaleFor(plan([4000, 6000], [4000, 6000], false), 1024),
    ).toBeCloseTo(6000 / 1024, 5);
  });

  it("never returns NaN for a malformed probe edge — that would silently empty the mask", () => {
    // segmentLongEdgePx is Number(process.env...), so a typo yields NaN. NaN would flow through the
    // erode and ramp into maskAlpha, where every alpha rounds to 0 and the region keeps the
    // ORIGINAL with no error logged anywhere.
    for (const bad of [NaN, 0, -1]) {
      const u = maskEdgeUncertaintyFor(
        plan([4000, 6000], [4000, 6000], false),
        bad,
      );
      expect(Number.isFinite(u)).toBe(true);
      expect(u).toBeGreaterThanOrEqual(1);
      expect(u).toBeLessThanOrEqual(MAX_MASK_EDGE_UNCERTAINTY_PX);
    }
  });

  it("counts the SEND downscale too, which happens before the segmenter ever sees the crop", () => {
    // studio/generate.ts hands maskForCrop the same buffer cropFrame produced, so a crop that was
    // downscaled to `send` was already smaller than `crop`. Missing this understates the
    // uncertainty on exactly the crops that have the most of it.
    const p = plan([4000, 6000], [2000, 3000], true);
    expect(maskUpscaleFor(p, 1024)).toBeCloseTo(6000 / 1024, 5);
    // ...and it is strictly worse than the same crop sent at full size would have been.
    expect(maskUpscaleFor(p, 4096)).toBeGreaterThan(
      maskUpscaleFor(plan([4000, 6000], [4000, 6000], false), 4096),
    );
  });
});

describe("maskEdgeUncertaintyFor tracks the measured round-trip error", () => {
  const at = (crop: [number, number]): number =>
    maskEdgeUncertaintyFor(
      {
        regions: [region()],
        crop: { left: 0, top: 0, width: crop[0], height: crop[1] },
        send: { width: crop[0], height: crop[1] },
        downscaled: false,
      },
      1024,
    );

  // The probe round trip was measured at three scales — max boundary error 1.0px at 1.0x, 2.0px at
  // 2.15x, 2.4px at 5.86x. These are those three points. The rule must never sit UNDER the
  // measurement, which is the direction that would put a hard step back at the boundary.
  it("is 1px on a crop that was never downscaled", () => {
    expect(at([622, 582])).toBe(1);
  });
  it("is 2px on a jersey crop at ~2.15x", () => {
    expect(at([1800, 2200])).toBe(2);
  });
  it("is 3px on a whole frame at ~5.9x", () => {
    expect(at([4000, 6000])).toBe(3);
  });
  it("never exceeds the measured worst case, however large the crop", () => {
    expect(at([20000, 30000])).toBe(MAX_MASK_EDGE_UNCERTAINTY_PX);
  });
});

describe("the default probe edge — what it buys, and why it stops at 1280", () => {
  const frame = { width: 4000, height: 6000 };
  const planFor = (r: EditRegion) => planCrops([r], frame)[0];

  it("probes the reported rim job's crop at NATIVE size, so its erode is 0", () => {
    // The real geometry behind the white rim on a recolour: 588x582 on a 4000x6000 frame pads to a
    // 1176x1164 crop. At 1024 that was a 1.148x resample charged the same 2px erode as a 4x one —
    // 2px of untouched ORIGINAL garment left around the edited one, which is what read as the rim.
    const r = region({ left: 1652, top: 3546, width: 588, height: 582 });
    const plan = planFor(r);
    expect([plan.crop.width, plan.crop.height]).toEqual([1176, 1164]);
    expect(maskEdgeUncertaintyFor(plan, segmentLongEdgePx())).toBe(1);
    expect(maskEdgeFor(r, plan, segmentLongEdgePx())).toEqual({
      erode: 0,
      ramp: 3,
    });
  });

  it("still holds a band on a jacket crop, which is the one case that changed", () => {
    // 3672x4518 is still resampled (3.53x), just less, so it moves "3+9" -> "2+6" rather than to 0.
    // Measured on d149d83f: the only ring that changes state is a mixed garment-edge pixel going
    // from untouched to 17% edited. No clean background pixel moves.
    const r = region({ left: 1244, top: 2664, width: 1836, height: 2364 });
    const plan = planFor(r);
    expect([plan.crop.width, plan.crop.height]).toEqual([3672, 4518]);
    expect(maskEdgeFor(r, plan, segmentLongEdgePx())).toEqual({
      erode: 2,
      ramp: 6,
    });
  });

  it("keeps the inversion arm's margin at 3px — the reason this stops at 1280", () => {
    // ⚠️ THIS TEST IS THE 1536 CAUTION, PINNED. On preserve-inside the mask is HER and the erode is
    // what keeps the new background off her outline. A whole-frame probe holds uncertainty 3 at
    // 1024 and at 1280, and drops to 2 at 1536 — trading a cosmetic rim on garments for edits
    // landing on her hair and skin. Raising the default past 1280 must fail here, not merely
    // contradict a comment.
    const whole = region({ left: 0, top: 0, width: 4000, height: 6000 });
    const plan = planFor(whole);
    expect(maskEdgeUncertaintyFor(plan, segmentLongEdgePx())).toBe(3);
    expect(maskEdgeUncertaintyFor(plan, 1536)).toBe(2);
    expect(
      maskEdgeFor(
        whole,
        plan,
        segmentLongEdgePx(),
        undefined,
        "preserve-inside",
      ).erode,
    ).toBe(3);
  });
});

describe("maskEdgeFor — the band stays put as the region grows. THIS IS THE BUG.", () => {
  const frame = { width: 4000, height: 6000 };
  const edgeOf = (w: number, h: number) => {
    const r = region({ left: 0, top: 0, width: w, height: h });
    return { r, edge: maskEdgeFor(r, planCrop([r], frame), 1024) };
  };

  it("does not track featherRadiusFor, which is what produced both reported artifacts", () => {
    // The rectangle's ramp spans 3 -> 120 across this range. That 40x swing IS the seam bug: at the
    // small end the transition became a hard step 2px inside the shoe, at the large end a 122px
    // smear across the subject's outline.
    const shoe = edgeOf(180, 110);
    const whole = edgeOf(4000, 6000);
    expect(featherRadiusFor(shoe.r)).toBe(3);
    expect(featherRadiusFor(whole.r)).toBe(120);
    expect(whole.edge.ramp).not.toBe(featherRadiusFor(whole.r));
    // Sized by the mask's own boundary, not by the rectangle: an order of magnitude below the 120px
    // cross-fade that smeared the subject's outline, while still hiding its own erode plateau.
    expect(whole.edge.ramp).toBeLessThan(featherRadiusFor(whole.r) / 10);
    expect(whole.edge.ramp).toBeGreaterThanOrEqual(
      whole.edge.erode * MASK_RAMP_TO_ERODE,
    );
  });

  const SIZES: [number, number][] = [
    [180, 110],
    [260, 150],
    [140, 260],
    [520, 380],
    [900, 1100],
    [4000, 6000],
  ];

  it("keeps the whole band within a few pixels from a shoe to a whole frame", () => {
    const bands = SIZES.map(([w, h]) => {
      const { edge } = edgeOf(w, h);
      return edge.erode + edge.ramp;
    });
    // Before the seam fix these were 5, 7, 6, 13, 29, 122 — a 24x swing.
    //
    // ⚠️ THE SPREAD WIDENED FROM 8 TO 9 AND THAT IS THE SMALL END IMPROVING, NOT THE BAND
    // DESTABILISING. A small garment's probe is never downscaled, so its uncertainty is 1, so its
    // erode is now 0 — its band went 1+3=4 to 0+3=3. The large end is untouched (3+9=12). The
    // ceiling is the assertion that guards against the 122px blowup this test was written for, and
    // it has not moved.
    expect(Math.max(...bands) - Math.min(...bands)).toBeLessThanOrEqual(9);
    expect(Math.max(...bands)).toBeLessThanOrEqual(12);
  });

  // ─── SHARPNESS, NOT BAND WIDTH. THIS IS THE MEASURE THAT PREDICTS A VISIBLE SEAM. ───────────
  //
  // Sizing the ramp for boundary uncertainty alone shipped a visible dark rim at a jersey sleeve,
  // and the band-width metric called it an improvement: the narrow ramp showed LESS of the original
  // (1px darker-than-half against 13px) and looked far worse, because a crisp line reads where a
  // wide fade does not. These assert the thing that actually matters.

  it("never lets the erode's plateau be more than a quarter of the transition", () => {
    for (const [w, h] of SIZES) {
      const { edge } = edgeOf(w, h);
      expect(edge.ramp).toBeGreaterThanOrEqual(edge.erode * MASK_RAMP_TO_ERODE);
    }
  });

  it("bounds the alpha STEP between neighbouring pixels at every region size", () => {
    // The regression measured 48/px of pixel value at a jersey sleeve, against 8/px before it. In
    // alpha terms the step is 255/ramp, so the ramp floor is what bounds it.
    for (const [w, h] of SIZES) {
      const { edge } = edgeOf(w, h);
      const W = Math.max(edge.erode + edge.ramp + 6, 32);
      const mask = Buffer.alloc(W * 3, 255);
      for (let y = 0; y < 3; y++) mask[y * W] = 0;
      const a = maskAlpha(mask, W, 3, edge.erode, edge.ramp);
      let step = 0;
      for (let d = 1; d < W - 2; d++)
        step = Math.max(step, Math.abs(a[W + d + 1] - a[W + d]));
      expect(step).toBeLessThanOrEqual(Math.ceil(255 / MASK_RAMP_TO_ERODE));
    }
  });

  it("gives a jersey a 6px ramp, not the 4px that showed a dark rim at the sleeve", () => {
    // The exact case that regressed, pinned by its numbers.
    const { edge } = edgeOf(900, 1100);
    expect(edge.erode).toBe(2);
    expect(edge.ramp).toBe(6);
  });

  it("leaves small garments' RAMP untouched — they already satisfied that rule", () => {
    // The end that motivated narrowing the ramp must not be widened to repair the other end. The
    // ramp is still 3 for both; only the erode moved, and it moved to 0 for the reason in
    // `defaultErodeFor` — an un-downscaled probe has 1px of boundary uncertainty, and eroding by it
    // was leaving the rim of original garment this suite already tried to remove once.
    const shoe = edgeOf(180, 110).edge;
    const sock = edgeOf(140, 260).edge;
    expect(shoe).toEqual({ erode: 0, ramp: 3 });
    expect(sock).toEqual({ erode: 0, ramp: 3 });
  });

  it("erodes 0px on a small garment — the rim of the original that read as an outline", () => {
    // ─── THIS ASSERTION HAS NOW MOVED TWICE, FOR THE SAME REASON BOTH TIMES ────────────────────
    //
    // It read "erodes 1px, not 2" and it was pinning an INTENDED PROPERTY rather than an incidental
    // number: the erode should be as small as the boundary allows, because what it leaves behind is
    // a ring of ORIGINAL garment around the edited one. 2px → 1px removed half of that ring and the
    // rim was still reported.
    //
    // Measured (see `defaultErodeFor`): at erode 1 the outermost ring receives essentially no edit
    // — 0.5 against a deep interior of 32.3 on fabric, 0.6 against 43.6 on hair. Erode 0 lifts it
    // 15x and 33x, and spill outside the contour stays at exactly 0.000%. So the intent is
    // unchanged and the value follows the measurement to its floor.
    //
    // ⚠️ SMALL GARMENT SPECIFICALLY. A whole-frame probe is downscaled, its uncertainty is 2 or 3,
    // and it keeps the derived erode — that case is unmeasured. And the INVERSION arm keeps it at
    // every size, because there the erode protects her outline rather than trimming a garment's.
    expect(edgeOf(180, 110).edge.erode).toBe(0);
  });

  it("always leaves a real gradient rather than a step", () => {
    // MASK_ANTIALIAS_PX exists because maskAlpha only produces intermediate values strictly between
    // erode and erode + ramp: a 1px ramp is a hard edge with extra arithmetic.
    for (const [w, h] of [
      [180, 110],
      [900, 1100],
      [4000, 6000],
    ] as [number, number][]) {
      expect(edgeOf(w, h).edge.ramp).toBeGreaterThanOrEqual(MASK_ANTIALIAS_PX);
    }
  });

  it("puts the ceiling on the BAND, so a tiny region is not swallowed", () => {
    // The ceiling maskErodeFor was documented as providing and never did. On a 20px region a
    // quarter is 5, and erode + ramp must fit inside it.
    const r = region({ left: 0, top: 0, width: 20, height: 20 });
    const edge = maskEdgeFor(r, planCrop([r], frame), 1024);
    expect(edge.erode + edge.ramp).toBeLessThanOrEqual(Math.floor(20 / 4));
  });

  it("honours an explicit erode override, and the ramp FOLLOWS it", () => {
    // The ramp used to be independent of the erode, which is precisely the bug: a bigger plateau
    // with the same fade over it is a more visible rim, not a less visible one. An override that
    // widened the plateau without widening the fade would reintroduce it by hand.
    const r = region({ left: 0, top: 0, width: 900, height: 1100 });
    const plan = planCrop([r], frame);
    const derived = maskEdgeFor(r, plan, 1024);
    const forced = maskEdgeFor(r, plan, 1024, 5);
    expect(derived).toEqual({ erode: 2, ramp: 6 });
    expect(forced.erode).toBe(5);
    expect(forced.ramp).toBe(15);
    expect(forced.ramp).toBeGreaterThanOrEqual(
      forced.erode * MASK_RAMP_TO_ERODE,
    );
  });
});

describe("maskErodeFor mirrors featherRadiusFor's ceiling", () => {
  it("takes the asked-for depth on a region with room for it", () => {
    expect(maskErodeFor({ width: 400, height: 400 }, 2)).toBe(2);
  });
  it("does not eat a small region alive", () => {
    // A 6px sock: a quarter of the shorter side is 1, so that is all the erode gets.
    expect(maskErodeFor({ width: 6, height: 6 }, 3)).toBe(1);
  });
  it("never goes negative", () => {
    expect(maskErodeFor({ width: 2, height: 2 }, 3)).toBe(0);
  });
});

// ─── The leak guard ────────────────────────────────────────────────────────────────────────────

describe("the leak guard is geometric, and never reads a confidence score", () => {
  const crop = { width: 200, height: 200 };
  const paint = (on: (x: number, y: number) => boolean) => {
    const b = Buffer.alloc(crop.width * crop.height);
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        b[y * crop.width + x] = on(x, y) ? 255 : 0;
    return b;
  };

  // ─── EACH CASE CARRIES ITS OWN RECTANGLE, AND THAT IS NOT TEST-WRITING CONVENIENCE ────────────
  //
  // The two guards bite at genuinely different region-to-crop ratios, and overreach is evaluated
  // FIRST. A mask big enough to trip `crop_fill` around a SMALL rectangle trips `overreach` on the
  // way there and never reaches the fill check — so a shared rectangle cannot demonstrate both, and
  // one of the two assertions would be passing for the wrong reason. Sizing each rectangle for the
  // signal it is isolating is what makes these tests say what they claim to.
  it("passes a mask that sits inside its rectangle", () => {
    const within = { left: 50, top: 50, width: 100, height: 100 };
    const m = paint((x, y) => x >= 60 && x < 140 && y >= 60 && y < 140);
    const g = maskGeometryFor(m, crop, within);
    expect(g.overreach).toBe(0);
    expect(maskLeakReason(g, LIMITS)).toBeNull();
  });

  it("passes a garment that legitimately continues past a tight box", () => {
    // The ordinary case the guard must NOT reject: a jersey whose detection box stopped at the
    // waist, continuing into the crop's context padding. If this ever starts failing, the feature
    // has been tuned into rejecting exactly the masks it exists to produce.
    const within = { left: 50, top: 50, width: 100, height: 100 };
    const m = paint((x, y) => x >= 45 && x < 155 && y >= 45 && y < 175);
    const g = maskGeometryFor(m, crop, within);
    expect(g.overreach).toBeGreaterThan(0);
    expect(maskLeakReason(g, LIMITS)).toBeNull();
  });

  it("catches a mask that has run far past its rectangle", () => {
    // A small rectangle, so overreach is the signal that fires and the fill stays modest (0.3).
    const within = { left: 70, top: 70, width: 60, height: 60 };
    const m = paint((x, y) => x >= 0 && x < 200 && y >= 70 && y < 130);
    const g = maskGeometryFor(m, crop, within);
    expect(g.fillOfCrop).toBeLessThan(LIMITS.maxCropFill);
    expect(maskLeakReason(g, LIMITS)).toBe("overreach");
  });

  it("catches the garment-is-the-background case that overreach cannot see", () => {
    // A LARGE rectangle, so the mask can take almost the whole crop while staying well inside the
    // overreach margin — which is precisely the blind spot the second guard exists to cover.
    const within = { left: 20, top: 20, width: 160, height: 160 };
    const m = paint((x, y) => !(x < 4 || y < 4 || x > 195 || y > 195));
    const g = maskGeometryFor(m, crop, within);
    expect(g.overreach).toBeLessThan(LIMITS.maxOverreach);
    expect(g.fillOfCrop).toBeGreaterThan(LIMITS.maxCropFill);
    expect(maskLeakReason(g, LIMITS)).toBe("crop_fill");
  });

  it("treats the overreach margin as inclusive — a mask exactly at it is kept", () => {
    // Pinned because it was found by a fixture landing on the boundary by accident. The margin is
    // "may exceed by half", so half is allowed; a mask a pixel past it is not.
    const within = { left: 50, top: 50, width: 100, height: 100 };
    const exactly = maskGeometryFor(
      paint((x, y) => x >= 0 && x < 200 && y >= 60 && y < 140),
      crop,
      within,
    );
    expect(exactly.overreach).toBeCloseTo(0.5, 5);
    expect(maskLeakReason(exactly, LIMITS)).toBeNull();
  });

  it("calls an empty mask empty rather than dividing by nothing", () => {
    const within = { left: 50, top: 50, width: 100, height: 100 };
    const g = maskGeometryFor(
      paint(() => false),
      crop,
      within,
    );
    expect(g.bbox).toBeNull();
    expect(g.fillOfCrop).toBe(0);
    expect(maskLeakReason(g, LIMITS)).toBe("empty");
  });
});

// ─── The three numbers that tell one rejection from another ────────────────────────────────────

describe("maskShapeStats separates the failures that overreach alone conflates", () => {
  const crop = { width: 751, height: 663 };
  const geo = (
    bbox: { left: number; top: number; width: number; height: number } | null,
    maskPx: number,
  ) => ({
    bbox,
    fillOfCrop: maskPx / (crop.width * crop.height),
    overreach: 0,
  });

  it("reads a CLEAN MASK OF THE WRONG INSTANCE — solid, smaller than its region, yet overreaching", () => {
    // The real run this came from: two socks detected as two regions, merged into one crop, SAM
    // returned ONE instance mask, and it was scored against BOTH rectangles — 0.00 against its own
    // sock and 1.21 against the other one. The mask was excellent. Nothing about overreach or
    // fillOfCrop could say so.
    const stats = maskShapeStats(
      geo({ left: 376, top: 261, width: 117, height: 230 }, 15558),
      crop,
      { width: 107, height: 295 },
    );
    expect(stats.bbox).toBe("117x230@376,261");
    expect(stats.solidity).toBeCloseTo(0.578, 2); // solid — not fragments
    expect(stats.maskVsRegion).toBeCloseTo(0.49, 2); // smaller than its region — not over-inclusive
  });

  it("reads a FRAGMENTED mask — a huge bbox holding almost nothing", () => {
    // One small blob plus a stray far away: the bbox spans them both, the pixel count does not.
    const stats = maskShapeStats(
      geo({ left: 10, top: 10, width: 400, height: 400 }, 1200),
      crop,
      { width: 107, height: 295 },
    );
    expect(stats.solidity).toBeLessThan(0.05);
  });

  it("reads an OVER-INCLUSIVE mask — the sock plus the leg", () => {
    const stats = maskShapeStats(
      geo({ left: 300, top: 100, width: 160, height: 520 }, 62000),
      crop,
      { width: 107, height: 295 },
    );
    expect(stats.solidity).toBeGreaterThan(0.5); // solid, so not fragments
    expect(stats.maskVsRegion).toBeGreaterThan(1); // and bigger than what it was refining
  });

  it("survives an empty mask without dividing by zero", () => {
    expect(
      maskShapeStats(geo(null, 0), crop, { width: 107, height: 295 }),
    ).toEqual({
      bbox: null,
      solidity: null,
      maskVsRegion: 0,
    });
  });

  it("does not divide by zero on a degenerate region", () => {
    expect(
      maskShapeStats(
        geo({ left: 0, top: 0, width: 10, height: 10 }, 50),
        crop,
        { width: 0, height: 0 },
      ).maskVsRegion,
    ).toBe(0);
  });
});

// ─── THE PAIRED-GARMENT BUG, AT THE REAL FRAME'S GEOMETRY ──────────────────────────────────────
//
// Numbers taken from the live run this fix came from: a 1008x1476 frame, two socks detected as two
// regions, merged by planCrops into ONE 751x663 crop. Before per-region masks, one probe of that
// crop returned ONE instance mask, and pasteBack scored it against BOTH rectangles — 0.000 against
// its own sock, 1.215 against the other. The second was discarded for "overreach", fell back to its
// RECTANGLE, and the rectangle re-rendered her leg.

describe("two same-target instances in one merged crop", () => {
  const FRAME = { width: 1008, height: 1476 };
  const SOCK_A: EditRegion = {
    label: "adidas socks",
    left: 345,
    top: 1089,
    width: 107,
    height: 295,
    samNoun: "socks",
  };
  const SOCK_B: EditRegion = {
    label: "adidas socks",
    left: 464,
    top: 1069,
    width: 120,
    height: 239,
    samNoun: "socks",
  };

  /** A sock-shaped mask INSIDE a region — narrower than its rectangle, so the gap is testable. */
  async function sockMask(
    plan: PlannedCrop,
    region: EditRegion,
  ): Promise<Buffer> {
    const w = regionWithinCrop(plan, region);
    return maskBytesFor(
      plan,
      (x, y) =>
        x >= w.left + 25 &&
        x < w.left + w.width - 25 &&
        y >= w.top + 20 &&
        y < w.top + w.height - 20,
    );
  }

  it("merges into one crop — the premise of the bug", () => {
    const plans = planCrops([SOCK_A, SOCK_B], FRAME);
    expect(plans).toHaveLength(1);
    expect(plans[0].regions).toHaveLength(2);
    expect(plans[0].crop.width).toBe(751);
    expect(plans[0].crop.height).toBe(663);
  });

  it("BOTH socks get their own mask, and NEITHER falls back to its rectangle", async () => {
    const plan = planCrops([SOCK_A, SOCK_B], FRAME)[0];
    const frame = await flatFrame(FRAME.width, FRAME.height, 40);
    const patchBytes = await flatPatch(plan, 200);
    const masks = [await sockMask(plan, SOCK_A), await sockMask(plan, SOCK_B)];

    const out = await pasteBack(frame, [{ plan, patchBytes, masks }]);

    // THE ASSERTION THAT BITES. Pre-fix this was ["overreach", "used"].
    expect(out.maskVerdicts).toEqual(["used", "used"]);

    const d = await decode(out.bytes);
    for (const r of [SOCK_A, SOCK_B]) {
      // Inside the sock: the edit landed.
      expect(
        at(
          d,
          r.left + Math.floor(r.width / 2),
          r.top + Math.floor(r.height / 2),
        ),
      ).toBe(200);
      // Inside the RECTANGLE but outside the sock — her leg. A rectangle fallback would have
      // re-rendered this; a mask leaves it exactly as it was. This is the distortion, in one pixel.
      expect(at(d, r.left + 5, r.top + Math.floor(r.height / 2))).toBe(40);
    }
  });

  it("still fails the old way when ONE mask is shared by both regions", async () => {
    // The pre-fix arrangement, kept as a test rather than as a memory: one mask for the crop. It is
    // a perfectly good mask of sock B, and against sock A's rectangle it reads as overreach — so A
    // is discarded and takes its rectangle, which is the leg.
    const plan = planCrops([SOCK_A, SOCK_B], FRAME)[0];
    const frame = await flatFrame(FRAME.width, FRAME.height, 40);
    const patchBytes = await flatPatch(plan, 200);
    const onlyB = await sockMask(plan, SOCK_B);

    const out = await pasteBack(frame, [
      { plan, patchBytes, masks: [onlyB, onlyB] },
    ]);
    expect(out.maskVerdicts).toEqual(["overreach", "used"]);

    // And this is the damage: sock A's whole rectangle was pasted, including her leg.
    const d = await decode(out.bytes);
    expect(
      at(d, SOCK_A.left + 5, SOCK_A.top + Math.floor(SOCK_A.height / 2)),
    ).toBe(200);
  });
});

describe("a USED mask records its own geometry, not only a discarded one", () => {
  // ─── WHY THIS IS ASSERTED AND NOT JUST LOGGED ──────────────────────────────────────────────
  //
  // The shape fields were produced only when a mask was thrown away, so a composite that SUCCEEDED
  // recorded nothing but the word "used". Measured cost of that gap: a mask-geometry investigation
  // had to re-derive solidity and fillOfCrop out of band, against a saved mask, because the
  // successful runs recorded none of it. This pins that the next such question is answerable.
  it("returns the shape of a mask it used", async () => {
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const within = regionWithinCrop(plan);
    const patchBytes = await flatPatch(plan, 200);
    // Half the region — a real shape, comfortably inside the leak guard's limits.
    const half = await maskBytesFor(
      plan,
      (x, y) =>
        x >= within.left &&
        x < within.left + within.width / 2 &&
        y >= within.top &&
        y < within.top + within.height,
    );

    const out = await pasteBack(frame, [{ plan, patchBytes, masks: [half] }]);
    expect(out.maskVerdicts).toEqual(["used"]);
    expect(out.maskStats).toHaveLength(1);
    expect(Object.keys(out.maskStats[0]).sort()).toEqual([
      "bbox",
      "maskVsRegion",
      "solidity",
    ]);
    // Not merely present — actually describing this mask. Half a region, so well under 1.
    expect(out.maskStats[0].maskVsRegion).toBeGreaterThan(0);
    expect(out.maskStats[0].maskVsRegion).toBeLessThan(1);
    expect(out.maskStats[0].bbox).not.toBeNull();
  });

  it("stays empty when every region composited on its rectangle", async () => {
    // Shorter than maskVerdicts by design: only USED masks appear, so an empty array is the honest
    // report that nothing was masked rather than a row of nulls to filter.
    const r = region();
    const frame = await flatFrame(1000, 1000, 40);
    const plan = planCrop([r], { width: 1000, height: 1000 });
    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 200) },
    ]);
    expect(out.maskVerdicts).toEqual(["off"]);
    expect(out.maskStats).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE ERODE DEFAULT, AND WHY IT IS 0 ON ONE ARM AND NOT THE OTHER
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("the erode default reaches the mask's own edge on a trusted boundary", () => {
  const frameSize = { width: 1000, height: 1000 };

  /**
   * Mean alpha at a given depth inside a mask, which is what the depth-band probe measured through
   * pixels. Asserting the RATIO between depths rather than any magnitude — a magnitude depends on
   * the patch, and the probe's patch was a synthetic hue-shift standing in for a model output.
   */
  function alphaAtDepth(
    erode: number,
    ramp: number,
    w: number,
    h: number,
  ): (d: number) => number {
    const mask = Buffer.alloc(w * h, 255);
    // A one-pixel border of "outside", so distance-to-outside is the depth.
    for (let x = 0; x < w; x++) {
      mask[x] = 0;
      mask[(h - 1) * w + x] = 0;
    }
    for (let y = 0; y < h; y++) {
      mask[y * w] = 0;
      mask[y * w + w - 1] = 0;
    }
    const a = maskAlpha(mask, w, h, erode, ramp);
    return (d: number) => a[d * w + Math.floor(w / 2)];
  }

  it("gives the outermost ring real coverage where erode 1 gave it almost none", () => {
    // ─── THE MEASUREMENT, AS A RATIO ───────────────────────────────────────────────────────────
    //
    // At erode 1 the 1px ring is fully transparent — it receives NO edit, which is the rim users
    // report. At erode 0 it carries real alpha. The probe measured 0.5 vs 32.3 (fabric) and 0.6 vs
    // 43.6 (hair) in pixel terms; this is the same fact in the alpha that causes it.
    const w = 60,
      h = 60;
    const withErode = alphaAtDepth(1, 3, w, h);
    const without = alphaAtDepth(0, 3, w, h);
    expect(withErode(1)).toBe(0);
    expect(without(1)).toBeGreaterThan(0);
    // And the interior is unaffected either way — this moves the edge, not the fill.
    expect(withErode(20)).toBe(255);
    expect(without(20)).toBe(255);
  });

  it("is 0 for a garment whose probe was never downscaled", () => {
    const r = region({ left: 0, top: 0, width: 180, height: 110 });
    expect(maskEdgeFor(r, planCrop([r], frameSize), 1024).erode).toBe(0);
  });

  it("KEEPS the derived erode where the boundary is uncertain — the unmeasured case", () => {
    // uncertainty > 1 only happens when the probe was downscaled, which is the whole-frame path.
    // The probe ran on a 480x640 frame with no downscale, so it says nothing here. Trusting a
    // boundary the system says may be off by 3px, in the direction of pixels nobody asked to edit,
    // is not a change this measurement supports.
    const big = region({ left: 0, top: 0, width: 4000, height: 6000 });
    const bigPlan = planCrop([big], { width: 4000, height: 6000 });
    expect(maskEdgeFor(big, bigPlan, 1024).erode).toBeGreaterThan(0);
    expect(maskEdgeFor(big, bigPlan, 1024).erode).toBe(
      maskEdgeUncertaintyFor(bigPlan, 1024),
    );
  });

  it("KEEPS the derived erode on the inversion arm at every size", () => {
    // ⚠️ THE ERODE MEANS THE OPPOSITE THING HERE. The mask is HER and it is inverted before use, so
    // the erode holds the new background off her outline. Reducing it would creep the edit into her
    // hair and skin — and the probe that justifies 0 measured edit-inside masks only. Found by this
    // change breaking backgroundMask.test.ts, not by reading the code.
    const r = region({ left: 0, top: 0, width: 180, height: 110 });
    const plan = planCrop([r], frameSize);
    expect(maskEdgeFor(r, plan, 1024, undefined, "edit-inside").erode).toBe(0);
    expect(maskEdgeFor(r, plan, 1024, undefined, "preserve-inside").erode).toBe(
      1,
    );
  });

  it("still honours STUDIO_MASK_ERODE_PX on both arms", () => {
    const r = region({ left: 0, top: 0, width: 900, height: 1100 });
    const plan = planCrop([r], { width: 4000, height: 6000 });
    expect(maskEdgeFor(r, plan, 1024, 5, "edit-inside").erode).toBe(5);
    expect(maskEdgeFor(r, plan, 1024, 5, "preserve-inside").erode).toBe(5);
    // An explicit 0 is a real value, not "unset" — the override must be able to say zero.
    expect(maskEdgeFor(r, plan, 1024, 0, "preserve-inside").erode).toBe(0);
  });

  it("cannot grow a mask at any erode value — the invariant, re-pinned", () => {
    // Spill outside the contour measured 0.000% at every erode value on both nouns. In code the
    // reason is that erode is an inset: alpha at depth 0 (outside) is 0 whatever the erode.
    for (const erode of [0, 1, 2, 5]) {
      expect(alphaAtDepth(erode, 3, 60, 60)(0)).toBe(0);
    }
  });
});
