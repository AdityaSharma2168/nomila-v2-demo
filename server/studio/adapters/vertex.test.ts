/**
 * vertex.test.ts — the Vertex IMAGE wire body and the cost line it produces, with `fetch` and ADC
 * both stubbed so nothing here can reach the live project or spend a cent.
 *
 * Two things are asserted, and they are the two the U2 manual run could not tell apart by reading
 * the log:
 *
 *  1. ASPECT RATIO reaches the wire. plannedInputs() has always computed one, and until now the
 *     image body dropped it — only the prose in buildPrompt() carried the shape, so a 4:5 post and a
 *     9:16 story asked Vertex for exactly the same thing.
 *  2. A token-accurate cost and a silent fallback to the pre-generation estimate write DIFFERENT
 *     log lines. Both are basis "estimated", so `detail` is the only field that separates them.
 *
 * The wire shape asserted here is generationConfig.imageConfig.aspectRatio — see the header of
 * vertex.ts for where that was read from. It is deliberately NOT the shape Veo takes.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate } from "../router";
import { readLog } from "../costLog";

// A url reference is fetched through safeFetch (PR 7, Lane F2). Here it delegates to the suite's own
// `fetch` stub, so the queue below serves the reference bytes and the model call alike.
jest.mock("../../lib/safeFetch", () => ({
  safeFetch: jest.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

// ADC never runs in a test: the adapter only needs a bearer string, so hand it one.
jest.mock("google-auth-library", () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({
      getAccessToken: async () => ({ token: "test-token" }),
      credentials: { expiry_date: Date.now() + 3_600_000 },
    }),
  })),
}));

const ORIGINAL_ENV = { ...process.env };
const MODEL = "gemini-3-pro-image";
const B64 = Buffer.from("fake-png-bytes").toString("base64");
const VERTEX = { provider: "vertex" as const, model: MODEL };

let fetchMock: jest.Mock;
let logDir: string;
let logFile: string;

/** One image candidate, with the usageMetadata block under test. */
const imageResponse = (usageMetadata?: unknown) => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }],
  ...(usageMetadata ? { usageMetadata } : {}),
});

function queue(...bodies: unknown[]) {
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => "" } as any);
  }
}

const bodyOf = (call: number) => JSON.parse((fetchMock.mock.calls[call][1] as any).body);

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "studio-vertex-"));
  logFile = join(logDir, "log.jsonl");
  // Round numbers so the assertions read as arithmetic rather than as floating-point noise.
  process.env = {
    ...ORIGINAL_ENV,
    STUDIO_COST_LOG: logFile,
    STUDIO_PRICE_JSON: JSON.stringify({
      [MODEL]: { unit: "per_image_token", usdPerToken: 0.0001, tokensPerImage: 1000 },
    }),
  };
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
});

afterEach(() => rmSync(logDir, { recursive: true, force: true }));
afterAll(() => { process.env = ORIGINAL_ENV; });

describe("image wire body — aspect ratio actually leaves the process", () => {
  it("sends a story and a post at DIFFERENT aspect ratios", async () => {
    queue(imageResponse(), imageResponse());

    await generate("image.generate", { prompt: "her, mid-stride", aspectRatio: "9:16" }, VERTEX);
    await generate("image.generate", { prompt: "her, mid-stride", aspectRatio: "4:5" }, VERTEX);

    // The whole point of the fix: the two calls no longer ask the wire for the same shape.
    expect(bodyOf(0).generationConfig.imageConfig.aspectRatio).toBe("9:16");
    expect(bodyOf(1).generationConfig.imageConfig.aspectRatio).toBe("4:5");
  });

  it("puts the ratio in imageConfig, NOT in the top-level `parameters` block Veo uses", async () => {
    queue(imageResponse());
    await generate("image.generate", { prompt: "x", aspectRatio: "1:1" }, VERTEX);

    const body = bodyOf(0);
    expect(body.generationConfig).toMatchObject({
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    });
    expect(body.parameters).toBeUndefined();
  });

  it("omits imageConfig entirely when the brief has no ratio — no empty object on the wire", async () => {
    queue(imageResponse());
    await generate("image.generate", { prompt: "x" }, VERTEX);
    expect(bodyOf(0).generationConfig).not.toHaveProperty("imageConfig");
  });

  it("keeps the planned ratio when a caller sets a SIBLING imageConfig knob", async () => {
    queue(imageResponse());
    await generate(
      "image.generate",
      { prompt: "x", aspectRatio: "4:5" },
      { ...VERTEX, providerParams: { generationConfig: { imageConfig: { imageSize: "2K" } } } },
    );
    // A shallow spread would have replaced the object and silently dropped the ratio again.
    expect(bodyOf(0).generationConfig.imageConfig).toEqual({ aspectRatio: "4:5", imageSize: "2K" });
  });

  it("still lets a caller's explicit aspectRatio beat the planned one", async () => {
    queue(imageResponse());
    await generate(
      "image.generate",
      { prompt: "x", aspectRatio: "4:5" },
      { ...VERTEX, providerParams: { generationConfig: { imageConfig: { aspectRatio: "21:9" } } } },
    );
    expect(bodyOf(0).generationConfig.imageConfig.aspectRatio).toBe("21:9");
  });
});

describe("cost log — a token-accurate cost is distinguishable from a fallback estimate", () => {
  it("writes DIFFERENT lines for a real token count and a silent fallback", async () => {
    queue(
      imageResponse({ candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1500 }] }),
      imageResponse(),                                     // no usageMetadata at all → fallback
    );

    await generate("image.generate", { prompt: "a" }, VERTEX);
    await generate("image.generate", { prompt: "b" }, VERTEX);

    const [accurate, fallback] = await readLog(logFile);

    // 1500 REPORTED tokens, not the 1000 the config assumed.
    expect(accurate.cost).toBeCloseTo(0.15);
    expect(accurate.detail).toContain("1500 actual image tokens");

    // The fallback is the pre-generation estimate, and says so.
    expect(fallback.cost).toBeCloseTo(0.1);
    expect(fallback.detail).toContain("ASSUMPTION");

    // Both are "estimated" — which is exactly why the basis alone could never tell them apart.
    expect(accurate.costBasis).toBe("estimated");
    expect(fallback.costBasis).toBe("estimated");
    expect(accurate.detail).not.toEqual(fallback.detail);
  });

  it("distinguishes them even when the two costs happen to land on the same number", async () => {
    // The reported count matches the assumed one, so cost + basis are identical on both lines and
    // `detail` is the ONLY thing left that says which path ran. This is the case that made a cost
    // investigation necessary.
    queue(
      imageResponse({ candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1000 }] }),
      imageResponse({ candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 40 }] }),  // no IMAGE → fallback
    );

    await generate("image.generate", { prompt: "a" }, VERTEX);
    await generate("image.generate", { prompt: "b" }, VERTEX);

    const [accurate, fallback] = await readLog(logFile);
    expect(accurate.cost).toBeCloseTo(fallback.cost);
    expect(accurate.costBasis).toBe(fallback.costBasis);
    expect(accurate.detail).not.toEqual(fallback.detail);
  });

  it("records the reasoning tokens that bill on top, when Vertex reports them", async () => {
    queue(imageResponse({
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1000 }],
      thoughtsTokenCount: 162,
    }));
    await generate("image.generate", { prompt: "a" }, VERTEX);

    const [r] = await readLog(logFile);
    expect(r.detail).toContain("162 reasoning tokens");
  });
});

// ─── LAYER 3 — the parts leave in slot order, whatever order they arrived in ─────────────────────
//
// This is the assertion that makes the prompt's reference manifest honest. "Image 2 — HER LIKENESS"
// is a claim about the second image in `contents[0].parts`; if the adapter shipped them in caller
// order, a shuffled array would silently point that sentence at a mood board.
//
// Reference bytes are fetched by `toInlinePart`, so each reference costs one extra fetch call
// before the generateContent POST — `refFetches` below accounts for them.

describe("reference ordering — a mood board can never occupy the identity position", () => {
  // Every reference below is `kind: "bytes"`, so `toInlinePart` inlines it directly and NO extra
  // fetch happens — the generateContent POST is call 0. That is deliberate: it keeps these tests
  // about ordering rather than about the fetch path, and it makes each part's identity readable
  // straight out of the body.

  /** The base64 payloads in the order they actually left, so identity is checked by CONTENT. */
  const sentParts = (call: number) =>
    JSON.parse((fetchMock.mock.calls[call][1] as any).body).contents[0].parts
      .filter((p: { inlineData?: unknown }) => p.inlineData)
      .map((p: { inlineData: { data: string } }) => Buffer.from(p.inlineData.data, "base64").toString());

  it("re-orders a shuffled array into frame → character → object → style", async () => {
    queue(imageResponse());
    await generate("image.edit", {
      prompt: "p",
      references: [
        { kind: "bytes", bytes: Buffer.from("MOOD"),    mimeType: "image/jpeg", slot: "style" },
        { kind: "bytes", bytes: Buffer.from("CHARM"),   mimeType: "image/jpeg", slot: "object" },
        { kind: "bytes", bytes: Buffer.from("HER"),     mimeType: "image/jpeg", slot: "character" },
        { kind: "bytes", bytes: Buffer.from("FRAME"),   mimeType: "image/jpeg", slot: "frame" },
      ],
    }, { ...VERTEX, noLog: true });

    expect(sentParts(0)).toEqual(["FRAME", "HER", "CHARM", "MOOD"]);
  });

  it("never lets a style reference reach the position the manifest calls her likeness", async () => {
    queue(imageResponse());
    await generate("image.generate", {
      prompt: "p",
      references: [
        { kind: "bytes", bytes: Buffer.from("MOOD"), mimeType: "image/jpeg", slot: "style" },
        { kind: "bytes", bytes: Buffer.from("HER"),  mimeType: "image/jpeg", slot: "character" },
      ],
    }, { ...VERTEX, noLog: true });

    const parts = sentParts(0);
    expect(parts[0]).toBe("HER");
    expect(parts.indexOf("MOOD")).toBeGreaterThan(parts.indexOf("HER"));
  });

  it("keeps two references in the SAME slot in the order the planner gave them", async () => {
    queue(imageResponse());
    await generate("image.generate", {
      prompt: "p",
      references: [
        { kind: "bytes", bytes: Buffer.from("CHARM-A"), mimeType: "image/jpeg", slot: "object" },
        { kind: "bytes", bytes: Buffer.from("CHARM-B"), mimeType: "image/jpeg", slot: "object" },
        { kind: "bytes", bytes: Buffer.from("HER"),     mimeType: "image/jpeg", slot: "character" },
      ],
    }, { ...VERTEX, noLog: true });

    // Stable sort — otherwise "PRODUCT: the charm" could describe the wrong one of two charms.
    expect(sentParts(0)).toEqual(["HER", "CHARM-A", "CHARM-B"]);
  });

  it("leaves an untyped caller's order exactly as it was", async () => {
    queue(imageResponse());
    await generate("image.generate", {
      prompt: "p",
      references: [
        { kind: "bytes", bytes: Buffer.from("ONE"), mimeType: "image/jpeg" },
        { kind: "bytes", bytes: Buffer.from("TWO"), mimeType: "image/jpeg" },
      ],
    }, { ...VERTEX, noLog: true });

    expect(sentParts(0)).toEqual(["ONE", "TWO"]);
  });

  it("puts slot and label in NO wire field — there is nowhere on a Part for them to go", async () => {
    queue(imageResponse());
    await generate("image.generate", {
      prompt: "p",
      references: [{ kind: "bytes", bytes: Buffer.from("HER"), mimeType: "image/jpeg", slot: "character", label: "her likeness" }],
    }, { ...VERTEX, noLog: true });

    const raw = (fetchMock.mock.calls[0][1] as any).body as string;
    expect(raw).not.toMatch(/"slot"/);
    expect(raw).not.toMatch(/her likeness/);
  });

  it("records the slots on the cost line, in the order they were sent", async () => {
    queue(imageResponse({ candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1000 }] }));
    await generate("image.generate", {
      prompt: "p",
      references: [
        { kind: "bytes", bytes: Buffer.from("MOOD"), mimeType: "image/jpeg", slot: "style" },
        { kind: "bytes", bytes: Buffer.from("HER"),  mimeType: "image/jpeg", slot: "character" },
      ],
    }, VERTEX);

    const [line] = await readLog(logFile);
    // The ORDER SENT, not the order given — a cost line that disagreed with the request would be
    // worse than no cost line, because it would be read as evidence.
    expect(line.inputRefs).toMatchObject({ count: 2, slots: ["character", "style"] });
  });
});

describe("an edit's aspect ratio reaches the wire too, not just a generate's", () => {
  it("puts the frame's ratio in generationConfig.imageConfig for image.edit", async () => {
    queue(imageResponse());
    await generate("image.edit", {
      prompt: "p",
      aspectRatio: "2:3",
      references: [{ kind: "bytes", bytes: Buffer.from("FRAME"), mimeType: "image/jpeg", slot: "frame" }],
    }, { ...VERTEX, noLog: true });

    expect(bodyOf(0).generationConfig.imageConfig).toEqual({ aspectRatio: "2:3" });
    // Not the top-level `parameters` block Veo takes — the two models take the same concept in
    // different places, and an edit is the same generateContent call as a generate.
    expect(bodyOf(0).parameters).toBeUndefined();
  });
});

/**
 * ─── THE VEO WIRE BODY — the arm that actually ships, and it had no coverage ────────────────────
 *
 * Video routes to Veo on Vertex by default, and until now nothing asserted what leaves the process
 * on that path. The image suite above cannot stand in for it: Veo takes its first frame as
 * `instances[0].image` and its knobs in a top-level `parameters` block, which is a different shape
 * from `generationConfig.imageConfig` in every particular.
 *
 * ⚠️ NOTHING HERE ENABLES VIDEO. These call the router directly, as the probes do. (Since video V3
 * the product path queues a clip rather than refusing it, but it is still gated by `studioEnabled`
 * and nothing in this file touches that.)
 */
describe("Veo's wire body — the first frame, the duration, and the audio arm", () => {
  const VEO = { provider: "vertex" as const, model: "veo-3.1-generate-001" };
  const CLIP = Buffer.from("fake-mp4-bytes").toString("base64");
  /** The poll cadence, passed as an OPTION rather than through the environment — the adapter
   *  reads `opts.pollIntervalMs ?? poll.intervalMs`, so a sibling suite cannot undo it. */
  const FAST = { noLog: true, pollIntervalMs: 1, maxPollMs: 5_000 };

  /** predictLongRunning returns an operation name; fetchPredictOperation returns the finished clip. */
  function queueVideo() {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      { done: true, response: { videos: [{ bytesBase64Encoded: CLIP, mimeType: "video/mp4" }] } },
    );
  }

  it("puts the first reference in instances[0].image, not in a contents part", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "she stands up and looks into the camera",
        durationSeconds: 8,
        aspectRatio: "9:16",
        references: [{ kind: "bytes", bytes: Buffer.from("HERFRAME"), mimeType: "image/jpeg", slot: "frame" }],
      },
      { ...VEO, ...FAST, providerParams: { parameters: { generateAudio: false } } },
    );

    const body = bodyOf(0);
    expect(body.instances[0].image).toEqual({
      bytesBase64Encoded: Buffer.from("HERFRAME").toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(body.instances[0].prompt).toBe("she stands up and looks into the camera");
  });

  it("carries duration, aspect and the no-audio flag in the top-level parameters block", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 8, aspectRatio: "9:16" },
      { ...VEO, ...FAST, providerParams: { parameters: { generateAudio: false } } },
    );

    // generateAudio false is worth $1.60 on an 8s clip — it selects the cheaper of two SKUs that
    // differ by 2x, and studio/pricing reads it from this same object so the arm quoted is the arm
    // bought. If it stopped reaching the wire, the quote would silently become the optimistic one.
    expect(bodyOf(0).parameters).toMatchObject({
      durationSeconds: 8,
      aspectRatio: "9:16",
      generateAudio: false,
      sampleCount: 1,
    });
  });

  it("anchors on the SLOT order — only refParts[0] reaches Veo at all", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 6,
        references: [
          { kind: "bytes", bytes: Buffer.from("MOOD"), mimeType: "image/jpeg", slot: "style" },
          { kind: "bytes", bytes: Buffer.from("HER"), mimeType: "image/jpeg", slot: "frame" },
        ],
      },
      { ...VEO, ...FAST },
    );

    // THE FACT THAT SHAPES THE BAKE-OFF: Veo reads one image and drops the rest, so a "3-reference
    // pack" is not a thing that can be sent here. Her frame wins on slot order despite arriving
    // second — the same rule the OpenRouter adapter now applies to frame_images.
    expect(bodyOf(0).instances[0].image.bytesBase64Encoded).toBe(Buffer.from("HER").toString("base64"));
    expect(bodyOf(0).instances).toHaveLength(1);
  });

  it("polls the operation and returns the clip's bytes", async () => {
    queueVideo();
    const res = await generate("video.generate", { prompt: "x", durationSeconds: 6 }, { ...VEO, ...FAST });

    expect(fetchMock.mock.calls[1][0]).toContain("fetchPredictOperation");
    expect(res.assets[0].bytes?.toString("base64")).toBe(CLIP);
    expect(res.assets[0].mimeType).toBe("video/mp4");
  });
});

describe("Veo's refusals arrive with a code that says whether to ask again", () => {
  const VEO = { provider: "vertex" as const, model: "veo-3.1-generate-001" };
  const FAST = { noLog: true, pollIntervalMs: 1, maxPollMs: 5_000 };
  const CLIP2 = Buffer.from("fake-mp4-bytes").toString("base64");

  const runVideo = () =>
    generate(
      "video.generate",
      {
        prompt: "she stands up and looks into the camera",
        durationSeconds: 8,
        aspectRatio: "9:16",
      },
      {
        ...VEO,
        ...FAST,
        providerParams: { parameters: { generateAudio: false } },
      },
    );

  /** The thrown GenerationError, or a failure if the call somehow succeeded. */
  async function refusal() {
    try {
      await runVideo();
    } catch (err) {
      return err as { code: string; message: string; provider?: string };
    }
    throw new Error("expected the poll to throw, and it returned a clip");
  }

  /**
   * ⚠️ THE OUTPUT FILTER, DRIVEN THROUGH THE REAL POLL. The operation is DONE, carries no videos,
   * and says how many were filtered and why. Before this commit every one of these arrived as
   * `provider_error`, indistinguishable from a 503.
   */
  it("reads a filtered, empty completion as content_filtered and reports the REASONS", async () => {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      {
        done: true,
        response: {
          videos: [],
          raiMediaFilteredCount: 1,
          raiMediaFilteredReasons: ["Support Codes: 58061214"],
        },
      },
    );

    const err = await refusal();
    expect(err.code).toBe("content_filtered");
    // The reasons were never read before — only the count was — so a filtered clip's stated cause
    // reached no log and no job row.
    expect(err.message).toContain("Support Codes: 58061214");
    expect(err.message).toContain("1 output(s) filtered");
  });

  it("keeps an empty completion with NO filtering as an ordinary provider error", async () => {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      { done: true, response: { videos: [] } },
    );
    expect((await refusal()).code).toBe("provider_error");
  });

  it("reads an INVALID_ARGUMENT operation error as content_blocked", async () => {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      {
        error: {
          code: 3,
          status: "INVALID_ARGUMENT",
          message: "the first frame was rejected",
        },
      },
    );
    const err = await refusal();
    expect(err.code).toBe("content_blocked");
    expect(err.message).toContain("the first frame was rejected");
  });

  it("leaves a transient operation error exactly as it was", async () => {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      { error: { code: 13, status: "INTERNAL", message: "backend hiccup" } },
    );
    expect((await refusal()).code).toBe("provider_error");
  });

  it("does not touch the happy path — a clip still comes back", async () => {
    queue(
      { name: "projects/p/locations/us-central1/operations/op-1" },
      {
        done: true,
        response: {
          videos: [{ bytesBase64Encoded: CLIP2, mimeType: "video/mp4" }],
          // A sample was filtered AND a clip arrived: not a refusal, and it must not become one.
          raiMediaFilteredCount: 1,
        },
      },
    );
    const out = await runVideo();
    expect(out.assets).toHaveLength(1);
  });
});

describe("reference urls go through safeFetch (Lane F2)", () => {
  /** ⚠️ MUTATION: fetch the reference with bare `fetch` — this reds: safeFetch was never asked. */
  it("a url reference is fetched through safeFetch; the model call itself is not", async () => {
    const { safeFetch } = jest.requireMock("../../lib/safeFetch") as { safeFetch: jest.Mock };
    // First answer: the reference bytes (served through the safeFetch → fetch delegate). Then the model.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as any);
    queue(imageResponse());

    await generate(
      "image.edit",
      { prompt: "swap the kit", references: [{ kind: "url", url: "https://signed.example/ref.jpg" }] },
      VERTEX,
    );

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe("https://signed.example/ref.jpg");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/aiplatform\.googleapis\.com/); // ours, not a page's — bare fetch, as before
    const part = bodyOf(1).contents[0].parts[0];
    expect(part.inlineData).toEqual({ mimeType: "image/jpeg", data: Buffer.from([1, 2, 3]).toString("base64") });
  });
});
