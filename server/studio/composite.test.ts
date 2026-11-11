/**
 * composite.test.ts — the pixel-identity guarantee, proven rather than asserted.
 *
 * ─── THE STRONGEST FORM THE TEST CAN TAKE ───────────────────────────────────────────────────────
 *
 * The stand-in provider here is ADVERSARIAL: it perturbs EVERY pixel of the crop it is given —
 * worst-case round-trip drift — and overwrites the region on top. If the guarantee survives a
 * provider that changes everything it touches, it survives a real model, and it survives the next
 * model too. A well-behaved fake would prove nothing, because the property under test is that the
 * provider's behaviour DOES NOT MATTER outside the region.
 *
 * ─── PARITY IS ASSERTED BEFORE ANYTHING IS DIFFED ───────────────────────────────────────────────
 *
 * `diffOutside` throws on a channel or dimension mismatch rather than comparing. This is not
 * defensiveness: the first run of this proof reported 23,313,432 of 23,313,600 pixels differing at
 * max delta 255 — a near-total FALSE mismatch — because sharp's composite() promotes the pipeline to
 * RGBA and the comparison walked a 4-channel buffer at stride 3. A proof that assumes buffer
 * geometry can report a confident falsehood in EITHER direction, which is worse than no proof.
 *
 * Fixtures are synthetic and generated in-test — real image bytes encoded by sharp, not header
 * stubs, because the thing under test is what a decoder actually sees. No athlete pixels anywhere.
 */
import sharp from "sharp";
import {
  planCrop,
  planCrops,
  regionWithinCrop,
  cropFrame,
  pasteBack,
  CONTEXT_PAD_FACTOR,
  MIN_CONTEXT_PAD_PX,
  MAX_PATCH_PIXELS,
  JPEG_LADDER,
  featherRadiusFor,
  FEATHER_FRACTION,
  MIN_FEATHER_PX,
  coversMostOfFrame,
  MAX_EDIT_INSIDE_FRAME_SHARE,
  type PlannedCrop,
} from "./composite";
import type { EditRegion } from "./brief";

jest.setTimeout(120_000);

const region = (over: Partial<EditRegion> = {}): EditRegion => ({
  label: "remove the ball",
  left: 400,
  top: 700,
  width: 300,
  height: 200,
  ...over,
});

/**
 * A frame with real high-frequency detail. Flat colour would survive any encoder and would let a
 * broken implementation pass — the texture is what makes drift measurable.
 */
async function frameBytes(w: number, h: number, format: "jpeg" | "png" = "jpeg"): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 7 + y * 3) % 256;
      raw[i + 1] = ((x ^ y) * 5) % 256;
      raw[i + 2] = (x * 3 + y * 11) % 256;
    }
  }
  const p = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  return format === "png" ? p.png().toBuffer() : p.jpeg({ quality: 92 }).toBuffer();
}

/** Decoded pixels, alpha stripped, with the geometry that came with them. */
const decode = (b: Buffer) => sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });

/**
 * A FLAT frame, for the feather suite only.
 *
 * Everywhere else in this file texture is the point — it is what makes drift measurable. Here it
 * would be the opposite: the property under test is "what fraction of the patch is at this pixel",
 * and against two flat fields that fraction IS the pixel value, read directly with no inference. A
 * gradient would force the test to model the resampler to know what it should have seen.
 */
async function flatFrame(w: number, h: number, value: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3, value);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A patch of one flat colour at the crop's own size — the other end of every blend below. */
async function flatPatch(plan: PlannedCrop, value: number): Promise<Buffer> {
  const raw = Buffer.alloc(plan.crop.width * plan.crop.height * 3, value);
  return sharp(raw, { raw: { width: plan.crop.width, height: plan.crop.height, channels: 3 } })
    .png()
    .toBuffer();
}

/** One channel at one pixel of a decoded buffer. */
const at = (d: { data: Buffer; info: { width: number; channels: number } }, x: number, y: number) =>
  d.data[(y * d.info.width + x) * d.info.channels];

/**
 * THE ADVERSARY. Every pixel of the crop moves; the region is additionally painted flat. Returned at
 * a DIFFERENT resolution than it was given, because a real model does exactly that and the
 * paste-back has to resize it back itself.
 */
async function adversarialPatch(cropBytes: Buffer, scale = 1.7): Promise<Buffer> {
  const { data, info } = await sharp(cropBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i++) data[i] = data[i] ^ 0xff; // every single pixel, inverted
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
    .resize(Math.round(info.width * scale), Math.round(info.height * scale), { fit: "fill" })
    .png()
    .toBuffer();
}

/** Subpixels differing OUTSIDE the given rectangles, and the worst single difference. */
async function diffOutside(original: Buffer, result: Buffer, regions: EditRegion[]) {
  const a = await decode(original);
  const b = await decode(result);
  // BEFORE any comparison. See the header.
  if (a.info.channels !== b.info.channels) {
    throw new Error(`channel mismatch: ${a.info.channels} vs ${b.info.channels} — refusing to diff`);
  }
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    throw new Error(`dimension mismatch: ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
  }
  const ch = a.info.channels;
  const inside = (x: number, y: number) =>
    regions.some((r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height);

  let differing = 0;
  let max = 0;
  let insideChanged = 0;
  let insideMax = 0;
  let insideTotal = 0;
  for (let y = 0; y < a.info.height; y++) {
    for (let x = 0; x < a.info.width; x++) {
      const i = (y * a.info.width + x) * ch;
      if (inside(x, y)) {
        insideTotal += ch;
        for (let c = 0; c < ch; c++) {
          const d = Math.abs(a.data[i + c] - b.data[i + c]);
          if (d) {
            insideChanged++;
            // Tracked PER CHANNEL, so a caller can bound the magnitude of an inside change rather than only count
            // how many there were. A count alone cannot tell 8-bit rounding from real image drift.
            if (d > insideMax) insideMax = d;
          }
        }
        continue;
      }
      for (let c = 0; c < ch; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        if (d) {
          differing++;
          if (d > max) max = d;
        }
      }
    }
  }
  return { differing, max, insideChanged, insideMax, insideTotal, channels: ch };
}

/** One full turn of the pipeline against the adversary. */
async function runEdit(frame: Buffer, regions: EditRegion[], size: { width: number; height: number }) {
  const plans = planCrops(regions, size);
  const patches = [];
  for (const plan of plans) {
    patches.push({ plan, patchBytes: await adversarialPatch(await cropFrame(frame, plan)) });
  }
  return { plans, out: await pasteBack(frame, patches) };
}

// ─── The arithmetic ─────────────────────────────────────────────────────────────────────────────

describe("planCrop", () => {
  const frame = { width: 4000, height: 6000 };

  it("grows the region by the pad factor and always contains it", () => {
    const r = region({ left: 1000, top: 2000, width: 800, height: 600 });
    const { crop } = planCrop([r], frame);
    expect(crop.width).toBe(r.width * CONTEXT_PAD_FACTOR);
    expect(crop.height).toBe(r.height * CONTEXT_PAD_FACTOR);
    expect(crop.left).toBeLessThanOrEqual(r.left);
    expect(crop.top).toBeLessThanOrEqual(r.top);
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(r.left + r.width);
    expect(crop.top + crop.height).toBeGreaterThanOrEqual(r.top + r.height);
  });

  it("floors the pad so a small region still gets a real neighbourhood", () => {
    // 60px logo: a proportional pad would give 30px of context, which is nothing to match against.
    const r = region({ left: 1000, top: 2000, width: 60, height: 60 });
    const { crop } = planCrop([r], frame);
    expect(crop.width).toBe(60 + 2 * MIN_CONTEXT_PAD_PX);
    expect(crop.height).toBe(60 + 2 * MIN_CONTEXT_PAD_PX);
  });

  it("clamps at every corner without ever overflowing the frame", () => {
    for (const r of [
      region({ left: 0, top: 0, width: 200, height: 200 }),
      region({ left: 3800, top: 5800, width: 200, height: 200 }),
      region({ left: 0, top: 5800, width: 200, height: 200 }),
      region({ left: 3800, top: 0, width: 200, height: 200 }),
    ]) {
      const { crop } = planCrop([r], frame);
      expect(crop.left).toBeGreaterThanOrEqual(0);
      expect(crop.top).toBeGreaterThanOrEqual(0);
      expect(crop.left + crop.width).toBeLessThanOrEqual(frame.width);
      expect(crop.top + crop.height).toBeLessThanOrEqual(frame.height);
    }
  });

  it("keeps two far-apart regions as two tight crops — never one union box", () => {
    // The motivating plural edit: a logo on the ball and one on the sleeve, opposite corners. Their
    // union is 18.6 MP — the whole photograph, i.e. the re-render this feature exists to leave.
    const plans = planCrops(
      [region({ left: 100, top: 200, width: 300, height: 300 }), region({ left: 3600, top: 5500, width: 300, height: 300 })],
      frame,
    );
    expect(plans).toHaveLength(2);
    for (const p of plans) expect(p.crop.width * p.crop.height).toBeLessThan(1_000_000);
    expect(plans.some((p) => p.downscaled)).toBe(false);
  });

  /**
   * ─── THE MERGE: SAME TARGET, ONE CALL, WHERE THEY ARE ACTUALLY NEAR EACH OTHER ────────────────
   *
   * Two socks are one logical edit wearing two rectangles. Sending them as two calls pays twice to
   * say the same sentence about the same target, and the call count is the wall-clock bound on an
   * inline path (studio/config.ts maxEditCalls). So same-label regions share a crop — but ONLY while
   * their union stays tight, because a union grows to contain the gap between its members and a
   * merge across the frame rebuilds exactly the whole-photograph crop this module refuses.
   */
  describe("merging regions that name the same target", () => {
    it("merges two NEARBY same-target regions into one crop and one call", () => {
      const socks = [
        region({ label: "adidas socks", left: 1800, top: 4000, width: 200, height: 300 }),
        region({ label: "adidas socks", left: 2100, top: 4000, width: 200, height: 300 }),
      ];
      const plans = planCrops(socks, frame);
      expect(plans).toHaveLength(1);
      expect(plans[0].regions).toHaveLength(2);
      // The crop contains both rectangles, and is still a crop rather than the photograph.
      expect(plans[0].crop.left).toBeLessThanOrEqual(1800);
      expect(plans[0].crop.left + plans[0].crop.width).toBeGreaterThanOrEqual(2300);
      expect(plans[0].crop.width * plans[0].crop.height).toBeLessThan(0.25 * frame.width * frame.height);
    });

    it("does NOT merge same-target regions across the frame — that is the union box again", () => {
      const shoes = [
        region({ label: "adidas shoes", left: 100, top: 200, width: 300, height: 300 }),
        region({ label: "adidas shoes", left: 3600, top: 5500, width: 300, height: 300 }),
      ];
      const plans = planCrops(shoes, frame);
      expect(plans).toHaveLength(2);
      for (const p of plans) expect(p.regions).toHaveLength(1);
    });

    it("never merges DIFFERENT targets, however close they sit", () => {
      // Adjacent, and would union tightly — but they carry different changes, so one crop could only
      // be told one of them. Merging here would silently drop a change she asked for.
      const plans = planCrops(
        [
          region({ label: "red jersey", left: 1800, top: 3000, width: 200, height: 200 }),
          region({ label: "black shorts", left: 1800, top: 3220, width: 200, height: 200 }),
        ],
        frame,
      );
      expect(plans).toHaveLength(2);
      expect(plans.map((p) => p.regions[0].label)).toEqual(["red jersey", "black shorts"]);
    });

    it("turns the motivating request into far fewer calls than rectangles", () => {
      // "uniform, socks, shoes" — three targets, seven boxes, all near each other on one athlete.
      const seven = [
        region({ label: "adidas jersey", left: 1700, top: 1500, width: 600, height: 700 }),
        region({ label: "adidas jersey", left: 1750, top: 2250, width: 500, height: 400 }),
        region({ label: "adidas socks", left: 1750, top: 4000, width: 180, height: 300 }),
        region({ label: "adidas socks", left: 2050, top: 4000, width: 180, height: 300 }),
        region({ label: "adidas shoes", left: 1730, top: 4350, width: 200, height: 200 }),
        region({ label: "adidas shoes", left: 2040, top: 4350, width: 200, height: 200 }),
        region({ label: "adidas shoes", left: 1900, top: 4560, width: 150, height: 120 }),
      ];
      const plans = planCrops(seven, frame);
      expect(plans.length).toBeLessThanOrEqual(3);
      // Nothing is lost in the merge: every rectangle still belongs to exactly one crop.
      expect(plans.reduce((n, p) => n + p.regions.length, 0)).toBe(7);
    });

    it("is deterministic — the preview and the generate leg must plan the SAME crops", () => {
      // The quote is derived from the crop count on one side of the approval gate and the spend on
      // the other. A merge that depended on a search or on iteration order would quote one job and
      // run another.
      const regions = [
        region({ label: "a", left: 100, top: 100, width: 200, height: 200 }),
        region({ label: "b", left: 500, top: 100, width: 200, height: 200 }),
        region({ label: "a", left: 340, top: 100, width: 200, height: 200 }),
      ];
      const once = planCrops(regions, frame);
      const twice = planCrops(regions, frame);
      expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
      // Order of first appearance is preserved, so "a" (merged) comes before "b".
      expect(once.map((p) => p.regions[0].label)).toEqual(["a", "b"]);
    });
  });

  it("downscales an oversized crop instead of refusing it, preserving aspect", () => {
    // The band where geometry.ts warns but does not block. Degraded, never refused.
    const r = region({ left: 0, top: 0, width: 4000, height: 5000 });
    const plan = planCrop([r], frame);
    expect(plan.downscaled).toBe(true);
    expect(plan.send.width * plan.send.height).toBeLessThanOrEqual(MAX_PATCH_PIXELS);
    expect(plan.send.width / plan.send.height).toBeCloseTo(plan.crop.width / plan.crop.height, 2);
    // The crop itself is still stated in FRAME space — that is what the paste-back composites into.
    expect(plan.crop.width).toBe(4000);
  });

  it("sends a typical crop at its own resolution, untouched", () => {
    const plan = planCrop([region({ width: 780, height: 780 })], frame);
    expect(plan.downscaled).toBe(false);
    expect(plan.send).toEqual({ width: plan.crop.width, height: plan.crop.height });
  });

  it("places the region inside its own crop at the offset the paste-back will slice", () => {
    const r = region({ left: 1000, top: 2000, width: 300, height: 200 });
    const plan = planCrop([r], frame);
    const within = regionWithinCrop(plan);
    expect(within).toEqual({ left: r.left - plan.crop.left, top: r.top - plan.crop.top, width: 300, height: 200 });
    expect(within.left + within.width).toBeLessThanOrEqual(plan.crop.width);
    expect(within.top + within.height).toBeLessThanOrEqual(plan.crop.height);
  });
});

// ─── The guarantee ──────────────────────────────────────────────────────────────────────────────

describe("pasteBack — the guarantee", () => {
  const W = 1600;
  const H = 2400;
  const size = { width: W, height: H };

  it("leaves every pixel outside the region EXACTLY as it was, against an adversary", async () => {
    // PNG in, PNG out: lossless both ways, so this isolates OUR arithmetic from the container.
    const frame = await frameBytes(W, H, "png");
    const regions = [region({ left: 400, top: 700, width: 300, height: 200 })];
    const { out } = await runEdit(frame, regions, size);

    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.differing).toBe(0);          // ← the whole feature
    expect(d.max).toBe(0);
    expect(d.insideChanged).toBeGreaterThan(0);
    expect(out.width).toBe(W);
    expect(out.height).toBe(H);
  });

  /**
   * ─── THE MERGE MUST NOT COST THE GUARANTEE ───────────────────────────────────────────────────
   *
   * A merged crop covers TWO rectangles and the gap between them. The model re-renders that whole
   * crop — gap included — and the gap is pixels she never marked. If pasteBack composited the patch
   * rather than the rectangles, the merge would quietly import the model's drift into the space
   * between two socks, and the "outside the regions is the original" claim would become false for
   * exactly the edits this change was built to enable.
   *
   * The adversarial patch differs everywhere, so any leak from the gap shows up as a non-zero diff.
   */
  it("leaves the GAP INSIDE a merged crop exactly as it was", async () => {
    const frame = await frameBytes(W, H, "png");
    // Same label ⇒ one crop. Close enough that the union stays well under the merge budget.
    const regions = [
      region({ label: "adidas socks", left: 400, top: 700, width: 200, height: 200 }),
      region({ label: "adidas socks", left: 700, top: 700, width: 200, height: 200 }),
    ];
    const { plans, out } = await runEdit(frame, regions, size);

    // Precondition: this is genuinely testing a MERGED crop, not two crops that happened to pass.
    expect(plans).toHaveLength(1);
    expect(plans[0].regions).toHaveLength(2);
    // And the gap between them really is inside the crop the model saw.
    expect(plans[0].crop.left).toBeLessThan(600);
    expect(plans[0].crop.left + plans[0].crop.width).toBeGreaterThan(700);

    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.differing).toBe(0);          // ← the gap, and everything else outside, untouched
    expect(d.max).toBe(0);
    expect(d.insideChanged).toBeGreaterThan(0);
  });

  it("changes BOTH rectangles of a merged crop, not just the first", async () => {
    const frame = await frameBytes(W, H, "png");
    const a = region({ label: "adidas socks", left: 400, top: 700, width: 200, height: 200 });
    const b = region({ label: "adidas socks", left: 700, top: 700, width: 200, height: 200 });
    const { out } = await runEdit(frame, [a, b], size);

    // Each rectangle on its own must have changed. A merge that pasted only one would still pass
    // the guarantee test above — it would just silently drop half the edit she paid for.
    for (const r of [a, b]) {
      const only = await diffOutside(frame, out.bytes, [r]);
      expect(only.insideChanged).toBeGreaterThan(0);
    }
  });

  it("keeps the channel count the source had — removeAlpha() is load-bearing", async () => {
    const frame = await frameBytes(W, H, "png");
    const { out } = await runEdit(frame, [region()], size);
    // composite() promotes to RGBA. Without removeAlpha this is 4 and every consumer sees a
    // different image than the one that went in.
    expect((await decode(out.bytes)).info.channels).toBe((await decode(frame)).info.channels);
    expect((await sharp(out.bytes).metadata()).hasAlpha).toBe(false);
  });

  it("holds for three regions at once, including one at a corner", async () => {
    const frame = await frameBytes(W, H, "png");
    const regions = [
      region({ left: 0, top: 0, width: 200, height: 150 }),
      region({ left: 700, top: 1100, width: 250, height: 250 }),
      region({ left: W - 200, top: H - 150, width: 200, height: 150 }),
    ];
    const { out } = await runEdit(frame, regions, size);
    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.differing).toBe(0);
    // Effectively all of it, not literally all: the adversary's patch is resized 1.7x and back, and
    // that round trip lands a handful of subpixels (0.2% here) back on the value they started with
    // by coincidence. Asserting exact equality would be asserting a property of the resampler.
    expect(d.insideChanged / d.insideTotal).toBeGreaterThan(0.99);
  });

  it("holds after a DOWNSCALED crop — the large-region case", async () => {
    // A region big enough to force planCrop past MAX_PATCH_PIXELS, so the patch makes a full
    // downscale/upscale round trip. Detail is lost inside the region; outside must be untouched.
    const big = { width: 5000, height: 5000 };
    const frame = await frameBytes(big.width, big.height, "png");
    const regions = [region({ left: 200, top: 200, width: 4200, height: 4200 })];
    const { plans, out } = await runEdit(frame, regions, big);
    expect(plans[0].downscaled).toBe(true);
    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.differing).toBe(0);
    expect(d.max).toBe(0);
  });

  it("changes NOTHING outside when the model returns the crop untouched", async () => {
    // The no-op edit. A pipeline that re-encoded the frame, or pasted the padded ring, would show
    // drift here even though nothing was asked to change. Both are still caught: a re-encode moves
    // pixels across the WHOLE frame, and the padded crop is far larger than the region, so either
    // one shows up outside.
    const frame = await frameBytes(W, H, "png");
    const regions = [region()];
    const plan = planCrop(regions, size);
    const out = await pasteBack(frame, [{ plan, patchBytes: await cropFrame(frame, plan) }]);

    // The REGIONS, not []. `diffOutside` treats whatever it is not given as outside, so an empty
    // list quietly turned this into "nothing anywhere changes" — a different and stricter claim
    // than the one in the title, and one the feather cannot satisfy (see the inside bound below).
    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.differing).toBe(0);
    expect(d.max).toBe(0);

    // INSIDE, the feather ramp costs at most one unit of 8-bit rounding and never more.
    // pasteBack composites the patch over the original through a premultiply/unpremultiply round
    // trip. With identical content that blend is a mathematical no-op, but it is not an integer
    // one: some pixels can land ±1. Asserted as a per-channel BOUND rather than a count, so the
    // rounding is documented at its true magnitude while any real drift — a shifted paste, a
    // re-encode, a wrong ramp — still fails, because none of those stay within one unit.
    expect(d.insideMax).toBeLessThanOrEqual(1);

    // ⚠️ NO LOWER BOUND ON THE COUNT — zero is a correct answer. WHICH alphas round is a property of
    // the libvips build, not of pasteBack. This region's radius-6 ramp only ever uses alphas 21, 64,
    // 106, 149, 191 and 234. CI's linux-x64 build rounds at least one of them. darwin-arm64, on the
    // same sharp 0.34.5 / libvips 8.17.3, rounds identical content only at odd alphas 65–127, so
    // there the count is exactly 0, and a `> 0` failed a correct composite. Measured on that machine:
    // a 300×233 region (radius 7, a ramp through 91) gives 627 changed at max Δ 1, outside 0 — the
    // blend is running, and this ramp simply misses the alphas it rounds at. That the ramp is APPLIED
    // at all is proven where it can be read directly: "BLENDS inside the ramp", in the feather suite.
  });
});

// ─── The feather ────────────────────────────────────────────────────────────────────────────────

describe("featherRadiusFor — proportional, because one pixel count cannot serve both ends", () => {
  it("scales with the region rather than sitting at a constant", () => {
    const necklace = featherRadiusFor({ width: 200, height: 200 });
    const background = featherRadiusFor({ width: 2000, height: 2000 });
    expect(necklace).toBe(Math.round(200 * FEATHER_FRACTION));
    expect(background).toBe(Math.round(2000 * FEATHER_FRACTION));
    // The actual requirement, stated as the ratio rather than as two numbers that happen to differ.
    expect(background / necklace).toBeCloseTo(10, 5);
  });

  it("measures the SHORTER side, so a letterbox region is not ramped past its own middle", () => {
    expect(featherRadiusFor({ width: 4000, height: 300 })).toBe(featherRadiusFor({ width: 300, height: 300 }));
  });

  it("never lets two opposite ramps meet — a quarter of the shorter side is the ceiling", () => {
    for (const n of [8, 9, 12, 20, 64, 300, 2000, 6000]) {
      const r = featherRadiusFor({ width: n, height: n });
      expect(r * 2).toBeLessThanOrEqual(n / 2);
      expect(r).toBeLessThanOrEqual(Math.floor(n / 4));
    }
  });

  it("floors at MIN_FEATHER_PX, because a one-pixel ramp is a hard edge with extra steps", () => {
    // 40px region: 3% rounds to 1, which is not a ramp. The floor lifts it; the ceiling (10) allows it.
    expect(featherRadiusFor({ width: 40, height: 40 })).toBe(MIN_FEATHER_PX);
  });

  it("degrades rather than throws at the smallest region the product can produce", () => {
    // MIN_REGION_PX in studio/geometry.ts is 8. A quarter of that is 2, which is also the floor.
    expect(featherRadiusFor({ width: 8, height: 8 })).toBe(2);
    expect(featherRadiusFor({ width: 4, height: 4 })).toBe(1);
  });
});

describe("pasteBack — feathered, and exactly where it is and is not exact", () => {
  const W = 1600;
  const H = 2400;
  const size = { width: W, height: H };
  // 400x400 → radius 12 at 3%. Big enough that the ramp has room to be sampled at several depths.
  const r400 = region({ left: 400, top: 700, width: 400, height: 400 });

  /** A black frame, a white patch: every composited pixel reads as its own blend weight. */
  async function blend(opts?: { feather?: boolean }) {
    const frame = await flatFrame(W, H, 0);
    const plan = planCrop([r400], size);
    const out = await pasteBack(frame, [{ plan, patchBytes: await flatPatch(plan, 255) }], opts);
    return { plan, out: await decode(out.bytes) };
  }

  it("leaves every pixel OUTSIDE the region exactly as it was — the feather did not weaken this", async () => {
    const frame = await flatFrame(W, H, 0);
    const plan = planCrop([r400], size);
    const out = await pasteBack(frame, [{ plan, patchBytes: await flatPatch(plan, 255) }]);
    // The original guarantee, re-proven against a feathered composite rather than assumed to hold.
    const d = await diffOutside(frame, out.bytes, [r400]);
    expect(d.differing).toBe(0);
    expect(d.max).toBe(0);
  });

  it("is EXACTLY the patch beyond the ramp", async () => {
    const { out } = await blend();
    const radius = featherRadiusFor(r400);
    // One pixel deeper than the ramp, at the centre of each edge and at the region's middle.
    expect(at(out, 400 + radius, 700 + 200)).toBe(255);
    expect(at(out, 400 + 200, 700 + radius)).toBe(255);
    expect(at(out, 800 - 1 - radius, 700 + 200)).toBe(255);
    expect(at(out, 400 + 200, 1100 - 1 - radius)).toBe(255);
    expect(at(out, 600, 900)).toBe(255);
  });

  it("BLENDS inside the ramp — neither the original nor the patch, and monotonic inward", async () => {
    const { out } = await blend();
    const radius = featherRadiusFor(r400);
    const y = 700 + 200; // mid-height, so only the left edge is the nearest one
    const walk = Array.from({ length: radius }, (_, i) => at(out, 400 + i, y));

    // The first pixel inside the rectangle is nearly the ORIGINAL — that is what removes the step.
    expect(walk[0]).toBeLessThan(40);
    expect(walk[0]).toBeGreaterThan(0);
    // Every one of them is a genuine mixture, not a rounding of either end.
    for (const v of walk) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(255);
    }
    // And it only ever climbs toward the patch.
    for (let i = 1; i < walk.length; i++) expect(walk[i]).toBeGreaterThan(walk[i - 1]);
  });

  it("ramps the CORNERS too — distance is to the nearest edge, not to the nearest side", async () => {
    const { out } = await blend();
    // The corner pixel is min(x,y) from an edge in both axes, so it must be at least as faint as the
    // edge-centre pixel at the same depth. A ramp built per-axis would light the corner too early.
    expect(at(out, 400, 700)).toBeLessThanOrEqual(at(out, 400, 900));
  });

  it("a wider region gets a wider ramp — the same test at 4x the size", async () => {
    const big = region({ left: 200, top: 400, width: 1200, height: 1200 });
    const frame = await flatFrame(W, H, 0);
    const plan = planCrop([big], size);
    const out = await decode((await pasteBack(frame, [{ plan, patchBytes: await flatPatch(plan, 255) }])).bytes);
    const radius = featherRadiusFor(big);
    expect(radius).toBe(featherRadiusFor(r400) * 3); // 1200 vs 400
    // Still blending at a depth that is already solid patch on the small region.
    expect(at(out, 200 + featherRadiusFor(r400), 1000)).toBeLessThan(255);
    expect(at(out, 200 + radius, 1000)).toBe(255);
  });

  it("{ feather: false } restores the hard paste exactly — the strict path is still there", async () => {
    const { out } = await blend({ feather: false });
    // The very first pixel inside the rectangle is the patch, with nothing in between. This is the
    // step the feather exists to remove, kept reachable for a future strict mode.
    expect(at(out, 400, 700)).toBe(255);
    expect(at(out, 400, 900)).toBe(255);
    expect(at(out, 399, 900)).toBe(0);
  });

  it("keeps the source's channel count even though the overlay now carries alpha", async () => {
    const frame = await flatFrame(W, H, 0);
    const plan = planCrop([r400], size);
    const out = await pasteBack(frame, [{ plan, patchBytes: await flatPatch(plan, 255) }]);
    // ensureAlpha on the OVERLAY must not survive into the output. Same failure removeAlpha() has
    // always guarded, now with a second way in.
    expect((await sharp(out.bytes).metadata()).hasAlpha).toBe(false);
    expect((await decode(out.bytes)).info.channels).toBe(3);
  });
});

// ─── The container, told honestly ───────────────────────────────────────────────────────────────

describe("encoding — pixel-identical, and where that is bounded rather than exact", () => {
  const W = 1600;
  const H = 2400;
  const size = { width: W, height: H };

  it("is EXACT for a lossless source", async () => {
    const frame = await frameBytes(W, H, "png");
    const { out } = await runEdit(frame, [region()], size);
    expect(out.mimeType).toBe("image/png");
    expect(out.jpegQuality).toBeNull();
    expect((await diffOutside(frame, out.bytes, [region()])).max).toBe(0);
  });

  /**
   * A JPEG output re-encodes the whole frame, so "exact" is not available and claiming it would be a
   * lie. What IS available is a BOUND, and the bound is what this pins.
   *
   * It is a real regression guard, not a formality: sharp's DEFAULT jpeg settings move a pixel by up
   * to 116/255 on this fixture — a visible artifact — and nearly all of that is chroma subsampling
   * rather than quality. Drop 4:4:4 from JPEG_LADDER and this fails.
   */
  it("is BOUNDED for a jpeg source, and the bound is what 4:4:4 buys", async () => {
    const frame = await frameBytes(W, H, "jpeg");
    const regions = [region()];
    const { out } = await runEdit(frame, regions, size);
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.jpegQuality).toBe(JPEG_LADDER[0].quality);

    const d = await diffOutside(frame, out.bytes, regions);
    expect(d.max).toBeLessThanOrEqual(8); // measured 4 on a 24MP frame at the top rung
    expect(d.differing).toBeGreaterThan(0); // and it is NOT zero — say bounded, never exact
  });

  it("refuses a patch that came back transposed, rather than squashing it into the region", async () => {
    // fit:"fill" forces the patch to the crop's exact dimensions, so a transposed return is not
    // rotated — it is STRETCHED, producing a correctly-placed region containing a distorted picture.
    // Nothing upstream can see that: the composited frame has the right shape either way.
    const frame = await frameBytes(1600, 2400, "png");
    const plan = planCrop([region()], { width: 1600, height: 2400 });
    const sideways = await sharp(await cropFrame(frame, plan))
      .resize(plan.crop.height, plan.crop.width, { fit: "fill" }) // transposed
      .png()
      .toBuffer();
    await expect(pasteBack(frame, [{ plan, patchBytes: sideways }])).rejects.toThrow(/would be stretched to fit/);
  });

  it("lets an ordinary rescale through — the guard catches a transpose, not a resize", async () => {
    // A model returning its own rounding of the same ratio is normal. Catching that would refuse
    // almost every real edit.
    const frame = await frameBytes(1600, 2400, "png");
    const plan = planCrop([region()], { width: 1600, height: 2400 });
    const rescaled = await sharp(await cropFrame(frame, plan))
      .resize(Math.round(plan.crop.width * 1.9), Math.round(plan.crop.height * 1.9), { fit: "fill" })
      .png()
      .toBuffer();
    await expect(pasteBack(frame, [{ plan, patchBytes: rescaled }])).resolves.toBeTruthy();
  });

  it("refuses a format it cannot honestly preserve rather than silently converting", async () => {
    const tiff = await sharp(await frameBytes(64, 64, "png")).tiff().toBuffer();
    const plan = planCrop([region({ left: 8, top: 8, width: 16, height: 16 })], { width: 64, height: 64 });
    await expect(pasteBack(tiff, [{ plan, patchBytes: await cropFrame(tiff, plan) }])).rejects.toThrow(/only jpeg, png and webp/);
  });
});

// ─── What the model is handed ───────────────────────────────────────────────────────────────────

describe("cropFrame", () => {
  it("hands the model exactly the pixels the plan describes, at the send size", async () => {
    const frame = await frameBytes(1600, 2400, "png");
    const plan: PlannedCrop = planCrop([region()], { width: 1600, height: 2400 });
    const meta = await sharp(await cropFrame(frame, plan)).metadata();
    expect(meta.width).toBe(plan.send.width);
    expect(meta.height).toBe(plan.send.height);
    // PNG on the way out: this buffer is the INPUT to a paid call and must not start with loss.
    expect(meta.format).toBe("png");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE WHOLE-FRAME GUARD — a re-render must not be reachable by a field being absent
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `subjectNoun` is what makes a region an inversion, and the inversion refusal only fires for
// something already identified as one. Detection drops that field at a real rate, and a whole-frame
// region without it is `edit-inside` by default — so it trips nothing and the patch is composited
// over the entire photograph. Six real jobs reached this state and every one reported success.
//
// These are built from the shapes those jobs actually had.

describe("coversMostOfFrame — measured, not guessed", () => {
  const frame = { width: 1056, height: 1408 };

  it("passes the largest LEGITIMATE garment region measured in production", () => {
    // The biggest object-noun region across 83 real regions: a jersey at 19.3% of frame area.
    const jersey = {
      width: Math.round(frame.width * 0.502),
      height: Math.round(frame.height * 0.385),
    };
    expect(
      (jersey.width * jersey.height) / (frame.width * frame.height),
    ).toBeLessThan(0.2);
    expect(coversMostOfFrame(jersey, frame)).toBe(false);
  });

  it("⚠️ AREA, NOT WIDTH — that same jersey is 50.2% of the frame's WIDTH", () => {
    // A width-based rule at any plausible threshold clips a real garment edit while still admitting
    // the catastrophic case. This pins WHY the constant is expressed as area.
    const jersey = {
      width: Math.round(frame.width * 0.502),
      height: Math.round(frame.height * 0.385),
    };
    expect(jersey.width / frame.width).toBeGreaterThan(
      MAX_EDIT_INSIDE_FRAME_SHARE,
    );
    expect(coversMostOfFrame(jersey, frame)).toBe(false);
  });

  it("catches b20a7554's shape at 90.8% — an exact-whole-frame test would miss it", () => {
    const r = { width: Math.round(frame.width * 0.908), height: frame.height };
    expect(coversMostOfFrame(r, frame)).toBe(true);
  });

  it("catches the whole frame", () => {
    expect(
      coversMostOfFrame({ width: frame.width, height: frame.height }, frame),
    ).toBe(true);
  });

  it("does not divide by zero on a degenerate frame", () => {
    expect(
      coversMostOfFrame({ width: 10, height: 10 }, { width: 0, height: 0 }),
    ).toBe(false);
  });
});

describe("pasteBack refuses a whole-frame edit-inside region", () => {
  const SIZE = { width: 800, height: 1200 };

  /** 666b4386's shape: the region IS the frame, no noun of any kind, so polarity is edit-inside. */
  const wholeFrameRegion = () =>
    region({
      label: "a soccer stadium",
      left: 0,
      top: 0,
      width: 800,
      height: 1200,
    });

  it("refuses rather than compositing — the six jobs that reported success", async () => {
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    const plan = planCrop([wholeFrameRegion()], SIZE);
    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 240) },
    ]);

    expect(out.maskVerdicts).toHaveLength(1);
    expect(out.maskVerdicts[0]).toMatch(/^refused_whole_frame_/);

    // And nothing was pasted: the frame is unchanged where the patch would have gone.
    const before = await decode(frame);
    const after = await decode(out.bytes);
    expect(
      Math.abs(at(after, 400, 600) - at(before, 400, 600)),
    ).toBeLessThanOrEqual(2);
  });

  it("uses the `refused_` prefix generate.ts collects, so she is TOLD", async () => {
    // The prefix is the contract: runMaskedEdit scans for it to name failed targets and to fail a
    // job whose every region refused. A verdict that did not start with it would refuse silently —
    // which is the failure mode being fixed, wearing a different mask.
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    const plan = planCrop([wholeFrameRegion()], SIZE);
    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 240) },
    ]);
    expect(out.maskVerdicts.every((v) => v.startsWith("refused_"))).toBe(true);
  });

  it("does NOT refuse the same region when a usable mask confines it", async () => {
    // A big region WITH a mask is an ordinary masked edit — the mask is what stops it being a
    // re-render, so the geometry is no longer the whole story. Refusing here would break every
    // legitimate background edit, which is the arm this guard exists to protect.
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    const plan = planCrop([wholeFrameRegion()], SIZE);
    // A REAL mask, not an all-white one: all-white fills the crop and the leak guard rejects it as
    // `crop_fill`, so `regionMask` would be null and this test would prove nothing. The subject
    // occupies the middle quarter — what a person mask on a whole-frame background edit looks like.
    const raw = Buffer.alloc(plan.crop.width * plan.crop.height, 0);
    const x0 = Math.round(plan.crop.width * 0.25);
    const x1 = Math.round(plan.crop.width * 0.75);
    const y0 = Math.round(plan.crop.height * 0.25);
    const y1 = Math.round(plan.crop.height * 0.75);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) raw[y * plan.crop.width + x] = 255;
    }
    const mask = await sharp(raw, {
      raw: { width: plan.crop.width, height: plan.crop.height, channels: 1 },
    })
      .png()
      .toBuffer();

    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 240), masks: [mask] },
    ]);
    expect(out.maskVerdicts[0]).not.toMatch(/^refused_whole_frame_/);
  });

  it("leaves an ordinary garment-sized region alone", async () => {
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    // ~19% of frame area, the legitimate maximum measured in production.
    const r = region({ left: 100, top: 200, width: 400, height: 460 });
    const plan = planCrop([r], SIZE);
    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 240) },
    ]);
    expect(out.maskVerdicts[0]).not.toMatch(/^refused_whole_frame_/);
  });

  it("leaves a whole-frame INVERSION region on its own refusal path", async () => {
    // subjectNoun ⇒ preserve-inside ⇒ the existing inversion refusal fires first and names its own
    // reason. The new guard must not shadow it: the two say different things about the same shape.
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    const r = region({
      label: "a soccer stadium",
      left: 0,
      top: 0,
      width: 800,
      height: 1200,
      subjectNoun: "person",
    });
    const plan = planCrop([r], SIZE);
    const out = await pasteBack(frame, [
      {
        plan,
        patchBytes: await flatPatch(plan, 240),
        // As generate.ts sets it, from polarityFor(plan.regions). pasteBack reads the POLARITY off
        // the input rather than re-deriving it — see polarityFor's own note for why.
        maskPolarity: "preserve-inside",
      },
    ]);
    expect(out.maskVerdicts[0]).toMatch(/^refused_/);
    expect(out.maskVerdicts[0]).not.toMatch(/^refused_whole_frame_/);
  });

  it("STILL refuses a subject region that arrives without its polarity — defence in depth", async () => {
    // `pasteBack` reads polarity off the INPUT, not off the regions. A caller that forgot to set it
    // hands a whole-frame inversion to the edit-inside arm, which is exactly the re-render this
    // guard exists to stop — so it fires, and that is correct rather than a shadowing bug. Found by
    // a test of mine that omitted the field.
    const frame = await flatFrame(SIZE.width, SIZE.height, 40);
    const r = region({
      label: "a soccer stadium",
      left: 0,
      top: 0,
      width: 800,
      height: 1200,
      subjectNoun: "person",
    });
    const plan = planCrop([r], SIZE);
    const out = await pasteBack(frame, [
      { plan, patchBytes: await flatPatch(plan, 240) },
    ]);
    expect(out.maskVerdicts[0]).toMatch(/^refused_whole_frame_/);
  });
});
