/**
 * pricing.test.ts — the pre-generation quote, and specifically the one number that decides whether
 * the spend boundary means anything at variable output resolution.
 *
 * ─── WHAT THIS IS REALLY GUARDING ───────────────────────────────────────────────────────────────
 *
 * `studio/generate.ts` checks the quote against TWO ceilings — the figure the athlete approved, and
 * the house cap `maxJobUsd()` underneath it — and BOTH read the same estimate. So a single
 * under-quote defeats both at once: she approves $0.13, the model bills $0.24, and neither guard
 * fires because neither was ever shown $0.24.
 *
 * That is not hypothetical. `tokensPerImage` was one constant (1120) applied to every tier, and
 * Google bills 2000 output tokens at 4K. The `4K quotes 4K, not 1K` case below is the NEGATIVE
 * CONTROL for exactly that regression: collapse tokensPerImage back to a constant and it fails.
 *
 * Everything here is pure — no network, no adapter, no clock. The figures are the published ones
 * rather than round test numbers wherever the point is that we quote what Google bills.
 */
import { estimateCost } from "./pricing";
import { imageSizeFrom, imageSizeParams, tokensPerImage, IMAGE_SIZES, type ImageSizeName } from "./config";
import type { GenerationInputs, ProviderOpts } from "./types";

const ORIGINAL_ENV = { ...process.env };

/** The live route for both image tasks. Its real published rate, deliberately not a round number. */
const NANO_PRO = "gemini-3-pro-image";
const USD_PER_TOKEN = 0.00012;

const inputs = (over: Partial<GenerationInputs> = {}): GenerationInputs => ({ prompt: "p", ...over });

/** What plannedInputs will hand the adapter for a given size — through the one writer, not a literal. */
const atSize = (size: ImageSizeName): ProviderOpts => ({ providerParams: imageSizeParams(size) });

beforeEach(() => {
  // References OFF by default so the arithmetic under test is the image arm alone. The reference
  // contribution has its own case below.
  process.env = { ...ORIGINAL_ENV, STUDIO_TOKENS_PER_REFERENCE: "0" };
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tokensPerImage is a function of the size", () => {
  it("bills 1120 for the sizes Google publishes 1120 for, and 2000 for 4K", () => {
    expect(tokensPerImage()).toBe(1120);        // unnamed ⇒ the API default, 1K
    expect(tokensPerImage("1K")).toBe(1120);
    expect(tokensPerImage("2K")).toBe(1120);
    expect(tokensPerImage("4K")).toBe(2000);
  });

  it("maps 512px to the 1K figure rather than inventing one", () => {
    // Google publishes no output-token count for 512px. It is certainly fewer than 1120, and
    // "certainly fewer" is not a number — so it over-quotes, in the direction config.ts calls safe.
    expect(tokensPerImage("512px")).toBe(1120);
  });
});

describe("the quote follows the size the request actually carries", () => {
  it("quotes the 1K figure when nothing names a size", () => {
    const cost = estimateCost(inputs(), NANO_PRO);
    expect(cost.amountUsd).toBeCloseTo(1120 * USD_PER_TOKEN, 6);   // $0.1344
    expect(cost.unpriced).toBeUndefined();
  });

  it.each(["1K", "2K"] as const)("quotes $0.1344 at %s", (size) => {
    expect(estimateCost(inputs(), NANO_PRO, atSize(size)).amountUsd).toBeCloseTo(0.1344, 6);
  });

  /**
   * THE NEGATIVE CONTROL. This is the regression that shipped: 4K bills $0.24 and quoted $0.1344,
   * a 79% under-quote that sails past both money guards because both read this number.
   *
   * It asserts the absolute figure AND that it differs from the 1K one, because either assertion
   * alone can pass a broken implementation — a hardcoded 2000 would satisfy the difference, and a
   * hardcoded 1120 would satisfy neither, but a future "round everything to 0.24" would satisfy the
   * absolute. Together they pin the arithmetic.
   */
  it("quotes 4K at 4K, not at 1K", () => {
    const at4k = estimateCost(inputs(), NANO_PRO, atSize("4K"));
    const at1k = estimateCost(inputs(), NANO_PRO, atSize("1K"));
    expect(at4k.amountUsd).toBeCloseTo(2000 * USD_PER_TOKEN, 6);   // $0.24, Google's own per-image price
    expect(at4k.amountUsd).toBeGreaterThan(at1k.amountUsd);
    expect(at4k.amountUsd / at1k.amountUsd).toBeCloseTo(2000 / 1120, 4);
  });

  it("names the size in `detail`, so the why-line is checkable against the invoice", () => {
    expect(estimateCost(inputs(), NANO_PRO, atSize("4K")).detail).toContain("(4K)");
    expect(estimateCost(inputs(), NANO_PRO, atSize("4K")).detail).toContain("2000 tok");
    // An unnamed size names nothing — the line reads exactly as it always did.
    expect(estimateCost(inputs(), NANO_PRO).detail).not.toContain("(1K)");
  });

  it("says out loud that 512px is quoted at a figure Google never published", () => {
    const cost = estimateCost(inputs(), NANO_PRO, atSize("512px"));
    expect(cost.amountUsd).toBeCloseTo(0.1344, 6);
    expect(cost.detail).toContain("512px has no published token count");
  });

  it("multiplies by n, at whatever size", () => {
    const cost = estimateCost(inputs({ n: 3 }), NANO_PRO, atSize("4K"));
    expect(cost.amountUsd).toBeCloseTo(3 * 2000 * USD_PER_TOKEN, 6);
  });

  it("still folds references in on top of the sized image count", () => {
    process.env.STUDIO_TOKENS_PER_REFERENCE = "258";
    const cost = estimateCost(inputs({ references: [{ kind: "url", url: "u" }] }), NANO_PRO, atSize("4K"));
    // estimateCost rounds to 4dp (its own `round`), so the raw 0.27096 quotes as 0.271. Asserted at
    // the module's own precision rather than to 6, which would be testing floating point.
    expect(cost.amountUsd).toBeCloseTo((2000 + 258) * USD_PER_TOKEN, 4);
    expect(cost.amountUsd).toBe(0.271);
  });
});

describe("the escape hatch outranks the size", () => {
  /**
   * `STUDIO_TOKENS_PER_IMAGE=0` means "we have no figure for this model". It must not become a
   * figure because a request happened to ask for 4K — which is precisely what resolving the size
   * BEFORE the base check would do, and why the order in estimateCost is load-bearing.
   */
  it("reports unpriced at 4K when the base is zeroed", () => {
    process.env.STUDIO_TOKENS_PER_IMAGE = "0";
    for (const size of IMAGE_SIZES) {
      const cost = estimateCost(inputs(), NANO_PRO, atSize(size));
      expect(cost.unpriced).toBe(true);
      expect(cost.amountUsd).toBe(0);
    }
    expect(estimateCost(inputs(), NANO_PRO).unpriced).toBe(true);
  });

  it("reports unpriced rather than $0 when only the 4K figure is zeroed", () => {
    process.env.STUDIO_TOKENS_PER_IMAGE_4K = "0";
    expect(estimateCost(inputs(), NANO_PRO, atSize("4K")).unpriced).toBe(true);
    // ...and the sizes that still have a figure keep quoting one.
    expect(estimateCost(inputs(), NANO_PRO, atSize("2K")).amountUsd).toBeCloseTo(0.1344, 6);
  });

  it("honours a recalibrated 4K figure without touching the base", () => {
    process.env.STUDIO_TOKENS_PER_IMAGE_4K = "2500";
    expect(estimateCost(inputs(), NANO_PRO, atSize("4K")).amountUsd).toBeCloseTo(2500 * USD_PER_TOKEN, 6);
    expect(estimateCost(inputs(), NANO_PRO, atSize("1K")).amountUsd).toBeCloseTo(0.1344, 6);
  });
});

describe("the size we price is the size we buy", () => {
  /**
   * The pair, round-tripped. `imageSizeParams` is what plannedInputs writes into providerParams and
   * what the vertex adapter merges into `generationConfig`; `imageSizeFrom` is what pricing reads
   * back. If the two ever spell the path differently, the quote silently describes a different
   * request than the one that runs — the same class of drift wantsAudio() exists to prevent.
   */
  it.each(IMAGE_SIZES)("round-trips %s through the wire shape the adapter sends", (size) => {
    const params = imageSizeParams(size);
    expect(params).toEqual({ generationConfig: { imageConfig: { imageSize: size } } });
    expect(imageSizeFrom(params)).toBe(size);
  });

  it("treats an absent, malformed or unknown size as unnamed rather than throwing", () => {
    expect(imageSizeFrom(undefined)).toBeUndefined();
    expect(imageSizeFrom({})).toBeUndefined();
    expect(imageSizeFrom({ generationConfig: {} })).toBeUndefined();
    // Lowercase is REJECTED by the API, so it is not a size we may quote as one.
    expect(imageSizeFrom({ generationConfig: { imageConfig: { imageSize: "4k" } } })).toBeUndefined();
    expect(imageSizeFrom({ generationConfig: { imageConfig: { imageSize: 4096 } } })).toBeUndefined();
  });

  it("quotes the base figure when the size is unreadable, never the expensive arm", () => {
    // Unlike Veo's audio — where an unset flag genuinely buys the pricier SKU — an unset size buys
    // the CHEAPER one. Defaulting up "to be safe" would over-quote every ordinary generate by 79%.
    const cost = estimateCost(inputs(), NANO_PRO, { providerParams: { generationConfig: { imageConfig: { imageSize: "huge" } } } });
    expect(cost.amountUsd).toBeCloseTo(0.1344, 6);
  });

  /**
   * ⚠️ THE PRICE HALF OF THE CLIP-AUDIO REVERT CHECK. Its siblings are in preview.test.ts (the flag
   * reaches the wire off the brief) and routes/studio.test.ts (the route freezes it). Here, and only
   * here, is pricing real — preview.test.ts mocks `router.estimate` to a fixed plan, so a dollar
   * asserted there would hold under every mutation.
   *
   * MUTATION: point `usdWithAudio` at `usd`, or make `wantsAudio` return false. This reds.
   */
  it("sound doubles the Veo clip — the arm she approves is the arm the wire bought", () => {
    const at = (generateAudio: boolean) =>
      estimateCost(inputs({ durationSeconds: 8 }), "veo-3.1-generate-001", {
        providerParams: { parameters: { generateAudio } },
      }).amountUsd;
    expect(at(false)).toBeCloseTo(8 * 0.2, 6); // $1.60
    expect(at(true)).toBeCloseTo(8 * 0.4, 6); //  $3.20
  });

  /**
   * ⚠️ THE OTHER HALF OF "SEEDANCE AUDIO IS FREE", and the reason b-roll may have sound while a
   * Kling bridge may not. Seedance is `per_video_token`; `wantsAudio` is consulted only inside
   * `case "per_second"`. So this is not a rounding claim — the flag cannot reach the arithmetic.
   *
   * MUTATION: make `per_video_token` consult `wantsAudio` for any purpose. This reds.
   */
  it("sound is free on seedance — the same tokens, the same figure, flag either way", () => {
    const at = (generateAudio: boolean) =>
      estimateCost(
        inputs({ durationSeconds: 6, width: 720, height: 1280 }),
        "bytedance/seedance-2.0-fast",
        { providerParams: { parameters: { generateAudio } } },
      ).amountUsd;
    expect(at(true)).toBeGreaterThan(0);
    expect(at(true)).toBe(at(false));
  });

  it("leaves the video arms alone — a size on an image job must not reach a per-second quote", () => {
    const veo = estimateCost(inputs({ durationSeconds: 4 }), "veo-3.1-generate-001", {
      providerParams: { ...imageSizeParams("4K"), parameters: { generateAudio: false } },
    });
    expect(veo.amountUsd).toBeCloseTo(4 * 0.2, 6);
  });
});
