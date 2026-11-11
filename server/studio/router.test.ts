/**
 * router.test.ts — the adapter CONTRACT, with every OpenRouter call stubbed.
 *
 * The point is that the router is verifiable BEFORE OPENROUTER_API_KEY exists: `fetch` is replaced,
 * so these assert the wire format we send, the shapes we accept back, the poll loop, cancellation,
 * and that the dry-run path is provably billable-call-free.
 *
 * Wire shapes are taken from OpenRouter's documented API:
 *   POST /images  → { created, data:[{b64_json, media_type}], usage:{cost} }
 *   POST /videos  → 202 { id, polling_url, status:"pending" }
 *   GET  /videos/{id} → { status, unsigned_urls:[…], usage:{cost} }
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate, estimate, resolve, GenerationError } from "./router";
import type { GenerationInputs } from "./types";

const ORIGINAL_ENV = { ...process.env };
let fetchMock: jest.Mock;

/** Queue one JSON response per expected call. */
function queue(...responses: Array<{ status?: number; body: unknown }>) {
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as any);
  }
}

/**
 * A completed video job is followed by the adapter's own AUTHENTICATED download of the clip, so a
 * video test queues one more response than it used to.
 *
 * ⚠️ QUEUE THIS EXPLICITLY RATHER THAN LETTING THE MOCK RUN DRY. Without it `fetch` resolves
 * `undefined`, `downloadClip` degrades to no-bytes, and the test still passes — green while
 * silently exercising the failure path and proving nothing about the success one.
 */
const CLIP = Buffer.from("fake-mp4-bytes");
function queueClipDownload() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      CLIP.buffer.slice(CLIP.byteOffset, CLIP.byteOffset + CLIP.byteLength),
    json: async () => ({}),
    text: async () => "",
  } as any);
}

const B64_PIXEL = Buffer.from("fake-png-bytes").toString("base64");
const PROMPT: GenerationInputs = {
  prompt: "her, mid-stride, hard evening light",
};

let logDir: string;

afterEach(() => rmSync(logDir, { recursive: true, force: true }));

beforeEach(() => {
  // generate() is instrumented, so without this the suite appends real lines to the default cost
  // log in the repo root. Redirect it per test; costLog.test.ts owns the logging assertions.
  logDir = mkdtempSync(join(tmpdir(), "studio-router-"));
  process.env = {
    ...ORIGINAL_ENV,
    OPENROUTER_API_KEY: "test-key",
    STUDIO_COST_LOG: join(logDir, "log.jsonl"),
  };
  // Pin routes + prices so the suite never depends on ambient env or on the shipped defaults.
  // Defaults now route Nano/Veo at Vertex; these suites exercise the OpenRouter wire format, so
  // pin the provider as well as the model rather than depending on the shipped default.
  process.env.STUDIO_IMAGE_PROVIDER = "openrouter";
  process.env.STUDIO_IMAGE_EDIT_PROVIDER = "openrouter";
  process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
  process.env.STUDIO_IMAGE_MODEL = "test/image-model";
  process.env.STUDIO_IMAGE_EDIT_MODEL = "test/image-model";
  process.env.STUDIO_VIDEO_MODEL = "test/video-model";
  process.env.STUDIO_PRICE_JSON = JSON.stringify({
    "test/image-model": { unit: "per_image", usd: 0.04 },
    "test/video-model": { unit: "per_second", usd: 0.4 },
  });
  process.env.STUDIO_VIDEO_POLL_MS = "1";
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const bodyOf = (call: number) =>
  JSON.parse((fetchMock.mock.calls[call][1] as any).body);
const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);

describe("routing by config, not by call site", () => {
  it("resolves each task to its configured provider + model", () => {
    expect(resolve("image.generate")).toMatchObject({
      model: "test/image-model",
    });
    expect(resolve("video.generate")).toMatchObject({
      model: "test/video-model",
    });
    expect(resolve("image.generate").adapter.name).toBe("openrouter");
  });

  it("an env change re-points a task without touching any caller", () => {
    process.env.STUDIO_IMAGE_MODEL = "someone-else/other-model";
    expect(resolve("image.generate").model).toBe("someone-else/other-model");
  });

  it("opts can override provider + model per call", () => {
    expect(resolve("image.generate", { model: "ad/hoc" }).model).toBe("ad/hoc");
    expect(resolve("image.generate", { provider: "vertex" }).adapter.name).toBe(
      "vertex",
    );
  });

  it("rejects an unknown provider with a named code", () => {
    expect(() =>
      resolve("image.generate", { provider: "nope" as any }),
    ).toThrow(/Unknown provider/);
    try {
      resolve("image.generate", { provider: "nope" as any });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.code).toBe("unknown_provider");
    }
  });

  it("both adapters now declare all three tasks — vertex is no longer a stub", () => {
    for (const p of ["openrouter", "vertex"] as const) {
      for (const t of [
        "image.generate",
        "image.edit",
        "video.generate",
      ] as const) {
        expect(resolve(t, { provider: p }).adapter.supports(t)).toBe(true);
      }
    }
  });
});

describe("missing API key", () => {
  it("fails with a clear, actionable error rather than a generic 401", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect.assertions(3);
    try {
      await generate("image.generate", PROMPT);
    } catch (e: any) {
      expect(e).toBeInstanceOf(GenerationError);
      expect(e.code).toBe("missing_api_key");
      expect(e.message).toMatch(/OPENROUTER_API_KEY/);
    }
  });

  it("does not need the key to estimate — the pre-generation check works before it lands", () => {
    delete process.env.OPENROUTER_API_KEY;
    const plan = estimate("image.generate", { ...PROMPT, n: 3 });
    expect(plan.cost.amountUsd).toBeCloseTo(0.12);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("image.generate", () => {
  it("sends the documented body and decodes base64 data back to bytes", async () => {
    queue({
      body: {
        created: 1,
        data: [{ b64_json: B64_PIXEL, media_type: "image/png" }],
        usage: { cost: 0.037 },
      },
    });

    const res = await generate("image.generate", {
      ...PROMPT,
      width: 1024,
      height: 1024,
      seed: 7,
    });

    expect(urlOf(0)).toBe("https://openrouter.ai/api/v1/images");
    expect(bodyOf(0)).toMatchObject({
      model: "test/image-model",
      prompt: PROMPT.prompt,
      seed: 7,
      size: "1024x1024",
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer test-key",
    );

    expect(res.assets).toHaveLength(1);
    expect(res.assets[0].bytes?.toString()).toBe("fake-png-bytes");
    expect(res.assets[0].mimeType).toBe("image/png");
    expect(res.provider).toBe("openrouter");
  });

  it("prefers the provider's reported cost over our estimate once work has run", async () => {
    queue({
      body: {
        data: [{ b64_json: B64_PIXEL, media_type: "image/png" }],
        usage: { cost: 0.037 },
      },
    });
    const res = await generate("image.generate", PROMPT);
    expect(res.cost).toMatchObject({ amountUsd: 0.037, basis: "reported" });
  });

  it("falls back to the estimate when the provider reports no cost", async () => {
    queue({
      body: { data: [{ b64_json: B64_PIXEL, media_type: "image/png" }] },
    });
    const res = await generate("image.generate", { ...PROMPT, n: 2 });
    expect(res.cost).toMatchObject({ basis: "estimated" });
    expect(res.cost.amountUsd).toBeCloseTo(0.08);
  });

  it("surfaces a provider error with its status", async () => {
    queue({ status: 429, body: { error: "rate limited" } });
    expect.assertions(2);
    try {
      await generate("image.generate", PROMPT);
    } catch (e: any) {
      expect(e.code).toBe("provider_error");
      expect(e.status).toBe(429);
    }
  });
});

describe("image.edit", () => {
  it("passes reference images as input_references, url and inline bytes alike", async () => {
    queue({
      body: { data: [{ b64_json: B64_PIXEL, media_type: "image/png" }] },
    });

    await generate("image.edit", {
      prompt: "recolour the kit",
      references: [
        { kind: "url", url: "https://signed.example/asset.jpg" },
        { kind: "bytes", bytes: Buffer.from("raw"), mimeType: "image/jpeg" },
      ],
    });

    expect(bodyOf(0).input_references).toEqual([
      {
        type: "image_url",
        image_url: { url: "https://signed.example/asset.jpg" },
      },
      {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from("raw").toString("base64")}`,
        },
      },
    ]);
  });

  it("refuses an edit with no reference image, before any call", async () => {
    expect.assertions(2);
    try {
      await generate("image.edit", PROMPT);
    } catch (e: any) {
      expect(e.code).toBe("invalid_input");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

describe("video.generate — submit, poll, retrieve", () => {
  it("submits, polls until completed, and returns the output url", async () => {
    queue(
      {
        status: 202,
        body: { id: "job-1", polling_url: "…", status: "pending" },
      },
      { body: { id: "job-1", status: "in_progress" } },
      {
        body: {
          id: "job-1",
          status: "completed",
          unsigned_urls: [
            "https://openrouter.ai/api/v1/videos/job-1/content?index=0",
          ],
          usage: { cost: 2.4 },
        },
      },
    );
    queueClipDownload();

    const seen: string[] = [];
    const res = await generate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6 },
      { onProgress: (e) => seen.push(e.status) },
    );

    expect(urlOf(0)).toBe("https://openrouter.ai/api/v1/videos");
    expect(bodyOf(0)).toMatchObject({ model: "test/video-model", duration: 6 });
    expect(urlOf(1)).toBe("https://openrouter.ai/api/v1/videos/job-1");
    expect(res.jobId).toBe("job-1");
    expect(res.assets[0].url).toContain("/videos/job-1/content");
    // The clip's BYTES, downloaded by the adapter with its own bearer. Asserted so this test cannot
    // go green on the degrade path the way it briefly did when the download was first added.
    expect(res.assets[0].bytes).toEqual(CLIP);
    expect(res.assets[0].durationSeconds).toBe(6);
    expect(res.cost).toMatchObject({ amountUsd: 2.4, basis: "reported" });
    expect(seen).toEqual(["pending", "in_progress", "completed"]);
  });

  it("raises the provider's reason when a job fails", async () => {
    queue(
      { status: 202, body: { id: "job-2", status: "pending" } },
      { body: { id: "job-2", status: "failed", error: "content policy" } },
    );
    expect.assertions(2);
    try {
      await generate("video.generate", PROMPT);
    } catch (e: any) {
      expect(e.code).toBe("provider_error");
      expect(e.message).toMatch(/content policy/);
    }
  });

  it("stops polling when the caller aborts — a disconnect must not keep paid work running", async () => {
    const ctrl = new AbortController();
    queue(
      { status: 202, body: { id: "job-3", status: "pending" } },
      { body: { id: "job-3", status: "in_progress" } },
    );
    fetchMock.mockImplementation(async () => {
      ctrl.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    expect.assertions(1);
    try {
      await generate("video.generate", PROMPT, { signal: ctrl.signal });
    } catch (e: any) {
      expect(e.code).toBe("aborted");
    }
  });

  it("gives up once maxPollMs is exceeded instead of polling forever", async () => {
    queue({ status: 202, body: { id: "job-4", status: "pending" } });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "job-4", status: "in_progress" }),
      text: async () => "",
    } as any);

    expect.assertions(1);
    try {
      await generate("video.generate", PROMPT, {
        maxPollMs: 5,
        pollIntervalMs: 1,
      });
    } catch (e: any) {
      expect(e.code).toBe("timeout");
    }
  });
});

describe("dryRun / estimate — the pre-generation check", () => {
  it("returns the plan and cost without making ANY call", async () => {
    const res = await generate(
      "video.generate",
      { ...PROMPT, durationSeconds: 8 },
      { dryRun: true },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.assets).toEqual([]);
    expect(res.cost).toMatchObject({ basis: "estimated", amountUsd: 3.2 });
    expect(res.model).toBe("test/video-model");
  });

  it("estimate() shows what will run, so the athlete sees the plan first", () => {
    const plan = estimate("image.edit", {
      prompt: "brighten and reframe",
      references: [{ kind: "url", url: "https://signed.example/a.jpg" }],
      n: 4,
    });
    expect(plan).toMatchObject({
      task: "image.edit",
      provider: "openrouter",
      model: "test/image-model",
      inputs: { references: 1, n: 4 },
      cost: { amountUsd: 0.16, basis: "estimated" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unpriced rather than a confident $0 for a model with no configured price", () => {
    const plan = estimate("image.generate", PROMPT, {
      model: "brand/new-unpriced",
    });
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.detail).toMatch(/no price configured/);
  });

  it("a dry run against the vertex stub still prices, even though generate would throw", async () => {
    const res = await generate("image.generate", PROMPT, {
      provider: "vertex",
      dryRun: true,
    });
    expect(res.provider).toBe("vertex");
    expect(res.cost.basis).toBe("estimated");
  });
});

describe("pricing shapes read from the live OpenRouter API", () => {
  beforeEach(() => {
    delete process.env.STUDIO_PRICE_JSON;
  });

  it("prices a per-second video model from its duration SKU", () => {
    // veo-3.1 duration_seconds_with_audio = $0.40/s; audio is the default arm (see the SKU suite below)
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6 },
      { model: "google/veo-3.1" },
    );
    expect(plan.cost.amountUsd).toBeCloseTo(2.4);
    expect(plan.cost.unpriced).toBeUndefined();
  });

  it("prices a per-output-token image model, and says the token count is an assumption", () => {
    process.env.STUDIO_TOKENS_PER_IMAGE = "1000";
    const plan = estimate("image.generate", PROMPT, {
      model: "google/gemini-3-pro-image",
    });
    expect(plan.cost.amountUsd).toBeCloseTo(0.12); // 1000 tok × $0.00012
    expect(plan.cost.detail).toMatch(/ASSUMPTION/);
  });

  it("reports unpriced when the tokens-per-image assumption is switched off", () => {
    process.env.STUDIO_TOKENS_PER_IMAGE = "0";
    const plan = estimate("image.generate", PROMPT, {
      model: "google/gemini-3-pro-image",
    });
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.amountUsd).toBe(0);
    expect(plan.cost.detail).toMatch(/tokens-per-image is not published/);
  });

  it("leaves Seedance unpriced when the request names no size — the rate depends on it", () => {
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6 },
      { model: "bytedance/seedance-2.0" },
    );
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.amountUsd).toBe(0);
    expect(plan.cost.detail).toMatch(/names no width and height/);
  });

  it("prices Seedance from the published token formula once the size is known", () => {
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 720, height: 1280 },
      { model: "bytedance/seedance-2.0" },
    );
    // 720×1280 = 900 tok/frame, × (24×6 + 1) frames = 130,500 tok × $0.000007.
    // THE FIGURE IS AN INVOICE, NOT AN ARITHMETIC EXERCISE: three Seedance b-roll cells billed
    // exactly $0.9135 on 2026-09-18 (docs/probes/video-bakeoff.md §6).
    expect(plan.cost.amountUsd).toBeCloseTo(0.9135);
    expect(plan.cost.unpriced).toBeUndefined();
    expect(plan.cost.detail).toMatch(/hd720/);
  });

  it("charges the DEARER 1080p rate one band up, rather than the 720p one", () => {
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 1080, height: 1920 },
      { model: "bytedance/seedance-2.0" },
    );
    // 1080×1920 = 2025 tok/frame × 145 frames = 293,625 tok × $0.0000077
    expect(plan.cost.amountUsd).toBeCloseTo(2.2609);
    // THE POINT, and why a single scalar had to go: the old price quoted this at the 720p rate,
    // which is 2.5x low, and a quote that drifts DOWN from the invoice is the one failure the
    // pre-generation check exists to prevent.
    //
    // ⚠️ It has to be the RATE that is asserted, not the total. "More than twice the 720p total" is
    // true of the 720p rate here too — the token count alone is 2.25x — so that version of this
    // test passes under the very mutation it names. The rate is the thing that must differ.
    expect(plan.cost.detail).toContain("$0.0000077/tok");
  });

  it("bills the frame at BOTH ends — fps×secs+1, which is what the invoices actually said", () => {
    // The published formula reads fps × duration. Quoted literally it came in 0.5-0.7% under the
    // invoice on seven billed calls, and the gap was exactly 900 tokens every time — which at
    // 720x1280 is exactly one frame. An N-second clip is billed inclusive of both endpoints.
    //
    // This is pinned as the DIFFERENCE BETWEEN TWO DURATIONS rather than as one total, because that
    // is what a per-frame off-by-one cannot fake: 8s and 6s must differ by exactly 48 frames, and
    // each must carry the same single extra frame on top.
    const at = (secs: number) =>
      estimate(
        "video.generate",
        { ...PROMPT, durationSeconds: secs, width: 720, height: 1280 },
        { model: "bytedance/seedance-2.0" },
      ).cost.amountUsd;

    const perFrame = (720 * 1280) / 1024; // 900 tokens
    const rate = 0.000007;
    expect(at(8) - at(6)).toBeCloseTo(48 * perFrame * rate); // 24fps × 2s
    expect(at(8)).toBeCloseTo((24 * 8 + 1) * perFrame * rate); // $1.2159 — billed exactly this
    expect(at(6)).toBeCloseTo((24 * 6 + 1) * perFrame * rate); // $0.9135 — billed exactly this
  });

  it("rounds a fractional token count UP, because a token is a unit", () => {
    // 480x854 is 400.3125 tokens a frame, so the total lands between integers. Rounding to nearest
    // would under-quote half the time, which is the one direction this file refuses.
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 480, height: 854 },
      { model: "bytedance/seedance-2.0" },
    );

    // ⚠️ THE ASSERTION IS ON THE TOKEN COUNT, NOT ON THE DOLLARS, and the first draft of this test
    // got that wrong. `round()` at the bottom of a quote is Math.round to 4 decimal places, shared
    // by every price path in this file — so it can still take the final figure down by up to
    // $0.00005 after the tokens have been ceiled. Asserting `amountUsd >= exact` therefore fails on
    // arithmetic that is doing exactly what it should, and "fixing" it would mean changing the
    // rounding of every image quote too, for half a thousandth of a cent.
    const exactTokens = ((480 * 854) / 1024) * (24 * 6 + 1); // 58,045.3125
    const quoted = Number(/→ (\d+) tok /.exec(plan.cost.detail ?? "")?.[1]);
    expect(Number.isInteger(quoted)).toBe(true);
    expect(quoted).toBe(Math.ceil(exactTokens)); // 58,046 — up, never to nearest
  });

  it("refuses a size BETWEEN two bands rather than rounding it down into the cheaper 4K rate", () => {
    // 1440p: past 1080p, short of 4K. 4K is the one band whose rate is LOWER than the one below it,
    // so a tolerant `<= 2160` here would under-quote every 2K clip.
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 1440, height: 2560 },
      { model: "bytedance/seedance-2.0" },
    );
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.detail).toMatch(/not a resolution its price list covers/);
  });

  it("refuses a band the model publishes no rate for rather than borrowing a neighbour's", () => {
    // seedance-2.0-fast advertises 480p and 720p only, and quotes one rate for them.
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 1080, height: 1920 },
      { model: "bytedance/seedance-2.0-fast" },
    );
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.detail).toMatch(/publishes no hd1080 rate/);
  });

  it("a calibration override replaces the token COUNT, not the per-band rate", () => {
    process.env.STUDIO_VIDEO_TOKENS_PER_SECOND = "10000";
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 720, height: 1280 },
      { model: "bytedance/seedance-2.0" },
    );
    // NO EXTRA FRAME HERE, deliberately: an override is a tokens-per-second figure pinned to a real
    // invoice, so whatever the provider counts is already inside it.
    expect(plan.cost.amountUsd).toBeCloseTo(0.42); // 6s × 10000 tok/s × $0.000007
    expect(plan.cost.detail).toMatch(/overriding the formula/);
  });

  it("an override still cannot price a size the list does not cover — the rate is the missing half", () => {
    process.env.STUDIO_VIDEO_TOKENS_PER_SECOND = "10000";
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6 },
      { model: "bytedance/seedance-2.0" },
    );
    expect(plan.cost.unpriced).toBe(true);
  });

  it("a STUDIO_PRICE_JSON override carrying the OLD single-rate shape reports unpriced, not a crash", () => {
    // The env is parsed and merged with no validation, so a stale override is a real arrival shape —
    // and the failure it used to cause was a TypeError thrown mid-quote rather than a refusal. This
    // file's opening rule is that a price we cannot compute is reported `unpriced`; a crash is
    // further from that than a confident zero would be.
    process.env.STUDIO_PRICE_JSON = JSON.stringify({
      "bytedance/seedance-2.0": {
        unit: "per_video_token",
        usdPerToken: 0.000007,
      },
    });
    const plan = estimate(
      "video.generate",
      { ...PROMPT, durationSeconds: 6, width: 720, height: 1280 },
      { model: "bytedance/seedance-2.0" },
    );
    expect(plan.cost.unpriced).toBe(true);
    expect(plan.cost.amountUsd).toBe(0);
  });
});

/**
 * Veo bills audio as a separate, 2x SKU ($0.40/s with audio, $0.20/s without). The price table carried
 * only the with-audio arm, so a SILENT clip — which is what the deck's video bed actually orders —
 * was quoted at twice its real cost. The property these pin down is not "the number is 0.20": it is
 * that the arm PRICED is the arm BOUGHT, resolved from the same `parameters.generateAudio` key the
 * request body carries.
 *
 * That equality only holds where the field is verified, which is VERTEX. The OpenRouter adapter
 * withholds the flag from pricing on purpose and always quotes the audio arm, so its failure
 * direction is an over-quote rather than a bill nobody was warned about; asserted at the bottom.
 */
describe("Veo audio SKU — the arm priced is the arm bought", () => {
  beforeEach(() => {
    delete process.env.STUDIO_PRICE_JSON;
  });

  const CLIP = { ...PROMPT, durationSeconds: 6 };
  const audio = (generateAudio: boolean) => ({
    providerParams: { parameters: { generateAudio } },
  });
  // The suite-wide env pins video at OpenRouter, so the Vertex path is named explicitly here.
  const VEO_ON_VERTEX = {
    provider: "vertex" as const,
    model: "veo-3.1-generate-001",
  };

  it("prices a silent clip at the no-audio arm — $0.20/s, not $0.40/s", () => {
    const plan = estimate("video.generate", CLIP, {
      ...VEO_ON_VERTEX,
      ...audio(false),
    });
    expect(plan.cost.amountUsd).toBeCloseTo(1.2); // 6s × $0.20
    expect(plan.cost.unpriced).toBeUndefined();
    expect(plan.cost.detail).toMatch(/no-audio SKU/);
  });

  it("prices an explicit audio clip at the with-audio arm — $0.40/s", () => {
    const plan = estimate("video.generate", CLIP, {
      ...VEO_ON_VERTEX,
      ...audio(true),
    });
    expect(plan.cost.amountUsd).toBeCloseTo(2.4); // 6s × $0.40
    expect(plan.cost.detail).toMatch(/with-audio SKU/);
  });

  it("defaults an UNSET flag to the audio arm — over-quoting is the safe failure", () => {
    const plan = estimate("video.generate", CLIP, VEO_ON_VERTEX);
    expect(plan.cost.amountUsd).toBeCloseTo(2.4);
    expect(plan.cost.detail).toMatch(/with-audio SKU/);
  });

  it("carries both arms on the OpenRouter-form id too, so a model-id flip never loses the cheap arm", () => {
    const opts = { provider: "vertex" as const, model: "google/veo-3.1" };
    expect(
      estimate("video.generate", CLIP, { ...opts, ...audio(false) }).cost
        .amountUsd,
    ).toBeCloseTo(1.2);
    expect(
      estimate("video.generate", CLIP, { ...opts, ...audio(true) }).cost
        .amountUsd,
    ).toBeCloseTo(2.4);
    expect(estimate("video.generate", CLIP, opts).cost.amountUsd).toBeCloseTo(
      2.4,
    );
  });

  it("reads the SAME providerParams shape preview.ts sends, so the pre-generation check is the fixed one", () => {
    // plannedInputs() emits exactly this for a clip; asserted there in preview.test.ts.
    const plan = estimate("video.generate", CLIP, {
      ...VEO_ON_VERTEX,
      providerParams: { parameters: { generateAudio: false } },
    });
    expect(plan.cost.amountUsd).toBeCloseTo(1.2);
  });

  it("ALWAYS quotes the audio arm on OpenRouter — its audio field is unverified, so it must over-quote", () => {
    // parameters.generateAudio is the Vertex wire field; this adapter spreads providerParams at the
    // top level and may still get audio. Pricing the cheap arm here would under-quote a real bill.
    const or = { provider: "openrouter" as const, model: "google/veo-3.1" };
    for (const opts of [
      { ...or, ...audio(false) },
      { ...or, ...audio(true) },
      or,
    ]) {
      const plan = estimate("video.generate", CLIP, opts);
      expect(plan.cost.amountUsd).toBeCloseTo(2.4); // 6s × $0.40, whatever the flag says
      expect(plan.cost.detail).toMatch(/with-audio SKU/);
    }
  });

  it("leaves a single-arm per-second model alone — Kling's flat price is now ENFORCED, not assumed", () => {
    // ─── WHAT THIS TEST USED TO CLAIM, AND WHY THE CLAIM CHANGED ────────────────────────────────
    //
    // It read "Kling has no audio arm to pick", resting on config.ts's written exemption: "Nothing
    // sends Kling an audio flag today, so a second arm would be one no request could ever select."
    //
    // ⚠️ THAT PREMISE WAS FALSE, and it was false in the expensive direction. OpenRouter's video
    // guide says `generate_audio` "defaults to true for models that support audio output", and
    // kling-v3.0-std advertises audio at 0.126/s against 0.084/s without. Nobody had to SEND a flag
    // to select the dearer arm — leaving it unset selected it. So the flat 0.084 here was a 50%
    // under-quote, which is the one direction the pre-generation check exists to prevent.
    //
    // ─── WHY IT IS TRUE NOW ─────────────────────────────────────────────────────────────────────
    //
    // The OpenRouter adapter now forces `generate_audio: false` on every video request, BELOW the
    // providerParams spread so a caller cannot flip it (adapters/openrouter.ts, and the two wire
    // assertions in adapters/openrouter.test.ts). MEASURED 2026-09-19: four real Kling cells sent
    // the flag and all four invoiced $0.5040 = 6s × $0.084 — the audio-off arm exactly, on the first
    // Kling invoice from this account (docs/probes/kling-moderation.md §5).
    //
    // So the price table is UNCHANGED and is now correct rather than optimistic. What moved is the
    // wire, and this test's claim moved with it: the flat arm is enforced, not merely unselectable.
    //
    // Still priced through the flag-honouring Vertex path on purpose — that keeps "a single-arm
    // price ignores generateAudio" a real assertion rather than one the OpenRouter always-audio
    // gate would satisfy for free.
    const kling = {
      provider: "vertex" as const,
      model: "kwaivgi/kling-v3.0-std",
    };
    expect(
      estimate("video.generate", CLIP, { ...kling, ...audio(false) }).cost
        .amountUsd,
    ).toBeCloseTo(0.504);
    const plan = estimate("video.generate", CLIP, { ...kling, ...audio(true) });
    expect(plan.cost.amountUsd).toBeCloseTo(0.504); // 6s × $0.084
    expect(plan.cost.detail).not.toMatch(/SKU/);
  });
});

describe("mandatory reasoning", () => {
  it("sends a reasoning block for Nano Banana Pro, which rejects requests without one", async () => {
    queue({
      body: { data: [{ b64_json: B64_PIXEL, media_type: "image/png" }] },
    });
    await generate("image.generate", PROMPT, {
      model: "google/gemini-3-pro-image",
    });
    expect(bodyOf(0).reasoning).toEqual({ enabled: true });
  });

  it("does not send one for models where it is optional", async () => {
    queue({
      body: { data: [{ b64_json: B64_PIXEL, media_type: "image/png" }] },
    });
    await generate("image.generate", PROMPT, {
      model: "google/gemini-3.1-flash-image",
    });
    expect(bodyOf(0).reasoning).toBeUndefined();
  });

  it("lets providerParams override the reasoning block", async () => {
    queue({
      body: { data: [{ b64_json: B64_PIXEL, media_type: "image/png" }] },
    });
    await generate("image.generate", PROMPT, {
      model: "google/gemini-3-pro-image",
      providerParams: { reasoning: { effort: "low" } },
    });
    expect(bodyOf(0).reasoning).toEqual({ effort: "low" });
  });
});

describe("default routing sends Nano + Veo to Vertex, ByteDance to OpenRouter", () => {
  beforeEach(() => {
    for (const k of [
      "STUDIO_IMAGE_PROVIDER",
      "STUDIO_IMAGE_EDIT_PROVIDER",
      "STUDIO_VIDEO_PROVIDER",
      "STUDIO_IMAGE_MODEL",
      "STUDIO_IMAGE_EDIT_MODEL",
      "STUDIO_VIDEO_MODEL",
    ])
      delete process.env[k];
  });

  it("defaults image + video to vertex with the Vertex-native ids", () => {
    expect(resolve("image.generate")).toMatchObject({
      model: "gemini-3-pro-image",
    });
    expect(resolve("image.generate").adapter.name).toBe("vertex");
    // Veo's Vertex id is NOT derivable from the OpenRouter one — it must come from the mapping.
    expect(resolve("video.generate")).toMatchObject({
      model: "veo-3.1-generate-001",
    });
  });

  it("falls back to the OpenRouter ids when a task is flipped back — the sequencing guard", () => {
    process.env.STUDIO_IMAGE_PROVIDER = "openrouter";
    process.env.STUDIO_VIDEO_PROVIDER = "openrouter";
    expect(resolve("image.generate")).toMatchObject({
      model: "google/gemini-3-pro-image",
    });
    expect(resolve("video.generate")).toMatchObject({
      model: "google/veo-3.1",
    });
  });

  it("prices the Vertex-native ids too, so a provider flip never silently becomes unpriced", () => {
    expect(
      estimate("video.generate", { ...PROMPT, durationSeconds: 5 }).cost
        .unpriced,
    ).toBeUndefined();
    expect(estimate("image.generate", PROMPT).cost.unpriced).toBeUndefined();
  });

  it("ByteDance and Kling stay on OpenRouter — Vertex does not serve them", () => {
    expect(
      resolve("video.generate", {
        provider: "openrouter",
        model: "bytedance/seedance-2.0",
      }).adapter.name,
    ).toBe("openrouter");
  });
});

describe("input validation happens before any billable call", () => {
  it.each([
    ["empty prompt", { prompt: "   " }],
    ["n = 0", { prompt: "x", n: 0 }],
    ["negative duration", { prompt: "x", durationSeconds: -1 }],
  ])("rejects %s", async (_label, inputs) => {
    await expect(
      generate("image.generate", inputs as GenerationInputs),
    ).rejects.toThrow(GenerationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
