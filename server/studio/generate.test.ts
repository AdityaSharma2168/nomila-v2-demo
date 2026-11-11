/**
 * generate.test.ts — THE FORK, and nothing else.
 *
 * `runsInline` is the one place that decides whether studio/generate.ts runs a task inside the
 * request or queues it for the detached runner. It is a wall-clock decision, not a capability one:
 * the router and both adapters support all three tasks. So the thing worth pinning is exactly which
 * tasks run inline, and that the other one is handed over without spending twice.
 *
 * The two properties asserted hardest:
 *   1. Both image tasks run inline. `image.edit` is the same single synchronous `generateContent`
 *      call as `image.generate` — it differs only in carrying reference parts — so holding it back
 *      refused the workspace's main verb for no reason. That regression is what this suite exists
 *      to stop coming back.
 *   2. `video.generate` is QUEUED, and queued at the right MOMENT: after the approval is consumed
 *      and after the spend caps, before any provider call. The ordering is the invariant — a runner
 *      that picks the job up finds the approval already claimed and cannot re-spend it.
 *      (This replaced "video is still refused" when video V3 deleted `assertRunnableInline`.)
 *
 * Everything under the gate is mocked at the module boundary, so "did we spend?" is a call count.
 * The briefs are hand-built for the same reason preview.test.ts hand-builds them: this suite is
 * about the gate, not about the DB read.
 */
import type { CreativeBrief } from "./brief";
import type { GenerationPlan, GenerationResult, GenerationTask } from "./types";

jest.mock("../db", () => ({ db: {}, pool: { end: async () => {}, on: () => {} } }));

const estimateMock = jest.fn();
const generateMock = jest.fn();
// The real router always answers with a `cost` (studio/types.ts GenerationResult); the stubs below
// mostly do not say one, so the boundary supplies the plan's own figure unless a stub sets its own —
// generate.ts reads it at succeed (PR 13, generation_jobs.cost_usd).
const STUB_COST = { amountUsd: 0.1344, currency: "USD", basis: "estimated", detail: "stub" };
jest.mock("./router", () => ({
  estimate: (...a: unknown[]) => estimateMock(...a),
  generate: async (...a: unknown[]) => {
    const r = await generateMock(...a);
    return r && typeof r === "object" && !("cost" in r) ? { cost: STUB_COST, ...r } : r;
  },
}));

const spentTodayUsdMock = jest.fn();
const createGenerationJobMock = jest.fn();
const recordGeneratedAssetMock = jest.fn();
const succeedJobMock = jest.fn();
const failJobMock = jest.fn();
jest.mock("./jobs", () => ({
  createGenerationJob: (...a: unknown[]) => createGenerationJobMock(...a),
  claimJob: async () => true,
  cancelJob: async () => {},
  failJob: (...a: unknown[]) => failJobMock(...a),
  succeedJob: (...a: unknown[]) => succeedJobMock(...a),
  recordGeneratedAsset: (...a: unknown[]) => recordGeneratedAssetMock(...a),
  assetsForJob: async () => [],
  // The day's running total, which the spend gate reads. Zero here: this suite is about the ORDER
  // the gate runs in, and the ceiling itself is proven arithmetically in spendCaps.test.ts and
  // through the real door in routes/studio.generate.test.ts.
  spentTodayUsd: (...a: unknown[]) => spentTodayUsdMock(...a),
}));

// The queue side of the fork. `queueJob` is the ONLY thing studio/generate.ts calls on the detached
// path, and it is the boundary this suite stops at — the runner's own behaviour (lease, submit-once,
// reap) is proven against a real database in videoJobs.test.ts and videoRunner.test.ts.
const queueJobMock = jest.fn();
jest.mock("./videoJobs", () => ({
  queueJob: (...a: unknown[]) => queueJobMock(...a),
}));

const consumePreviewMock = jest.fn();
jest.mock("./previewStore", () => ({
  ...jest.requireActual("./previewStore"),
  consumePreview: (...a: unknown[]) => consumePreviewMock(...a),
}));

const orientToPixelsMock = jest.fn();
jest.mock("./orient", () => ({
  // needsOrienting is pure arithmetic and is proven in orient.test.ts — run the real one so this
  // suite tests the WIRING rather than a restatement of the predicate.
  ...jest.requireActual("./orient"),
  orientToPixels: (...a: unknown[]) => orientToPixelsMock(...a),
}));

/**
 * The composite is mocked HERE for the same reason the router and the job rows are: this suite is
 * about the ORDER things happen in, not about pixels. The paste-back's actual guarantee — that
 * everything outside the region is the original's — is proven against an adversarial provider in
 * composite.test.ts, on real images, where it belongs. Running real sharp here would mean encoding a
 * 24MP fixture per test to assert something another suite already asserts better.
 *
 * What IS asserted here is the wiring: one crop per region, one fetch of the frame, and the
 * composited result being what reaches the shape guard and the store.
 */
const cropFrameMock = jest.fn();
const pasteBackMock = jest.fn();
jest.mock("./composite", () => ({
  // planCrops/regionWithinCrop are pure arithmetic proven in composite.test.ts — run the REAL ones,
  // so this suite tests the wiring rather than a restatement of the crop math.
  ...jest.requireActual("./composite"),
  cropFrame: (...a: unknown[]) => cropFrameMock(...a),
  pasteBack: (...a: unknown[]) => pasteBackMock(...a),
}));

/** What reaches the store — observable, so a test can see the bytes and the type that were kept. */
const saveBufferMock = jest.fn();
jest.mock("../lib/mediaStore", () => ({
  // A GCS path has to be signed before a provider can read it; the signed url is the credential,
  // which is why the suite also checks it never reaches the stored ref list.
  signedUrl: async (p: string) => `https://signed.test/${p}?sig=secret`,
  saveBuffer: (...a: unknown[]) => saveBufferMock(...a),
  rehostFromUrl: async () => ({ gcs_path: "athletes/athlete-1/studio/job-1/0", content_type: "image/png", bytes: 4 }),
}));

/**
 * Creative QA, at the module boundary. Q's stage is observation-only and never throws (qa/inspect.ts);
 * what this suite asserts is only the WIRING — that a generation reaches it, with which asset.
 * `STUDIO_CREATIVE_QA` stays off unless a test turns it on, so every other test is unaffected.
 */
const inspectAssetMock = jest.fn();
jest.mock("./qa/inspect", () => ({
  inspectAsset: (...a: unknown[]) => inspectAssetMock(...a),
}));

import sharp from "sharp";
import {
  runStudioGeneration,
  NATIVE_EDIT_SWITCHED_OFF,
  VIDEO_NOT_ENABLED,
} from "./generate";
import { imageSizeFrom } from "./config";
import { compileNativeInstruction, type FrozenEditIntent } from "./nativeEdit";
import { GenerationError } from "./types";

// ── Briefs, shaped exactly like assembleBrief's output. ─────────────────────────────────────────
const SOURCE = {
  mediaAssetId: "asset-1",
  ref: "athletes/synthetic/frame-0709.jpg",
  width: 4000,
  height: 6000,
  editRegions: [{ label: "competitor swoosh", left: 2125, top: 2345, width: 780, height: 780 }],
};

/** The same frame, stored on its side. Display dims are unchanged; the BUFFER is not. */
const ROTATED_SOURCE = { ...SOURCE, orientation: 6 };

const ORIENTED_BYTES = Buffer.from("upright-pixels");
/** What cropFrame hands the model in place of the frame. Opaque here; real in composite.test.ts. */
const CROP_BYTES = Buffer.from("one-padded-crop");

/**
 * Three regions of DELIBERATELY DIFFERENT SIZES, on a 4000x6000 frame.
 *
 * The size spread is the load-bearing part and is not decoration. A trio of similarly-small regions
 * all resolve to the same imageSize, so a "priced == sent" assertion over them passes even if the
 * code sized each crop independently — the bug and the correct behaviour are indistinguishable. The
 * first region here pads to well under a megapixel and the second is large enough to need the top
 * size, so per-crop sizing and per-job sizing give DIFFERENT answers and the assertion can fail.
 */
const THREE_REGIONS = [
  { label: "the bib number", left: 100, top: 200, width: 200, height: 200 },   // ~0.5 MP crop
  { label: "the whole jersey", left: 400, top: 800, width: 2600, height: 3900 }, // over the ceiling
  { label: "the sleeve logo", left: 3400, top: 5300, width: 240, height: 240 }, // ~0.6 MP crop
];

function makeBrief(over: Partial<CreativeBrief["job"]> = {}): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: "2026-08-29T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      mode: "generate",
      source: null,
      direction: { set: "chosen", statement: "Something that reads as hers.", untrusted: false, featuredPieces: [] },
      ...over,
    },
    athlete: {
      athleteId: "athlete-1",
      identity: {
        name: "Test Spike Athlete", firstName: "Test", identityLine: "Soccer · Example · National Team",
        sport: "soccer", org: "Example", division: "D1", conference: "Example Conference",
        segment: "college", tier: "Established", marqueeTag: "National Team",
      },
      voice: { storyArc: "A defender who kept choosing the harder programme.", highlights: [] },
      audience: { descriptor: "women 18-24 · top market US", ageRange: "18-24", topCity: "Exampleton", topMarket: "US", share: 66 },
      aesthetic: { register: "Established · college · soccer", notes: [] },
      goal: "Grow her audience with something that reads as hers, not as an ad",
      commercialState: "undisclosed",
    },
    brand: null,
    gaps: [],
  } as unknown as CreativeBrief;
}

/** An `edit`: a real frame, and the regions that measure what may change. */
const editBrief = () => makeBrief({ mode: "edit", source: SOURCE });
/** A `clip`: the deliverable is motion, so the fork picks video.generate. */
const clipBrief = () => makeBrief({ deliverable: "clip" });

const planFor = (task: GenerationTask): GenerationPlan => ({
  task,
  provider: "vertex",
  model: task === "video.generate" ? "veo-3.1-generate-001" : "gemini-3-pro-image",
  inputs: { prompt: "p", references: task === "image.edit" ? 1 : 0, n: 1 },
  cost: { amountUsd: 0.1344, currency: "USD", basis: "estimated", detail: "1 × ~1120 tok" },
});

/** A minimal but well-formed PNG header — signature + IHDR — so parseImageSize measures it for real. */
function pngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(17);
  ihdr.writeUInt32BE(13, 0);              // chunk length
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);                 // bit depth
  return Buffer.concat([sig, ihdr]);
}

const run = (brief: CreativeBrief) =>
  runStudioGeneration({ athleteId: "athlete-1", brief, previewId: "preview-1", approvedCostUsd: 1 });

beforeEach(() => {
  jest.clearAllMocks();
  estimateMock.mockImplementation((task: GenerationTask) => planFor(task));
  spentTodayUsdMock.mockResolvedValue(0);
  generateMock.mockResolvedValue({
    assets: [{ bytes: Buffer.from("png!"), mimeType: "image/png", width: 1024, height: 1280 }],
  } as unknown as GenerationResult);
  createGenerationJobMock.mockResolvedValue({ id: "job-1", athlete_id: "athlete-1" });
  queueJobMock.mockResolvedValue(true);
  saveBufferMock.mockResolvedValue({ gcs_path: "athletes/athlete-1/studio/job-1/0", content_type: "image/png", bytes: 4 });
  consumePreviewMock.mockResolvedValue({ claimed: true });
  recordGeneratedAssetMock.mockResolvedValue({ id: "media-1", gcs_path: "athletes/athlete-1/studio/job-1/0", approval_status: "draft" });
  orientToPixelsMock.mockResolvedValue({ bytes: ORIENTED_BYTES, mimeType: "image/jpeg" });
  cropFrameMock.mockResolvedValue(CROP_BYTES);
  // The composite's output is the ORIGINAL's frame — that is its whole contract, and returning
  // anything else here would be mocking a composite that does not composite.
  // ⚠️ maskVerdicts IS PART OF THE CONTRACT, one entry per region across all patches. runMaskedEdit
  // reads it to find inversion regions the composite REFUSED, so a mock that omits it is a mock of
  // a pasteBack that cannot report a refusal — which is the whole safety property of the background
  // path. Derived from the patches it was handed rather than hardcoded, so it stays aligned as the
  // suite's fixtures change.
  pasteBackMock.mockImplementation(async (_frame: unknown, patches: { plan: { regions: unknown[] } }[]) => ({
    bytes: pngBytes(SOURCE.width, SOURCE.height),
    mimeType: "image/png",
    width: SOURCE.width,
    height: SOURCE.height,
    jpegQuality: null,
    maskVerdicts: patches.flatMap((p) => p.plan.regions.map(() => "off")),
  }));
  global.fetch = jest.fn(async () => ({
    ok: true,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as unknown as typeof fetch;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("both image tasks run inline", () => {
  it("image.edit passes the gate and reaches the router", async () => {
    const out = await run(editBrief());

    expect(out.spent).toBe(true);
    expect(out.jobId).toBe("job-1");
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toBe("image.edit");
    // With the figure the result carried (PR 13): the job row remembers what it cost.
    expect(succeedJobMock).toHaveBeenCalledWith("job-1", "athlete-1", 0.1344);
  });

  it("image.generate still passes — the edit entry did not displace it", async () => {
    const out = await run(makeBrief());

    expect(out.spent).toBe(true);
    expect(generateMock.mock.calls[0][0]).toBe("image.generate");
  });

  it("hands the provider the CROP's bytes, and no url for the frame at all", async () => {
    // THIS CHANGED, AND THE CHANGE IS THE FEATURE. The frame used to travel as a signed url and the
    // model re-rendered the whole photograph. It now never leaves this process: the frame is read
    // once, cropped, and only the crop is sent — which is what makes everything outside the region
    // ours to preserve rather than the model's to respect.
    await run(editBrief());

    const inputs = generateMock.mock.calls[0][1] as { references: { kind: string; bytes?: Buffer; url?: string }[] };
    expect(inputs.references[0]).toEqual({
      kind: "bytes", bytes: CROP_BYTES, mimeType: "image/png",
      // Normalizing or cropping must not cost the frame its slot — the resolver returns a bare
      // ImageRef and runGeneration re-attaches the role.
      slot: "frame", label: "the frame to preserve",
    });
    // Unchanged and still the point: the signed url's query string IS the credential, so only
    // PATHS are handed on to be recorded. Nothing signed reaches the log or the provider.
    expect(generateMock.mock.calls[0][2]).toMatchObject({ refIds: [SOURCE.ref] });
    expect(JSON.stringify(inputs.references)).not.toContain("sig=secret");
  });

  it("runs one provider call per region, and reads the frame only once", async () => {
    // Each region gets its own crop and its own call (one union crop would be the whole photograph
    // for two far-apart regions — see composite.ts). The 24MP read and decode is the expensive part
    // and is hoisted out of the loop.
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: THREE_REGIONS } }));

    expect(generateMock).toHaveBeenCalledTimes(3);
    expect(cropFrameMock).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // One composite, carrying all three patches, into one original.
    expect(pasteBackMock).toHaveBeenCalledTimes(1);
    expect(pasteBackMock.mock.calls[0][1]).toHaveLength(3);
  });

  it("tells each call which crop it is for, and nothing else about the money changes", async () => {
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: THREE_REGIONS } }));

    const indices = generateMock.mock.calls.map((c) => (c[2] as { cropIndex?: number }).cropIndex);
    expect(indices).toEqual([0, 1, 2]);
    // The size is the JOB's, identical on every call — the property the approved ceiling rests on.
    const sizes = generateMock.mock.calls.map(
      (c) => ((c[2] as { providerParams?: Record<string, never> }).providerParams as never as { generationConfig: { imageConfig: { imageSize: string } } }).generationConfig.imageConfig.imageSize,
    );
    expect(new Set(sizes).size).toBe(1);
  });

  /**
   * ─── PARTIAL FAILURE: ONE BAD CROP MUST NOT BILL HER TWICE ───────────────────────────────────
   *
   * The approval is consumed BEFORE the first provider call (studio/previewStore.ts — it has to be,
   * it is the double-tap guard). So when the loop rethrew on crop 3 of 3, two calls had already
   * billed, the job failed, nothing was saved, and the retry needed a FRESH approval at the FULL
   * price. She paid twice for the crops that worked the first time.
   *
   * These pin the other direction: what landed is kept, what failed is named, and the retry she
   * needs is one target rather than all of them.
   */
  describe("one crop failing", () => {
    const threeRegionBrief = () =>
      makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: THREE_REGIONS } });

    /** Fail exactly one call, by index, and succeed the rest. */
    const failCropAt = (badIndex: number) => {
      let i = 0;
      generateMock.mockImplementation(async () => {
        const mine = i++;
        if (mine === badIndex) throw new Error("provider said no");
        return {
          assets: [{ bytes: Buffer.from("png!"), mimeType: "image/png", width: 1024, height: 1280 }],
        } as unknown as GenerationResult;
      });
    };

    it("KEEPS the crops that landed instead of throwing them away", async () => {
      failCropAt(2);
      const out = await run(threeRegionBrief());

      // It still composited — with the two patches that worked, not zero.
      expect(pasteBackMock).toHaveBeenCalledTimes(1);
      expect(pasteBackMock.mock.calls[0][1]).toHaveLength(2);
      expect(out.spent).toBe(true);
    });

    it("names the target that failed, so she knows what is missing", async () => {
      failCropAt(2);
      const out = await run(threeRegionBrief());
      expect(out.failedTargets).toEqual(["the sleeve logo"]);
    });

    it("carries on past a failure in the MIDDLE — later crops still run", async () => {
      // A `continue` that accidentally became a `break` would pass the test above and silently drop
      // every target after the first failure.
      failCropAt(0);
      const out = await run(threeRegionBrief());

      expect(generateMock).toHaveBeenCalledTimes(3);
      expect(pasteBackMock.mock.calls[0][1]).toHaveLength(2);
      expect(out.failedTargets).toEqual(["the bib number"]);
    });

    it("does not re-bill: it never retries a crop inside the same job", async () => {
      // The fix must not turn one failure into a retry loop against her approved ceiling. One call
      // per crop, failures included — the retry is a NEW preview she approves.
      failCropAt(1);
      await run(threeRegionBrief());
      expect(generateMock).toHaveBeenCalledTimes(THREE_REGIONS.length);
      expect(consumePreviewMock).toHaveBeenCalledTimes(1);
    });

    it("reports nothing when every crop lands — a clean run's envelope is unchanged", async () => {
      const out = await run(threeRegionBrief());
      expect(out.failedTargets).toBeUndefined();
      expect(pasteBackMock.mock.calls[0][1]).toHaveLength(3);
    });

    it("FAILS the job when nothing landed — there is no photo to hand back", async () => {
      // The one case that still throws. A composite of zero patches would be the original returned
      // as though it had been edited, which is the dishonest outcome.
      generateMock.mockRejectedValue(new Error("provider said no"));
      await expect(run(threeRegionBrief())).rejects.toThrow(/None of the changes could be applied/i);
      expect(pasteBackMock).not.toHaveBeenCalled();
    });

    it("treats a url-returning crop as a failed crop, not a failed job", async () => {
      // Same reasoning as any other bad crop: it cannot be composited, but it must not take the
      // crops that DID come back as bytes down with it.
      let i = 0;
      generateMock.mockImplementation(async () => {
        const mine = i++;
        return mine === 1
          ? ({ assets: [{ url: "https://x/y.png", mimeType: "image/png" }] } as unknown as GenerationResult)
          : ({ assets: [{ bytes: Buffer.from("png!"), mimeType: "image/png", width: 1024, height: 1280 }] } as unknown as GenerationResult);
      });
      const out = await run(threeRegionBrief());
      expect(pasteBackMock.mock.calls[0][1]).toHaveLength(2);
      expect(out.failedTargets).toEqual(["the whole jersey"]);
    });
  });

  it("refuses a provider that returns a url — there is nothing to paste", async () => {
    // A url-returning provider cannot be composited. Falling back to the model's own frame would
    // hand her the full re-render this path exists to leave, so it refuses instead.
    generateMock.mockResolvedValue({ assets: [{ url: "https://x/y.png", mimeType: "image/png" }] } as unknown as GenerationResult);
    await expect(run(editBrief())).rejects.toThrow(/can't paste into your photo/i);
    expect(pasteBackMock).not.toHaveBeenCalled();
  });

  it("records what an edit was derived from — the link is provenance, not decoration", async () => {
    await run(editBrief());
    expect(recordGeneratedAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ derivedFromAssetId: SOURCE.mediaAssetId }),
    );
  });

  it("leaves derivedFrom null for net-new work, which has no frame to stay continuous with", async () => {
    await run(makeBrief());
    expect(recordGeneratedAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({ derivedFromAssetId: null }),
    );
  });
});

/**
 * ─── WHAT WE PRICED IS WHAT WE SENT ─────────────────────────────────────────────────────────────
 *
 * THE invariant this whole checkpoint exists for, asserted at the two REAL call sites rather than on
 * the pure function underneath them.
 *
 * `estimate()` produces the figure that studio/previewStore records and that generate.ts checks
 * against the approved ceiling. `generate()` is the request that actually bills. They are handed
 * providerParams by two different code paths — previewGeneration at step 1, and runGeneration once
 * per crop inside runMaskedEdit — and if those ever carried a different `imageSize`, the athlete
 * would approve one job and pay for another.
 *
 * ⚠️ AND THE CEILING WOULD NOT CATCH IT. This is the part worth being precise about, because it is
 * easy to assume otherwise. The money guards compare a QUOTE against a QUOTE: generate.ts
 * re-derives previewGeneration and tests `fresh > approved`. Nothing in that path ever looks at the
 * request body. A run that quotes 2K and then asks the provider for 4K passes every check —
 * `fresh === approved` because both came from the same (correct) derivation, and the divergence
 * lives entirely downstream of the number. The ceiling guards against the brief changing, not
 * against the request disagreeing with the quote.
 *
 * So this assertion is not redundant with the ceiling. It is the ONLY thing standing between the
 * quote and the spend, and it is why it compares the two mocks' arguments directly.
 */
describe("what we priced is what we sent", () => {
  /** The providerParams whose cost became the ceiling — step 1's estimate, the one with no cropIndex. */
  const pricedParams = () =>
    (estimateMock.mock.calls[0][2] as { providerParams?: Record<string, unknown> }).providerParams;

  /** The providerParams that actually reached the router, once per region. */
  const sentParams = () =>
    generateMock.mock.calls.map((c) => (c[2] as { providerParams?: Record<string, unknown> }).providerParams);

  it("the router is called with the imageSize the preview priced — one region", async () => {
    await run(editBrief());

    const priced = imageSizeFrom(pricedParams());
    expect(priced).toBeDefined();                       // an edit always names a size
    expect(sentParams()).toHaveLength(1);
    for (const sent of sentParams()) expect(imageSizeFrom(sent)).toBe(priced);
  });

  it("...and on every one of three regions of very different sizes", async () => {
    // THE CASE WITH TEETH. These three crops would size to 1K, 4K and 1K if each were sized on its
    // own, so this fails the moment anything derives the size per call instead of per job — which is
    // the plausible regression, dressed up as an optimization.
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: THREE_REGIONS } }));

    const priced = imageSizeFrom(pricedParams());
    const sent = sentParams();
    expect(sent).toHaveLength(3);
    expect(priced).toBe("4K");                       // the job's size is the LARGEST crop's
    for (const p of sent) expect(imageSizeFrom(p)).toBe(priced);
    expect(new Set(sent.map(imageSizeFrom)).size).toBe(1);
  });

  it("...for a crop large enough to need 4K, not just the common 2K case", async () => {
    // Pinning both arms: a bug that hardcoded either size would pass one of these and fail the other.
    await run(makeBrief({
      mode: "edit",
      source: { ...SOURCE, editRegions: [{ label: "the whole jersey", left: 100, top: 100, width: 2600, height: 3900 }] },
    }));
    expect(imageSizeFrom(pricedParams())).toBe("4K");
    for (const p of sentParams()) expect(imageSizeFrom(p)).toBe("4K");
  });

  it("prices no size for a generate, and sends none either", async () => {
    await run(makeBrief());
    expect(imageSizeFrom(pricedParams())).toBeUndefined();
    for (const p of sentParams()) expect(imageSizeFrom(p)).toBeUndefined();
  });

  it("the WHOLE providerParams object agrees, not merely the size", async () => {
    // A narrower assertion would let a sibling knob (a future personGeneration, a seed) diverge
    // between the quote and the request without anything noticing.
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: THREE_REGIONS } }));
    for (const p of sentParams()) expect(p).toEqual(pricedParams());
  });
});

describe("video is DARK unless STUDIO_VIDEO_ENABLED says otherwise", () => {
  /**
   * The flag that replaced `assertRunnableInline`. The old hold was unconditional and removable only
   * by a deploy; this is the same refusal, at the same seam, with a switch on it — so V3 merging
   * does not by itself make a clip reachable.
   *
   * The properties that matter are the ones the old hold had: refused ABOVE the job row and ABOVE
   * the approval, so nothing is opened, consumed or reconciled while video is off.
   */
  const OFF = { ...process.env };
  afterEach(() => {
    process.env = { ...OFF };
  });

  it("refuses a clip with unsupported_task when the flag is unset", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    expect.assertions(3);
    try {
      await run(clipBrief());
    } catch (e) {
      expect(e).toBeInstanceOf(GenerationError);
      expect((e as GenerationError).code).toBe("unsupported_task");
      expect((e as GenerationError).message).toBe(VIDEO_NOT_ENABLED);
    }
  });

  it("is not satisfied by STUDIO_ENABLED — the two flags are separate on purpose", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    process.env.STUDIO_ENABLED = "true";
    await expect(run(clipBrief())).rejects.toThrow(VIDEO_NOT_ENABLED);
  });

  it("is not satisfied by a truthy-but-wrong value", async () => {
    process.env.STUDIO_VIDEO_ENABLED = "1";
    await expect(run(clipBrief())).rejects.toThrow(VIDEO_NOT_ENABLED);
  });

  it("opens no job row, consumes no approval and never queues while it is off", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    await expect(run(clipBrief())).rejects.toThrow(VIDEO_NOT_ENABLED);
    expect(createGenerationJobMock).not.toHaveBeenCalled();
    expect(consumePreviewMock).not.toHaveBeenCalled();
    expect(queueJobMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the spend gate — the day's total is not even read while video is off", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    await expect(run(clipBrief())).rejects.toThrow(VIDEO_NOT_ENABLED);
    expect(spentTodayUsdMock).not.toHaveBeenCalled();
  });

  it("does not hold IMAGES — the flag is about video, not about Studio", async () => {
    delete process.env.STUDIO_VIDEO_ENABLED;
    const out = await run(makeBrief({ deliverable: "post" }));
    expect(out.jobId).toBe("job-1");
    expect(generateMock).toHaveBeenCalled();
  });
});

describe("video is QUEUED, and queued only after the approval and the caps", () => {
  // Every test below is about what happens ONCE video is switched on. The flag itself is covered
  // above; here it is turned on so the path under test is reachable at all.
  const OFF = { ...process.env };
  beforeEach(() => {
    process.env.STUDIO_VIDEO_ENABLED = "true";
  });
  afterEach(() => {
    process.env = { ...OFF };
  });

  /**
   * THIS SUITE REPLACES "video is still held". The hold — `assertRunnableInline` — is gone, and with
   * it the six assertions that a clip throws `VIDEO_NOT_INLINE_YET`. Keeping them passing would have
   * meant keeping video unreachable, so they are not ported; they are inverted.
   *
   * What the old suite was really protecting is still protected, and is what these assert:
   *   - a clip still makes NO inline provider call (`generateMock` untouched) — that was the point
   *     of the hold, and detaching keeps it true rather than removing it;
   *   - the spend caps, which the hold sat above and therefore hid, are now REACHED for video. The
   *     old suite pinned the order so that "the day someone deletes the hold can see what they are
   *     uncovering: the spend gate, not nothing." This is that day, and this is that check.
   */
  it("returns queued instead of throwing, with no assets", async () => {
    const out = await run(clipBrief());
    expect(out).toMatchObject({ jobId: "job-1", spent: true, queued: true });
    expect(out.assets).toEqual([]);
  });

  it("hands the job to the queue, scoped to the athlete", async () => {
    await run(clipBrief());
    expect(queueJobMock).toHaveBeenCalledWith("job-1", "athlete-1");
  });

  it("makes no provider call in the request — the reason video was ever held", async () => {
    await run(clipBrief());
    expect(generateMock).not.toHaveBeenCalled();
    expect(succeedJobMock).not.toHaveBeenCalled();
    expect(recordGeneratedAssetMock).not.toHaveBeenCalled();
  });

  it("opens the job row and consumes the approval BEFORE queueing — the invariant the runner relies on", async () => {
    await run(clipBrief());
    expect(createGenerationJobMock).toHaveBeenCalled();
    expect(consumePreviewMock).toHaveBeenCalled();
    // Ordering, not just occurrence: a runner that picks this job up finds the approval already
    // claimed and has nothing left to spend. That is what makes a lease handoff free.
    expect(consumePreviewMock.mock.invocationCallOrder[0]).toBeLessThan(
      queueJobMock.mock.invocationCallOrder[0],
    );
  });

  it("REACHES the spend gate now — the day's total is read for a clip", async () => {
    await run(clipBrief());
    expect(spentTodayUsdMock).toHaveBeenCalled();
  });

  it("is refused by the caps before it is ever queued, when the quote is over the approved figure", async () => {
    estimateMock.mockImplementation((task: GenerationTask) => ({
      ...planFor(task),
      cost: {
        amountUsd: 999,
        currency: "USD",
        basis: "estimated",
        detail: "over",
      },
    }));
    await expect(run(clipBrief())).rejects.toThrow(GenerationError);
    expect(queueJobMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("fails loudly rather than silently dropping the job when the queue refuses it", async () => {
    queueJobMock.mockResolvedValue(false);
    await expect(run(clipBrief())).rejects.toThrow(/could not be queued/);
  });

  it("leaves the image path inline — the fork is by task, not by a flag", async () => {
    const out = await run(makeBrief({ deliverable: "post" }));
    expect(out.queued).toBeFalsy();
    expect(queueJobMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalled();
  });
});

describe("the spend gate runs on the image path, and its refusals reach the caller", () => {
  /**
   * The wiring, not the arithmetic. `runStudioGeneration` now reads four figures and hands them to
   * studio/spendCaps.ts; these prove it reads them and that a refusal stops the job dead. Which
   * comparison fires for which quote is spendCaps.test.ts's business.
   */
  it("reads the day's total for THIS athlete before spending", async () => {
    await run(editBrief());
    expect(spentTodayUsdMock).toHaveBeenCalledWith("athlete-1");
  });

  it("refuses when the day's ceiling is already met, and never reaches the router", async () => {
    process.env.STUDIO_MAX_DAY_USD = "1";
    spentTodayUsdMock.mockResolvedValue(0.95);
    try {
      await expect(run(editBrief())).rejects.toThrow(/daily ceiling/);
      expect(generateMock).not.toHaveBeenCalled();
      expect(consumePreviewMock).not.toHaveBeenCalled();
      expect(createGenerationJobMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.STUDIO_MAX_DAY_USD;
    }
  });

  it("refuses over the per-job cap without burning her approval", async () => {
    process.env.STUDIO_MAX_JOB_USD = "0.05";
    try {
      await expect(run(editBrief())).rejects.toThrow(/per-job limit/);
      expect(generateMock).not.toHaveBeenCalled();
      expect(consumePreviewMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.STUDIO_MAX_JOB_USD;
    }
  });
});

describe("a rotated source frame is normalized before any provider sees it", () => {
  const rotatedBrief = () => makeBrief({ mode: "edit", source: ROTATED_SOURCE });

  /** The reference list as it reached the router. */
  const refsSentFor = async (brief: CreativeBrief) => {
    await run(brief);
    return (generateMock.mock.calls[0][1] as { references: ImageRefLike[] }).references;
  };
  type ImageRefLike = { kind: string; url?: string; mimeType?: string; bytes?: Buffer };

  it("straightens the pixels before they are cropped, when the brief says it is rotated", async () => {
    await run(rotatedBrief());

    // The crop is taken from the STRAIGHTENED buffer, not the stored one. That ordering is the
    // whole correctness argument: the regions are measured in display space, so a crop taken from a
    // sideways buffer would cut out the wrong part of the photograph — and then paste it back into
    // the right one.
    expect(orientToPixelsMock).toHaveBeenCalledTimes(1);
    expect(cropFrameMock.mock.calls[0][0]).toBe(ORIENTED_BYTES);
    const refs = await refsSentFor(rotatedBrief());
    expect(refs[0]).toMatchObject({ kind: "bytes", slot: "frame", label: "the frame to preserve" });
  });

  it("still READS an upright source — the free url path is gone, and that is the cost of cropping", async () => {
    // ⚠️ A DELIBERATE REGRESSION IN COST, RECORDED RATHER THAN HIDDEN.
    //
    // An upright frame used to travel to the provider as a signed url and was never read by us at
    // all: zero bytes, zero CPU. A masked edit cannot do that, because the crop has to be cut from
    // the actual pixels — so every edit now fetches and decodes the frame, upright or not.
    //
    // That is the price of the guarantee and it is only paid on the EDIT path. `orientToPixels` is
    // still skipped for an upright frame, so the rotate itself stays conditional; what is no longer
    // conditional is the read.
    await run(makeBrief({ mode: "edit", source: SOURCE }));

    expect(orientToPixelsMock).not.toHaveBeenCalled();  // no rotate — still conditional
    expect(global.fetch).toHaveBeenCalledTimes(1);      // but it IS read now
    expect(cropFrameMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes ONCE per edit, even across three regions — this is not in a loop", async () => {
    // It matters more now than it did: the loop below it runs once per region, and a 24MP decode
    // inside that loop would triple the most expensive thing on the path.
    await run(makeBrief({ mode: "edit", source: { ...ROTATED_SOURCE, editRegions: THREE_REGIONS } }));
    expect(orientToPixelsMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("REFUSES when normalization fails, rather than falling back to the rotated bytes", async () => {
    // The fallback is the trap: it would succeed, bill, and come back edited in the wrong place.
    orientToPixelsMock.mockRejectedValue(new Error("decode failed"));

    await expect(run(rotatedBrief())).rejects.toThrow(/couldn't prepare this photo/i);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("refuses on a failed read too, and never leaks the signed url in the message", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;

    await expect(run(rotatedBrief())).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("sig=secret") }),
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("a generate has no source, so the branch is never entered", async () => {
    await run(makeBrief());
    expect(orientToPixelsMock).not.toHaveBeenCalled();
  });
});

describe("a photograph of HER is downscaled before it is sent; nothing else is", () => {
  /**
   * The reference list as the router received it, by slot. The adapter inlines every reference
   * whole (`toInlinePart`), so what is in this array IS what goes into the request body.
   */
  type SentRef = {
    kind: string;
    url?: string;
    mimeType?: string;
    bytes?: Buffer;
    slot?: string;
  };
  const sentRefs = () =>
    (generateMock.mock.calls[0][1] as { references: SentRef[] }).references;

  /** A real photograph, because sharp is not mocked here and a stub Buffer would not decode. */
  const photo = (width: number, height: number) =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 120, g: 90, b: 70 },
      },
    })
      .jpeg()
      .toBuffer();

  /** Every fetch returns this photograph — the person ref and the product ref both read it. */
  const servePhoto = (bytes: Buffer) => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    })) as unknown as typeof fetch;
  };

  const ref = (role: "person" | "product", name: string) => ({
    role,
    ref: `athletes/synthetic/${name}.jpg`,
    mediaAssetId: `asset-${name}`,
    label: name,
  });

  const withRefs = (...refs: ReturnType<typeof ref>[]) =>
    makeBrief({
      references: refs as CreativeBrief["job"]["references"],
    });

  it("sends her photograph as BYTES at 2048 on the long edge, not as a url", async () => {
    // A pack is up to three of these, and the adapter base64s each one whole into the request body.
    // Three 24 MP uploads is ~20 MB of JSON assembled inside one Cloud Run request.
    servePhoto(await photo(6000, 4000));
    await run(withRefs(ref("person", "me")));

    const her = sentRefs()[0];
    expect(her.kind).toBe("bytes");
    expect(her.mimeType).toBe("image/jpeg");
    const meta = await sharp(her.bytes!).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2048);
    expect(meta.width! / meta.height!).toBeCloseTo(6000 / 4000, 2);
  });

  it("never ENLARGES a photograph that is already small", async () => {
    // Upscaling would invent detail in the one place the model is being asked to copy detail from.
    servePhoto(await photo(900, 1200));
    await run(withRefs(ref("person", "me")));

    const meta = await sharp(sentRefs()[0].bytes!).metadata();
    expect(meta.width).toBe(900);
    expect(meta.height).toBe(1200);
  });

  it("sends her UPRIGHT when the stored file carries an EXIF orientation flag", async () => {
    // ⚠️ THE ONE THAT WAS MISSING, and it cost an $1.09 acceptance run. Two of the three photographs
    // in the real pack are stored 6000x4000 with orientation=8 — upright they are 4000x6000
    // portraits. Sent as stored, the model gets a woman lying on her side and returns a stranger.
    //
    // A landscape 2400x1600 buffer flagged 8 must leave as a PORTRAIT, taller than it is wide. If
    // .rotate() is removed this is 2048x1365 and red.
    const flagged = await sharp({
      create: {
        width: 2400,
        height: 1600,
        channels: 3,
        background: { r: 120, g: 90, b: 70 },
      },
    })
      .withMetadata({ orientation: 8 })
      .jpeg()
      .toBuffer();
    servePhoto(flagged);
    await run(withRefs(ref("person", "me")));

    const meta = await sharp(sentRefs()[0].bytes!).metadata();
    expect(meta.height).toBeGreaterThan(meta.width!);
    expect(Math.max(meta.width!, meta.height!)).toBe(2048);
  });

  it("leaves a PRODUCT photo on the url path — this is the person slot only", async () => {
    // A product is a thing whose fine detail the model is told to reproduce exactly. Shrinking it
    // would be a change to an output nobody asked about, riding in on a payload commit.
    servePhoto(await photo(6000, 4000));
    await run(withRefs(ref("person", "me"), ref("product", "boot")));

    const [her, boot] = sentRefs();
    expect(her.kind).toBe("bytes");
    expect(boot.kind).toBe("url");
    expect(boot.url).toContain("athletes/synthetic/boot.jpg");
  });

  it("falls back to the url when the downscale fails, rather than refusing the generation", async () => {
    // The opposite of the source-frame arm above, deliberately. That one refuses because sending
    // un-normalized bytes produces a wrong edit that still bills. This is an optimization: the url
    // path is exactly what shipped before packs, so sending it is the honest degradation.
    servePhoto(Buffer.from("not an image"));
    const out = await run(withRefs(ref("person", "me")));

    expect(out.spent).toBe(true);
    expect(sentRefs()[0]).toMatchObject({ kind: "url" });
  });

  it("never leaks the signed url into a log or an error when the fetch fails", async () => {
    // The signed url's query string IS the credential (the rule costLog.safeRef exists to keep).
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    const out = await run(withRefs(ref("person", "me")));
    expect(out.spent).toBe(true);
    // Still sent, still as the url it always was — the fallback is the pre-pack behaviour.
    expect(sentRefs()[0]).toMatchObject({ kind: "url" });
  });

  it("does not touch the EDIT path's frame, which has its own rules", async () => {
    // referencesFor refuses a person reference on an edit outright, so this asserts the other half:
    // an edit's frame is not quietly routed through the person arm on its way to the crop.
    servePhoto(await photo(4000, 6000));
    await run(makeBrief({ mode: "edit", source: SOURCE }));
    expect(cropFrameMock).toHaveBeenCalledTimes(1);
  });
});

describe("a photograph of a THING is sent upright when its file says it is not — and never resized", () => {
  /** The reference list as the router received it, in the adapter's slot order. */
  type SentRef = { kind: string; url?: string; mimeType?: string; bytes?: Buffer; slot?: string };
  const sentRefs = () => (generateMock.mock.calls[0][1] as { references: SentRef[] }).references;

  /** A landscape 2400x1600 stored with `orientation=8`: upright it is a 1600x2400 portrait. */
  const flagged = (channels: 3 | 4 = 3) => {
    const image = sharp({
      create: {
        width: 2400,
        height: 1600,
        channels,
        background: channels === 4 ? { r: 120, g: 90, b: 70, alpha: 0.5 } : { r: 120, g: 90, b: 70 },
      },
    }).withMetadata({ orientation: 8 });
    return channels === 4 ? image.png().toBuffer() : image.jpeg().toBuffer();
  };
  const upright = () =>
    sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 120, g: 90, b: 70 } } })
      .jpeg()
      .toBuffer();

  /** Every fetch returns this file — whichever reference reads it. */
  const serve = (bytes: Buffer) => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })) as unknown as typeof fetch;
  };

  const tagged = (role: "product" | "object", name: string) =>
    makeBrief({
      references: [
        { role, ref: `athletes/synthetic/${name}.jpg`, mediaAssetId: `asset-${name}`, label: name },
      ] as CreativeBrief["job"]["references"],
    });

  /** A brand whose only reference is one https image — brand imagery is never hers, never a GCS path. */
  const withBrandImage = () => ({
    ...makeBrief(),
    brand: {
      brandId: 1,
      name: "examplebrand",
      category: "Apparel",
      tier: "established",
      tone: { contentStyle: "clean", values: "effort", audience: "Women 18-24" },
      palette: [],
      dos: [],
      donts: [],
      pieces: [],
      referenceImagery: [{ ref: "https://brand.test/cover.jpg", role: "cover" }],
      recentCampaigns: [],
      competitors: [],
    },
  }) as unknown as CreativeBrief;

  it.each([
    ["product", () => tagged("product", "boot")],
    ["object", () => tagged("object", "bottle")],
    ["brand-imagery", withBrandImage],
  ] as const)("sends a flagged %s photo UPRIGHT, as bytes, at its full size", async (_role, brief) => {
    // The person slot's test, for every other thing she or a brand can attach. A landscape buffer
    // flagged 8 must leave as a PORTRAIT, taller than it is wide. Without the rotate it goes out as
    // the url it always was — the stored bytes, flag included, which the model reads sideways.
    serve(await flagged());
    await run(brief());

    const [sent] = sentRefs();
    expect(sent.kind).toBe("bytes");
    expect(sent.mimeType).toBe("image/jpeg");
    const meta = await sharp(sent.bytes!).metadata();
    expect(meta.height).toBeGreaterThan(meta.width!);
    // Never resized: a thing's detail is what the model is told to reproduce.
    expect([meta.width, meta.height]).toEqual([1600, 2400]);
    // And the flag is gone, so nothing that does honour EXIF can turn it a second time.
    expect(meta.orientation ?? 1).toBe(1);
  });

  it.each([
    ["product", () => tagged("product", "boot"), "athletes/synthetic/boot.jpg"],
    ["object", () => tagged("object", "bottle"), "athletes/synthetic/bottle.jpg"],
    ["brand-imagery", withBrandImage, "https://brand.test/cover.jpg"],
  ] as const)("leaves an UPRIGHT %s photo on the url path, exactly as before", async (_role, brief, where) => {
    // Re-encoding a correct photograph would cost detail for nothing.
    serve(await upright());
    await run(brief());

    const [sent] = sentRefs();
    expect(sent.kind).toBe("url");
    expect(sent.url).toContain(where);
  });

  it("keeps a flagged cut-out's transparency — PNG in with an alpha channel, PNG out, upright", async () => {
    // A JPEG would flatten a cut-out product onto black.
    serve(await flagged(4));
    await run(tagged("product", "cutout"));

    const [sent] = sentRefs();
    expect(sent.mimeType).toBe("image/png");
    const meta = await sharp(sent.bytes!).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect([meta.width, meta.height]).toEqual([1600, 2400]);
  });

  it("falls back to the url when the file cannot be read, rather than refusing the generation", async () => {
    // As `personReference` does, and for its reason: the url path is what shipped. No mask or
    // coordinate depends on a product's pixels, unlike the source frame, which refuses.
    serve(Buffer.from("not an image"));
    const out = await run(tagged("product", "boot"));

    expect(out.spent).toBe(true);
    expect(sentRefs()[0]).toMatchObject({ kind: "url" });
  });
});

describe("the return leg: an edit that comes back the wrong shape never reaches her library", () => {
  /**
   * A real JPEG header at a given size. The check measures the RETURNED BYTES with the same parser
   * the source frame uses, so a stub Buffer would be measured as null and skip the check entirely —
   * which is the branch that must NOT be what makes these pass.
   */
  const jpegOf = (width: number, height: number): Buffer => {
    const sof = Buffer.alloc(6);
    sof.writeUInt8(8, 0);
    sof.writeUInt16BE(height, 1);
    sof.writeUInt16BE(width, 3);
    sof.writeUInt8(3, 5);
    const head = Buffer.alloc(4);
    head.writeUInt8(0xff, 0);
    head.writeUInt8(0xc0, 1);
    head.writeUInt16BE(sof.length + 2, 2);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), head, sof, Buffer.from([0xff, 0xda])]);
  };

  /**
   * What lands in her library. On the masked path that is the COMPOSITE's output, not the provider's
   * — the model returns a patch of a crop, and the thing whose shape has to match the frame is what
   * comes out the other end. So this drives the composite, which is the last step before the guard.
   */
  const returns = (w: number, h: number) =>
    // maskVerdicts carried here too — these tests are about the SHAPE guard, and a composite result
    // missing part of its contract would fail them for the wrong reason. One "off" per region.
    pasteBackMock.mockImplementation(async (_frame: unknown, patches: { plan: { regions: unknown[] } }[]) => ({
      bytes: jpegOf(w, h), mimeType: "image/jpeg", width: w, height: h, jpegQuality: 100,
      maskVerdicts: patches.flatMap((p) => p.plan.regions.map(() => "off")),
    }));

  // SOURCE is 4000x6000 portrait.
  it("refuses a sideways return — the transposed frame", async () => {
    returns(6000, 4000);
    await expect(run(editBrief())).rejects.toThrow(/came back the wrong shape/i);
  });

  it("stores nothing when it refuses, and fails the job", async () => {
    returns(6000, 4000);
    await expect(run(editBrief())).rejects.toThrow();
    expect(recordGeneratedAssetMock).not.toHaveBeenCalled();
    expect(succeedJobMock).not.toHaveBeenCalled();
    expect(failJobMock).toHaveBeenCalled();
  });

  it("names both shapes so the refusal is readable", async () => {
    returns(6000, 4000);
    await expect(run(editBrief())).rejects.toThrow(/4000x6000.*6000x4000/s);
  });

  it("allows the source's own frame through — which is what a composite always produces", async () => {
    returns(SOURCE.width, SOURCE.height);
    await expect(run(editBrief())).resolves.toMatchObject({ spent: true });
  });

  it("allows a RESCALE — that is the separate retouch-contract problem, not this guard", async () => {
    // The live-measured case: 400x300 in, 1200x896 out. Aspect moves 1.3333 → 1.3393, well under
    // the threshold. Blocking it here would be this guard quietly taking on a different job.
    returns(1200, 896);
    await expect(
      run(makeBrief({ mode: "edit", source: { ...SOURCE, width: 1200, height: 896, editRegions: [{ label: "x", left: 100, top: 100, width: 200, height: 150 }] } })),
    ).resolves.toMatchObject({ spent: true });
  });

  it("does not touch a GENERATE — there is no source frame to keep the shape of", async () => {
    // A generate never composites, so it is the PROVIDER's asset that is measured here.
    generateMock.mockResolvedValue({ assets: [{ bytes: jpegOf(6000, 4000), mimeType: "image/jpeg" }] } as unknown as GenerationResult);
    await expect(run(makeBrief())).resolves.toMatchObject({ spent: true });
  });

  it("demands EXACT equality from a composite, not merely a similar aspect", async () => {
    // assertEditKeptItsShape allows 15% of drift because it is guarding a path where the PROVIDER
    // picks the canvas. Here we picked it — the paste-back composites into the source's own pixels —
    // so a rescaled result means the composite did not happen, and "close enough" would be the
    // model's re-render wearing the right shape.
    returns(2000, 3000); // the source's aspect exactly, at half its size
    await expect(run(editBrief())).rejects.toThrow(/isn't the full-resolution original/i);
    expect(recordGeneratedAssetMock).not.toHaveBeenCalled();
    expect(failJobMock).toHaveBeenCalled();
  });

  it("BLOCKS an unmeasurable edit outright, where it used to skip the check and generate", async () => {
    // ─── A DELIBERATE TIGHTENING, AND THE OLD BEHAVIOUR WAS THE DANGEROUS ONE ────────────────────
    //
    // This used to assert that an edit whose frame was never measured generated anyway, with the
    // shape guard skipped for want of anything to compare against. That was defensible while an edit
    // was a whole-frame call. It is not any more: with no dimensions there are no crops, so the only
    // thing left for it to do is the full re-render this path exists to replace — and it would do it
    // silently, having been quoted and approved as an edit.
    //
    // So it refuses before the approval is consumed. Nothing spends.
    generateMock.mockResolvedValue({ assets: [{ bytes: jpegOf(6000, 4000), mimeType: "image/jpeg" }] } as unknown as GenerationResult);
    await expect(
      run(makeBrief({ mode: "edit", source: { ...SOURCE, width: null, height: null } })),
    ).rejects.toThrow(/couldn't match the area to change/i);
    expect(generateMock).not.toHaveBeenCalled();
    expect(consumePreviewMock).not.toHaveBeenCalled();
  });

  it("still skips the check for a GENERATE, which has no frame to compare against", async () => {
    // The shape guard's own skip branch is still reachable and still right — just not via an edit.
    generateMock.mockResolvedValue({ assets: [{ bytes: jpegOf(6000, 4000), mimeType: "image/jpeg" }] } as unknown as GenerationResult);
    await expect(run(makeBrief())).resolves.toMatchObject({ spent: true });
  });
});

// ─── The edit output's orientation ───────────────────────────────────────────────────────────────
//
// ⚠️  THE DIAGNOSIS THAT USED TO BE WRITTEN HERE WAS WRONG, AND IT IS WORTH KNOWING WHY.
//
// It said: the base is a fresh upload, already straightened at ingest, so its orientation is 1 and
// the bytes the model receives are upright — "the base was never the problem" — and the rotation
// therefore had to come from the request not stating a shape.
//
// Half of that was a symptom being read as a fact. The orientation was 1 because
// `parseImageSize` REPORTED 1, and it reported 1 because a real upload carries two APP1 segments —
// Exif, then XMP — and the scanner let the second one overwrite the first (see imageSize.test.ts
// and orientPath.test.ts). Every 24MP upload in the library actually declares orientation 8. So:
//
//   • the frame measured 6000x4000 landscape when it displays 4000x6000 portrait;
//   • `needsOrienting(1)` was false, so studio/orient.ts never ran and the model was handed the
//     RAW sideways buffer;
//   • aspectFor asked for "3:2" — the model was explicitly told to return landscape;
//   • the guard below compared the landscape return against the same wrong number and PASSED it.
//
// One bad measurement, and every stage downstream agreed with it. Measured across nine real edits
// on the live project: every output matched the shape we asked for, and every one displayed
// rotated 90 degrees from what the athlete sees. Three real runs after the parser fix return
// upright, deterministically.
//
// Stating the shape (below) is still right and still necessary. It was just never sufficient on
// its own, because the shape being stated was the wrong one.

describe("the canvas we ask for is the shape of what the model can SEE", () => {
  /**
   * ─── THIS MOVED FROM THE FRAME TO THE CROP, AND IT HAD TO ─────────────────────────────────────
   *
   * These cases used to assert the FRAME's aspect ratio, and that was right while the model was sent
   * the whole photograph. It is wrong now and it fails silently: a masked edit sends a padded CROP,
   * a square region on a 2:3 photograph crops to a square, and asking for 2:3 while showing a square
   * gets back a 2:3 patch which pasteBack's fit:"fill" resize then SQUASHES back into the square.
   * Nothing errors. The edited region is simply distorted, which is only visible by looking.
   *
   * The invariant underneath is unchanged and is the one that matters: the canvas must match the
   * picture in front of the model. What changed is which picture that is.
   */
  const aspectOfFirstCall = () => (generateMock.mock.calls[0][1] as { aspectRatio?: string }).aspectRatio;

  it("asks for the CROP's shape, not the frame's", async () => {
    // SOURCE is 4000x6000 (2:3) with a 780x780 SQUARE region, which pads to a square crop.
    await run(editBrief());
    expect(generateMock.mock.calls[0][0]).toBe("image.edit");
    expect(aspectOfFirstCall()).toBe("1:1");
  });

  it("follows the crop when the region is not square", async () => {
    const tall = makeBrief({
      mode: "edit",
      source: { ...SOURCE, editRegions: [{ label: "her sleeve", left: 1000, top: 1000, width: 400, height: 1600 }] },
    });
    await run(tall);
    const [w, h] = (aspectOfFirstCall() as string).split(":").map(Number);
    expect(w / h).toBeLessThan(1); // a tall crop asks for a tall canvas
  });

  it("gives each region's call its own canvas", async () => {
    await run(makeBrief({
      mode: "edit",
      source: { ...SOURCE, editRegions: [
        { label: "wide", left: 500, top: 500, width: 1200, height: 300 },
        { label: "tall", left: 2000, top: 3000, width: 300, height: 1200 },
      ] },
    }));
    const ratios = generateMock.mock.calls.map((c) => {
      const [w, h] = ((c[1] as { aspectRatio: string }).aspectRatio).split(":").map(Number);
      return w / h;
    });
    expect(ratios[0]).toBeGreaterThan(1); // wide region, wide canvas
    expect(ratios[1]).toBeLessThan(1);    // tall region, tall canvas
  });

  it("still drives everything from DISPLAY dimensions, not the stored buffer's", async () => {
    // The invariant the APP1 bug broke, and it is unchanged by the crop: a file stored 6000x4000
    // with orientation 8 DISPLAYS as 4000x6000, the regions are measured in display space, and the
    // crop is therefore taken from the straightened buffer. Asking anything derived from the stored
    // shape is what shipped rotated edits.
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, orientation: 8 } }));
    expect(orientToPixelsMock).toHaveBeenCalledTimes(1);
    expect(cropFrameMock.mock.calls[0][0]).toBe(ORIENTED_BYTES);
  });

  it("still asks for the FRAME's shape when there is no crop to ask about", async () => {
    // The un-composited fallback: regions measured against a frame whose dimensions we could not
    // read. Already a refusal upstream, but the canvas must still be the frame's if it is reached.
    await run(makeBrief({ mode: "edit", source: { ...SOURCE, editRegions: [] } })).catch(() => {});
    if (generateMock.mock.calls.length) expect(aspectOfFirstCall()).toBe("2:3");
  });

  it("stores an upright return for a rotated-on-disk base instead of refusing it", async () => {
    // End to end for the production shape: base declares orientation 8, displays portrait, and a
    // portrait return must land in her library — not a refusal, and not sideways.
    generateMock.mockResolvedValue({
      assets: [{ bytes: pngBytes(848, 1264), mimeType: "image/png" }],
    } as unknown as GenerationResult);
    await expect(
      run(makeBrief({ mode: "edit", source: { ...SOURCE, width: 4000, height: 6000, orientation: 8 } })),
    ).resolves.toMatchObject({ spent: true });
    expect(recordGeneratedAssetMock).toHaveBeenCalled();
  });

  it("still refuses a sideways return — the guard stays behind the fix, it is not replaced by it", async () => {
    // 6000x4000 PNG: the transpose of the source.
    generateMock.mockResolvedValue({
      assets: [{ bytes: pngBytes(6000, 4000), mimeType: "image/png" }],
    } as unknown as GenerationResult);
    // ─── THE GUARD MOVED DOWN A LEVEL, BECAUSE THE FAILURE DID ──────────────────────────────────
    //
    // A sideways FRAME is now impossible by construction: the composite pastes into the original, so
    // the output has the source's shape whatever the model returns. What replaced that risk is a
    // sideways PATCH, which fit:"fill" would squash into a correctly-placed region — invisible to
    // any dimension check up here. composite.ts refuses it (MAX_PATCH_ASPECT_DRIFT), and this is the
    // wiring assertion that the refusal reaches her as a failed job rather than a distorted photo.
    pasteBackMock.mockRejectedValue(new Error("the edited region came back 6000x4000 for a 1560x1560 crop"));
    await expect(run(editBrief())).rejects.toThrow(/came back 6000x4000/);
    expect(recordGeneratedAssetMock).not.toHaveBeenCalled();
    expect(failJobMock).toHaveBeenCalled();
  });

  it("lets an upright return through and stores it", async () => {
    generateMock.mockResolvedValue({
      assets: [{ bytes: pngBytes(4000, 6000), mimeType: "image/png" }],
    } as unknown as GenerationResult);
    const out = await run(editBrief());
    expect(out.spent).toBe(true);
    expect(recordGeneratedAssetMock).toHaveBeenCalledTimes(1);
  });
});

// ─── A refusal happens INSIDE the composite, after the crop loop can no longer see it ──────────

describe("an inversion region the composite refused is reported as a failed target", () => {
  /** A background brief: one whole-frame region naming the subject to preserve. */
  const backgroundBrief = () =>
    makeBrief({
      mode: "edit",
      source: {
        ...SOURCE,
        editRegions: [
          { label: "a stadium at night", left: 0, top: 0, width: 4000, height: 6000, subjectNoun: "person" },
        ],
      },
    });

  /** pasteBack reporting `refused_<reason>` for every region it was handed. */
  const composeRefusing = (reason: string) =>
    pasteBackMock.mockImplementation(async (_f: unknown, patches: { plan: { regions: unknown[] } }[]) => ({
      bytes: pngBytes(SOURCE.width, SOURCE.height),
      mimeType: "image/png",
      width: SOURCE.width,
      height: SOURCE.height,
      jpegQuality: null,
      maskVerdicts: patches.flatMap((p) => p.plan.regions.map(() => `refused_${reason}`)),
    }));

  it("fails the job rather than handing back the untouched original as a finished edit", async () => {
    // The refused composite returns the frame byte-for-byte. Presenting that as the edit she paid
    // for is the silent failure the whole inversion path exists to prevent — she would be shown her
    // own unchanged photograph and told it worked.
    composeRefusing("empty");
    await expect(run(backgroundBrief())).rejects.toThrow(/couldn't separate you from the background/i);
  });

  it("names the refused region and only that one, by matching verdict order to region order", async () => {
    // THE INDEX ALIGNMENT IS THE RISK HERE. maskVerdicts carries one entry per region across all
    // patches, in the plans' own order, and a mis-index would name the wrong target — telling her a
    // thing that changed did not, while staying silent about the thing that actually failed. Two
    // differently-labelled regions make that visible; one region cannot.
    const twoRegions = makeBrief({
      mode: "edit",
      source: {
        ...SOURCE,
        editRegions: [
          { label: "the backdrop", left: 0, top: 0, width: 1600, height: 1600, subjectNoun: "person" },
          { label: "the far wall", left: 2000, top: 3000, width: 1200, height: 1200, subjectNoun: "person" },
        ],
      },
    });
    pasteBackMock.mockImplementation(async () => ({
      bytes: pngBytes(SOURCE.width, SOURCE.height),
      mimeType: "image/png",
      width: SOURCE.width,
      height: SOURCE.height,
      jpegQuality: null,
      // Second region refused, first one used.
      maskVerdicts: ["used", "refused_empty"],
    }));
    const out = await run(twoRegions);
    expect(out.failedTargets).toEqual(["the far wall"]);
  });

  it("says nothing about failures when the composite used the mask", async () => {
    pasteBackMock.mockImplementation(async (_f: unknown, patches: { plan: { regions: unknown[] } }[]) => ({
      bytes: pngBytes(SOURCE.width, SOURCE.height),
      mimeType: "image/png",
      width: SOURCE.width,
      height: SOURCE.height,
      jpegQuality: null,
      maskVerdicts: patches.flatMap((p) => p.plan.regions.map(() => "used")),
    }));
    const out = await run(backgroundBrief());
    expect(out.failedTargets).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE NATIVE EDIT — one full-frame call, routed around the masked stack (PR N, N.2)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The brief is the SAME edit brief the masked tests use — regions and all — plus a frozen intent.
// That is the case the dispatch has to get right: the brief is croppable, and it must not be cropped.

/** What the freeze writes for "make the swoosh black" on SOURCE — hand-built, as the briefs are. */
const FROZEN: FrozenEditIntent = {
  version: 1,
  initialPath: "FULL_IMAGE",
  steps: [{ op: "RECOLOR", targets: ["swoosh"], value: "black", scope: "REGION" }],
  changes: [{ op: "RECOLOR", target: "swoosh", change: "black" }],
  imageSize: "4K",
};

const nativeBrief = (intent: unknown = FROZEN) =>
  makeBrief({
    mode: "edit",
    source: SOURCE,
    direction: { set: "chosen", statement: "make the swoosh black", untrusted: false, featuredPieces: [] },
    editIntent: intent,
  } as unknown as Partial<CreativeBrief["job"]>);

describe("a native edit is ONE full-frame call, and the masked stack is never entered", () => {
  beforeEach(() => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    // What a 4K full-frame call returns for a 4000x6000 frame — the model's own canvas (probe, Q5L).
    generateMock.mockResolvedValue({
      assets: [{ bytes: pngBytes(3392, 5056), mimeType: "image/png" }],
    } as unknown as GenerationResult);
  });
  afterEach(() => {
    delete process.env.STUDIO_NATIVE_EDIT;
    delete process.env.STUDIO_CREATIVE_QA;
  });

  it("makes one provider call with the WHOLE frame in the frame slot, and never crops or pastes", async () => {
    await run(nativeBrief());

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(cropFrameMock).not.toHaveBeenCalled();
    expect(pasteBackMock).not.toHaveBeenCalled();
    const inputs = generateMock.mock.calls[0][1];
    expect(inputs.references).toHaveLength(1);
    expect(inputs.references[0]).toMatchObject({
      kind: "url",
      url: expect.stringContaining(SOURCE.ref),
      slot: "frame",
    });
  });

  it("asks for the frozen size and the frame's own ratio", async () => {
    await run(nativeBrief());
    const [, inputs, opts] = generateMock.mock.calls[0];
    expect(imageSizeFrom(opts.providerParams)).toBe("4K");
    expect(inputs.aspectRatio).toBe("2:3");
  });

  it("sends the compiled instruction — not her sentence, and not the masked path's crop prompt", async () => {
    await run(nativeBrief());
    const prompt: string = generateMock.mock.calls[0][1].prompt;
    expect(prompt).toBe(compileNativeInstruction(FROZEN));
    expect(prompt).not.toMatch(/CHANGE ONLY|DIRECTION:|GOAL:/);
  });

  it("stores the model's own canvas — the composite's exactness claim is not applied to it", async () => {
    // 3392x5056 is not the source's 4000x6000, so assertCompositeIsTheOriginal would refuse it. It
    // must not run: this job never composited. The transpose guard still does, and passes (0.6%).
    await expect(run(nativeBrief())).resolves.toMatchObject({ spent: true });
    expect(recordGeneratedAssetMock).toHaveBeenCalledTimes(1);
    expect(recordGeneratedAssetMock.mock.calls[0][0]).toMatchObject({
      derivedFromAssetId: SOURCE.mediaAssetId,
    });
  });

  it("FIRES CREATIVE QA on the native output — sweep #2 is the calibration event, and it needs the records", async () => {
    // A native path that skipped inspectAsset would produce zero verdicts at sweep #2 and nothing
    // would say so. Q's block is untouched; this proves a native job reaches it, with its asset.
    process.env.STUDIO_CREATIVE_QA = "true";
    await run(nativeBrief());
    expect(inspectAssetMock).toHaveBeenCalledTimes(1);
    expect(inspectAssetMock).toHaveBeenCalledWith("media-1", "athlete-1", {
      instruction: "make the swoosh black",
    });
  });

  it("does not inspect with QA off — the stage costs one boolean", async () => {
    await run(nativeBrief());
    expect(inspectAssetMock).not.toHaveBeenCalled();
  });

  it("hands QA the things the intent PLACED, and nothing on an edit that placed none (wave B)", async () => {
    // The framing observation's gate is the compile tier's own `placedAdds`, and this is the only
    // place it is computed (studio/qa/framing.ts has what measured it). A recolour must pass no
    // option at all rather than an empty list: absent is what says "there was nothing to observe".
    process.env.STUDIO_CREATIVE_QA = "true";
    await run(nativeBrief());
    expect(inspectAssetMock).toHaveBeenCalledWith("media-1", "athlete-1", {
      instruction: "make the swoosh black",
    });

    inspectAssetMock.mockClear();
    await run(
      nativeBrief({
        ...FROZEN,
        steps: [
          {
            op: "ADD_OBJECT",
            targets: [],
            value: "at her feet",
            scope: "FULL_IMAGE",
          },
        ],
        changes: [
          {
            op: "ADD_OBJECT",
            target: null,
            change: null,
            add: {
              thing: "soccer ball",
              place: "at her feet",
              objectAssetId: null,
            },
          },
        ],
      }),
    );
    expect(inspectAssetMock).toHaveBeenCalledWith("media-1", "athlete-1", {
      instruction: "make the swoosh black",
      placedAdds: ["soccer ball"],
    });
  });

  it("REFUSES a frozen native brief once the flag is off — before a job opens or the approval is claimed", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    await expect(run(nativeBrief())).rejects.toThrow(NATIVE_EDIT_SWITCHED_OFF);
    expect(createGenerationJobMock).not.toHaveBeenCalled();
    expect(consumePreviewMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(cropFrameMock).not.toHaveBeenCalled();
  });

  it("refuses an intent it cannot run, before spending", async () => {
    await expect(run(nativeBrief({ ...FROZEN, version: 2 }))).rejects.toThrow(/can't run any more/);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("leaves a brief with NO intent on the masked path, flag on or off", async () => {
    // Every edit on a box she drew is this brief: explicit spatial intent routes masked.
    await run(editBrief());
    expect(cropFrameMock).toHaveBeenCalled();
    expect(pasteBackMock).toHaveBeenCalled();
  });
});

describe("the resolution record — a native output is recorded at the size it came back (N.3)", () => {
  beforeEach(() => {
    process.env.STUDIO_NATIVE_EDIT = "true";
    generateMock.mockResolvedValue({
      assets: [{ bytes: pngBytes(3392, 5056), mimeType: "image/png" }],
    } as unknown as GenerationResult);
  });
  afterEach(() => {
    delete process.env.STUDIO_NATIVE_EDIT;
  });

  it("records the MEASURED 3392x5056 — not null, and not the source's 4000x6000", async () => {
    // The adapter stamps dimensions from the request, which names none for an edit. Without the
    // measurement this row would carry nulls and the fidelity split would be invisible.
    await run(nativeBrief());
    expect(recordGeneratedAssetMock.mock.calls[0][0]).toMatchObject({ width: 3392, height: 5056 });
  });

  it("leaves a masked edit's record exactly as it was — the composite reports the source's frame", async () => {
    delete process.env.STUDIO_NATIVE_EDIT;
    await run(editBrief());
    expect(recordGeneratedAssetMock.mock.calls[0][0]).toMatchObject({
      width: SOURCE.width,
      height: SOURCE.height,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A NATIVE OUTPUT THAT WOULD NOT FIT THE STORE IS KEPT AS JPEG, NOT THROWN AWAY
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Vertex returns native edits as PNG; at 4K that is ~27 MB, over the 25 MB store cap, and it was
// being refused AFTER the call billed. The fixture is sigma-4 noise at 600x900: its PNG is ~902 KB and
// its q100 4:4:4 JPEG ~741 KB (stable across runs, measured), so a cap one byte under the PNG puts it
// over exactly as 27 MB is over 25 — and only the TOP rung shows a max Δ of 4 or 5 (q95, q90 and
// sharp's default all read 18–25), which is how the tests know which rung ran.
//
// ─── WHY THE BOUND IS 5, NOT 4 ─────────────────────────────────────────────────────────────────
//
// The noise is drawn fresh on every run, so the top rung's max Δ is a sample, not a constant. Over
// 3,000 fresh fixtures (darwin-arm64, sharp 0.34.5 / libvips 8.17.3): Δ4 on 2,969 and Δ5 on 31 — 1.03%,
// never 6. CI's linux-x64 drew a 5 once (run 35161253900, attempt 1; attempt 2 passed on the same
// commit). So 4 went red about one run in a hundred on legitimate encoder rounding, with nothing wrong
// with the re-encode. 5 is every value measured on either build, and it is also the most this bound
// can give: the nearest wrong encode, q99 4:4:4, reads 6–7 on the same fixtures (60 measured), and
// q100 with 4:2:0 chroma reads 18–22. At 6 a top rung quietly slipped to q99 would pass.

const noisyPng = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "#000000", noise: { type: "gaussian", mean: 128, sigma: 4 } },
  })
    .png()
    .toBuffer();

async function maxAbsDiff(a: Buffer, b: Buffer): Promise<number> {
  const [x, y] = await Promise.all([a, b].map((z) => sharp(z).removeAlpha().raw().toBuffer()));
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
  return max;
}

describe("a native output that would not fit the store is kept as JPEG, not thrown away", () => {
  beforeEach(() => {
    process.env.STUDIO_NATIVE_EDIT = "true";
  });
  afterEach(() => {
    delete process.env.STUDIO_NATIVE_EDIT;
    delete process.env.MEDIA_MAX_BYTES;
  });

  it("re-encodes an over-cap PNG at the ladder's TOP rung — JPEG, under the cap, same size, max Δ 5", async () => {
    const png = await noisyPng(600, 900); // 2:3 — the source's own shape, so the shape guard passes
    process.env.MEDIA_MAX_BYTES = String(png.length - 1);
    generateMock.mockResolvedValue({
      assets: [{ bytes: png, mimeType: "image/png" }],
    } as unknown as GenerationResult);

    await run(nativeBrief());

    const [stored, , contentType] = saveBufferMock.mock.calls[0];
    expect(contentType).toBe("image/jpeg");
    expect([...stored.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(stored.length).toBeLessThanOrEqual(png.length - 1);
    expect(await maxAbsDiff(png, stored)).toBeLessThanOrEqual(5);
    // The record measures what was KEPT, and the re-encode never resizes.
    expect(recordGeneratedAssetMock.mock.calls[0][0]).toMatchObject({ width: 600, height: 900 });
  });

  it("stores a native output that fits exactly as it came back", async () => {
    const png = await noisyPng(600, 900); // well under the real 25 MB cap
    generateMock.mockResolvedValue({
      assets: [{ bytes: png, mimeType: "image/png" }],
    } as unknown as GenerationResult);

    await run(nativeBrief());

    const [stored, , contentType] = saveBufferMock.mock.calls[0];
    expect(contentType).toBe("image/png");
    expect(stored).toBe(png);
  });

  it("never re-encodes a MASKED output — the composite encodes its own to fit", async () => {
    const png = await noisyPng(600, 900);
    process.env.MEDIA_MAX_BYTES = String(png.length - 1);
    const small = {
      ...SOURCE,
      width: 600,
      height: 900,
      editRegions: [{ label: "competitor swoosh", left: 100, top: 100, width: 200, height: 200 }],
    };
    pasteBackMock.mockImplementation(async (_f: unknown, patches: { plan: { regions: unknown[] } }[]) => ({
      bytes: png,
      mimeType: "image/png",
      width: 600,
      height: 900,
      jpegQuality: null,
      maskVerdicts: patches.flatMap((p) => p.plan.regions.map(() => "off")),
    }));

    await run(makeBrief({ mode: "edit", source: small }));

    expect(cropFrameMock).toHaveBeenCalled();
    const [stored, , contentType] = saveBufferMock.mock.calls[0];
    expect(contentType).toBe("image/png");
    expect(stored).toBe(png);
  });
});
