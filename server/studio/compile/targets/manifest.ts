/**
 * studio/compile/targets/manifest — what each (model, provider) we route to ACCEPTS, one entry per target, every field
 * sourced (quality-scrappy piece 1, docs/probes/quality-scrappy.md, ADI-QS-GO).
 *
 * Not to be confused with studio/compile/manifest.ts, which numbers the images inside one request. This is the other
 * half of a request: which parameters, durations, shapes and inputs a target will take at all.
 *
 * ─── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────────
 *
 * The facts below were scattered: durations in config.ts `supportedDurationsFor`, sizes in `videoOutputSizeFor`'s
 * comment, the audio carve-out in adapters/openrouter.ts, the reference caps in config.ts `refCapacityFor`, the "Veo
 * takes no last frame here" warning in adapters/vertex.ts. Nothing could ask "may this payload go to that target", so
 * nothing did. `payloadViolations` asks it, and a compiled payload that carries a parameter its target does not accept
 * is refused at the quote (studio/preview.ts, behind STUDIO_DIALECTS) instead of discovered at the provider.
 *
 * ─── EVERY FIELD SAYS WHERE IT CAME FROM, AND AN UNVERIFIED "YES" COUNTS AS "NO" ────────────────────
 *
 * `source` is a doc, an API read, or a probe ledger; `verified: false` marks a fact nobody here has read from the
 * provider. The check treats an unverified ACCEPT as not accepted — refusing a parameter we have not confirmed is a
 * sentence she can read, sending one is a request that fails (or bills) in a way nobody predicted. Where this file says
 * a target does NOT take something, that direction is safe whether or not it is verified.
 *
 * Reads behind the OpenRouter entries: `GET https://openrouter.ai/api/v1/videos/models`, public, re-read 2026-09-28
 * (`OR_VIDEOS` below). Reads behind the Vertex entries: the wire shapes adapters/vertex.ts verified against the live
 * project on 2026-08-27, plus the probes named per field. Google's Veo reference page did not load here on 2026-09-28
 * (a redirect, then an unrelated page) — every Vertex field that rests on it alone is `verified: false`.
 *
 * ⚠️ MUTATION (manifest.test.ts): Seedance accepting a negative prompt — "Seedance takes no negative prompt" reds.
 */
import { MODELS, vertexModelFor } from "../../config";
import type { GenerationInputs, ProviderName } from "../../types";

/** One fact about a target, with where it came from. */
export interface Sourced<T> {
  value: T;
  source: string;
  /** False when nobody here has read this from the provider. An unverified accept is treated as a refusal. */
  verified: boolean;
}

/**
 * The prompt dialect a target is written in — null for "today's shared templates". Seedance's (video/seedance.ts,
 * second-hand) and Gemini 3 Pro Image's (compile/geminiDialect.ts, quality-scrappy piece 7: four rules Google's own).
 */
export type Dialect = "seedance" | "gemini-image";

export interface TargetManifest {
  /** `model@provider`, the manifest's own key. */
  key: string;
  /** The model id AS THE JOB ROW CARRIES IT — `forProvider`'s form (config.ts), so a row's model looks up directly. */
  model: string;
  provider: ProviderName;
  task: "video.generate" | "image.generate";
  dialect: Dialect | null;
  accepts: {
    negativePrompt: Sourced<boolean>;
    firstFrame: Sourced<boolean>;
    lastFrame: Sourced<boolean>;
    /** A camera-control PARAMETER (not camera words in the prompt, which every model takes). */
    cameraControls: Sourced<boolean>;
    audio: Sourced<boolean>;
    seed: Sourced<boolean>;
    /**
     * The provider-specific keys a request may carry beyond the normalized inputs: top-level body keys on OpenRouter,
     * `parameters.*` keys on Vertex video, `generationConfig.imageConfig.*` keys on Vertex image.
     */
    passthrough: Sourced<readonly string[]>;
  };
  /** How many reference images one request may carry, all slots together. */
  references: Sourced<number>;
  durations: Sourced<readonly number[] | null>;
  aspects: Sourced<readonly string[]>;
  resolutions: Sourced<readonly string[]>;
  /** Exact output sizes, where the provider lists them. Null when it takes a ratio and picks its own pixels. */
  sizes: Sourced<readonly string[] | null>;
  /** What is known about lettering in the output — prose, for the reader deciding what to ask a target for. */
  text: Sourced<string>;
}

const OR_VIDEOS =
  "OpenRouter GET /api/v1/videos/models, read 2026-09-28 (quality-scrappy ledger)";
const VERTEX_WIRE =
  "adapters/vertex.ts header — wire shape verified against the live project 2026-08-27";
const VEO_DOCS_UNREAD =
  "Google's Veo reference (docs.cloud.google.com …/veo-video-generation) did not load 2026-09-28 — unread";

const yes = (source: string): Sourced<boolean> => ({
  value: true,
  source,
  verified: true,
});
const no = (source: string, verified = true): Sourced<boolean> => ({
  value: false,
  source,
  verified,
});
const fact = <T>(value: T, source: string, verified = true): Sourced<T> => ({
  value,
  source,
  verified,
});

const SEEDANCE_SIZES_FAST = [
  "480x480",
  "480x640",
  "480x854",
  "640x480",
  "854x480",
  "1120x480",
  "720x720",
  "720x960",
  "720x1280",
  "720x1680",
  "960x720",
  "1280x720",
  "1680x720",
] as const;
const SEEDANCE_ASPECTS = [
  "1:1",
  "3:4",
  "9:16",
  "4:3",
  "16:9",
  "21:9",
  "9:21",
] as const;
const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

/**
 * Seedance's lettering note, both tiers. Its prompt guide is read SECOND-HAND (the official page would not load —
 * see targets/seedance.ts), and no b-roll frame from it has been looked at for text.
 */
const SEEDANCE_TEXT = fact(
  "No text-rendering read. The b-roll template asks for no readable text at all; garbled signage is the loudest " +
    "generated-look tell (video/prompts.ts BROLL_EMPTINESS). Nothing has measured whether the Avoid clause holds.",
  "video/prompts.ts BROLL_EMPTINESS; docs/probes/video-bakeoff.md (all six b-roll clips 401'd, none looked at)",
  false,
);

function seedance(model: string, tier: "full" | "fast"): TargetManifest {
  return {
    key: `${model}@openrouter`,
    model,
    provider: "openrouter",
    task: "video.generate",
    dialect: "seedance",
    accepts: {
      // THE ONE THIS FILE EXISTS FOR: no negative parameter, so an avoid list can only travel as prose.
      negativePrompt: no(
        `${OR_VIDEOS}: allowed_passthrough_parameters are watermark, req_key only`,
      ),
      firstFrame: yes(`${OR_VIDEOS}: supported_frame_images`),
      lastFrame: yes(`${OR_VIDEOS}: supported_frame_images`),
      cameraControls: no(
        `${OR_VIDEOS}: no camera parameter; camera is prompt text`,
      ),
      audio: yes(
        `${OR_VIDEOS}: generate_audio true; video_tokens_without_audio = video_tokens (free)`,
      ),
      seed: yes(`${OR_VIDEOS}: seed true`),
      passthrough: fact(["watermark", "req_key"], OR_VIDEOS),
    },
    references: fact(
      2,
      "adapters/openrouter.ts videoImageFields: frame_images first + last; more go to input_references, which " +
        "this product never sends to b-roll — 2 is what we have exercised, not the provider's ceiling",
      false,
    ),
    durations: fact(
      SEEDANCE_DURATIONS,
      `${OR_VIDEOS}; config.ts supportedDurationsFor`,
    ),
    aspects: fact(SEEDANCE_ASPECTS, OR_VIDEOS),
    resolutions: fact(
      tier === "fast" ? ["480p", "720p"] : ["480p", "720p", "1080p", "4K"],
      OR_VIDEOS,
    ),
    sizes: fact(
      tier === "fast"
        ? SEEDANCE_SIZES_FAST
        : [
            ...SEEDANCE_SIZES_FAST,
            "1080x1080",
            "1080x1440",
            "1080x1920",
            "1440x1080",
            "1920x1080",
            "2520x1080",
            "3840x2160",
            "2160x3840",
            "2160x2160",
            "2880x2160",
            "2160x2880",
            "5040x2160",
          ],
      OR_VIDEOS,
    ),
    text: SEEDANCE_TEXT,
  };
}

const VEO_TEXT = fact(
  "The identity templates forbid adding, removing or redrawing lettering (video/prompts.ts IDENTITY_PRESERVATION) " +
    "because a clip re-renders a kit every frame; clip QA's text check fails only on a person's name or handle " +
    "(docs/probes/video-prompt-quality-ledger.md D5).",
  "video/prompts.ts; video-prompt-quality-ledger D5",
);

function veo(provider: ProviderName): TargetManifest {
  const onVertex = provider === "vertex";
  return {
    key: `${onVertex ? "veo-3.1-generate-001" : MODELS.veo}@${provider}`,
    model: onVertex ? "veo-3.1-generate-001" : MODELS.veo,
    provider,
    task: "video.generate",
    dialect: null,
    accepts: onVertex
      ? {
          negativePrompt: no(VEO_DOCS_UNREAD, false),
          firstFrame: yes(`${VERTEX_WIRE}: instances[0].image`),
          // Unread, AND not sent: vertex.ts builds instances[0] = { prompt, image } and stops. A last frame on this
          // target is dropped silently — which is why preview.ts routes every last frame to Kling.
          lastFrame: no(
            `${VEO_DOCS_UNREAD}; adapters/vertex.ts never sends one`,
            false,
          ),
          cameraControls: no(VEO_DOCS_UNREAD, false),
          audio: yes(
            "server/scripts/studioClipAudioProbe.ts 2026-09-20: parameters.generateAudio honoured (-91 dB silent / -13 dB asked)",
          ),
          seed: no(VEO_DOCS_UNREAD, false),
          passthrough: fact(
            ["generateAudio"],
            `${VERTEX_WIRE}; parameters.generateAudio priced by pricing.ts from this key`,
          ),
        }
      : {
          negativePrompt: yes(
            `${OR_VIDEOS}: allowed_passthrough_parameters include negativePrompt`,
          ),
          firstFrame: yes(`${OR_VIDEOS}: supported_frame_images`),
          lastFrame: yes(`${OR_VIDEOS}: supported_frame_images`),
          cameraControls: no(`${OR_VIDEOS}: no camera parameter`),
          // Advertised — but adapters/openrouter.ts forces generate_audio false for every non-Seedance model, and
          // preview.ts refuses a sounding identity clip off Vertex. The TARGET takes it; this product does not ask.
          audio: yes(`${OR_VIDEOS}: generate_audio true`),
          seed: yes(`${OR_VIDEOS}: seed true`),
          passthrough: fact(
            [
              "personGeneration",
              "aspectRatio",
              "negativePrompt",
              "conditioningScale",
              "enhancePrompt",
            ],
            OR_VIDEOS,
          ),
        },
    references: onVertex
      ? fact(1, `${VERTEX_WIRE}: only refParts[0] is sent, as the first frame`)
      : fact(
          2,
          "adapters/openrouter.ts videoImageFields: frame_images first + last",
          false,
        ),
    durations: fact(
      [4, 6, 8],
      `${OR_VIDEOS}; config.ts supportedDurationsFor (verified 2026-09-07, "consistent with Vertex's own docs")`,
    ),
    aspects: fact(["16:9", "9:16"], OR_VIDEOS, onVertex ? false : true),
    resolutions: fact(["720p", "1080p", "4K"], OR_VIDEOS, !onVertex),
    // Vertex takes a ratio and picks its own pixels (V2b's clips came back 720x1280 — config.ts videoOutputSizeFor).
    sizes: onVertex
      ? fact(
          null,
          "config.ts videoOutputSizeFor: Vertex sends aspectRatio and ignores width/height",
        )
      : fact(
          [
            "1280x720",
            "1080x1920",
            "1920x1080",
            "720x1280",
            "3840x2160",
            "2160x3840",
          ],
          OR_VIDEOS,
        ),
    text: VEO_TEXT,
  };
}

const KLING: TargetManifest = {
  key: `${MODELS.kling}@openrouter`,
  model: MODELS.kling,
  provider: "openrouter",
  task: "video.generate",
  dialect: null,
  accepts: {
    negativePrompt: yes(
      `${OR_VIDEOS}: allowed_passthrough_parameters negative_prompt, cfg_scale`,
    ),
    firstFrame: yes(`${OR_VIDEOS}: supported_frame_images`),
    lastFrame: yes(
      `${OR_VIDEOS}; docs/probes/kling-first-last.md (the last frame is load-bearing, c2 0.056 vs c4 1.020)`,
    ),
    cameraControls: no(`${OR_VIDEOS}: no camera parameter`),
    // Advertised at 0.126/s against the 0.084/s we price flat — adapters/openrouter.ts excludes Kling from audio BY
    // MODEL, and preview.ts never lets a bridge sound. The target takes it; this product must not ask (under-quote).
    audio: yes(
      `${OR_VIDEOS}: generate_audio true (duration_seconds_with_audio 0.126)`,
    ),
    seed: no(`${OR_VIDEOS}: seed false`),
    passthrough: fact(["negative_prompt", "cfg_scale"], OR_VIDEOS),
  },
  references: fact(
    2,
    "adapters/openrouter.ts videoImageFields: frame_images first + last",
    false,
  ),
  durations: fact(
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    `${OR_VIDEOS}; config.ts supportedDurationsFor`,
  ),
  aspects: fact(["16:9", "9:16", "1:1"], OR_VIDEOS),
  resolutions: fact(["720p"], OR_VIDEOS),
  sizes: fact(["1280x720", "720x1280", "720x720"], OR_VIDEOS),
  text: fact(
    "The bridge template forbids adding or redrawing lettering (video/prompts.ts TRANSITION_CONTINUITY). No read.",
    "video/prompts.ts TRANSITION_CONTINUITY",
    false,
  ),
};

const NANO_PRO_VERTEX: TargetManifest = {
  key: "gemini-3-pro-image@vertex",
  model: "gemini-3-pro-image",
  provider: "vertex",
  task: "image.generate",
  dialect: "gemini-image",
  accepts: {
    negativePrompt: no("generateContent has no negative-prompt field"),
    firstFrame: no("an image model"),
    lastFrame: no("an image model"),
    cameraControls: no("an image model; camera is prompt text"),
    audio: no("an image model"),
    seed: no(`${VERTEX_WIRE} does not list seed`, false),
    passthrough: fact(
      ["aspectRatio", "imageSize"],
      `${VERTEX_WIRE} (imageConfig.aspectRatio from @google/genai 2.7.0); config.ts imageSizeParams (imageSize verified)`,
    ),
  },
  references: fact(
    6,
    "config.ts defaultRefCapacities (STUDIO_MAX_REFERENCES, default 6); per-kind caps are Google's except the " +
      "character pack of 3, which is ours (config.ts CHARACTER_CAP)",
  ),
  durations: fact(null, "an image model"),
  aspects: fact(
    ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "9:16", "16:9", "21:9"],
    "compile/aspect.ts SUPPORTED_ASPECTS (@google/genai 2.7.0) + 4:5, which vertex.ts records as accepted in practice",
  ),
  resolutions: fact(
    ["512px", "1K", "2K", "4K"],
    "config.ts IMAGE_SIZES (uppercase K; lowercase is rejected)",
  ),
  sizes: fact(null, "takes a ratio and a size tier, not pixels"),
  text: fact(
    "Short display text renders in-model (Q6, 2026-09-11, CLEAN/CLEAN on one frame); long copy, small sizes and " +
      "run-to-run spelling are unmeasured. Invented names on kits are what qa/text.ts exists for.",
    "docs/probes/sweep-4-ledger.md Q6; studio/qa/text.ts",
  ),
};

/** Every target this product routes to. */
export const TARGETS: readonly TargetManifest[] = [
  veo("vertex"),
  veo("openrouter"),
  seedance(MODELS.seedance, "full"),
  seedance(MODELS.seedanceFast, "fast"),
  KLING,
  NANO_PRO_VERTEX,
];

/** The manifest entry for a (model, provider) pair, or null for a target nobody has described. */
export function targetFor(
  model: string,
  provider: ProviderName,
): TargetManifest | null {
  return (
    TARGETS.find((t) => t.model === model && t.provider === provider) ?? null
  );
}

/**
 * The dialect a MODEL is written in, whatever provider it is on — null when it has none (today's templates).
 *
 * Keyed on the model alone because the dialect is a property of the model's training, not of the pipe it arrives
 * through. The CALLER decides which model: the quote's route at the quote, the job ROW's model at the run
 * (studio/preview.ts `dialectModel`) — never the current env (ADI-QS-GO R6, ledger D1).
 */
export function dialectFor(model: string | undefined): Dialect | null {
  if (!model) return null;
  // A model's OpenRouter id finds its Vertex target too (`google/gemini-3-pro-image` → `gemini-3-pro-image`): one model,
  // one dialect, whichever pipe the route names (quality-scrappy piece 7).
  return (
    TARGETS.find((t) => t.model === model || t.model === vertexModelFor(model))
      ?.dialect ?? null
  );
}

/**
 * A compiled request, reduced to what a manifest can judge. Built from the planner's own output — the inputs and the
 * provider params — never from the wire body, which each adapter builds differently.
 */
export interface PayloadView {
  durationSeconds?: number;
  aspectRatio?: string;
  size?: string;
  references: number;
  lastFrame: boolean;
  generateAudio: boolean;
  seed: boolean;
  negativePrompt: boolean;
  /** Provider-specific keys the request carries, in the manifest's `passthrough` vocabulary. */
  passthrough: string[];
}

const NEGATIVE_KEYS = new Set(["negative_prompt", "negativePrompt"]);

/** The planner's output as a PayloadView. */
export function payloadOf(
  inputs: GenerationInputs,
  providerParams: Record<string, unknown> | undefined,
  provider: ProviderName,
): PayloadView {
  const params = (providerParams ?? {}) as Record<string, unknown>;
  const nested = (params.parameters ?? {}) as Record<string, unknown>;
  const imageConfig = ((
    params.generationConfig as Record<string, unknown> | undefined
  )?.imageConfig ?? {}) as Record<string, unknown>;
  // Which keys count as "provider-specific" depends on where the adapter puts them: OpenRouter spreads the top level
  // of providerParams into the body (and reads `parameters.generateAudio` itself), Vertex video spreads `parameters`,
  // Vertex image nests under generationConfig.imageConfig.
  const topLevel = Object.keys(params).filter(
    (k) => k !== "parameters" && k !== "generationConfig",
  );
  const passthrough =
    provider === "vertex"
      ? [
          ...Object.keys(nested).filter((k) => nested[k] !== false),
          ...Object.keys(imageConfig),
          ...topLevel,
        ]
      : topLevel;
  return {
    ...(inputs.durationSeconds !== undefined
      ? { durationSeconds: inputs.durationSeconds }
      : {}),
    ...(inputs.aspectRatio ? { aspectRatio: inputs.aspectRatio } : {}),
    ...(inputs.width && inputs.height
      ? { size: `${inputs.width}x${inputs.height}` }
      : {}),
    references: inputs.references?.length ?? 0,
    lastFrame: !!inputs.lastFrame,
    generateAudio: nested.generateAudio === true,
    seed: inputs.seed !== undefined,
    negativePrompt: [...topLevel, ...Object.keys(nested)].some((k) =>
      NEGATIVE_KEYS.has(k),
    ),
    // `generateAudio: false` is the planner's default on every video and is the ABSENCE of a request, not a key the
    // target has to accept; it is judged by `generateAudio` above.
    passthrough: passthrough.filter((k) => !NEGATIVE_KEYS.has(k)),
  };
}

const accepted = (s: Sourced<boolean>) => s.value && s.verified;

/**
 * Every way a payload asks a target for something it does not take, in plain words — [] when it may go.
 *
 * An unverified accept counts as a refusal (see the header). A null list (durations on an image, sizes on a
 * ratio-taking target) is "not a thing this target is asked", and is not checked.
 *
 * ⚠️ THE REFERENCE COUNT IS NOT CHECKED, AND THAT IS A FINDING RATHER THAN AN OMISSION. Veo on Vertex is sent the
 * FIRST reference only (adapters/vertex.ts `refParts[0]`); a clip that plans three has the other two dropped by OUR
 * adapter, not refused by the provider. Refusing it here would turn a silent drop that works today into a refusal
 * under a flag that is meant to change the prompt — so the count is recorded (`references`) and left to the ledger.
 */
export function payloadViolations(
  target: TargetManifest,
  p: PayloadView,
): string[] {
  const out: string[] = [];
  const a = target.accepts;
  if (p.negativePrompt && !accepted(a.negativePrompt))
    out.push("a negative prompt");
  if (p.lastFrame && !accepted(a.lastFrame)) out.push("a last frame");
  if (p.generateAudio && !accepted(a.audio)) out.push("sound");
  if (p.seed && !accepted(a.seed)) out.push("a seed");
  const durations = target.durations.value;
  if (
    p.durationSeconds !== undefined &&
    durations &&
    !durations.includes(p.durationSeconds)
  )
    out.push(`a ${p.durationSeconds}s clip`);
  if (p.aspectRatio && !target.aspects.value.includes(p.aspectRatio))
    out.push(`a ${p.aspectRatio} frame`);
  const sizes = target.sizes.value;
  if (p.size && sizes && !sizes.includes(p.size))
    out.push(`a ${p.size} output`);
  const known = new Set(a.passthrough.verified ? a.passthrough.value : []);
  for (const k of p.passthrough)
    if (!known.has(k)) out.push(`the parameter "${k}"`);
  return out;
}
