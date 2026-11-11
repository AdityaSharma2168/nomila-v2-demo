/**
 * studio/pricing — turn a config Price into a pre-generation CostEstimate.
 *
 * Shared by every adapter so OpenRouter and Vertex quote the same way. The rule that matters:
 * a price we cannot compute is reported `unpriced`, never $0. A confident zero is worse than an
 * honest "unknown" when the number is about to be shown to an athlete before she spends money.
 */
import {
  imageSizeFrom, priceFor, tokensPerImage, tokensPerReference, videoTierFor, VIDEO_TOKEN_FPS,
  type ImageSizeName,
} from "./config";
import type { CostEstimate, GenerationInputs, ProviderOpts } from "./types";

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Which output RESOLUTION is this run buying?
 *
 * Read from the SAME object the adapter merges into the request body —
 * `providerParams.generationConfig.imageConfig.imageSize` — through the one reader in studio/config,
 * for exactly the reason wantsAudio gives below: resolving a SKU from anywhere other than where the
 * request carries it is how an estimate drifts from the invoice.
 *
 * Undefined means the request names no size, so the API serves its own default (1K) and the base
 * figure is already right. It does NOT mean "unknown" and must not resolve to the expensive arm:
 * unlike Veo's audio, where an unset flag genuinely buys the pricier SKU, an unset size here buys
 * the cheaper one. Defaulting to 4K "to be safe" would over-quote every ordinary generate in the
 * product by 79%.
 */
function imageSizeFor(opts?: ProviderOpts): ImageSizeName | undefined {
  return imageSizeFrom(opts?.providerParams);
}

/**
 * Which video SKU is this run buying — the audio arm or the silent one?
 *
 * Read from the SAME place the request body reads it: `providerParams.parameters.generateAudio`, the
 * verified Vertex wire field that the adapter spreads straight into `parameters`. Resolving it from
 * anywhere else is exactly how an estimate drifts from the invoice; resolving it from here makes
 * "the SKU we price" and "the SKU we buy" the same value by construction rather than by agreement.
 *
 * Unset ⇒ AUDIO, for two reasons: Veo 3.x generates audio unless told not to, and over-quoting is the
 * safe failure. Being quoted high and billed low surprises nobody.
 *
 * Only an adapter whose wire body actually carries this field passes `opts` in — the OpenRouter one
 * withholds it on purpose (see the note on its `estimate`), so it resolves to the audio arm and
 * over-quotes rather than risking the reverse.
 */
function wantsAudio(opts?: ProviderOpts): boolean {
  const params = opts?.providerParams?.parameters as { generateAudio?: unknown } | undefined;
  // `!== false`, not a truthiness test — only an explicit false buys the cheaper arm.
  return params?.generateAudio !== false;
}

const unpriced = (detail: string): CostEstimate => ({
  amountUsd: 0, currency: "USD", basis: "estimated", unpriced: true, detail,
});

export function estimateCost(inputs: GenerationInputs, model: string, opts?: ProviderOpts): CostEstimate {
  const price = priceFor(model);
  if (!price) return unpriced(`no price configured for ${model}`);

  switch (price.unit) {
    case "per_image": {
      const n = inputs.n ?? 1;
      return { amountUsd: round(price.usd * n), currency: "USD", basis: "estimated", detail: `${n} × $${price.usd}/image` };
    }
    case "per_image_token": {
      const n = inputs.n ?? 1;
      // THE ESCAPE HATCH OUTRANKS THE SIZE, and the order here is the whole reason why. A zeroed
      // base means "we have no figure for this model" — it must not become a figure because a
      // request happened to name 4K, which is what resolving the size first would do.
      const base = price.tokensPerImage;
      if (!base || !Number.isFinite(base)) {
        return unpriced(`${model} bills per output token ($${price.usdPerToken}/tok); tokens-per-image is not published — set STUDIO_TOKENS_PER_IMAGE to estimate`);
      }
      // WHICH SKU IS THIS RUN BUYING — the same question wantsAudio() answers for Veo, one field
      // over, and answered the same way: from the object the ADAPTER SENDS, so the size we price and
      // the size we buy are the same value by construction rather than by agreement.
      const size = imageSizeFor(opts);
      const tpi = size ? tokensPerImage(size) : base;
      if (!tpi || !Number.isFinite(tpi)) {
        return unpriced(`${model} bills per output token ($${price.usdPerToken}/tok); no tokens-per-image is configured for ${size} — set STUDIO_TOKENS_PER_IMAGE_4K to estimate`);
      }
      // REFERENCES MOVE THE NUMBER NOW. They did not before, and that was defensible while a
      // reference was an occasional brand cover; it stopped being defensible when references became
      // the primary input to a generation. Both approximations are stated in `detail` rather than
      // smoothed away — see tokensPerReference in studio/config.ts for which way each one errs.
      const refs = inputs.references?.length ?? 0;
      const tpr = tokensPerReference();
      const refTokens = Number.isFinite(tpr) && tpr > 0 ? refs * tpr : 0;
      const refPart = refTokens
        ? `${refs} reference${refs === 1 ? "" : "s"} × ~${tpr} tok`
        : "";
      return {
        amountUsd: round(price.usdPerToken * (tpi * n + refTokens)),
        currency: "USD", basis: "estimated",
        detail:
          `${n} × ~${tpi} tok${size ? ` (${size})` : ""}${refPart ? ` + ${refPart}` : ""} × $${price.usdPerToken}/tok ` +
          "(tokens-per-image is an ASSUMPTION" +
          // 512px has no published token count, so it is quoted at the 1K figure. Named here rather
          // than smoothed away, the same way every other approximation in this file is.
          (size === "512px" ? "; 512px has no published token count and is quoted at the 1K figure, which over-prices it" : "") +
          (refTokens
            ? "; references are quoted at the OUTPUT rate on a per-image base count, which over-prices each token and under-counts a large photo"
            : "") +
          "; reasoning tokens bill on top)",
      };
    }
    case "per_second": {
      const secs = inputs.durationSeconds ?? 5;
      const audio = wantsAudio(opts);
      // A model with no audio arm configured bills one rate either way. Don't invent the second one.
      const usd = audio ? (price.usdWithAudio ?? price.usd) : price.usd;
      // Named only when there is a real choice to name, so a single-arm model reads as it always did.
      const arm = price.usdWithAudio === undefined
        ? ""
        : audio
          ? " (with-audio SKU)"
          : ` (no-audio SKU — with audio it would be $${round(price.usdWithAudio * secs)})`;
      return { amountUsd: round(usd * secs), currency: "USD", basis: "estimated", detail: `${secs}s × $${usd}/s${arm}` };
    }
    case "per_video_token": {
      const secs = inputs.durationSeconds ?? 5;

      // THE BAND DECIDES THE RATE, AND THE BAND NEEDS PIXELS. Both halves of a per-token video
      // quote — how many tokens, and what each one costs — are functions of the output's size. So a
      // request that names no size cannot be priced at all, and saying so is what closes the old
      // scalar's failure: one rate applied at every resolution, right at 720p and 2.5x wrong at
      // 1080p, in the UNDER-quoting direction.
      const tier = videoTierFor(inputs.width, inputs.height);
      if (!tier) {
        return unpriced(
          `${model} bills per video token, at a rate set by the output resolution — ` +
            (inputs.width && inputs.height
              ? `${inputs.width}x${inputs.height} is not a resolution its price list covers`
              : "and this request names no width and height"),
        );
      }
      // OPTIONAL CHAINING, not a type-level certainty. `STUDIO_PRICE_JSON` is parsed straight out of
      // the environment and merged over the defaults with no validation (studio/config.ts,
      // `priceFor`), so an override still carrying this SKU's old single-`usdPerToken` shape would
      // arrive with no tier table at all. Reaching into it unguarded turns that into a TypeError
      // mid-quote; the rule this file opens with is that a price we cannot compute is reported
      // `unpriced`, and a crash is further from that than a zero is.
      const usdPerToken = price.usdPerTokenByTier?.[tier];
      if (!usdPerToken || !Number.isFinite(usdPerToken)) {
        return unpriced(
          `${model} publishes no ${tier} rate — a band with no published price must not borrow a neighbour's`,
        );
      }

      // ─── THE FRAME COUNT IS fps×secs + 1, AND THAT IS MEASURED, NOT ASSUMED ──────────────────
      //
      // The published formula reads `h × w × fps × duration ÷ 1024`, and quoting it literally came
      // in consistently 0.5–0.7% UNDER the invoice on seven billed Seedance calls. That looked like
      // a percentage bias worth rounding away. It is not a bias: the gap was exactly 900 tokens on
      // every one of the seven, across two durations and two models — and at 720x1280, 900 tokens is
      // exactly ONE FRAME (720 × 1280 ÷ 1024). The provider bills the frames of an N-second clip
      // INCLUSIVE of both endpoints, which is fps×N + 1, not fps×N.
      //
      // With the extra frame the derivation is EXACT on all seven — implied token counts of 173,700
      // and 130,500 against 900 × 193 and 900 × 145. A percentage fudge would have papered over an
      // off-by-one and stayed wrong at every other duration; this is right at all of them.
      //
      // ⚠️ A CALIBRATION OVERRIDE IS NOT GIVEN THE EXTRA FRAME. It is a measured tokens-per-second
      // pinned to a real invoice, so whatever the provider counts is already inside the figure.
      //
      // Math.ceil on top because a token is a unit, not a quantity: w×h÷1024 is fractional at plenty
      // of real sizes (480x854 is 400.3 tokens a frame), and the half-token has to round the way
      // that cannot under-quote.
      const override = price.tokensPerSecond;
      const usingOverride = !!override && Number.isFinite(override);
      const frames = VIDEO_TOKEN_FPS * secs + 1;
      const tokens = usingOverride
        ? Math.ceil(override! * secs)
        : Math.ceil((inputs.width! * inputs.height! * frames) / 1024);

      return {
        amountUsd: round(usdPerToken * tokens),
        currency: "USD",
        basis: "estimated",
        detail:
          `${secs}s × ${inputs.width}x${inputs.height} (${tier}) → ${tokens} tok × $${usdPerToken}/tok ` +
          (usingOverride
            ? `(${override} tok/s from STUDIO_VIDEO_TOKENS_PER_SECOND, overriding the formula)`
            : `(w×h×${frames}f÷1024 — ${VIDEO_TOKEN_FPS}fps×${secs}s+1, the frame count measured against 7 billed calls)`),
      };
    }
  }
}

/**
 * The same quote, for N calls instead of one.
 *
 * ─── WHY THIS EXISTS RATHER THAN `inputs.n` ─────────────────────────────────────────────────────
 *
 * A masked edit is ONE PROVIDER CALL PER CROP — each crop gets its own call and its own patch
 * (studio/composite.ts explains why one union crop over everything is not an option). So a
 * three-crop edit costs three images and the quote has to say so, or the athlete approves a third of
 * what she is about to spend.
 *
 * `calls` is the CROP count, not the region count, and since same-target regions merge into one crop
 * the two differ on exactly the multi-target edits this matters most for. Passing regions here would
 * over-quote a merged job — quoting seven for the four calls it actually makes — which is the safe
 * direction and still wrong: she would decline a job on a price we invented.
 *
 * Expressing that as `inputs.n = 3` would also produce the right total, and it was the first
 * instinct. It is wrong in a way that only shows up later: `n` travels into every INDIVIDUAL call's
 * inputs too, so each of the three calls would then estimate itself at 3x and the cost log would
 * record 9x for a 3x job whenever a provider omits its usage block. Keeping `n` at 1 — one image per
 * call, which is what actually happens — and multiplying HERE puts the region count in exactly one
 * place: the quote.
 *
 * `unpriced` is preserved rather than multiplied. Three unknowns are still unknown, and an
 * `unpriced` estimate carries amountUsd 0, which would multiply to a confident $0.
 */
export function scaleCost(cost: CostEstimate, calls: number): CostEstimate {
  if (calls <= 1 || cost.unpriced) return cost;
  return {
    ...cost,
    amountUsd: round(cost.amountUsd * calls),
    detail: `${calls} areas × [${cost.detail ?? "one image"}] — a masked edit is one call per area`,
  };
}

/** The provider's own figure for work that ACTUALLY ran. Falls back to the estimate when absent. */
export function reportedCost(usage: unknown, fallback: CostEstimate): CostEstimate {
  const c = (usage as { cost?: unknown } | null | undefined)?.cost;
  if (typeof c !== "number" || !Number.isFinite(c)) return fallback;
  return { amountUsd: c, currency: "USD", basis: "reported", detail: "provider-reported usage.cost" };
}
