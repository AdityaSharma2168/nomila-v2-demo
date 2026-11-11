/**
 * editSizing.test.ts — the property the spend boundary rests on under variable output resolution.
 *
 * ─── THE ONE CLAIM ──────────────────────────────────────────────────────────────────────────────
 *
 * `previewGeneration` quotes a figure and studio/previewStore records it as the ceiling she approved.
 * `runStudioGeneration` then RE-DERIVES the verdict and checks the fresh quote against that ceiling
 * (generate.ts:327). Both sides call `plannedInputs`. If the two derivations ever produced a
 * different `imageSize`, they would be quoting and spending on DIFFERENT JOBS — and because the
 * ceiling compares two numbers that were both computed the same wrong way, neither the approval nor
 * the house cap would notice. A 4K render approved at a 1K price is exactly the shape of that.
 *
 * So: the size is a pure function of the FROZEN BRIEF. Not of opts, not of which region a call is
 * for, not of anything a caller can pass. These tests assert that directly, and the negative control
 * is at the bottom — force the two to differ and the ceiling check fails.
 *
 * The router is mocked, so nothing here spends or touches the network.
 */
import type { CreativeBrief, EditRegion } from "./brief";

jest.mock("../db", () => ({ db: {}, pool: { end: async () => {}, on: () => {} } }));

const estimateMock = jest.fn();
jest.mock("./router", () => ({
  estimate: (...a: unknown[]) => estimateMock(...a),
  generate: jest.fn(),
  resolve: () => ({ adapter: { name: "vertex" }, model: "gemini-3-pro-image" }),
}));

import { previewGeneration, plannedInputs, editCropsFor, editImageSizeFor, type PreviewOptions } from "./preview";
import { imageSizeFrom, smallestImageSizeFor, tokensPerImage } from "./config";
import { estimateCost } from "./pricing";

const region = (over: Partial<EditRegion> = {}): EditRegion => ({
  label: "remove the ball",
  left: 2125,
  top: 2345,
  width: 780,
  height: 780,
  ...over,
});

function editBrief(regions: EditRegion[], frame = { width: 4000, height: 6000 }): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: "2026-09-06T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      mode: "edit",
      source: { mediaAssetId: "a1", ref: "athletes/x/f.jpg", width: frame.width, height: frame.height, editRegions: regions },
      direction: { set: "chosen", statement: "remove the ball", untrusted: false, featuredPieces: [] },
    },
    athlete: {
      athleteId: "athlete-1",
      audience: { descriptor: "d" },
      aesthetic: { register: "r" },
      goal: "g",
    },
    brand: null,
    gaps: [],
    references: [],
  } as unknown as CreativeBrief;
}

const ORIGINAL_ENV = { ...process.env };

/** The real pricing, so the quote under test is the one the product would show. */
beforeEach(() => {
  // Reference tokens OFF, so the figures below are the IMAGE arm alone and read as arithmetic. An
  // edit always carries its source frame as a reference, so with them on every number here would
  // carry a +258-token tail that has nothing to do with what this suite is about. That the frame
  // does contribute is asserted once, on its own, at the end.
  process.env = { ...ORIGINAL_ENV, STUDIO_TOKENS_PER_REFERENCE: "0" };
  estimateMock.mockImplementation((task: string, inputs: never, opts: PreviewOptions) => ({
    task,
    provider: "vertex",
    model: "gemini-3-pro-image",
    inputs: { prompt: "", references: 0, n: 1 },
    cost: estimateCost(inputs, "gemini-3-pro-image", opts),
  }));
});

describe("the size is derived from the brief and from nothing else", () => {
  const brief = editBrief([region()]);

  it("is stable across cropIndex — the only opt that differs between the two call sites", () => {
    // previewGeneration never sets cropIndex; every per-region generate call does. This pins the
    // PURE function against that one difference.
    //
    // It is NOT the end-to-end claim, and it should not be read as one: it exercises plannedInputs
    // directly, not the two endpoints. That the size the preview PRICED is the size the router is
    // actually CALLED with, through runStudioGeneration, is asserted in generate.test.ts — see
    // "what we priced is what we sent".
    const preview = plannedInputs(brief);
    for (let i = 0; i < (editCropsFor(brief)?.length ?? 0); i++) {
      const call = plannedInputs(brief, { cropIndex: i });
      expect(imageSizeFrom(call.providerParams)).toBe(imageSizeFrom(preview.providerParams));
      expect(call.providerParams).toEqual(preview.providerParams);
    }
  });

  it("holds across three regions of very different sizes", () => {
    const many = editBrief([
      region({ left: 0, top: 0, width: 120, height: 120 }),
      region({ left: 1000, top: 2000, width: 900, height: 1400 }),
      region({ left: 3000, top: 5000, width: 300, height: 300 }),
    ]);
    const preview = imageSizeFrom(plannedInputs(many).providerParams);
    for (let i = 0; i < 3; i++) {
      expect(imageSizeFrom(plannedInputs(many, { cropIndex: i }).providerParams)).toBe(preview);
    }
    // ONE size for the job, taken from the largest crop — not a size per region, which is what
    // would make it depend on which call this is.
    expect(preview).toBe(editImageSizeFor(editCropsFor(many)!));
  });

  it("ignores a caller trying to set the size — the derived value wins", () => {
    // Everywhere else in plannedInputs an explicit parameter beats our default. Not here: imageSize
    // is what pricing quotes AND what decides whether the patch is big enough for the paste-back, so
    // a caller moving it would decouple both at once.
    const forced = plannedInputs(brief, {
      providerParams: { generationConfig: { imageConfig: { imageSize: "4K" } } },
    });
    expect(imageSizeFrom(forced.providerParams)).toBe(imageSizeFrom(plannedInputs(brief).providerParams));
  });

  it("names no size at all for a generate, so an ordinary job is unaffected", () => {
    const gen = editBrief([]);
    (gen.job as { mode: string }).mode = "generate";
    (gen.job as { source: unknown }).source = null;
    expect(editCropsFor(gen)).toBeNull();
    expect(imageSizeFrom(plannedInputs(gen).providerParams)).toBeUndefined();
  });

  it("picks the smallest size the crop fits in — 2K for an ordinary edit, not 4K", () => {
    // The crop is what buys fidelity; the size only buys patch resolution. A typical 780px region
    // pads to ~1560px square (2.4 MP), which 2K covers — at 1120 tokens against 4K's 2000.
    const size = imageSizeFrom(plannedInputs(brief).providerParams);
    expect(size).toBe("2K");
    expect(tokensPerImage(size)).toBe(1120);
  });

  it("reaches for 4K only when the crop actually needs it", () => {
    const big = editBrief([region({ left: 100, top: 100, width: 2600, height: 3900 })], { width: 4000, height: 6000 });
    expect(imageSizeFrom(plannedInputs(big).providerParams)).toBe("4K");
  });

  it("never asks for more than 4K — an oversized crop downscales instead", () => {
    const huge = editBrief([region({ left: 0, top: 0, width: 5900, height: 8900 })], { width: 6000, height: 9000 });
    const crops = editCropsFor(huge)!;
    expect(crops[0].downscaled).toBe(true);
    expect(imageSizeFrom(plannedInputs(huge).providerParams)).toBe("4K");
    expect(smallestImageSizeFor(crops[0].send.width * crops[0].send.height)).toBe("4K");
  });
});

describe("the quote and the spend are for the same job", () => {
  it("quotes the size it will actually run at", () => {
    const brief = editBrief([region()]);
    const p = previewGeneration(brief);
    // 2K bills the 1120-token figure, which is what the preview shows.
    expect(p.cost!.amountUsd).toBeCloseTo(1120 * 0.00012, 6);
    expect(imageSizeFrom(plannedInputs(brief).providerParams)).toBe("2K");
  });

  it("quotes a 4K edit at the 4K figure, not the 1K one", () => {
    const big = editBrief([region({ left: 100, top: 100, width: 2600, height: 3900 })]);
    expect(previewGeneration(big).cost!.amountUsd).toBeCloseTo(2000 * 0.00012, 6);
  });

  it("quotes ONE CALL PER CROP, because that is what runs", () => {
    // Three far-apart regions are three crops and three provider calls (studio/composite.ts explains
    // why one union crop is not an option). Quoting one would have her approve a third of the spend.
    const three = editBrief([
      region({ left: 0, top: 0, width: 200, height: 200 }),
      region({ left: 1500, top: 2000, width: 200, height: 200 }),
      region({ left: 3000, top: 5000, width: 200, height: 200 }),
    ]);
    const one = editBrief([region({ left: 0, top: 0, width: 200, height: 200 })]);
    const per = previewGeneration(one).cost!.amountUsd;
    expect(previewGeneration(three).cost!.amountUsd).toBeCloseTo(per * 3, 6);
    expect(previewGeneration(three).cost!.detail).toMatch(/3 areas/);
  });

  /**
   * ─── A MERGED EDIT IS QUOTED AT WHAT IT ACTUALLY CALLS ───────────────────────────────────────
   *
   * The quote multiplies by the CROP count, and same-target regions share a crop. Quoting by region
   * would over-charge a merged job — safe for us and still wrong, because she would decline an edit
   * on a price we invented. The preview and the generate leg derive crops from the same frozen
   * brief, so this number is the one that runs.
   */
  it("quotes a MERGED multi-region target as the one call it makes", () => {
    const socks = editBrief([
      region({ label: "adidas socks", left: 1800, top: 4000, width: 200, height: 300 }),
      region({ label: "adidas socks", left: 2100, top: 4000, width: 200, height: 300 }),
    ]);
    const one = editBrief([region({ label: "adidas socks", left: 1800, top: 4000, width: 200, height: 300 })]);
    // Two rectangles, one crop, one call — and a quote that says so rather than doubling.
    expect(previewGeneration(socks).cost!.amountUsd).toBeCloseTo(
      previewGeneration(one).cost!.amountUsd,
      6,
    );
    expect(previewGeneration(socks).cost!.detail).not.toMatch(/2 areas/);
  });

  it("keeps `n` at 1 so a per-call estimate is a per-call estimate", () => {
    // The region count lives in the quote, never in inputs.n — otherwise every one of the three
    // calls would estimate itself at 3x and the cost log would record 9x for a 3x job.
    const three = editBrief([region(), region({ left: 100, top: 100 }), region({ left: 900, top: 900 })]);
    expect(plannedInputs(three).inputs.n ?? 1).toBe(1);
  });
});

describe("the source frame is still priced as the input it is", () => {
  it("adds its reference tokens on top of the sized image count", () => {
    process.env.STUDIO_TOKENS_PER_REFERENCE = "258";
    const brief = editBrief([region()]);
    // 1 reference — the frame being edited — at the same rate the rest of the table quotes them.
    expect(previewGeneration(brief).cost!.amountUsd).toBeCloseTo((1120 + 258) * 0.00012, 4);
  });
});

describe("negative control — a size that drifts defeats the ceiling", () => {
  /**
   * Simulates the bug this whole design exists to make impossible: the preview derives one size and
   * the generate leg derives another. The approved ceiling is the preview's figure; the spend is the
   * generate leg's. Under-quoting passes the check and over-spends silently, which is why the
   * derivation must not depend on anything that can differ between the two calls.
   */
  it("under-quotes by 79% when preview says 2K and the run says 4K", () => {
    const brief = editBrief([region()]);
    const approved = previewGeneration(brief).cost!.amountUsd; // 2K — what she agreed to

    const drifted = estimateCost(plannedInputs(brief).inputs, "gemini-3-pro-image", {
      providerParams: { generationConfig: { imageConfig: { imageSize: "4K" } } },
    }).amountUsd;

    expect(approved).toBeCloseTo(0.1344, 4);
    expect(drifted).toBeCloseTo(0.24, 4);
    // The ceiling check is `quoted > approved`. The quote she was shown is NOT greater than itself,
    // so nothing fires — and the run bills the larger figure. The guard is only as good as the
    // guarantee that these two are the same derivation.
    expect(drifted > approved).toBe(true);
    expect(drifted / approved).toBeCloseTo(2000 / 1120, 3);
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
