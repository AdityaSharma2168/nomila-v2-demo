/**
 * studio/config — the ONLY place a provider, a model id, or a price lives.
 *
 * Same rule as lib/models.ts: never hardcode a model at a call site, and make every value
 * env-overridable so a bad rollout is a Cloud Run env flip rather than a redeploy. Everything is
 * read at CALL time, never captured at module load — otherwise an env change needs a restart, and
 * that defeats the point (this was a real bug in the first cut, caught by router.test.ts).
 *
 * PRICING — where each number came from (checked 2026-08-27 against the live OpenRouter API):
 *   • images  GET /api/v1/models            → pricing.image_output, a USD-per-OUTPUT-TOKEN rate.
 *                                             /api/v1/images/models returns pricing_skus: null, so
 *                                             there is no flat per-image price to read.
 *   • video   GET /api/v1/videos/models     → pricing_skus. NOTE: /api/v1/models does not list video
 *                                             models at all, and /models/<slug>/endpoints reports
 *                                             prompt/completion "0" for them — videos/models is the
 *                                             only surface that carries the real figures.
 *
 * Two different video billing shapes came back: Veo and Kling bill per DURATION SECOND (real numbers
 * below); Seedance bills per VIDEO TOKEN. Anything per-token needs a tokens-per-unit assumption to
 * turn into a pre-generation dollar figure, and that conversion rate is NOT published. So:
 *   - per-token models carry an explicit, env-overridable, clearly-labelled assumption;
 *   - with no assumption configured, the model reports `unpriced` — never a confident $0.
 * The estimate is always the BEFORE number. After a run, the provider's own `usage.cost` is
 * authoritative and is what gets logged (basis: "reported").
 */
import { readCap } from "../lib/spendCap";
import { studioFlag, studioGovernanceFlag } from "./studioFlag";
import type { GenerationTask, ProviderName, ShotType } from "./types";

export interface TaskRoute {
  provider: ProviderName;
  model: string;
}

// ─── Model registry ─────────────────────────────────────────────────────────────────────────────
// Logical name → provider-specific id. Ids verified to exist on OpenRouter 2026-08-27.

export const MODELS = {
  // Google image ("Nano Banana"). Pro is the quality arm, Flash the fast/volume arm.
  nanoPro: "google/gemini-3-pro-image", // Nano Banana Pro (Gemini 3 Pro Image)
  nanoFlash: "google/gemini-3.1-flash-image", // Nano Banana 2 (Gemini 3.1 Flash Image)
  // ByteDance image.
  seedream: "bytedance-seed/seedream-5-0-pro", // Seedream 5.0 Pro
  // Video.
  veo: "google/veo-3.1",
  seedance: "bytedance/seedance-2.0",
  seedanceFast: "bytedance/seedance-2.0-fast",
  kling: "kwaivgi/kling-v3.0-std",
  // Segmentation. Not a generator — it returns a garment MASK for the edit path (studio/segment.ts).
  sam3: "fal-ai/sam-3/image",
  // PR 19: not a model — sharp, in-process (studio/adapters/local.ts). An id of its own so the price table and the
  // cost line say what ran.
  crop: "local/sharp-crop",
} as const;

/**
 * Models on which REASONING IS MANDATORY — the request must carry a `reasoning` block or the model
 * rejects it. Note gemini-3-pro-image supports `reasoning` but NOT `reasoning_effort` (that is on
 * 3.1-flash-image), so the adapter sends the generic form. Reasoning tokens bill separately
 * (pricing.internal_reasoning), which is why a Pro estimate is a floor, not a ceiling.
 */
export function reasoningRequired(model: string): boolean {
  const extra = (process.env.STUDIO_REASONING_MODELS ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  return model === MODELS.nanoPro || extra.includes(model);
}

// ─── Routing ────────────────────────────────────────────────────────────────────────────────────

// ─── Vertex-native ids + locations ──────────────────────────────────────────────────────────────
// Verified against the live project 2026-08-27 by probing each id. The Gemini image ids happen to
// match OpenRouter's minus the `google/` prefix; Veo's does NOT (google/veo-3.1 vs
// veo-3.1-generate-001), so the mapping is explicit rather than derived from the string.

const VERTEX_MODELS: Record<string, string> = {
  [MODELS.nanoPro]: "gemini-3-pro-image",
  [MODELS.nanoFlash]: "gemini-3.1-flash-image",
  [MODELS.veo]: "veo-3.1-generate-001",
};

/** OpenRouter-style id → Vertex publisher-model id. Passes through anything already Vertex-native. */
export function vertexModelFor(model: string): string {
  return VERTEX_MODELS[model] ?? model;
}

/**
 * Vertex region per model — and these genuinely differ, which is the trap:
 *   gemini-3-pro-image / gemini-3.1-flash-image  resolve ONLY in `global` (us-central1 → 404)
 *   veo-3.1-generate-001                          resolves ONLY in `us-central1` (not global)
 * Both directions were confirmed by probe, so neither is a guess.
 */
export function vertexLocationFor(model: string): string {
  if (process.env.STUDIO_VERTEX_LOCATION)
    return process.env.STUDIO_VERTEX_LOCATION;
  if (model.startsWith("veo")) return "us-central1";
  return "global";
}

/**
 * Provider + model per task.
 *
 * Nano (image) and Veo (video) default to VERTEX — Mia wants them on GCP credits rather than
 * per-call OpenRouter spend, and both were probed working on gamechanger-pocket-agent. ByteDance and
 * Kling stay on OpenRouter, which is the only place they are served.
 *
 * The sequencing guard still holds: the OpenRouter path for Nano and Veo is fully intact and one env
 * var away (STUDIO_IMAGE_PROVIDER=openrouter / STUDIO_VIDEO_PROVIDER=openrouter), so if the Vertex
 * side ever misbehaves the spike falls back without a code change.
 */
/**
 * A model id is stored in its OpenRouter form and translated at the Vertex boundary, so the price
 * table stays keyed one way and a provider flip needs no second set of ids.
 *
 * Hoisted out of `routes()` because the per-shot video table below needs the same translation and a
 * second copy of it is a second place for the Vertex boundary to be got wrong.
 */
const forProvider = (p: ProviderName, m: string) =>
  p === "vertex" ? vertexModelFor(m) : m;

export function routes(): Record<GenerationTask, TaskRoute> {
  const imageProvider =
    (process.env.STUDIO_IMAGE_PROVIDER as ProviderName) ?? "vertex";
  const editProvider =
    (process.env.STUDIO_IMAGE_EDIT_PROVIDER as ProviderName) ?? imageProvider;
  const videoProvider =
    (process.env.STUDIO_VIDEO_PROVIDER as ProviderName) ?? "vertex";
  return {
    "image.generate": {
      provider: imageProvider,
      model:
        process.env.STUDIO_IMAGE_MODEL ??
        forProvider(imageProvider, MODELS.nanoPro),
    },
    "image.edit": {
      provider: editProvider,
      model:
        process.env.STUDIO_IMAGE_EDIT_MODEL ??
        forProvider(editProvider, MODELS.nanoPro),
    },
    "video.generate": {
      provider: videoProvider,
      model:
        process.env.STUDIO_VIDEO_MODEL ??
        forProvider(videoProvider, MODELS.veo),
    },
    // fal is the only place SAM-3 is served, so there is no provider flip to make here and no
    // `forProvider` translation to apply — unlike Nano and Veo, this id has exactly one home.
    "image.segment": {
      provider: (process.env.STUDIO_SEGMENT_PROVIDER as ProviderName) ?? "fal",
      model: process.env.STUDIO_SEGMENT_MODEL ?? MODELS.sam3,
    },
    // PR 19 (S-7): one home, no provider flip — a crop is her pixels, cut here.
    "image.crop": { provider: "local", model: MODELS.crop },
  };
}

export function routeFor(task: GenerationTask): TaskRoute {
  const r = routes()[task];
  if (!r) throw new Error(`No route configured for task ${task}`);
  return r;
}

// ─── Per-SHOT video routing ─────────────────────────────────────────────────────────────────────

/**
 * Provider + model per shot type. VIDEO ONLY, and deliberately beside `routes()` rather than inside
 * it.
 *
 * ⚠️ `routes()["video.generate"]` IS NOT TOUCHED, and that is the property that keeps this additive.
 * A caller that knows nothing about shot types — the runner resuming an old row, a script, a test
 * written before this existed — behaves exactly as it did. `STUDIO_VIDEO_PROVIDER` and
 * `STUDIO_VIDEO_MODEL` keep doing precisely what they did, because the identity arm IS that route
 * rather than a copy of it: the existing default was already Veo, which is the identity model, so
 * inheriting it means the established env flip cannot be silently bypassed by the new table.
 *
 * ─── WHY THE OTHER TWO ARE OPENROUTER AND WILL STAY THERE ──────────────────────────────────────
 *
 * Seedance and Kling are served nowhere else — the same fact that gives `image.segment` no provider
 * flip to make. So there is no `STUDIO_*_PROVIDER` knob that could usefully point them anywhere,
 * and the one here exists only so a future second home is an env change rather than a deploy.
 *
 * Read at CALL time, like everything else in this file.
 */
export function videoRouteFor(shot: ShotType): TaskRoute {
  switch (shot) {
    // INHERITED, not duplicated. See the note above.
    case "identity":
      return routeFor("video.generate");

    case "broll": {
      // seedance-2.0-fast won the bake-off's b-roll arm and is $0.0914/s against Veo's $0.20/s,
      // which is the whole reason b-roll is a separate route. It can ONLY do b-roll: it refuses
      // real-person image-to-video 6/6 by stated policy (studio/video/shotType.ts).
      const provider =
        (process.env.STUDIO_VIDEO_BROLL_PROVIDER as ProviderName) ??
        "openrouter";
      return {
        provider,
        model:
          process.env.STUDIO_VIDEO_BROLL_MODEL ??
          forProvider(provider, MODELS.seedanceFast),
      };
    }

    case "transition": {
      // LIVE FOR BRIDGES (V10, #532): `shotTypeFor` never returns this — the brief's frozen `lastFrame`
      // selects it in studio/preview.ts `plannedInputs`, beating identity because Veo on Vertex would
      // drop the last frame. Kling's first-last is measured: docs/probes/kling-first-last.md.
      const provider =
        (process.env.STUDIO_VIDEO_TRANSITION_PROVIDER as ProviderName) ??
        "openrouter";
      return {
        provider,
        model:
          process.env.STUDIO_VIDEO_TRANSITION_MODEL ??
          forProvider(provider, MODELS.kling),
      };
    }
  }
}

/**
 * The output size a shot type should ASK FOR, or null when it should ask for none.
 *
 * ─── ⚠️  THIS IS A MONEY DECISION BEFORE IT IS A PICTURE DECISION ──────────────────────────────
 *
 * seedance bills `per_video_token`, and BOTH halves of that quote are functions of the output's
 * pixels: the token count is `w x h x frames / 1024`, and the per-token RATE is chosen by the
 * resolution band. `studio/pricing.ts` says so plainly — "a request that names no size cannot be
 * priced at all" — and an unpriced quote is REFUSED by the spend gate. So a b-roll segment with no
 * dimensions is not a cheap segment; it is a segment that cannot be made.
 *
 * 720 ON THE SHORT EDGE, AND NOT 1080. The price table carries `sd` and `hd720` for
 * seedance-2.0-fast and nothing above, and that is the price list rather than an omission: the
 * model advertises `supported_resolutions: ["480p","720p"]`, so a 1080p request is unpriced
 * *correctly, because it is also unservable*. (Note this disagrees with studio/video/spec.ts's
 * "1080 on the short edge ... is what the Studio's generated clips come back at" — which was
 * written about Veo and is wrong about Veo too: V2b's clips came back 720x1280. The stitch target
 * conforms whatever arrives, so nothing downstream cares.)
 *
 * NULL FOR IDENTITY AND TRANSITION, and null is the right answer rather than a missing one. Veo and
 * Kling both bill `per_second`, so pixels buy no accuracy in the quote — and Vertex's video body
 * sends `aspectRatio` and ignores width/height entirely, so carrying them would be decoration that
 * a later reader could mistake for a request that was actually made.
 */
export function videoOutputSizeFor(
  shot: ShotType,
  aspectRatio: string | undefined,
): { width: number; height: number } | null {
  if (shot !== "broll") return null;
  const short = Number(process.env.STUDIO_VIDEO_BROLL_SHORT_EDGE ?? 720);
  return sizeForRatio(aspectRatio, short);
}

/**
 * "9:16" + 720 -> 720x1280. Null for anything unparseable.
 *
 * NULL FAILS CLOSED, deliberately: it flows to `unpriced` and a refusal she can read, rather than
 * to a guessed canvas that quotes one resolution and buys another. Both edges are forced EVEN —
 * yuv420p chroma siting needs it, the same rule `StitchTarget` states, and an odd edge is the kind
 * of thing that surfaces as a deep encoder error rather than as a bad number.
 */
function sizeForRatio(
  aspectRatio: string | undefined,
  shortEdge: number,
): { width: number; height: number } | null {
  const m = /^(\d+):(\d+)$/.exec((aspectRatio ?? "").trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return w <= h
    ? { width: even(shortEdge), height: even((shortEdge * h) / w) }
    : { width: even((shortEdge * w) / h), height: even(shortEdge) };
}

// ─── Pricing ────────────────────────────────────────────────────────────────────────────────────

export type Price =
  /** Flat USD per generated image. */
  | { unit: "per_image"; usd: number }
  /**
   * USD per output token (pricing.image_output). Needs tokensPerImage to become a dollar figure.
   *
   * `tokensPerImage` is the BASE — what an unnamed size costs, i.e. the API default of 1K. It is
   * NOT the whole story: a request that names 4K bills 2000 tokens rather than 1120, and
   * studio/pricing resolves that from the size the request actually carries. This field stays the
   * base because it is also the `unpriced` escape hatch (set it to 0 and the model reports no
   * price), and that must keep working regardless of what size a caller asks for.
   */
  | { unit: "per_image_token"; usdPerToken: number; tokensPerImage?: number }
  /**
   * USD per second of generated video (pricing_skus.duration_seconds*). Audio is a SEPARATE and more
   * expensive SKU on the models that offer one, so a per-second price carries both arms: `usd` is the
   * NO-AUDIO rate and `usdWithAudio` the with-audio rate. Carrying a single number is what quoted a
   * silent Veo clip at 2x its real cost. An absent `usdWithAudio` means we have verified only one
   * rate for that model and it bills the same either way — pricing must never invent the second arm.
   */
  | { unit: "per_second"; usd: number; usdWithAudio?: number }
  /**
   * USD per video token (pricing_skus.video_tokens*), TIERED BY OUTPUT RESOLUTION.
   *
   * A per-token video SKU has no single rate: the price list quotes a different one per resolution
   * (Seedance 2.0 — base $0.000007, 1080p $0.0000077, 4K $0.000004), and the token COUNT is itself a
   * function of the output's pixels. So one `usdPerToken` scalar could only ever be right at one
   * size, and wrong by 2.5x one tier up. `usdPerTokenByTier` keeps each published rate against the
   * tier it was published for, and a tier with no entry is `unpriced` — never the nearest rate.
   *
   * `tokensPerSecond` is the CALIBRATION OVERRIDE, not the normal path. Tokens are derived from the
   * output's own dimensions (studio/pricing.ts, `videoTokens`); this exists so a real run's reported
   * `usage.cost` can pin the figure if the derivation turns out to be wrong.
   */
  | {
      unit: "per_video_token";
      usdPerTokenByTier: Partial<Record<VideoTier, number>>;
      tokensPerSecond?: number;
    };

// ─── Video output resolution ────────────────────────────────────────────────────────

/**
 * The resolution bands a per-token video price list quotes rates against. Named for the price list,
 * not for the pixels — `sd` and `hd720` share the base rate today but are separate bands because
 * nothing guarantees they always will.
 */
export type VideoTier = "sd" | "hd720" | "hd1080" | "uhd4k";

/**
 * Which band does an output of these dimensions bill in?
 *
 * ─── THE SHORT EDGE IS THE BAND, AND THE LONG EDGE IS NOT ──────────────────────────────────────
 *
 * "720p" names a vertical resolution, so a 9:16 clip is 720p turned on its side: 720x1280 and
 * 1280x720 are the same SKU. Reading the LONG edge gets that right for widescreen and wrong for
 * square — 1080x1080 is a 1080p frame whose long edge (1080) sits in the 480p band. Every size on
 * the published list has its band as its short edge exactly: 480p sizes are 480 short (480x854,
 * 1120x480), 720p are 720 (720x1280, 1680x720, 720x720), 1080p are 1080, 4K are 2160.
 *
 * ─── WHICH WAY EACH TOLERANCE ERRS ─────────────────────────────────────────────────────────────
 *
 * A size between two bands rounds UP to the dearer one, because the rate rises with resolution and
 * over-quoting is the safe failure — the posture this whole file takes. 4K is the exception and is
 * matched EXACTLY: its rate is LOWER than 1080p's ($0.000004 vs $0.0000077), so rounding a 1440p
 * frame into it would under-quote, which is the one direction the pre-generation check exists to
 * prevent. Anything between 1080 and 2160, past 4K, or dimensionless is null → `unpriced`.
 */
export function videoTierFor(
  width?: number,
  height?: number,
): VideoTier | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height))
    return null;
  const shortEdge = Math.min(width, height);
  if (shortEdge <= 480) return "sd";
  if (shortEdge <= 720) return "hd720";
  if (shortEdge <= 1080) return "hd1080";
  if (shortEdge === 2160) return "uhd4k";
  return null;
}

/**
 * The `platform` every Studio-written media_asset carries.
 *
 * It lives HERE rather than in studio/jobs.ts, where it was, for an import-graph reason that is not
 * cosmetic: studio/video/materialize.ts needs this one string, and reaching it through jobs.ts
 * dragged brief.ts → services/shotList.ts → lib/models.ts into the detached stitch runner — the
 * whole spend path, pulled in for a five-character constant. jobs.ts re-exports it, so every
 * existing call site is unchanged.
 */
export const STUDIO_PLATFORM = "studio";

// ─── Output resolution ──────────────────────────────────────────────────────────────

/**
 * The sizes `imageConfig.imageSize` accepts. Uppercase K — a lowercase value is rejected by the API.
 *
 * Both Nano arms (pro and flash) serve all four. `gemini-3.1-flash-lite-image` serves 1K ONLY, so if
 * it is ever added to the registry it needs its own cap rather than inheriting this list.
 */
export const IMAGE_SIZES = ["512px", "1K", "2K", "4K"] as const;
export type ImageSizeName = (typeof IMAGE_SIZES)[number];

/** The API's own default when nothing names a size, and therefore what an unset request buys. */
export const DEFAULT_IMAGE_SIZE: ImageSizeName = "1K";

export const isImageSize = (v: unknown): v is ImageSizeName =>
  typeof v === "string" && (IMAGE_SIZES as readonly string[]).includes(v);

/**
 * WHERE `imageSize` LIVES ON THE WIRE — written once, read once, from here.
 *
 * `generationConfig.imageConfig.imageSize` is the shape VERIFIED against this project. Google's
 * public docs for the AI-Studio surface describe a different location (`response_format.image_size`),
 * so the two are genuinely not the same wire and the doc is not a check on us. What settles it is
 * that the vertex adapter merges exactly this object into the request body, and a live 4K run came
 * back at 4K resolution.
 *
 * The reader and the writer are a PAIR and they are deliberately adjacent. `pricing.wantsAudio()`
 * reads `providerParams.parameters.generateAudio` while `preview.plannedInputs` writes it, and the
 * path string is therefore spelled out in two files that must agree — which is the drift this pair
 * exists to avoid on the size. (The audio pair is not refactored here; it is correct as it stands
 * and is not what this change is about.)
 */
export function imageSizeParams(size: ImageSizeName): Record<string, unknown> {
  return { generationConfig: { imageConfig: { imageSize: size } } };
}

/** The size a request BUYS, read back off the same object the adapter sends. Undefined ⇒ the API default. */
export function imageSizeFrom(
  providerParams: Record<string, unknown> | undefined,
): ImageSizeName | undefined {
  const gc = providerParams?.generationConfig as
    | { imageConfig?: { imageSize?: unknown } }
    | undefined;
  const size = gc?.imageConfig?.imageSize;
  return isImageSize(size) ? size : undefined;
}

/**
 * How many pixels each size actually returns, as an AREA.
 *
 * `imageSize` does NOT cap the long edge. It caps the area at roughly the square of its name and
 * distributes that by aspect ratio — a 4000x6000 frame asked for 4K came back 3392x5056, which is
 * 17.1 megapixels against the 16.8 nominal below. Measured on the live project.
 *
 * So the nominal figures here are a conservative FLOOR: the model returns at least this much, and
 * on the one observation we have it returned 2% more. That direction is the safe one for what this
 * table is used for — picking the smallest size that will not force an upscale.
 */
const SIZE_PIXELS: Record<ImageSizeName, number> = {
  "512px": 512 * 512,
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 4096 * 4096,
};

/**
 * The smallest size that can return `pixels` without upscaling — the size derivation the edit path
 * runs on.
 *
 * ─── WHY SMALLEST, AND NOT SIMPLY 4K ────────────────────────────────────────────────────────────
 *
 * The crop is what buys fidelity; the size only buys PATCH RESOLUTION. Once an edit sends a crop
 * rather than the whole frame, the only requirement is that the patch come back at least as large as
 * the crop, because anything smaller is an upscale pasted into a sharp photograph. A typical edit
 * crops to 1.3-2.0 MP, which 2K covers at 1120 tokens where 4K would cost 2000 — so defaulting to
 * 4K would pay 79% more for pixels that are then thrown away in the downscale.
 *
 * Above 4K there is nothing larger to ask for, so it returns 4K and the caller downscales the crop
 * to fit (studio/composite.ts planCrop). Never null: a size is always available, and refusing here
 * would turn a degraded edit into no edit.
 */
export function smallestImageSizeFor(pixels: number): ImageSizeName {
  for (const size of IMAGE_SIZES) {
    if (SIZE_PIXELS[size] >= pixels) return size;
  }
  return "4K";
}

/**
 * The area a size returns, from the same table — the nominal FLOOR described above (a 4K request on
 * a 2:3 frame measured 3392x5056, 2% over it). Read by the native path's resolution note, so the
 * number she is told and the rule that picked the size cannot come from two different tables.
 */
export function imageSizePixels(size: ImageSizeName): number {
  return SIZE_PIXELS[size];
}

/**
 * Output tokens per generated image — needed to turn a per-TOKEN rate into a dollar figure.
 *
 * ─── IT IS A FUNCTION OF THE SIZE, AND IT HAD TO BECOME ONE ────────────────────────────────
 *
 * This was one constant, 1120, applied to every tier, with a comment predicting it would "still be
 * wrong at 2K/4K". It was: Google publishes 1120 output tokens for 1K and 2K, and 2000 for 4K. At
 * $0.00012/tok that is $0.1344 against $0.24 — a 4K job QUOTED at 56% of what it BILLS.
 *
 * An under-quote is the dangerous direction, and here it defeats BOTH money guards at once, because
 * both read the same estimate: the ceiling she approved (studio/generate.ts) and the house cap
 * `maxJobUsd()` underneath it. One wrong number and neither fires. Note the RECEIPT was already
 * honest — the vertex adapter recomputes from the tokens Vertex actually reports — which is exactly
 * why nothing caught this: the invoice was right and only the quote was wrong.
 *
 * 1120 stays MEASURED rather than read off a table: a real gemini-3-pro-image call on this project
 * returned usageMetadata.candidatesTokensDetails[modality=IMAGE].tokenCount = 1120 for a
 * default-size image (plus 162 reasoning tokens billed separately). 2000 is Google's published
 * figure for 4K and agrees with the $0.24-per-image price they quote beside it.
 *
 * ─── 512px IS NOT PUBLISHED, SO IT IS NOT INVENTED ──────────────────────────────────────
 *
 * Google names an output-token count for 1K/2K and for 4K and says nothing about 512px. It is
 * certainly fewer than 1120, and "certainly fewer" is not a number. So it maps to the 1K figure and
 * the `detail` line says so — an over-quote, in the direction this file already calls the safe one:
 * being billed less than quoted surprises nobody. Nothing routes 512px today.
 *
 * Each figure is independently overridable, and neither is derived from the other — they are two
 * measurements, not a base and a ratio. STUDIO_TOKENS_PER_IMAGE=0 still makes per-token image models
 * report `unpriced` rather than an assumed figure, and that escape hatch outranks a named size (see
 * studio/pricing.ts) — "we have no figure" must not become a figure because a request asked for 4K.
 *
 * On the VERTEX path these are only the pre-generation numbers — the adapter recomputes cost from
 * the token count Vertex actually reports once the call returns.
 */
export const tokensPerImage = (size?: ImageSizeName): number => {
  if (size === "4K") {
    const v = process.env.STUDIO_TOKENS_PER_IMAGE_4K;
    return v === undefined ? 2000 : Number(v);
  }
  // 1K, 2K, an unnamed size (the API default is 1K), and 512px, which has no published figure.
  const v = process.env.STUDIO_TOKENS_PER_IMAGE;
  return v === undefined ? 1120 : Number(v);
};

/**
 * Input tokens one REFERENCE image costs — needed because references are now the primary input to a
 * generation, and until this existed they moved the quote by exactly nothing.
 *
 * 258 is Google's documented base: an image up to 384x384 costs 258 input tokens, and anything
 * larger is tiled into 768x768 crops at 258 tokens each. So for the 4000x6000-class uploads this
 * product actually sends, 258 is a FLOOR — a real reference tiles into several of these.
 *
 * It is deliberately paired with an over-estimate in the other direction: studio/pricing quotes
 * these at the model's OUTPUT token rate, which is the only rate we have verified, and input tokens
 * bill lower than output tokens. Two errors pointing opposite ways, both named in the `detail` line
 * so nobody reads the figure as precise. That is the same posture pricing already takes on the Veo
 * audio arm — when unsure, quote high and say so; being billed less than quoted surprises nobody.
 *
 * Set STUDIO_TOKENS_PER_REFERENCE to 0 to take references out of the estimate entirely.
 */
export const tokensPerReference = () => {
  const v = process.env.STUDIO_TOKENS_PER_REFERENCE;
  return v === undefined ? 258 : Number(v);
};

/**
 * ─── A VIDEO TOKEN IS A PUBLISHED FORMULA, NOT AN UNKNOWN ──────────────────────────────────────
 *
 * This used to read "there is no published tokens-per-second of video either, and no widely-cited
 * figure to fall back on", so Seedance defaulted to `unpriced` and could not run at all. That was
 * half right. There is no published tokens-per-SECOND, and there cannot be one, because the count
 * depends on the output's pixels. But the COUNT ITSELF is published, by both the vendor and the
 * router we would be billed through:
 *
 *     tokens = height × width × fps × duration ÷ 1024        (fps = 24)
 *
 * — OpenRouter's video-generation guide, and BytePlus ModelArk's own estimation formula for the
 * Seedance family. So the honest move is to derive the count rather than pin a scalar that is only
 * ever right at one resolution. studio/pricing.ts does the deriving; this is the constant it needs.
 *
 * ⚠️ THE 24 IS THE FORMULA'S, NOT AN OBSERVATION — but the FRAME COUNT now is an observation, and
 * it is not `fps × duration`. See studio/pricing.ts: the provider bills fps×N + 1 frames for an
 * N-second clip, counting both endpoints. Quoting the formula literally came in 0.5–0.7% under the
 * invoice on seven billed Seedance calls, and the gap was exactly one frame's worth of tokens every
 * time. With the extra frame the derivation is exact on all seven.
 *
 * The 24 itself remains the published formula's, so it stays here as one constant to correct rather
 * than a number scattered through pricing. A clip the provider renders at some other frame rate
 * would still bill against it.
 *
 * VALIDATED AGAINST REAL INVOICES, 2026-09-18 — seven authoritative `usage.cost` figures from the
 * V2 bake-off (docs/probes/video-bakeoff.md §6):
 *
 *     8s @ 720x1280  →  900 × 193 = 173,700 tok  ×  $0.000007   =  $1.2159   billed $1.2159 ✓
 *     6s @ 720x1280  →  900 × 145 = 130,500 tok  ×  $0.000007   =  $0.9135   billed $0.9135 ✓
 *     6s @ 720x1280  →  900 × 145 = 130,500 tok  ×  $0.0000042  =  $0.5481   billed $0.5481 ✓
 *
 * That is the whole price path — the published per-token rate, the resolution band, and the frame
 * count — agreeing with the invoice to the cent, three shapes, seven calls, two models.
 */
export const VIDEO_TOKEN_FPS = 24;

/**
 * The CALIBRATION OVERRIDE for the above, in tokens per second of output.
 *
 * Unset by default, and it should stay unset: the derivation is the normal path now. This exists
 * for the day a real run's reported `usage.cost` disagrees with the formula, so the figure can be
 * pinned to the invoice without editing code. It overrides the token COUNT only — the per-token
 * rate still comes from the resolution band, because those are two different published numbers and
 * conflating them is what made a single `usdPerToken` scalar wrong.
 */
export const tokensPerVideoSecond = () => {
  const v = process.env.STUDIO_VIDEO_TOKENS_PER_SECOND;
  return v === undefined || v === "" ? undefined : Number(v);
};

/**
 * Real rates, read from the live API on 2026-08-27; the Seedance pair re-read 2026-09-18.
 *
 * Video SKUs carry audio/resolution variants. Veo's two audio arms are BOTH modelled, because they
 * differ by 2x and the request already picks between them (parameters.generateAudio):
 *   veo-3.1        duration_seconds               0.20   (with audio 0.40)
 *   kling-v3.0-std duration_seconds               0.084  (with audio 0.126 — see below)
 *   seedance-2.0   video_tokens                   0.000007  · 1080p 0.0000077 · 4K 0.000004
 *   seedance-fast  video_tokens                   0.0000042 · (480p/720p only — see below)
 *
 * The Seedance rates are per-resolution and are kept that way (`usdPerTokenByTier`), because they do
 * not move in one direction: 1080p is DEARER than the base rate and 4K is CHEAPER. A single scalar
 * would under-quote one of them whichever value it took.
 *
 * DELIBERATELY NOT MODELLED — flagged rather than approximated:
 *   • Veo's 4K arm ($0.60/s with audio). Resolution is not part of GenerationInputs and the Vertex
 *     parameter that selects it has not been verified on this project, so there is no honest key to
 *     price against. A 4K run is quoted at the 1080p rate and is therefore UNDER-quoted.
 *   • Kling's audio arm. Nothing sends Kling an audio flag today, so a second arm would be one no
 *     request could ever select. It prices at 0.084 either way, exactly as it did before.
 *   • Seedance's `video_tokens_with_video_input` ($0.0000043, and $0.0000047/$0.0000024 for its
 *     1080p/4K arms). It is a cheaper rate for video-TO-video, which is a different input modality
 *     and not a resolution band — nothing on this path sends a clip as input, so wiring it would
 *     add an arm no request could select, exactly like Kling's audio arm above. If video-to-video
 *     is ever built, it is a second axis on this table and not a substitution into it.
 *   • Seedance's audio arm, because there isn't one to model: `video_tokens_without_audio` equals
 *     `video_tokens` on both Seedance models. Audio is free there and 2x on Veo — which is a real
 *     cost difference between the two and is why `per_second` carries `usdWithAudio` and this does
 *     not.
 */
function defaultPrices(): Record<string, Price> {
  // The BASE — an unnamed size, which the API serves as 1K. A request that names 4K is repriced
  // against the size it carries, in studio/pricing. See the Price docs above.
  const tpi = tokensPerImage();
  const tps = tokensPerVideoSecond();
  return {
    // images — pricing.image_output from /api/v1/models
    [MODELS.nanoPro]: {
      unit: "per_image_token",
      usdPerToken: 0.00012,
      tokensPerImage: tpi,
    },
    [MODELS.nanoFlash]: {
      unit: "per_image_token",
      usdPerToken: 0.00006,
      tokensPerImage: tpi,
    },
    [MODELS.seedream]: {
      unit: "per_image_token",
      usdPerToken: 0.0000107784431137725,
      tokensPerImage: tpi,
    },
    // Vertex-native ids carry the same rates — a provider flip must not silently become `unpriced`.
    "gemini-3-pro-image": {
      unit: "per_image_token",
      usdPerToken: 0.00012,
      tokensPerImage: tpi,
    },
    "gemini-3.1-flash-image": {
      unit: "per_image_token",
      usdPerToken: 0.00006,
      tokensPerImage: tpi,
    },
    "veo-3.1-generate-001": { unit: "per_second", usd: 0.2, usdWithAudio: 0.4 },
    // video — pricing_skus from /api/v1/videos/models
    [MODELS.veo]: { unit: "per_second", usd: 0.2, usdWithAudio: 0.4 },
    [MODELS.kling]: { unit: "per_second", usd: 0.084 },
    [MODELS.seedance]: {
      unit: "per_video_token",
      // `sd` and `hd720` are the same published rate (the list quotes one "video_tokens" base for
      // both); they are separate keys so a future split is a table edit and not a re-reading.
      usdPerTokenByTier: {
        sd: 0.000007,
        hd720: 0.000007,
        hd1080: 0.0000077,
        uhd4k: 0.000004,
      },
      tokensPerSecond: tps,
    },
    [MODELS.seedanceFast]: {
      unit: "per_video_token",
      // NO 1080p OR 4K ENTRY, and that is the price list, not an omission: seedance-2.0-fast
      // advertises `supported_resolutions: ["480p","720p"]` and quotes one `video_tokens` rate. A
      // request past 720p on this model is unpriced — correctly, because it is also unservable.
      usdPerTokenByTier: { sd: 0.0000042, hd720: 0.0000042 },
      tokensPerSecond: tps,
    },
    // Segmentation — fal bills a flat rate per call, so this is `per_image` and not a token unit.
    // 0.005 is the figure the probes were billed at; it is a real price, not a placeholder zero.
    [MODELS.sam3]: { unit: "per_image", usd: 0.005 },
    // PR 19: a crop costs nothing, and says so — a PRICED zero, never `unpriced`, which the caps would refuse.
    [MODELS.crop]: { unit: "per_image", usd: 0 },
  };
}

/** STUDIO_PRICE_JSON: a JSON object of the same shape, merged over the defaults. */
export function priceFor(model: string): Price | null {
  const base = defaultPrices();
  const raw = process.env.STUDIO_PRICE_JSON;
  if (!raw) return base[model] ?? null;
  try {
    return (
      { ...base, ...(JSON.parse(raw) as Record<string, Price>) }[model] ?? null
    );
  } catch {
    return base[model] ?? null; // a malformed override must never take pricing down
  }
}

// ─── Text-model prices — the planner (PR 4, C5) ────────────────────────────────────────────────
//
// `Price` above is what a GENERATION is quoted in, and a text model is never quoted there. Until
// this table the planner's calls were booked on an assumed $1.25 / $10 per M with $2 / $12 as the
// "alternate", and a cap set on one was over on the other ($0.10 over on 22 Sep 2026). Priced per
// CALL, because the tier is chosen by that one prompt's size, never by a run's total.

/** USD per million tokens. Thinking tokens bill as output. `long*` applies when ONE prompt passes `longAbove`. */
export interface TextPrice {
  usdPerMInput: number;
  usdPerMOutput: number;
  longAbove?: number;
  usdPerMInputLong?: number;
  usdPerMOutputLong?: number;
  /** Where the figure was read, and when. */
  source: string;
}

function defaultTextPrices(): Record<string, TextPrice> {
  return {
    // Gemini API paid tier, standard (not batch/flex): $2.00 in / $12.00 out per M for a prompt
    // ≤ 200k tokens, $4.00 / $18.00 above; output includes thinking. Read 22 Sep 2026 from the page
    // below (its own "last updated 2026-09-22"). We call it on VERTEX (`global`), whose price page
    // could not be read that day — confirm against the first invoice (docs/probes/ingest-flip.md).
    "gemini-3.1-pro-preview": {
      usdPerMInput: 2,
      usdPerMOutput: 12,
      longAbove: 200_000,
      usdPerMInputLong: 4,
      usdPerMOutputLong: 18,
      source:
        "https://ai.google.dev/gemini-api/docs/pricing (paid tier, standard; read 2026-09-22)",
    },
  };
}

/** STUDIO_TEXT_PRICE_JSON: a JSON object of the same shape, merged over the defaults — as `priceFor`. */
export function textPriceFor(model: string): TextPrice | null {
  const base = defaultTextPrices();
  const raw = process.env.STUDIO_TEXT_PRICE_JSON;
  if (!raw) return base[model] ?? null;
  try {
    return (
      { ...base, ...(JSON.parse(raw) as Record<string, TextPrice>) }[model] ??
      null
    );
  } catch {
    return base[model] ?? null; // a malformed override must never take pricing down
  }
}

/**
 * What ONE call cost, from the tokens it reported — or null when the model has no text price (the
 * caller says "unpriced", never a guess). A prompt past `longAbove` bills the long tier for the call.
 * ⚠️ MUTATION (config.textPrice.test): ignore the long tier — "a prompt past 200k bills the long tier" reds.
 */
export function textCallUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const p = textPriceFor(model);
  if (!p) return null;
  const long =
    p.longAbove !== undefined &&
    usage.inputTokens > p.longAbove &&
    p.usdPerMInputLong !== undefined &&
    p.usdPerMOutputLong !== undefined;
  const inRate = long ? p.usdPerMInputLong! : p.usdPerMInput;
  const outRate = long ? p.usdPerMOutputLong! : p.usdPerMOutput;
  return (
    (usage.inputTokens * inRate + usage.outputTokens * outRate) / 1_000_000
  );
}

// ─── Reference capacity ─────────────────────────────────────────────────────────────────────────

/**
 * How many references of each kind one request may carry.
 *
 * ⚠️  READ THIS BEFORE CHANGING A NUMBER: THESE ARE OUR REFUSALS, NOT THE API'S.
 *
 * The `:generateContent` surface enforces NO limit and exposes no per-reference type field — a
 * reference is a plain `Part` in `contents[0].parts` (see the RefSlot docstring in studio/types.ts,
 * which records how that was verified against @google/genai 2.7.0). There is no `maxImages`
 * constant anywhere in that package. So nothing below is read back from the provider: it is a
 * refusal WE author, from Google's model documentation, and going over it produces a blocking gap
 * with a sentence rather than a provider error.
 *
 * The per-kind figures are Google's documented capacities. They are doc-level and they are not
 * stable: two reads of Google's own limits table disagreed about whether gemini-3-pro-image
 * supports style references at all (one rendering lists none; a secondary source claims three).
 * `nanoPro` is the DEFAULT route for both image tasks, so that ambiguity lands on the main path —
 * hence the env override, so correcting it is a value and not a deploy.
 *
 * `total` is deliberately NOT the 14 that circulates for these models, and it is ours on grounds
 * that have nothing to do with the model: studio/adapters/vertex.ts has no url form for a
 * reference — `toInlinePart` FETCHES each one and base64s it into the request body — so fourteen
 * full-resolution uploads is a tens-of-megabytes payload assembled in memory inside a Cloud Run
 * request, on top of the source frame. Six (a frame plus five) is a payload-and-latency judgement,
 * not a measurement, and it is the number most likely to want raising once real use exists.
 */
export interface RefCapacity {
  /** Identity references — the athlete's likeness. */
  character: number;
  /** Product/object references. */
  object: number;
  /**
   * Style references. Since the look-reference role was removed this holds the brand's own cover
   * and gallery imagery and nothing else — the athlete cannot add one. It is art direction, and it
   * makes no claim about what the model will or will not take out of the image.
   */
  style: number;
  /** Ceiling on ALL references in one request, frame included. Ours, on payload grounds. */
  total: number;
}

const DEFAULT_REF_CAPACITY: RefCapacity = {
  character: 2,
  object: 3,
  style: 2,
  total: 6,
};

/**
 * The photographs of HERSELF one generate may carry — the reference pack.
 *
 * ⚠️ THE ONE NUMBER HERE THAT IS NOT GOOGLE'S. Google documents 5 character images on
 * gemini-3-pro-image and 4 on the flash image model, and the per-kind figures beside this one are
 * theirs. THIS is ours: 3 is the size that was actually measured (docs/plans/
 * studio-generation-identity-plan.md — three bound photographs won Adi's blind pick in both poses,
 * against one, twice across a reshuffle). Four and five were never generated, and the honest ceiling
 * for a product refusal is the size we have evidence for, not the size the vendor's table allows.
 *
 * Raising it is an env flip, not a deploy: `STUDIO_REF_CAPS_JSON={"gemini-3-pro-image":
 * {"character":5}}`. Raise it when a pack of four or five has been generated and looked at.
 *
 * It is NOT a consent boundary, and it must never be mistaken for one. The boundary is that every
 * photograph in the person slot is of the SAME person — the athlete herself — and that is carried by
 * the picker's copy, by `refusedOnEdit` (studio/preview.ts), and by the fact that the server re-reads
 * every asset under her own athlete id. Nothing in this file verifies whose face is in a photograph.
 */
const CHARACTER_CAP = 3;

/** Per-model, keyed the same way the price table is: both id forms, so a provider flip keeps them. */
function defaultRefCapacities(): Record<string, RefCapacity> {
  const total = Number(process.env.STUDIO_MAX_REFERENCES ?? 6);
  const pro: RefCapacity = {
    character: CHARACTER_CAP,
    object: 6,
    style: 3,
    total,
  };
  const flash: RefCapacity = {
    character: CHARACTER_CAP,
    object: 10,
    style: 3,
    total,
  };
  return {
    [MODELS.nanoPro]: pro,
    [MODELS.nanoFlash]: flash,
    "gemini-3-pro-image": pro,
    "gemini-3.1-flash-image": flash,
  };
}

/**
 * Capacity for a model. An UNKNOWN model gets the conservative floor rather than a generous guess —
 * refusing a fifth product shot on a model we have not checked is a sentence she can read; sending
 * one that silently degrades the whole request is not.
 *
 * STUDIO_REF_CAPS_JSON: a JSON object of the same shape, merged over the defaults, exactly like
 * STUDIO_PRICE_JSON. A malformed override must never take reference handling down.
 */
export function refCapacityFor(model: string): RefCapacity {
  const base = defaultRefCapacities();
  const raw = process.env.STUDIO_REF_CAPS_JSON;
  if (!raw) return base[model] ?? DEFAULT_REF_CAPACITY;
  try {
    const merged = {
      ...base,
      ...(JSON.parse(raw) as Record<string, Partial<RefCapacity>>),
    };
    const hit = merged[model];
    return hit
      ? { ...(base[model] ?? DEFAULT_REF_CAPACITY), ...hit }
      : (base[model] ?? DEFAULT_REF_CAPACITY);
  } catch {
    return base[model] ?? DEFAULT_REF_CAPACITY;
  }
}

// ─── Runtime knobs ──────────────────────────────────────────────────────────────────────────────

/** Default polling behaviour for async video jobs. Call-time, for the same reason as routes(). */
export function videoPoll(): { intervalMs: number; maxMs: number } {
  return {
    intervalMs: Number(process.env.STUDIO_VIDEO_POLL_MS ?? 5_000),
    maxMs: Number(process.env.STUDIO_VIDEO_MAX_POLL_MS ?? 600_000), // 10 min
  };
}

export const httpTimeoutMs = () =>
  Number(process.env.STUDIO_HTTP_TIMEOUT_MS ?? 120_000);

/**
 * The hard ceiling on what ONE job may cost, in USD. Defence in depth, underneath the approval the
 * athlete actually gave: the persisted preview already stops a client naming its own ceiling, and
 * this stops a bug in that path — or a price list that moved — from spending an unbounded amount.
 * It is checked against the freshly derived quote, so it binds even when the stored approval is
 * higher.
 *
 * ─── $10, AND WHY THAT NUMBER ─────────────────────────────────────────────────
 *
 * This was a placeholder (30) with a TODO, on the grounds that it interacted with MAX_CLIP_SECONDS
 * and a 60s clip could be worth $24. That interaction is now resolved from the other end: video
 * routes to Veo, Veo on Vertex serves 4/6/8 seconds ONLY (see supportedDurationsFor), and the
 * route's clip cap is derived from that list rather than hardcoded to a 60 nothing serves. So the
 * real worst case is 8s on the with-audio SKU at $0.40/s = $3.20.
 *
 * $10 sits deliberately between the two: comfortably above any clip that can actually be requested
 * (3x the worst real case, ~75x an image quote of ~$0.13), and far below the runaway a bug could
 * otherwise authorise. It is a BACKSTOP, not a budget — the athlete's own approved figure is the
 * binding limit in normal operation, and this only fires when that path has already failed.
 */
export const STUDIO_MAX_JOB_USD_CEILING = 50;
/** Clamped to STUDIO_MAX_JOB_USD_CEILING; a value that is not a usable number is the default (lib/spendCap.ts). */
export const maxJobUsd = () => readCap("STUDIO_MAX_JOB_USD", 10, STUDIO_MAX_JOB_USD_CEILING);

/**
 * The ceiling on what ONE ATHLETE may be quoted across a whole day, in USD.
 *
 * ─── WHAT THIS CATCHES THAT maxJobUsd CANNOT ────────────────────────────────────
 *
 * The per-job cap bounds ONE spend. It says nothing about a hundred of them. The runaway this
 * project can actually produce is not one expensive job — every guard above catches that — it is a
 * loop that keeps asking for cheap ones, and at $3.20 a clip a loop gets expensive in minutes. So
 * the second ceiling is cumulative and is the one that bounds the DAY.
 *
 * ─── PER ATHLETE, NOT GLOBAL, AND THAT IS A DELIBERATE LIMIT ───────────────────────
 *
 * The sum behind it is scoped by `athlete_id`, like every other query in this codebase, which makes
 * it tenancy-clean and makes one athlete's runaway invisible to everyone else’s budget. It also
 * means N athletes can each spend this much. A genuinely global ceiling needs a cross-athlete
 * aggregate; that is written up as a proposal rather than built (docs/probes/video-v1-ledger.md V-L1).
 *
 * ─── $25, AND THE KNOB ──────────────────────────────────────────────────────
 *
 * A heavy acceptance or probe day on this project costs $1.50–$2.50 a run, so $25 is roughly five
 * such runs — enough headroom that ordinary work never meets it, low enough that a loop dies inside
 * one afternoon. The person most likely to hit it is whoever is running a planned probe, so the
 * refusal NAMES THE ENV VAR: raising it for a known run is a deliberate act with a number attached,
 * not a code change and not a mystery.
 */
export const STUDIO_MAX_DAY_USD_CEILING = 125;
/** Clamped to STUDIO_MAX_DAY_USD_CEILING; a value that is not a usable number is the default (lib/spendCap.ts). */
export const maxDayUsd = () => readCap("STUDIO_MAX_DAY_USD", 25, STUDIO_MAX_DAY_USD_CEILING);

/**
 * The clip lengths a video model will actually serve, in seconds. Null ⇒ we have not verified the
 * model's list and must not invent one.
 *
 * ⚠️  READ THIS BEFORE A DURATION IS QUOTED. Veo 3.1 on Vertex accepts 4, 6 and 8 — nothing else,
 * and not a continuous range. Before this existed, routes/studio.ts accepted 1..60 and the preview
 * happily QUOTED a 30s clip, so an athlete could approve a duration Vertex would then refuse. The
 * approval is consumed before the provider call, so that refusal lands AFTER the spend gate has
 * already burnt her approval on a job that could never run.
 *
 * Verified against OpenRouter's live capability API (`GET /api/v1/videos/models`,
 * `supported_durations`) on 2026-09-07 for google/veo-3.1, re-read 2026-09-18 for the Seedance
 * pair, and consistent with Vertex's own docs.
 *
 * The Seedance and Kling figures were "recorded for when that path is reachable", which it now is:
 * the adapter sends the first reference as `frame_images` rather than as a style ref, so
 * image-to-video fires on this provider (studio/adapters/openrouter.ts). What still gates Seedance
 * is the price, not the plumbing — see `videoTierFor` and the Seedance entry in `defaultPrices`.
 */
export function supportedDurationsFor(model: string): number[] | null {
  const raw = process.env.STUDIO_VIDEO_DURATIONS_JSON;
  if (raw) {
    try {
      const hit = (JSON.parse(raw) as Record<string, number[]>)[model];
      if (hit) return hit;
    } catch {
      /* a malformed override must never take duration checking down */
    }
  }
  if (model.startsWith("veo-3.1") || model === MODELS.veo) return [4, 6, 8];
  if (model === MODELS.kling)
    return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  if (model === MODELS.seedance || model === MODELS.seedanceFast)
    return [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  return null;
}

/**
 * The absolute ceiling on a clip, in seconds — the number no configuration may exceed.
 *
 * `maxClipSeconds()` below is derived from the routed model and is the working cap; today it is 8.
 * This is the backstop underneath it, and it exists because every input to that derivation is an
 * env var: STUDIO_VIDEO_MODEL picks the model, STUDIO_VIDEO_DURATIONS_JSON overrides its list. A
 * typo in either could otherwise name a length worth far more than anyone intended — 60s on the
 * with-audio SKU is the $24.00 clip this whole file is written around. 60 is kept rather than
 * lowered because it is the number that was already there; what changes is that it is now a clamp
 * nothing can argue past rather than the value in daily use.
 */
export const HARD_MAX_CLIP_SECONDS = 60;

/**
 * The longest clip the CURRENTLY ROUTED video model will serve — the route's input cap, so a
 * request cannot even name a duration that the model behind `video.generate` could not run.
 *
 * Read off the route rather than hardcoded, for the same reason nothing else in this file hardcodes
 * a model: flipping STUDIO_VIDEO_MODEL to something with a longer ceiling must move this with it,
 * or the cap silently becomes a refusal of clips the new model handles fine. Falls back to 8 — Veo's
 * ceiling, the conservative direction — for a model whose durations we have not verified, and is
 * clamped at HARD_MAX_CLIP_SECONDS so no override can reach the $24.00 clip.
 */
export const maxClipSeconds = () =>
  Math.min(
    HARD_MAX_CLIP_SECONDS,
    Math.max(
      ...(supportedDurationsFor(routeFor("video.generate").model) ?? [8]),
    ),
  );

/**
 * The size ceiling for a STORED generated video, in bytes.
 *
 * `mediaStore`'s default is 25 MB — right for the stills it was written for, and a trap for video:
 * `storeAsset` inherited it, so a clip over the cap failed with "over the media size cap" AFTER the
 * provider had been paid. Video gets its own, larger ceiling, and studio/preview.ts refuses a clip
 * projected to exceed it BEFORE the approval is consumed.
 */
export const maxVideoBytes = () =>
  Number(process.env.STUDIO_MAX_VIDEO_BYTES ?? 200 * 1024 * 1024);

/**
 * Bytes per second of generated video, for the pre-generation size projection.
 *
 * MEASURED, then rounded UP: the A6.1 spike's 8s 720p Veo clip was 6,204,567 bytes — 0.74 MB/s. 2
 * MB/s is roughly 1080p and leaves headroom, and over-estimating is the safe direction here (it can
 * only refuse early, never overspend). It is an ASSUMPTION and is labelled as one wherever it
 * surfaces, the same posture studio/pricing.ts takes with tokens-per-image.
 *
 * ⚠️  AT TODAY'S LIMITS THIS GUARD CANNOT FIRE, and that is deliberate rather than pointless. Veo
 * caps at 8s, so the worst projection is ~16 MB against a 200 MB ceiling. The guard exists for the
 * moment `maxClipSeconds` moves or Seedance/Kling (15s) become reachable — at which point it starts
 * refusing before the money instead of after it, with no one having to remember to add it.
 */
export const videoBytesPerSecond = () =>
  Number(process.env.STUDIO_VIDEO_BYTES_PER_SECOND ?? 2 * 1024 * 1024);

/**
 * How many provider calls ONE masked edit may make. The binding bound on this path.
 *
 * ─── THIS IS A WALL-CLOCK CAP BEFORE IT IS A SPEND CAP ──────────────────────────────────────────
 *
 * A masked edit is one call per crop, run INLINE and SEQUENTIALLY inside the POST (studio/generate
 * .ts). `httpTimeoutMs()` above allows 120s per call, so N crops is up to N×120s on a connection
 * held open with no bytes flowing — which is precisely the shape studio/generate.ts's header refuses
 * video for, and the reason server/lib/sse.ts keepalives at 15s.
 *
 * ⚠️ THE INLINE-SAFETY ARGUMENT IN generate.ts WAS WRITTEN FOR ONE CALL AND HAS NOT BEEN TRUE SINCE
 * THE COMPOSITE LANDED. It says an edit is "the same single synchronous generateContent call"; it is
 * N of them, and at the 3 that shipped the worst case was already six minutes. This cap is what
 * keeps that claim bounded while the real number is measured.
 *
 * ─── WHY 4, AND WHY IT IS DELIBERATELY LOW ──────────────────────────────────────────────────────
 *
 * There is no per-call latency measurement in this repo, so 4 is not a measured safe maximum — it is
 * the number chosen while we have none. The two failure directions are not symmetric:
 *
 *   cap too LOW    a five-target edit refuses before spending. She is told why. Recoverable.
 *   cap too HIGH   the connection dies mid-edit AFTER the approval was consumed and crops have
 *                  billed. She paid and has nothing. That is the video lesson.
 *
 * Refuse-safe beats spend-and-timeout, so this starts under where we think the limit is. Raise it on
 * EVIDENCE: `runMaskedEdit` logs `ms` per crop and for the job, so p95 per call is readable off the
 * logs within days. Env-overridable so the number can move without a deploy.
 */
export const maxEditCalls = () =>
  // Each call is a paid edit: clamped to 12 (lib/spendCap.ts), and a value that is not a usable number is 4.
  Math.floor(readCap("STUDIO_MAX_EDIT_CALLS", 4, 12));

/** Feature flag — off unless explicitly enabled. */
export const studioEnabled = () => studioFlag(process.env.STUDIO_ENABLED);
/**
 * Creative intents (0072): the athlete direct door, interpretation and confirmation. A GOVERNANCE flag — on only when
 * STUDIO_CREATIVE_INTENTS is exactly "true"; STUDIO_ALL_ON never opens it (studioFlag.ts).
 */
export const creativeIntentsEnabled = () => studioGovernanceFlag(process.env.STUDIO_CREATIVE_INTENTS);
/**
 * The athlete's Campaign governance surface (spec approval, external confirmation, ending). A GOVERNANCE flag — on
 * only when STUDIO_CAMPAIGN_GOVERNANCE is exactly "true"; STUDIO_ALL_ON never opens it (studioFlag.ts).
 */
export const campaignGovernanceEnabled = () => studioGovernanceFlag(process.env.STUDIO_CAMPAIGN_GOVERNANCE);

/**
 * VIDEO REACHABILITY — a SECOND flag, deliberately not folded into `studioEnabled`.
 *
 * Until video V3 the thing that kept clips unreachable was `assertRunnableInline` in
 * studio/generate.ts: a hold with no switch, removable only by a deploy. V3 replaced the hold with
 * the detached runner, and removing it without putting a flag in its place would have made video
 * reachable the moment V3 merged — a merge side-effect rather than a decision.
 *
 * So: OFF unless explicitly enabled, and separate from `STUDIO_ENABLED` so that turning Studio on
 * for an environment does NOT turn video on with it. Video is flipped per-environment, dev first,
 * after watching what the first clips actually cost.
 *
 * ⚠️  THIS IS THE ONLY THING STANDING BETWEEN A REQUEST AND A PAID VEO CALL, so it is checked in ONE
 * place — studio/generate.ts, at the seam the old hold occupied, ABOVE the spend caps and above the
 * job row. With it off, no clip opens a row, consumes an approval or reaches a provider. The caps in
 * studio/spendCaps.ts are the guard BEHIND it and become live the moment it is flipped.
 */
export const studioVideoEnabled = () =>
  studioFlag(process.env.STUDIO_VIDEO_ENABLED);

/**
 * CREATE ANYTHING THREADS PERSIST (studio/sessions.ts, routes/studioSessions.ts). Off unless explicitly enabled,
 * and meaningful only beside STUDIO_ENABLED: the sessions router 404s unless both are on. Paired with the client's
 * EXPO_PUBLIC_STUDIO_SESSIONS — the two halves of one switch, set independently, so a client with it on can meet a
 * server with it off and must read the 404 as "this thread lives only on the screen", which is today.
 *
 * Off: the four routes do not exist, nothing reads or writes the session tables, and nothing else changes — the
 * spend path never knew about threads. Read at call time.
 */
export const studioSessionsEnabled = () =>
  studioFlag(process.env.STUDIO_SESSIONS);

/**
 * THE ROUTING CUTOVER, SERVER SIDE. Off unless explicitly enabled, and paired with the client's
 * `EXPO_PUBLIC_STUDIO_SERVER_ROUTING` (client/lib/flags.ts) — the two halves of one switch.
 *
 * ─── WHY THE SERVER NEEDS A FLAG OF ITS OWN ────────────────────────────────────────────────────
 *
 * With this off, `/studio/generate` calls `runStudioGeneration` with no `opts`, so `opts.path` is
 * undefined, `usesMaskedPath` deduces from brief shape exactly as it always has, and the ASK
 * refusal at the top of that function is unreachable. That is today's behaviour, byte for byte.
 *
 * With it on, the generate route classifies the FROZEN brief and passes `{ path, askReason }`, so a
 * request the classifier declines is refused before anything is spent — including a request that
 * never came through the client at all. That is the half of the cutover a client flag cannot buy:
 * a retry, a cron, or any future API arrives with the client guard already behind it.
 *
 * ⚠️ IT MUST BE A SEPARATE FLAG FROM `STUDIO_ENABLED`, which is on in environments where this
 * should not be. Folding the two together would turn every environment with Studio switched on into
 * the cutover's first production test.
 */
export const studioServerRouting = () =>
  studioFlag(process.env.STUDIO_SERVER_ROUTING);

/**
 * THE NATIVE EDIT PATH — an edit becomes ONE full-frame Nano Pro call instead of a masked composite.
 * Off unless explicitly enabled.
 *
 * With this on, the preview route freezes her classified intent onto the brief it quotes
 * (studio/nativeIntent.ts), and a brief carrying a frozen intent is planned, priced and run as a
 * single call on the whole source frame with an instruction compiled from that intent
 * (studio/nativeEdit.ts). The masked stack is not touched — it is routed around, and it still serves
 * every edit a box she DREW describes (the permanent rule in the probe memo's Routing decision).
 *
 * ─── OFF IS TODAY'S BEHAVIOUR, BYTE FOR BYTE ───────────────────────────────────────────────────
 *
 * Nothing is frozen, so no brief carries an intent, so plannedInputs, the quote and the dispatch in
 * studio/generate.ts all take exactly the path they took before this flag existed.
 *
 * ⚠️ READ AT BOTH ENDS OF THE APPROVAL, AND THE SECOND READ REFUSES RATHER THAN FALLS BACK. A brief
 * frozen while this was on and spent after it was switched off is refused in runStudioGeneration —
 * running it masked instead would spend on an implementation she was never quoted for, and switching
 * this off has to mean "no native edit runs", not "native edits quietly become masked ones".
 */
export const nativeEditEnabled = () =>
  studioFlag(process.env.STUDIO_NATIVE_EDIT);

/**
 * THE AGENT TAB — the surface, and nothing else. Default OFF.
 *
 * ⚠️ IT DOES NOT TURN ON THE RETRY. That is `retryEnabled()`, its own variable, below. They were one
 * flag for a commit, which meant switching the Agent on for a demo would also have switched on a
 * second, off-ledger spend nobody had measured. Separate on purpose; a test pins it.
 */
export const agentEnabled = () => studioFlag(process.env.STUDIO_AGENT);

/**
 * THE ONE RE-ROLL OF A FILTERED CLIP (studio/videoRunner.ts, reading studio/refusal.ts). Default OFF.
 *
 * ─── ⚠️  THIS FLAG GUARDS A SPEND, WHICH IS WHY IT IS OFF ──────────────────────────────────────
 *
 * A `content_filtered` clip was GENERATED AND BILLED before its output filter withheld it. Asking
 * again buys a second one. Worse, `spentTodayUsd` (studio/jobs.ts) sums `cost_estimated_usd` per
 * generation_jobs ROW, and a retry reuses that row — so the second clip is money the daily ceiling
 * structurally cannot see. One retry roughly doubles a filtered clip's cost off-ledger.
 *
 * That is acceptable at a rate of "occasionally" and not at a rate of "often", and NOBODY HAS
 * MEASURED WHICH THIS IS. So the split (studio/refusal.ts) ships live and the retry ships dark:
 * with this off, a filtered clip fails exactly as it did before, the code is recorded, and the rate
 * can be counted off real jobs. Turn it on when there is a number — docs/plans/
 * studio-video-flip-checklist.md §10.
 *
 * ─── OFF IS TODAY'S RUNNER, BYTE FOR BYTE ──────────────────────────────────────────────────────
 *
 * `workJob` submits once, polls once, and fails on any refusal — the path it has always taken. The
 * classification still happens and still reaches the log and `last_error`; only the second submit
 * is withheld.
 *
 * ⚠️ NOT `STUDIO_AGENT`. Turning the Agent on must not turn this on — see `agentEnabled()`.
 */
export const retryEnabled = () => studioFlag(process.env.STUDIO_AGENT_RETRY);

/**
 * THE TEXT OP — a headline on her photo (DISPLAY_TEXT, PR T). Off unless explicitly enabled: N4, its own
 * switch, default off.
 *
 * ─── OFF IS TODAY'S ANSWER, BYTE FOR BYTE, AT THE CLASSIFIER ───────────────────────────────────────────
 *
 * The one sentence shape the op reads (studio/classify.ts, rule ⅛) is never read with this off: `route`
 * falls through to the rules below it exactly as it did before the op existed, so the sentence asks with
 * the code it always asked with, and nothing downstream can meet the op. Gated at the rule, not at the
 * freeze, so the flag-off route diff over the corpus is zero rows rather than "routes, then refuses".
 *
 * ⚠️ READ AT BOTH ENDS OF THE APPROVAL, and the second read refuses. The preview's freeze classifies with
 * it on; the generate route's re-check classifies again at spend time (routes/studio.ts, `nativeRecheck`).
 * A headline quoted while this was on and spent after it went off does not reproduce — the re-check asks —
 * so it refuses before anything is spent. Nothing falls back to another path.
 */
export const displayTextEnabled = () =>
  studioFlag(process.env.STUDIO_DISPLAY_TEXT);

/**
 * THE MOVE OP — a thing already in the frame, put somewhere else in it (MOVE_OBJECT, wave B card 2).
 * Off unless explicitly enabled: a new operation takes its own switch, as the headline did.
 *
 * ─── OFF IS TODAY'S ANSWER, BYTE FOR BYTE, AT THE CLASSIFIER ───────────────────────────────────────────
 *
 * Gated at the RULE and at `operationAt`, not at the freeze — the same place PR T put its gate, and for
 * the same reason: the flag-off corpus diff has to be zero rows rather than "routes, then refuses".
 *
 *   the rule        rule 4¾ is not reached, so "move the ball to the ground" asks `fast_path_declined`
 *                   exactly as it does on main, and the interpreter reads it exactly as it does now.
 *   `operationAt`   a move verb does not lead a clause, so `clausesOf` cuts where it always cut. This is
 *                   the half that would otherwise leak: the clause reader is shared by every sentence,
 *                   so a move verb joining OPERATION_VERBS unconditionally would move compounds that
 *                   have nothing to do with this op.
 *
 * ⚠️ READ AT BOTH ENDS OF THE APPROVAL. The preview's freeze classifies with it on; the generate route's
 * re-check classifies again at spend time (routes/studio.ts, `nativeRecheck`). A move quoted while this was
 * on and spent after it went off does not reproduce — the re-check asks — so it refuses before anything is
 * spent, and nothing falls back to an add.
 */
export const moveObjectEnabled = () =>
  studioFlag(process.env.STUDIO_MOVE_OBJECT);

// ─── The interpreter (plan v1 §2, A8) ───────────────────────────────────────────────────────────

/**
 * THE INTERPRETER — a model reads a sentence the rules asked about and proposes one they can read
 * (studio/interpret, the interpreter, I.5). Off unless explicitly enabled: A10, default off, and the
 * client's EXPO_PUBLIC_STUDIO_INTERPRETER must be on too before any preview can reach it.
 *
 * ─── OFF IS TODAY'S PREVIEW, BYTE FOR BYTE ──────────────────────────────────────────────────────────────
 *
 * The preview route asks this before anything else the interpreter does: off, no sentence is interpreted,
 * no model is called, and every preview is the one main builds — the same detection, the same brief, the
 * same row. `/studio/classify` answers `interpretable: false` for every sentence.
 *
 * Needs STUDIO_NATIVE_EDIT too: the interpreter's sentence only means anything as a frozen native intent
 * (studio/interpret/eligibility.ts). Read at call time. Nothing reads it at spend time — a proposal is a
 * sentence the rules read, and the spend-time re-check reads that sentence whatever this says.
 */
export const interpreterEnabled = () =>
  studioFlag(process.env.STUDIO_INTERPRETER);

/**
 * THE INTERPRETER'S MODEL — its own setting, pinned to `gemini-3.5-flash` (the interpreter, I.3).
 *
 * NOT the shared `GEMINI.flash` (server/lib/models.ts), which detection and QA read and any feature may
 * move with GEMINI_FLASH_MODEL. The model that wrote each proposal is recorded on the preview row, and a
 * proposal's prompt version is only meaningful against the model it was written for — so this one moves
 * only when this variable does, deliberately. Read at call time, like everything in this file.
 */
export const interpreterModel = () =>
  process.env.STUDIO_INTERPRETER_MODEL ?? "gemini-3.5-flash";

/**
 * How much the interpreter's model thinks: NOT AT ALL by default — a budget of 0, the lowest bound, never
 * dynamic (A8). A paraphrase into a closed menu is reading, not reasoning, and thinking costs latency on a
 * path she is waiting on.
 *
 * ─── THE SHAPE THIS PROJECT ALREADY SENDS THIS MODEL, NOT A NEW ONE ──────────────────────────────────
 *
 * `{ thinkingBudget: 0 }` is exactly what Mila's follow-up and summary calls send gemini-3.5-flash through
 * Vertex on this project (server/mila/gemini.ts). interpret/1 sent `{ thinkingLevel: "MINIMAL",
 * includeThoughts: false }` — a shape nothing here had sent this model on Vertex — and R1's first call came
 * back 400 INVALID_ARGUMENT, with a budget of 64 as well (2026-09-14; the reply schema rode both, see
 * interpret/transport.ts). So the default is the proven shape, and nothing else rides beside it.
 *
 * STUDIO_INTERPRETER_THINKING_BUDGET raises it — a number, or -1 for the model's own dynamic default — if
 * R1 shows readings that need it. Read at call time; a blank or non-numeric value is the default, never a
 * silent 0-from-empty-string mistake in the other direction.
 */
export function interpreterThinking(): { thinkingBudget: number } {
  const raw = process.env.STUDIO_INTERPRETER_THINKING_BUDGET;
  const n = raw == null || raw.trim() === "" ? 0 : Number(raw);
  return { thinkingBudget: Number.isFinite(n) ? n : 0 };
}

/**
 * How long the interpreter's one call may take before she gets her ask instead: 15s (v1 §2). It runs
 * before detection, on a preview she is waiting on, and a proposal that took longer than this is not
 * worth a spinner.
 */
export const interpreterTimeoutMs = () =>
  Number(process.env.STUDIO_INTERPRETER_TIMEOUT_MS ?? 15_000);

// ─── Brand profiles + reference decomposition (docs/specs/creative-architecture.md §7) ──────────

/**
 * Feature flag for brand profiles. Off unless explicitly enabled.
 *
 * OFF IS TODAY, EXACTLY. `decomposeReference` refuses before it reads a row or calls a model, so
 * nothing is spent and nothing is written. Nothing on main calls it yet either: the route and the
 * planner reading a profile land with the wiring (docs/studio-brand-profiles-wiring-card.md), and
 * the flag is checked at the engine's entry so a later caller cannot forget it.
 */
export const brandProfilesEnabled = () =>
  studioFlag(process.env.STUDIO_BRAND_PROFILES);

/**
 * THE REFERENCE ENGINE'S MODEL. Its own setting, pinned to `gemini-3.5-flash`, for the
 * interpreter's reason: the model that wrote each analysis is recorded on its row, and an analysis's
 * prompt version is only meaningful against the model it was written for. So it moves only when
 * this variable does. Read at call time.
 */
export const referenceModel = () =>
  process.env.STUDIO_REFERENCE_MODEL ?? "gemini-3.5-flash";

/**
 * No thinking by default: describing a reference along fixed dimensions is reading, not reasoning.
 * It uses the `{ thinkingBudget: 0 }` shape the interpreter proved on this project (see
 * interpreterThinking above). STUDIO_REFERENCE_THINKING_BUDGET raises it. A blank or non-numeric
 * value is the default.
 */
export function referenceThinking(): { thinkingBudget: number } {
  const raw = process.env.STUDIO_REFERENCE_THINKING_BUDGET;
  const n = raw == null || raw.trim() === "" ? 0 : Number(raw);
  return { thinkingBudget: Number.isFinite(n) ? n : 0 };
}

/** The one call's ceiling: 30s. She is waiting on it, but a reference is read once, not per keystroke. */
export const referenceTimeoutMs = () =>
  Number(process.env.STUDIO_REFERENCE_TIMEOUT_MS ?? 30_000);

// ─── The direction tools (studio/direction, PR 7) ───────────────────────────────────────────────

/**
 * summarize_brief's model — its own setting, for the reference engine's reason: a prompt version is
 * meaningful only against the model it was written for. Flash by default: reading a document and
 * quoting it is reading, not reasoning, and a brief is read once per campaign, not per keystroke.
 * STUDIO_SUMMARIZE_MODEL moves it (Pro is one variable away for the eval's Pro cell). Read at call time.
 */
export const summarizeBriefModel = () =>
  process.env.STUDIO_SUMMARIZE_MODEL ?? "gemini-3.5-flash";

/**
 * The thinking config a direction tool's call is sent — or none. It FOLLOWS THE MODEL, the planner's
 * rule (studio/agent/config.ts): the Flash arms take `{ thinkingBudget }` (0 by default; reading, not
 * reasoning; STUDIO_DIRECTION_THINKING_BUDGET raises it), and any other model is sent no thinking
 * config at all, because zero there is a guess this project has not proven.
 */
export function directionThinking(
  model: string,
): { thinkingBudget: number } | undefined {
  if (!/flash/.test(model)) return undefined;
  const raw = process.env.STUDIO_DIRECTION_THINKING_BUDGET;
  const n = raw == null || raw.trim() === "" ? 0 : Number(raw);
  return { thinkingBudget: Number.isFinite(n) ? n : 0 };
}

/** One call's ceiling: 45s — a document is read page by page, and she uploaded it a moment ago. */
export const directionTimeoutMs = () =>
  Number(process.env.STUDIO_DIRECTION_TIMEOUT_MS ?? 45_000);

/**
 * propose_campaign's model — Pro, the concept step's, because proposing three distinct campaigns from
 * an objective is the planner's kind of reasoning, not summarize_brief's kind of reading. Its own setting
 * so the eval can move it without touching the planner's (STUDIO_AGENT_MODEL). Read at call time.
 */
export const proposeCampaignModel = () =>
  process.env.STUDIO_PROPOSE_MODEL ?? "gemini-3.1-pro-preview";

/**
 * propose_campaign's temperature — the concept step's 0.6 (studio/agent/plan.ts PLAN_TEMPERATURE),
 * pinned here rather than read off the planner so the direction folder never imports it. Three ideas
 * at temperature 0 are three rewordings; 6c measured its concepts distinct at 0.6.
 */
export const PROPOSE_TEMPERATURE = 0.6;

/**
 * research_moment (PR 7, Lane D): ONE live web search per call, behind its own flag — default off,
 * and separate from STUDIO_BRAND_PROFILES because it spends a different kind of money (an OpenAI
 * web_search call, priced per call by agent/models costOf). The direction doors stay 404 for it until
 * it is on.
 */
export const momentSearchEnabled = () =>
  studioFlag(process.env.STUDIO_DIRECTION_MOMENTS);

// ─── Garment masking (SAM-3) ────────────────────────────────────────────────────────────────────

/**
 * Feature flag for the SHAPE mask on the edit path. Off unless explicitly enabled.
 *
 * OFF IS TODAY'S BEHAVIOUR EXACTLY, not a degraded version of it. Every region composites through
 * the rectangle ramp it always did (studio/composite.ts featherAlpha), no fal call is made, and
 * nothing is spent. That is the whole reversibility argument for this feature: the flag does not
 * select between two edit paths, it decides whether one extra ALPHA SOURCE is consulted, and the
 * absence of that source is the identity case — see the block above `distanceToOutside` in
 * studio/composite.ts.
 */
export const garmentMaskEnabled = () =>
  studioFlag(process.env.STUDIO_GARMENT_MASK);

/**
 * Feature flag for background-as-edit — the INVERSION path. Off unless explicitly enabled, and
 * independent of `STUDIO_GARMENT_MASK` rather than nested under it.
 *
 * Independent because the two paths fail in opposite directions and a deployment may reasonably
 * want one without the other. Off is not today's behaviour here, and that is the difference from
 * the garment flag: with this off, a background edit gets no subject mask, and studio/composite.ts
 * REFUSES that region rather than compositing it on its rectangle. So flipping this off does not
 * restore the old full-re-render — it withdraws the capability, which is the honest meaning of
 * turning off the only thing that made the edit safe.
 */
export const backgroundMaskEnabled = () =>
  studioFlag(process.env.STUDIO_BACKGROUND_MASK);

/**
 * Feature flag for masking NON-GARMENT objects — a ball, a bat, a water bottle, anything she can
 * name. Off unless explicitly enabled, and NESTED under `STUDIO_GARMENT_MASK` rather than
 * independent of it.
 *
 * ─── WHY THIS IS NESTED WHEN THE BACKGROUND FLAG IS NOT ────────────────────────────────────────
 *
 * `STUDIO_GARMENT_MASK` answers "is the shape-mask alpha source consulted on the edit path at all".
 * This one answers "and may a noun that was never probed reach it". They are the same path, the same
 * polarity, the same fallback and the same leak guard — the only difference is where the word came
 * from. So this flag gates the VOCABULARY, at the two places a noun is normalized, and
 * studio/segment.ts never has to ask whether a noun is a garment. It cannot, and must not: routing
 * on the word rather than on the field is exactly what the polarity split exists to prevent.
 *
 * The background flag is independent instead because its path fails in the opposite direction — a
 * missing subject mask REFUSES a region rather than compositing it — so a deployment may reasonably
 * want that arm off while garments stay on.
 *
 * ─── WHAT OFF MEANS, AND WHY THIS ONE NEEDED ITS OWN SWITCH AT ALL ─────────────────────────────
 *
 * Off is today's bytes exactly: `normalizeObjectNoun` falls back to the garment whitelist and
 * returns precisely what `normalizeGarmentNoun` returns, so a ball gets no noun, makes no call, and
 * composites on its rectangle exactly as it does now (studio/objectVocab.ts pins that equivalence).
 *
 * It is separate from `STUDIO_GARMENT_MASK` because it is the one part of this change that moves
 * SPEND. An object edit makes ZERO segmentation calls today — no noun, so studio/segment.ts returns
 * before it ever checks a flag. With this on it makes one per region, $0.005 each, bounded by
 * MAX_REGIONS (12) at ~$0.06 a job. That is a new cost on a path that previously had none, and it
 * must be withdrawable without giving up the garment masks that are already proven.
 */
export const objectMaskEnabled = () =>
  studioFlag(process.env.STUDIO_OBJECT_MASK);

/**
 * The long edge, in pixels, the crop is downscaled to before it is sent to the segmenter.
 *
 * ─── WHY 1280 AND NOT 1024: THE RESAMPLE IS THE DEFECT, NOT THE ERODE ───────────────────────────
 *
 * This was a V1 guess, flagged here as the number most likely to be wrong, and it was. It is the
 * upstream cause of the reported white rim on a recolour, and the mechanism is a rounding step
 * rather than anything about masks:
 *
 *   `maskEdgeUncertaintyFor` is `ceil(sqrt(cropLong / probeLong))`, so ANY resample at all — a
 *   crop one pixel over this edge — steps the uncertainty 1 → 2, and the erode with it. A shorts
 *   crop of 1176x1164 was resampled 1.148x and charged the same 2px erode as a 4x one.
 *
 * That erode is 2px of the ORIGINAL garment left untouched around the edited one, plus the low
 * end of the ramp on top. Measured on the real frame (b18bdd2e / d28b130c, 4000x6000, region
 * 588x582), patch share by depth from the mask contour:
 *
 *     "2+6"   1:0%   2:0%   3:17%  4:33%  5:50%  ...    2px pure original, 4px original-dominated
 *     "0+3"   1:33%  2:67%  3:100%                      0px pure original, 1px original-dominated
 *
 * ⚠️ AND THE RIM IS COMPOSITE-SIDE, WHICH IS WHAT MAKES THIS THE RIGHT LEVER. Solving
 * `output = original*(1-alpha) + patch*alpha` for the patch across the ramp of d28b130c gives a
 * patch luminance of 65.6, 77.2, 77.5, 78.7, 78.5 at depths 1-6, against a source of 180-186. The
 * model returned a fully-recoloured patch; the white is original showing through at low alpha. A
 * prompt change could not have fixed it, and the value is stable across depths rather than fitted,
 * which is what makes that evidence rather than a curve through two points.
 *
 * At 1280 a 1176-long crop is probed at its NATIVE size — scale exactly 1.0, no upsample of the
 * mask at all. That is not a loosened threshold: it is the regime the erode-0 rule was measured in
 * (composite.ts `defaultErodeFor`, spill 0.000%), reached by removing the resample rather than by
 * compensating for it.
 *
 * ⚠️ AND THE OLD CAVEAT STILL STANDS, BECAUSE IT WAS NEVER ABOUT THIS DIRECTION. The reported 0.94
 * jersey IoU was measured at whatever resolution those probes actually sent, so it is still not a
 * measurement OF this constant. Raising the edge can only move that number the right way — the
 * mask is upsampled less — but nobody has re-measured IoU here, and this note should not be read
 * as having done so.
 *
 * ─── WHAT IT COSTS, MEASURED, ON THE ONE CASE THAT CHANGES BEHAVIOUR ────────────────────────────
 *
 * Across real job geometries only two classes move. A jersey crop (990x1084) goes "2+6" → "0+3",
 * same as the shorts. The real one is a JACKET crop of 3672x4518, which goes "3+9" → "2+6" — still
 * resampled (3.53x), just less. Measured on d149d83f, source content by mask distance `v`:
 *
 *     v=1  lum 132   clean background      alpha 0 → 0     unchanged
 *     v=2  lum 120   clean background      alpha 0 → 0     unchanged
 *     v=3  lum  90   MIXED garment edge    alpha 0 → 43    the one ring that changes state
 *     v=4  lum  65   garment               alpha 28 → 85
 *
 * Exactly one ring changes from untouched to 17% edited, and it is a genuinely mixed edge pixel
 * halfway between the background (137) and the garment interior (49). No clean background pixel
 * changes state. That is the whole cost.
 *
 * ⚠️ ONE HONEST SHORTFALL, RECORDED RATHER THAN ROUNDED AWAY. At 3.53x the measured uncertainty
 * curve (1.0px at 1.0x, 2.0px at 2.15x, 2.4px at 5.86x) interpolates to ~2.15px, and `ceil(sqrt())`
 * gives 2 — so the jacket's erode sits ~0.15px UNDER the measurement, where before it sat over. It
 * is sub-pixel and the ramp's first ring carries only 17%, so it is absorbed; it is written down
 * because the next person to move this number should know the band is no longer strictly generous.
 *
 * ─── ⚠️ DO NOT RAISE IT FURTHER. 1536 COSTS PROTECTION AROUND HER AND BUYS NOTHING. ─────────────
 *
 * The obvious next thought is that if 1280 is good, 1536 is better. It is not, and the reason is
 * asymmetric:
 *
 *   THE INVERSION ARM LOSES ITS MARGIN. A whole-frame background probe (crop 4000x6000) holds
 *   uncertainty 3 at both 1024 and 1280, and drops to 2 at 1536. On `preserve-inside` the mask is
 *   HER and the erode is what keeps the new background off her outline — the one place the erode
 *   is protective rather than cosmetic (composite.ts `defaultErodeFor`). Thinning it there trades
 *   a cosmetic rim on garments for edits landing on her hair and skin.
 *
 *   AND IT BUYS NOTHING. `probeBytes` resizes `withoutEnlargement`, so a crop already under the
 *   edge is passed through untouched. Measured on the rim job's 1176x1164 crop: 1280 and 1536
 *   produce the SAME 1176x1164 probe and the same 3111 KB. The headroom is inert for this case and
 *   live for the inversion arm — all cost, no benefit.
 *
 *   BODY SIZE. The crop goes to fal as a DATA URI (studio/adapters/fal.ts explains why), and base64
 *   inflates by 4/3. Measured on that same crop: 1024 → 2504 KB PNG / 3339 KB encoded; 1280 →
 *   3111 KB / 4148 KB. A 24% payload increase, still inside one JSON body.
 *
 * Env-overridable so settling it further stays a value, not a deploy.
 */
export const segmentLongEdgePx = () =>
  Number(process.env.STUDIO_SEGMENT_LONG_EDGE_PX ?? 1280);

/** One segmentation round trip. Probes ran 1-3s; this is generous and still bounded. */
export const segmentTimeoutMs = () =>
  Number(process.env.STUDIO_SEGMENT_TIMEOUT_MS ?? 20_000);

/**
 * LEAK GUARD ①: how far a mask may extend beyond its own region rectangle, as a fraction of that
 * rectangle's width and height, before the mask is discarded for the rectangle.
 *
 * ⚠️ A V1 GUESS IN THE SAME SENSE geometry.ts's LOOSE_REGION_AREA is one, and set on the same
 * principle: deliberately NOT at the point where problems begin.
 *
 * The margin has to be generous, and the reason is structural rather than empirical. The crop
 * carries context padding (composite.ts CONTEXT_PAD_FACTOR, MIN_CONTEXT_PAD_PX), so a CORRECT mask
 * routinely runs past a tight detection box — a jersey box cut at the waist, with the jersey
 * visibly continuing into the padding, is the ordinary case and not the failure. A tight threshold
 * would reject exactly the masks this feature exists to produce.
 *
 * What it is really trying to catch is the mask that has stopped describing a garment at all. At
 * 0.5 a mask may exceed its rectangle by half that rectangle's size on any side; a jersey that
 * continues does not, and a mask that has annexed the background does.
 *
 * ⚠️ ─── THIS GUARD CANNOT FIRE ON A REGION 512px OR WIDER. MEASURED, NOT SUSPECTED. ────────────
 *
 * A mask is bounded by the crop, and the crop is the region plus `max(MIN_CONTEXT_PAD_PX, w/2)` per
 * side (studio/composite.ts planCrop). So the largest value `overreach` can take is `pad / w`:
 *
 *     region w      pad   max reachable overreach   can `> 0.5` fire?
 *           60      256                     4.267   yes
 *          140      256                     1.829   yes
 *          400      256                     0.640   yes
 *          511      256                    0.5010   yes
 *          512      256                    0.5000   NO — structurally impossible
 *          900      450                    0.5000   NO
 *         4000     2000                    0.5000   NO
 *
 * Past 512 the pad IS half the width, so the ratio is exactly 0.5 and `>` is never true. Production
 * frames are 4000x6000 and a jersey region is 800-1500px — squarely inside the dead zone, and the
 * regions most likely to border skin.
 *
 * ⚠️ AND AT w=513 IT FIRES AGAIN, AT 0.5010, because `Math.round(256.5)` is 257. A guard whose
 * existence depends on whether half the region width rounds to 256 or 257 is worse than a dead one:
 * dead is at least predictable. Nobody reading this would guess 512 is impossible and 513 is not.
 *
 * ⚠️ IT IS ALSO WEAKER FOR A GARMENT THAT SHARES A CROP. A solo region is probed against the whole
 * crop (pad 256); a paired one gets a window padded by MIN_PROBE_PAD_PX (32). The same 62px shoe
 * reaches 3.23 alone and 0.52 paired. Nothing there is about mask quality.
 *
 * The `crop_fill` guard below does NOT cover the gap: on a 4000px region a mask may cover ~2.5x the
 * region's area and still pass both.
 *
 * ⚠️ NOT FIXED HERE, DELIBERATELY. `padSpillFor` (studio/segment.ts) measures the same spill against
 * the headroom that actually bounded it — scale-fair by construction — and is LOGGED beside this
 * one, not enforced. The reason is that the dead zone cannot be measured with any frame available:
 * the largest garment region obtainable is ~400px, and the dead zone starts at 512. So it is proven
 * that this guard is dead there and NOT proven that a corrected one would not over-reject there.
 * Enforcing an uncalibrated threshold would swap a guard that silently never fires for one that
 * might silently over-reject. Log first, then set the number from data.
 */
export const maskMaxOverreach = () =>
  Number(process.env.STUDIO_MASK_MAX_OVERREACH ?? 0.5);

/**
 * LEAK GUARD ②: the share of the CROP a mask may cover before it is discarded.
 *
 * The signal overreach cannot see. A garment that legitimately continues past its box still leaves
 * most of the crop unmasked — the crop is roughly twice the region on each axis, so even a jersey
 * filling its whole rectangle and spilling generously sits well under this. A mask covering 85% of
 * the crop is not a garment that continues, it is the garment≈background failure: SAM has taken the
 * kit and the wall behind it as one region.
 *
 * ⚠️ NOT gated on SAM's own confidence, and that is deliberate and measured: the probes produced a
 * near-perfect mask at 0.716 and a LEAKING one at 0.800. Confidence and correctness were decoupled
 * on this task, so the score is not read anywhere in this feature. Do not add it back as a gate.
 */
export const maskMaxCropFill = () =>
  Number(process.env.STUDIO_MASK_MAX_CROP_FILL ?? 0.85);

/**
 * An OVERRIDE for the mask erode, in crop pixels. Undefined — the default — means "derive it".
 *
 * ⚠️ THIS USED TO BE A FLAT `?? 2` AND THE COMMENT ON IT WAS WRONG. It said the erode was "bounded
 * per region by the same quarter-of-the-shorter-side ceiling featherRadiusFor uses, so a 60px sock
 * is not eaten alive by a constant sized for a jersey". The arithmetic does not do that: a quarter
 * of 60 is 15 and the constant was 2, so the ceiling never bound. For it to bind at 2 the region
 * must be under 8px, and studio/geometry.ts MIN_REGION_PX rejects those. The erode was flat at
 * every region size the product can actually produce, and on a small garment those 2 pixels are a
 * rim of the ORIGINAL garment left around the edited one — half of the reported seam.
 *
 * It is derived now, from the mask's own boundary uncertainty (studio/composite.ts maskEdgeFor),
 * which is 1px on a crop that was never downscaled and at most 3px on a whole frame. That is the
 * quantity the erode was always trying to name.
 *
 * Applied INWARD only, as before — an erode can never grow a mask, so neither the default nor an
 * override can turn a safe mask into a leaking one.
 *
 * Left as an env override rather than deleted so the derivation can be pinned to a constant from a
 * value if a real frame ever needs it. Unset is the ordinary case and the tested one.
 *
 * ─── "AN ERODE CAN NEVER GROW A MASK" IS NOW MEASURED, NOT ONLY ARGUED ─────────────────────────
 *
 * Probed on a real frame at erode default / 0.5 / 0, on two nouns with very different boundary
 * complexity (a tank top and hair), compositing through the real pasteBack:
 *
 *     pixels changed OUTSIDE the SAM contour  →  0.000% at EVERY erode value, both nouns
 *
 * That is the property, held empirically rather than by inspection, and it has a consequence worth
 * stating plainly: REDUCING THE ERODE HAS NO SAFETY SURFACE. There is nothing to guard, no bounded
 * variant to design, and no person-mask recheck to add, because a smaller erode cannot reach a
 * pixel the mask did not already cover. Growing a mask is the opposite kind of change and needs all
 * three (see maskEdgeFor for what an 8px dilation did to an athlete's hand).
 *
 * ⚠️ The magnitudes in maskEdgeFor's table come from a synthetic patch. Ratios are the signal;
 * nothing should be tuned against the absolute numbers.
 *
 * ⚠️ ─── WHAT THE 0.000% DOES NOT COVER. READ THIS BEFORE GENERALISING IT. ──────────────────────
 *
 * The probe segmented a tank top and hair, and both were masks of things to CHANGE — EDIT-INSIDE
 * only. It never ran the inversion arm. So "spill was 0.000% at every erode value" is evidence
 * about the garment path and about nothing else, and reading it as a general statement about the
 * erode is exactly the mistake that nearly shipped: on preserve-inside the mask is HER, inverted,
 * and the erode is the margin holding a generated background off her outline. See defaultErodeFor
 * in studio/composite.ts. Measuring one polarity says nothing about the other, because the same
 * number does opposite work on each.
 */
export const maskErodePx = (): number | undefined => {
  const raw = process.env.STUDIO_MASK_ERODE_PX;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Feature flag for the typed edit ops (PR 9, Lane 1: server/studio/edit/**). Off unless explicitly
 * enabled.
 *
 * OFF IS TODAY, EXACTLY. The routes answer 404 before reading a row, and nothing else calls the engine,
 * so nothing is quoted, spent or written. Needs STUDIO_NATIVE_EDIT too — every op is a native edit —
 * and the ad op needs STUDIO_DISPLAY_TEXT for its headline (it refuses without it, at the quote).
 */
export const imageEditOpsEnabled = () =>
  studioFlag(process.env.STUDIO_IMAGE_EDIT_OPS);

/**
 * Feature flag for the verdict display (PR 11, R-4: server/studio/qa/routes.ts). Off unless explicitly
 * enabled. Paired with the client's EXPO_PUBLIC_STUDIO_QA_DISPLAY (client/lib/flags.ts) — both default
 * off, and the server's 404 is the real gate.
 *
 * OFF IS TODAY, EXACTLY. The route answers 404 before reading a row. On, it READS a verdict that
 * STUDIO_CREATIVE_QA (qa/record.ts) may or may not have written, and shows flag-or-pass wording and
 * the cost — never a score, never a threshold, never an action. It runs nothing and spends nothing.
 */
export const qaDisplayEnabled = () => studioFlag(process.env.STUDIO_QA_DISPLAY);

/**
 * THE COMPOSER (PR 15, docs/probes/composer.md). Default OFF. Paired with the client's
 * EXPO_PUBLIC_STUDIO_COMPOSER (client/lib/flags.ts). ON, server side: every capability the planner
 * writes maps onto a Board slot (studio/agent/capabilities.ts `toShotSpec` fills six slots and
 * `capabilityProse` carries nothing), and POST /studio/stitch/caption/suggest exists. OFF IS TODAY,
 * EXACTLY: the six-of-eleven mapping tables, the prose leak onto the direction, and a 404 on the
 * route. It spends nothing either way — the composer is rules, never a model call.
 */
export const composerEnabled = () => studioFlag(process.env.STUDIO_COMPOSER);

/**
 * LIBRARY FIELDS (PR 12, docs/probes/library-fields.md). Default OFF. Gates every READER of the
 * tagger's fuller answer: the planner's library line carries the ten fields it used to drop, the
 * picker sorts hero-first and labels each tile, and the reference gates refuse an unread photo or a
 * no-face likeness. The tagger's two new keys (`face_visibility`, `role`) are NOT behind it — a tag
 * written with two more keys is inert until something reads it, and gating the prompt would fork
 * the stored shape by deploy. With this off, the planner prompt is byte-identical to before PR 12
 * (plan.test pins it).
 */
export const libraryFieldsEnabled = () =>
  studioFlag(process.env.STUDIO_LIBRARY_FIELDS);

/**
 * THE BRIEF CARRIER (PR 14, docs/probes/brief-carrier.md). Default OFF. Paired with the client's
 * EXPO_PUBLIC_STUDIO_BRIEF_CARRIER (client/lib/flags.ts `STUDIO_BRIEF_CARRIER`). ON: a clip or bridge
 * request may carry `planId`; the preview route reads that plan row under her athlete id and freezes
 * the carrier (studio/campaign/carrier.ts) onto the brief — the tone triple, the constraints, the
 * concept, her typed feel — and the video templates render it as fenced data. The campaign parts also
 * need STUDIO_BRAND_PROFILES (a brief cannot exist without it); the feel line from her typed aesthetic
 * rides on a plan with no brief too. OFF: `planId` is an unknown field, no row is read, and every
 * compiled prompt and the planner prompt are byte-identical to before this existed (prompts.golden,
 * compile.golden and plan.test pin it).
 */
export const briefCarrierEnabled = () =>
  studioFlag(process.env.STUDIO_BRIEF_CARRIER);

/**
 * IDENTITY PACK (PR 17, docs/probes/identity-pack.md R-2/R-3/R-4). Default OFF. Gates the pack
 * surface (server/studio/identity/routes.ts: off is a 404 before any row is read), the best-3 chooser
 * on the client (paired with EXPO_PUBLIC_STUDIO_IDENTITY_PACK), and whether qa/identity.ts reads her
 * MEASURED band off identity_profiles instead of the global SAME_PERSON_BAND — and only ever when her
 * stranger control passed. Off, every identity path is byte-identical to before PR 17.
 */
export const identityPackEnabled = () =>
  studioFlag(process.env.STUDIO_IDENTITY_PACK);

/**
 * IDENTITY DRIFT (PR 17, R-6). Default OFF. With it on, clip QA (qa/inspectClip.ts) also cuts ≤8
 * frames at the clip's beat boundaries and records a frame-to-frame face-distance series as an
 * OBSERVATION beside identityObservation — never a check, never in `overall`, nothing acts on it.
 * The embeds are the spend. Off, the clip verdict jsonb is exactly what it was.
 */
export const identityDriftEnabled = () =>
  studioFlag(process.env.STUDIO_IDENTITY_DRIFT);

/**
 * THE STYLE SPEC (PR 18, docs/probes/style-spec.md). Default OFF. Paired with the client's
 * EXPO_PUBLIC_STUDIO_STYLE_SPEC (client/lib/flags.ts `STUDIO_STYLE_SPEC`). ON, all of these:
 *   * a `style_reference` may ride a preview request or a typed edit. It is one of her already-read
 *     references (studio_reference_analyses), and the spec is DERIVED from the stored reading
 *     (studio/reference/styleSpec.ts) and frozen onto the brief. No model call is made for it.
 *   * compile renders it as fenced data, with the image shot phrases.
 *   * the brand lines in the image prompts, and recommend's brand and brief lines, are fenced in
 *     <external_content>, verbatim (ADI-24SEP R1; brief R-7, R-12).
 *   * with STUDIO_IDENTITY_PACK also on, an accepted typed edit records an identity observation against
 *     her own band, and only when her stranger control passed (R-6, ADI-GO18 G10).
 * OFF IS TODAY, EXACTLY: a style role is a 400, no fence is written, and nothing is observed on accept.
 * All 118 image goldens, all 12 video goldens and the recommend prompt are byte-identical
 * (compile/styleFlag.test.ts pins it).
 */
export const styleSpecEnabled = () => studioFlag(process.env.STUDIO_STYLE_SPEC);

/**
 * STUDIO_IMAGE_OPS — PR 19: image ops on the Create Anything SENTENCE DOOR (docs/probes/image-ops.md; ADI-R19).
 *
 * ON, the rules read (all $0, all deterministic):
 *   * RELIGHT and CAMERA — a lighting change and a camera angle, each one native image edit;
 *   * weather as a background ("same place in the rain", R-9), the look pointer ("match this look" → the style
 *     reference's GLOBAL_STYLE, or the `style_reference_missing` ask, B), pose → GENERATE (R-8), the `vague` ask with
 *     op chips (R-6), closed typo and slang maps (R-7), rule 4c's "white and adidas" joiner and an unlisted brand
 *     (K33, R-18), a brand word in an add as fenced data (R-22), K9's colour, and the misroutes (R-25).
 * OFF IS TODAY, EXACTLY: no reader runs, and every compiled prompt is byte-identical (the goldens pin it).
 * The client twin is EXPO_PUBLIC_STUDIO_IMAGE_OPS (client/lib/flags.ts). F2 is NOT behind this flag (ADI-R19).
 */
export const imageOpsEnabled = () => studioFlag(process.env.STUDIO_IMAGE_OPS);

/**
 * ─── STUDIO QUALITY, SCRAPPY (docs/probes/quality-scrappy.md, ADI-QS-GO) ───────────────────────
 *
 * Six flags, split by what turning them on changes.
 *
 * UNDER THE MASTER — $0, observational, or a fall-through that is byte-identical until someone acts:
 *   STUDIO_CLIP_QC           the structural check on every finished clip and stitch (video/structure.ts)
 *   STUDIO_SHOT_DETECT       ffmpeg scene boundaries on a clip read, and the caster's snap (video/shots.ts)
 *   STUDIO_PROMPT_REGISTRY   a published `prompts` row for a Studio template; none published → the TS literal
 *
 * STRICT — `studioGovernanceFlag`, exactly "true", the master never reaches them (unified onto main's helper by
 * ADI-QS-10) — because each changes what she sees or what a spend asks for, and waits for Adi's walk:
 *   STUDIO_DIALECTS          the target manifest's payload check and the Seedance b-roll dialect
 *   STUDIO_OUTPUT_GATE       a clip or image that failed a check is shown as failed, with a re-quote ready
 *   STUDIO_FINISHING         bed normalization + true-peak limit, caption safe zones, beat-snapped cuts, 9:16 crop
 */
export const clipQcEnabled = () => studioFlag(process.env.STUDIO_CLIP_QC);
export const shotDetectEnabled = () =>
  studioFlag(process.env.STUDIO_SHOT_DETECT);
export const promptRegistryEnabled = () =>
  studioFlag(process.env.STUDIO_PROMPT_REGISTRY);
export const dialectsEnabled = () =>
  studioGovernanceFlag(process.env.STUDIO_DIALECTS);
export const outputGateEnabled = () =>
  studioGovernanceFlag(process.env.STUDIO_OUTPUT_GATE);
export const finishingEnabled = () =>
  studioGovernanceFlag(process.env.STUDIO_FINISHING);
