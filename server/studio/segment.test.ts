/**
 * segment.test.ts — the one rule this module has: it never throws, and it never spends when it
 * cannot use what it would buy.
 *
 * The reason that rule is worth a suite of its own is the ARITHMETIC OF A FAILURE HERE. By the time
 * a mask is requested, the crop's edit call has already billed and already succeeded.
 * `runMaskedEdit` catches per-crop failures and records the crop as LOST — she is told by name that
 * a thing she asked for did not change. Letting a $0.005 mask call fail an edit that already spent
 * dollars on its patch gets that backwards, so every failure path below has to end in `null`.
 */
import sharp from "sharp";
import { masksForCrop, nounFor, probeWindowFor, padSpillFor } from "./segment";
import { generate as routerGenerate } from "./router";
import type { PlannedCrop } from "./composite";
import {
  planCrop,
  planCrops,
  regionWithinCrop,
  regionsWithinCrop,
  maskLeakReason,
} from "./composite";
import type { EditRegion } from "./brief";

jest.mock("./router", () => ({ generate: jest.fn() }));
const generate = routerGenerate as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const region = (over: Partial<EditRegion> = {}): EditRegion => ({
  label: "adidas jersey",
  left: 100,
  top: 100,
  width: 200,
  height: 200,
  ...over,
});

const plan = (regions: EditRegion[]): PlannedCrop => ({
  regions,
  crop: { left: 0, top: 0, width: 600, height: 600 },
  send: { width: 600, height: 600 },
  downscaled: false,
});

let cropBytes: Buffer;
/** A real mask PNG, on over the region rect. The module decodes what it is given now, so a stand-in
 *  string buffer would fail for the wrong reason — it returns a CROP-SPACE mask, not the
 *  segmenter's bytes verbatim. */
let maskPng: Buffer;

async function maskOver(
  box: { left: number; top: number; width: number; height: number },
  w = 600,
  h = 600,
) {
  const raw = Buffer.alloc(w * h, 0);
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) raw[y * w + x] = 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  cropBytes = await sharp(Buffer.alloc(600 * 600 * 3, 128), {
    raw: { width: 600, height: 600, channels: 3 },
  })
    .png()
    .toBuffer();
  maskPng = await maskOver({ left: 100, top: 100, width: 200, height: 200 });
});

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, STUDIO_GARMENT_MASK: "true" };
  generate.mockReset();
  // A VALID mask by default. Tests that assert on the REQUEST do not care what comes back, but the
  // module decodes the response now, so a stand-in buffer would fill their logs with a decode error
  // that looks like a failure and is not one.
  generate.mockResolvedValue({
    assets: [{ bytes: maskPng, mimeType: "image/png" }],
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ─── THE OBJECT ARM AT THE SEGMENTER ───────────────────────────────────────────────────────────
//
// segment.ts routes on the FIELD, never on the word, so a ball needs no new code here. That is the
// claim, and an untested claim of "no change needed" is the one most likely to be wrong — these pin
// that a non-garment noun reaches the provider and that its failures fall back exactly as a
// garment's do.

describe("a non-garment noun is just a noun to this module", () => {
  it("reaches the segmenter as the prompt, unchanged", async () => {
    const out = await masksForCrop({
      plan: plan([region({ samNoun: "soccer ball" })]),
      cropBytes,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const [task, inputs] = generate.mock.calls[0];
    expect(task).toBe("image.segment");
    expect(inputs.prompt).toBe("soccer ball");
    // BYTES, never a url — the rule fal.ts refuses the other arm for. Restated on the new path
    // because "it is the same code" is exactly the assumption that lets a regression through.
    expect(inputs.references[0].kind).toBe("bytes");
    expect(out[0]).not.toBeNull();
  });

  it("rides the same STUDIO_GARMENT_MASK gate, so off means no call and no spend", async () => {
    process.env.STUDIO_GARMENT_MASK = "false";
    const out = await masksForCrop({
      plan: plan([region({ samNoun: "soccer ball" })]),
      cropBytes,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(out).toEqual([null]);
  });

  it("falls back to null when the segmenter finds nothing for the noun", async () => {
    // The unprobed-noun case, which is the whole cost of an open vocabulary: SAM does not know the
    // word, returns no masks, and the region takes its rectangle. Today's behaviour, plus $0.005.
    generate.mockResolvedValue({ assets: [] });
    const out = await masksForCrop({
      plan: plan([region({ samNoun: "kettlebell" })]),
      cropBytes,
    });
    expect(out).toEqual([null]);
  });

  it("falls back to null when the segmenter throws on it", async () => {
    generate.mockRejectedValue(new Error("fal timed out"));
    const out = await masksForCrop({
      plan: plan([region({ samNoun: "soccer ball" })]),
      cropBytes,
    });
    expect(out).toEqual([null]);
  });

  it("returns a mask that misses the region as null rather than as somebody else's shape", async () => {
    // Garbage in the useful sense: a real mask, over the wrong part of the crop. bestMaskFor scores
    // by overlap with THIS region, so nothing overlapping means no mask — and the leak guard in
    // pasteBack is the second net, for a mask that overlaps but sprawls.
    generate.mockResolvedValue({
      assets: [
        {
          bytes: await maskOver({
            left: 450,
            top: 450,
            width: 100,
            height: 100,
          }),
          mimeType: "image/png",
        },
      ],
    });
    const out = await masksForCrop({
      plan: plan([region({ samNoun: "soccer ball" })]),
      cropBytes,
    });
    expect(out).toEqual([null]);
  });
});

describe("nounFor", () => {
  it("takes the noun the crop's regions agree on, and says which side of it to edit", () => {
    expect(
      nounFor([region({ samNoun: "socks" }), region({ samNoun: "socks" })]),
    ).toEqual({ noun: "socks", polarity: "edit-inside" });
  });

  it("reads a subject noun as the INVERSION ask, not as another garment", () => {
    expect(nounFor([region({ subjectNoun: "person" })])).toEqual({
      noun: "person",
      polarity: "preserve-inside",
    });
  });

  it("returns null for a region naming both — that describes no coherent edit", () => {
    // Picking either would run a real segmentation, pass the leak guard, and change the wrong half
    // of the photograph with nothing reporting a problem.
    expect(
      nounFor([region({ samNoun: "jersey", subjectNoun: "person" })]),
    ).toBeNull();
    expect(
      nounFor([
        region({ subjectNoun: "person" }),
        region({ samNoun: "jersey" }),
      ]),
    ).toBeNull();
  });

  it("returns null when they disagree, rather than segmenting two things as one", () => {
    // planCrops only merges regions naming the SAME target, so this cannot happen today. The guard
    // is here so that if that merge rule is ever loosened, this degrades to no mask instead of
    // silently segmenting a shoe as a sock.
    expect(
      nounFor([region({ samNoun: "socks" }), region({ samNoun: "shoes" })]),
    ).toBeNull();
  });

  it("returns null when the first region carries no noun", () => {
    expect(nounFor([region(), region({ samNoun: "socks" })])).toBeNull();
    expect(nounFor([])).toBeNull();
  });
});

describe("it does not spend when it cannot use what it would buy", () => {
  it("makes no call at all when the flag is off", async () => {
    process.env.STUDIO_GARMENT_MASK = "false";
    expect(
      (
        await masksForCrop({
          plan: plan([region({ samNoun: "jersey" })]),
          cropBytes,
        })
      )[0],
    ).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("makes no call when nothing named a noun — the hand-drawn box, and every old brief", async () => {
    expect(
      (await masksForCrop({ plan: plan([region()]), cropBytes }))[0],
    ).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("every failure ends in null, never in a throw", () => {
  it("a provider error", async () => {
    generate.mockRejectedValue(new Error("fal exploded"));
    expect(
      (
        await masksForCrop({
          plan: plan([region({ samNoun: "jersey" })]),
          cropBytes,
        })
      )[0],
    ).toBeNull();
  });

  it("a missing key", async () => {
    generate.mockRejectedValue(new Error("FAL_KEY is not set"));
    expect(
      (
        await masksForCrop({
          plan: plan([region({ samNoun: "jersey" })]),
          cropBytes,
        })
      )[0],
    ).toBeNull();
  });

  it("a vocabulary miss — zero assets, which is a clean answer and not an error", async () => {
    generate.mockResolvedValue({ assets: [] });
    expect(
      (
        await masksForCrop({
          plan: plan([region({ samNoun: "jersey" })]),
          cropBytes,
        })
      )[0],
    ).toBeNull();
  });

  it("an asset with no bytes", async () => {
    generate.mockResolvedValue({
      assets: [{ url: "https://fal.media/m.png", mimeType: "image/png" }],
    });
    expect(
      (
        await masksForCrop({
          plan: plan([region({ samNoun: "jersey" })]),
          cropBytes,
        })
      )[0],
    ).toBeNull();
  });
});

describe("the happy path", () => {
  it("returns a CROP-SPACE mask and asks for the region's own noun", async () => {
    generate.mockResolvedValue({
      assets: [{ bytes: maskPng, mimeType: "image/png" }],
    });
    const out = (
      await masksForCrop({
        plan: plan([region({ samNoun: "crop top" })]),
        cropBytes,
      })
    )[0];

    // Not the segmenter's bytes verbatim any more: the mask comes back sized to the CROP, so the
    // compositor can index it by region without knowing which window it was probed in.
    expect(out).not.toBeNull();
    const decoded = await sharp(out!)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBe(600);
    expect(decoded.info.height).toBe(600);
    expect(decoded.data[200 * 600 + 200]).toBeGreaterThan(128); // inside the region: on
    expect(decoded.data[500 * 600 + 500]).toBeLessThan(128); // outside it: off

    const [task, inputs] = generate.mock.calls[0];
    expect(task).toBe("image.segment");
    expect(inputs.prompt).toBe("crop top");
  });

  it("sends BYTES, never a reference that could carry a url", async () => {
    generate.mockResolvedValue({
      assets: [{ bytes: Buffer.from("mask"), mimeType: "image/png" }],
    });
    await masksForCrop({
      plan: plan([region({ samNoun: "jersey" })]),
      cropBytes,
    });

    const [, inputs] = generate.mock.calls[0];
    expect(inputs.references).toHaveLength(1);
    expect(inputs.references[0].kind).toBe("bytes");
    expect(Buffer.isBuffer(inputs.references[0].bytes)).toBe(true);
  });

  it("downscales the crop to the configured long edge before sending it", async () => {
    process.env.STUDIO_SEGMENT_LONG_EDGE_PX = "256";
    generate.mockResolvedValue({
      assets: [{ bytes: Buffer.from("mask"), mimeType: "image/png" }],
    });
    await masksForCrop({
      plan: plan([region({ samNoun: "jersey" })]),
      cropBytes,
    });

    const sent = generate.mock.calls[0][1].references[0].bytes;
    const meta = await sharp(sent).metadata();
    // The body carries this as base64, so the send size is a payload decision as much as a
    // precision one — see studio/config.ts segmentLongEdgePx.
    expect(Math.max(meta.width!, meta.height!)).toBe(256);
  });

  it("never enlarges a crop that is already smaller than the long edge", async () => {
    process.env.STUDIO_SEGMENT_LONG_EDGE_PX = "4096";
    generate.mockResolvedValue({
      assets: [{ bytes: Buffer.from("mask"), mimeType: "image/png" }],
    });
    await masksForCrop({
      plan: plan([region({ samNoun: "jersey" })]),
      cropBytes,
    });

    const meta = await sharp(
      generate.mock.calls[0][1].references[0].bytes,
    ).metadata();
    expect(meta.width).toBe(600);
  });
});

// ─── ONE PROBE PER REGION: THE PAIRED-GARMENT BUG ──────────────────────────────────────────────

describe("a merged crop probes each region separately", () => {
  const twoSocks = () => [
    region({
      label: "adidas socks",
      left: 60,
      top: 200,
      width: 100,
      height: 250,
      samNoun: "socks",
    }),
    region({
      label: "adidas socks",
      left: 380,
      top: 200,
      width: 100,
      height: 250,
      samNoun: "socks",
    }),
  ];

  it("makes one segmentation call per region, not one per crop", async () => {
    // The merge is kept for the EDIT call ($0.13) and dropped for segmentation ($0.005). One probe
    // per crop is what produced the paired-garment bug: SAM answers with ONE instance and it then
    // gets scored against both rectangles.
    await masksForCrop({ plan: plan(twoSocks()), cropBytes });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  /**
   * A mask as the SEGMENTER would return it: in the probe WINDOW's own space, not the crop's.
   * Getting this wrong in a fixture is the easiest way to write a test that fails for the wrong
   * reason — the module resizes what it is given to the window it asked about.
   */
  const maskAsSamWouldReturnIt = async (regs: EditRegion[], r: EditRegion) => {
    const w = probeWindowFor(plan(regs), r);
    return maskOver(
      {
        left: r.left - w.left,
        top: r.top - w.top,
        width: r.width,
        height: r.height,
      },
      w.width,
      w.height,
    );
  };

  it("gives each region a mask over ITS OWN rectangle", async () => {
    // The masks differ per call, as two real socks would.
    const socks = twoSocks();
    generate
      .mockResolvedValueOnce({
        assets: [
          {
            bytes: await maskAsSamWouldReturnIt(socks, socks[0]),
            mimeType: "image/png",
          },
        ],
      })
      .mockResolvedValueOnce({
        assets: [
          {
            bytes: await maskAsSamWouldReturnIt(socks, socks[1]),
            mimeType: "image/png",
          },
        ],
      });

    const [a, b] = await masksForCrop({ plan: plan(socks), cropBytes });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const da = await sharp(a!).removeAlpha().greyscale().raw().toBuffer();
    const db = await sharp(b!).removeAlpha().greyscale().raw().toBuffer();
    // Each is on over its own sock and off over the other one.
    expect(da[300 * 600 + 110]).toBeGreaterThan(128);
    expect(da[300 * 600 + 430]).toBeLessThan(128);
    expect(db[300 * 600 + 430]).toBeGreaterThan(128);
    expect(db[300 * 600 + 110]).toBeLessThan(128);
  });

  it("picks the mask over THIS region, not the biggest one in the window", async () => {
    // A probe window carries context and often clips the neighbour. If the neighbour is more fully
    // in view, "largest" picks the WRONG sock; overlap with the region rectangle cannot.
    const socks = twoSocks();
    const w = probeWindowFor(plan(socks), socks[0]);
    const inWindow = {
      left: socks[0].left - w.left,
      top: socks[0].top - w.top,
    };
    // Small, and over the region.
    const overRegion = await maskOver(
      {
        left: inWindow.left + 10,
        top: inWindow.top + 10,
        width: 60,
        height: 60,
      },
      w.width,
      w.height,
    );
    // Four times the area, and nowhere near it.
    const bigElsewhere = await maskOver(
      {
        left: 0,
        top: 0,
        width: w.width,
        height: Math.max(1, inWindow.top - 5),
      },
      w.width,
      w.height,
    );
    generate.mockResolvedValue({
      assets: [
        { bytes: bigElsewhere, mimeType: "image/png" },
        { bytes: overRegion, mimeType: "image/png" },
      ],
    });

    const [a] = await masksForCrop({ plan: plan(socks), cropBytes });
    const da = await sharp(a!).removeAlpha().greyscale().raw().toBuffer();
    const onAt = (x: number, y: number) => da[y * 600 + x];
    expect(onAt(socks[0].left + 30, socks[0].top + 30)).toBeGreaterThan(128); // the small one won
    expect(onAt(w.left + 2, w.top + 2)).toBeLessThan(128); // the big one did not
  });

  it("returns null for a region nothing overlapped, without losing the other region's mask", async () => {
    const socks = twoSocks();
    generate
      .mockResolvedValueOnce({
        assets: [
          {
            bytes: await maskAsSamWouldReturnIt(socks, socks[0]),
            mimeType: "image/png",
          },
        ],
      })
      .mockResolvedValueOnce({ assets: [] });
    const [a, b] = await masksForCrop({ plan: plan(socks), cropBytes });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("one region's failure does not cost the other one its mask", async () => {
    const socks = twoSocks();
    generate
      .mockRejectedValueOnce(new Error("fal timed out"))
      .mockResolvedValueOnce({
        assets: [
          {
            bytes: await maskAsSamWouldReturnIt(socks, socks[1]),
            mimeType: "image/png",
          },
        ],
      });
    const [a, b] = await masksForCrop({ plan: plan(socks), cropBytes });
    expect(a).toBeNull();
    expect(b).not.toBeNull();
  });

  it("a single-region crop still probes the WHOLE crop, exactly as it always did", async () => {
    expect(probeWindowFor(plan([region()]), region())).toEqual({
      left: 0,
      top: 0,
      width: 600,
      height: 600,
    });
  });

  it("a merged crop probes a window around each region, not the whole crop", async () => {
    const socks = twoSocks();
    const w = probeWindowFor(plan(socks), socks[0]);
    expect(w.width).toBeLessThan(600);
    expect(w.left).toBeLessThanOrEqual(60);
    expect(w.left + w.width).toBeGreaterThanOrEqual(160); // covers the region
  });
});

describe("the mask source can be switched off per REQUEST, not only per process", () => {
  // The env var is process-wide, so it could never express "this job does not want a shape mask".
  // Threading it is what lets a chosen path carry the geometry that path implies — the same shape
  // parseDetections and normalizeObjectNoun already use.
  const plan = {
    regions: [
      {
        label: "red jersey",
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        samNoun: "jersey",
      },
    ],
    crop: { left: 0, top: 0, width: 200, height: 200 },
    send: { width: 200, height: 200 },
  } as never;

  it("makes NO call and returns no masks when enabled is false, whatever the env says", async () => {
    process.env.STUDIO_GARMENT_MASK = "true";
    const out = await masksForCrop({
      plan,
      cropBytes: Buffer.from("x"),
      enabled: false,
    });
    expect(out).toEqual([null]);
  });

  it("omitting it keeps the flag as the authority — today's behaviour exactly", async () => {
    process.env.STUDIO_GARMENT_MASK = "false";
    expect(await masksForCrop({ plan, cropBytes: Buffer.from("x") })).toEqual([
      null,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE OVERREACH DEAD ZONE, AND THE SCALE-FAIR METRIC THAT WILL REPLACE IT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("overreach is structurally dead on large regions — pinned so the fix is not undone quietly", () => {
  const frame = { width: 6000, height: 8000 };
  const square = (w: number): EditRegion => ({
    label: "x",
    left: 2000,
    top: 2000,
    width: w,
    height: w,
    samNoun: "jersey",
  });
  /** The largest value `overreach` can take: the pad, over the region's own width. */
  const maxOverreachFor = (w: number) => {
    const r = square(w);
    const plan = planCrop([r], frame);
    const within = regionWithinCrop(plan, r);
    return (within.left - 0) / within.width;
  };

  it("cannot fire at 512px or wider, whatever the mask does", () => {
    // Past 512 the pad IS half the width, so the ratio is exactly 0.5 and `> 0.5` is never true.
    // Production jerseys are 800-1500px on a 4000x6000 frame — squarely inside this.
    for (const w of [512, 600, 900, 1500, 4000]) {
      expect(maxOverreachFor(w)).toBeCloseTo(0.5, 4);
      expect(maxOverreachFor(w) > 0.5).toBe(false);
    }
  });

  it("DOES fire at 513, because Math.round(256.5) is 257", () => {
    // ⚠️ Worse than a dead guard, because dead is at least predictable. Pinned verbatim so nobody
    // "simplifies" the pad formula without seeing that the guard's existence rides on a rounding.
    expect(maxOverreachFor(513)).toBeGreaterThan(0.5);
    expect(maxOverreachFor(512)).not.toBeGreaterThan(0.5);
  });

  it("has real range below 512, which is why small garments are judged far harder", () => {
    expect(maxOverreachFor(60)).toBeGreaterThan(4);
    expect(maxOverreachFor(140)).toBeGreaterThan(1.8);
    expect(maxOverreachFor(400)).toBeGreaterThan(0.6);
  });

  it("is weaker again for a garment that shares a crop", () => {
    // A solo region is probed against the whole crop (pad 256); a paired one gets a window padded
    // by MIN_PROBE_PAD_PX (32). Same garment, same mask quality, different guard strength.
    const solo = {
      label: "s",
      left: 200,
      top: 815,
      width: 62,
      height: 100,
      samNoun: "shoes",
    } as EditRegion;
    const pair = [solo, { ...solo, left: 300, top: 840 }];
    const soloPlan = planCrop([solo], { width: 928, height: 1152 });
    const soloWin = probeWindowFor(soloPlan, solo);
    const soloIn = regionWithinCrop(soloPlan, solo);
    const [pairPlan] = planCrops(pair, { width: 928, height: 1152 });
    const pairWin = probeWindowFor(pairPlan, pair[0]);
    const pairIn = regionsWithinCrop(pairPlan)[0];

    const soloMax = (soloIn.left - soloWin.left) / soloIn.width;
    const pairMax = (pairIn.left - pairWin.left) / pairIn.width;
    expect(soloMax).toBeGreaterThan(3);
    expect(pairMax).toBeLessThan(0.6);
  });
});

describe("padSpillFor — the same spill, normalised by the headroom that bounded it", () => {
  const within = { left: 100, top: 100, width: 200, height: 200 };
  const window = { left: 0, top: 0, width: 400, height: 400 };

  it("is 0 for a mask sitting exactly on its rectangle", () => {
    expect(
      padSpillFor(
        { left: 100, top: 100, width: 200, height: 200 },
        within,
        window,
      ),
    ).toBe(0);
  });

  it("is 1 for a mask filling the whole window", () => {
    expect(
      padSpillFor({ left: 0, top: 0, width: 400, height: 400 }, within, window),
    ).toBeCloseTo(1, 4);
  });

  it("is SCALE-FAIR — identical relative behaviour scores identically at every region size", () => {
    // ─── THE PROPERTY THE WHOLE CHANGE EXISTS FOR ──────────────────────────────────────────────
    //
    // A mask spilling half its available headroom scores 0.5 whether the region is 60px or 4000px.
    // Under `overreach` the same behaviour reads 2.133 (fires) at 60px and 0.250 (passes) at
    // 4000px — same mask, opposite verdicts.
    for (const [w, pad] of [
      [60, 256],
      [140, 256],
      [400, 256],
      [900, 450],
      [4000, 2000],
    ] as const) {
      const reg = { left: pad, top: pad, width: w, height: w };
      const win = { left: 0, top: 0, width: w + pad * 2, height: w + pad * 2 };
      const spill = pad * 0.5;
      const bbox = {
        left: reg.left - spill,
        top: reg.top,
        width: w + spill,
        height: w,
      };
      expect(padSpillFor(bbox, reg, win)).toBeCloseTo(0.5, 4);
      // ...and today's metric does not, which is the bug.
      expect(spill / w).not.toBeCloseTo(0.5, 2);
    }
  });

  it("ignores a side with no headroom rather than dividing by zero", () => {
    // The frame clamp can put a region flush against the window edge.
    const flush = { left: 0, top: 0, width: 200, height: 200 };
    const win = { left: 0, top: 0, width: 200, height: 200 };
    expect(
      Number.isFinite(
        padSpillFor({ left: 0, top: 0, width: 200, height: 200 }, flush, win),
      ),
    ).toBe(true);
    expect(
      padSpillFor({ left: 0, top: 0, width: 200, height: 200 }, flush, win),
    ).toBe(0);
  });

  it("is NOT enforced — no mask is discarded for it", () => {
    // maskLeakReason reads bbox, overreach and fillOfCrop only. padSpill is a measurement until a
    // threshold is set from production data; enforcing an uncalibrated one would swap a guard that
    // silently never fires for one that might silently over-reject.
    const leaky = maskLeakReason(
      {
        bbox: { left: 0, top: 0, width: 400, height: 400 },
        fillOfCrop: 0.1,
        overreach: 0.4,
      },
      { maxOverreach: 0.5, maxCropFill: 0.85 },
    );
    expect(leaky).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// CROP SPACE vs SEND SPACE — a MAX_PATCH_PIXELS bug, not a background one
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `cropFrame` resizes to `plan.send` when the crop is over MAX_PATCH_PIXELS and hands the segmenter
// that buffer, while `probeWindowFor` answers in CROP space. Those are the same numbers only when
// nothing was downscaled — which is why every failing job live was `downscaled: true` and no
// succeeding one ever was.
//
// ⚠️ THE DIMENSIONS BELOW ARE SYNTHETIC ON PURPOSE. The real trigger is a crop over 4096² pixels,
// and a 4000x6000 buffer is ~72MB of raw pixels per test. The DEFECT is the crop/send mismatch, not
// the ceiling, so these plans set `downscaled: true` at 800x1200 -> 400x600 and exercise the same
// code path in a fraction of the memory. The last test keeps that honest by pinning that a real
// 4000x6000 crop does set the flag.

/** A downscaled plan: crop space is exactly 2x send space on both axes. */
const downscaledPlan = (regions: EditRegion[]): PlannedCrop => ({
  regions,
  crop: { left: 0, top: 0, width: 800, height: 1200 },
  send: { width: 400, height: 600 },
  downscaled: true,
});

/** The buffer `cropFrame` would actually have produced for that plan: SEND-sized. */
async function sendSpaceBytes(red?: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const w = 400;
  const h = 600;
  const raw = Buffer.alloc(w * h * 3, 0);
  if (red) {
    for (let y = red.top; y < red.top + red.height; y++) {
      for (let x = red.left; x < red.left + red.width; x++) {
        raw[(y * w + x) * 3] = 255; // red channel only
      }
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * ⚠️ A CONTENT-DERIVED MOCK, AND THE PLACEMENT TESTS ARE WORTHLESS WITHOUT IT.
 *
 * A mock returning a FIXED mask cannot catch a wrong extract rectangle: what it returns does not
 * depend on the pixels it was shown, so the assertion passes whatever was extracted. This returns a
 * mask that is white exactly where the received bytes are red — a FUNCTION of what was extracted —
 * so a mask only lands correctly if the extract took the right pixels AND the mapping back was
 * right.
 *
 * DO NOT "simplify" this to a static mask. It would still pass, and it would stop testing the one
 * thing it exists for.
 */
async function maskWhereRed(_task: string, inputs: any) {
  const received = inputs.references[0].bytes as Buffer;
  const { data, info } = await sharp(received)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height, 0);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * info.channels];
    const g = data[i * info.channels + 1];
    if (r > 200 && g < 50) out[i] = 255;
  }
  const png = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .png()
    .toBuffer();
  return { assets: [{ bytes: png, mimeType: "image/png" }] };
}

/** The white bounding box of a mask PNG, in its own coordinates. */
async function whiteBBox(png: Buffer) {
  const { data, info } = await sharp(png)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] >= 128) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

const near = (got: number, want: number, tol: number) =>
  Math.abs(got - want) <= tol;

const TWO_REGIONS = () => [
  region({ left: 100, top: 200, width: 200, height: 300, samNoun: "socks" }),
  region({ left: 500, top: 200, width: 200, height: 300, samNoun: "socks" }),
];

describe("a downscaled crop is segmented in the space the buffer is actually in", () => {
  it("does not throw extract_area on a whole-frame region — the live background failure", async () => {
    // Reproduces job eff7467b at 1/100th the pixels: one whole-frame region on a downscaled crop.
    // The window is the entire 800x1200 crop; the buffer is 400x600. Before the fix sharp raised
    // `extract_area: bad extract area` in ~1ms and — on the inversion arm — the job failed outright.
    const misses: string[] = [];
    const out = await masksForCrop({
      plan: downscaledPlan([
        region({ left: 0, top: 0, width: 800, height: 1200, samNoun: "socks" }),
      ]),
      cropBytes: await sendSpaceBytes(),
      onMiss: (_i, reason) => misses.push(reason),
    });

    expect(misses).not.toContain("error");
    expect(out).toHaveLength(1);
    expect(generate).toHaveBeenCalled();
  });

  it("sends the segmenter a window that FITS the buffer, not the crop's own numbers", async () => {
    await masksForCrop({
      plan: downscaledPlan([
        region({ left: 0, top: 0, width: 800, height: 1200, samNoun: "socks" }),
      ]),
      cropBytes: await sendSpaceBytes(),
    });

    // Whole-frame window ⇒ the whole SEND buffer, exactly. This is the right-edge-anchoring
    // property: 0..800 in crop space maps to 0..400 with nothing left over.
    const sent = generate.mock.calls[0][1].references[0].bytes as Buffer;
    const meta = await sharp(sent).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: 400,
      height: 600,
    });
  });

  it("lands the mask where the pixels actually were, not merely without crashing", async () => {
    // Red block at SEND {100,150,100,150} ⇒ CROP {200,300,200,300} at 2x.
    generate.mockImplementation(maskWhereRed);
    const [mask] = await masksForCrop({
      plan: downscaledPlan([
        region({ left: 0, top: 0, width: 800, height: 1200, samNoun: "socks" }),
      ]),
      cropBytes: await sendSpaceBytes({
        left: 100,
        top: 150,
        width: 100,
        height: 150,
      }),
    });

    expect(mask).not.toBeNull();
    const bbox = (await whiteBBox(mask!))!;
    expect(bbox).not.toBeNull();
    // CROP space, because that is the contract masksForCrop returns on. ±6px for the 400->800
    // fit:"fill" round trip and PNG quantisation.
    expect(near(bbox.left, 200, 6)).toBe(true);
    expect(near(bbox.top, 300, 6)).toBe(true);
    expect(near(bbox.width, 200, 6)).toBe(true);
    expect(near(bbox.height, 300, 6)).toBe(true);
  });

  /**
   * ⚠️ PLACEMENT ON A *PADDED* WINDOW — THE ONE THAT CATCHES THE WRONG FIX.
   *
   * MEASURED, not assumed. The whole-frame placement test above does NOT catch
   * clamp-instead-of-scale: when the window is the entire crop, clamping it to the buffer and
   * scaling it to the buffer produce the SAME rectangle, so that mutation passes it. Verified by
   * mutating `windowInSendSpace` to clamp — only the padded cases went red.
   *
   * So placement is asserted here too, on a window that is not the whole crop, which is where the
   * two arithmetics diverge. Delete this and the suite still passes under a fix that silently masks
   * the wrong pixels on every multi-region downscaled crop.
   */
  it("lands the mask correctly on a PADDED window too — where clamping and scaling diverge", async () => {
    // Red block at SEND {60,120,40,60} ⇒ CROP {120,240,80,120}.
    generate.mockImplementation(maskWhereRed);
    const [mask] = await masksForCrop({
      plan: downscaledPlan(TWO_REGIONS()),
      cropBytes: await sendSpaceBytes({
        left: 60,
        top: 120,
        width: 40,
        height: 60,
      }),
    });

    expect(mask).not.toBeNull();
    const bbox = (await whiteBBox(mask!))!;
    expect(bbox).not.toBeNull();
    expect(near(bbox.left, 120, 8)).toBe(true);
    expect(near(bbox.top, 240, 8)).toBe(true);
    expect(near(bbox.width, 80, 8)).toBe(true);
    expect(near(bbox.height, 120, 8)).toBe(true);
  });

  it("scales a PADDED window's dimensions, where a whole-frame rect would hide the arithmetic", async () => {
    const regions = TWO_REGIONS();
    const p = downscaledPlan(regions);
    await masksForCrop({ plan: p, cropBytes: await sendSpaceBytes() });

    const cropWindow = probeWindowFor(p, regions[0]);
    const sent = generate.mock.calls[0][1].references[0].bytes as Buffer;
    const meta = await sharp(sent).metadata();
    expect(meta.width).toBe(Math.round(cropWindow.width / 2));
    expect(meta.height).toBe(Math.round(cropWindow.height / 2));
    expect(meta.width!).toBeLessThanOrEqual(400);
    expect(meta.height!).toBeLessThanOrEqual(600);
  });

  it("is the identity when nothing was downscaled — one path, no branch", async () => {
    await masksForCrop({
      plan: plan([region({ samNoun: "socks" })]),
      cropBytes,
    });
    // 600x600 crop, 600x600 send, single region ⇒ the whole crop, unchanged.
    const sent = generate.mock.calls[0][1].references[0].bytes as Buffer;
    const meta = await sharp(sent).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: 600,
      height: 600,
    });
  });

  it("a real 4000x6000 crop IS downscaled — what ties the synthetic plans above to production", () => {
    // Pure arithmetic, no image. Without this the suite could pass while the condition it models
    // never actually occurs in production.
    const p = planCrop(
      [region({ left: 0, top: 0, width: 4000, height: 6000 })],
      {
        width: 4000,
        height: 6000,
      },
    );
    expect(p.downscaled).toBe(true);
    expect(p.send.width).toBeLessThan(p.crop.width);
    expect(p.crop.width * p.crop.height).toBeGreaterThan(4096 * 4096);
  });
});
