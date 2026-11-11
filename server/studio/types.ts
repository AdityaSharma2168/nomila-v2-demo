/**
 * studio/types — the one generation interface every provider hides behind.
 *
 * Deliberately TINY. It models the ~20% of parameters that every image/video provider shares
 * (prompt, reference images, dimensions, seed, count, duration) and nothing else. Anything a single
 * provider supports and the others don't goes through `opts.providerParams` un-inspected, so adding
 * a model never means growing this file.
 *
 * Provider + model are chosen by config (studio/config.ts), never at a call site — the same rule
 * server/mila/config.ts and lib/models.ts follow, so a bad model rollout is an env flip.
 */

/**
 * What kind of work this is. The router maps each to a provider + model via config.
 *
 * `image.segment` is the odd one and it is deliberately in this union rather than beside it. It
 * produces a MASK, not a picture — but it is a paid provider call on an athlete's photograph, and
 * everything this union buys (the one door in studio/router.ts, the cost-log entry, the trace span,
 * the model id living in config instead of at a call site) is exactly what a paid call needs. A
 * segmenter reached through a side channel would be the one generation in the product that spends
 * without being counted.
 *
 * It borrows the generation shape honestly: `inputs.prompt` is the garment noun, `references` is the
 * one crop to segment, and `assets[0].bytes` is the returned mask PNG. Nothing is stretched.
 */
export type GenerationTask =
  | "image.generate"
  | "image.edit"
  | "video.generate"
  | "image.segment"
  /**
   * PR 19 (S-7, ADI-R19-S): a CROP of her photo — a window of her own pixels, cut in-process by sharp. No model, $0,
   * served by the `local` adapter (studio/adapters/local.ts), and still one job, one quote and one cost line through
   * the router's one door, so PR 11's joins hold. Only STUDIO_IMAGE_OPS's CROP operation produces one.
   */
  | "image.crop";

/**
 * The most pieces POST /studio/plan/admit will judge at once — which is to say, the largest BOARD.
 *
 * ⚠️ 15 = 2 × MAX_ROWS − 1: eight shots (client/screens/studio/storyboardLogic.ts MAX_ROWS) and a
 * generated bridge into every one after the first. Admission is the Board's door, so it must take
 * the Board's worst case whole; a smaller bound would refuse a legal board before it could be judged.
 *
 * ⚠️ AND IT IS NOT THE PLANNER'S CAP. `MAX_PLAN_ITEMS` (6) bounds how many items the Agent's planner
 * may PROPOSE; this bounds how many previews admission may JUDGE. They were one constant for a
 * commit, and that refused every board over six pieces. Do not merge them again: a plan becomes a
 * board, a board can be longer than a plan, and admission sees boards.
 *
 * Declared in this file, which imports nothing, so the client's test can hold it to MAX_ROWS without
 * pulling the database into its graph.
 */
export const MAX_ADMIT_PIECES = 15;

/**
 * The most items the Agent's PLANNER may propose.
 *
 * ⚠️ NOT THE ADMISSION BOUND — see `MAX_ADMIT_PIECES` above. This bounds how long a list a MODEL may
 * hand us; that bounds how many previews admission may judge, which is the largest board. They were
 * one constant for a commit, and that refused every board over six pieces.
 *
 * Neither is enforced by `assertPlanWithinCaps`: both are SHAPE bounds, and the money gate decides
 * money. Keeping them out of it is what lets it stay a pure function of quotes and caps.
 *
 * ─── ⚠️  AND IT LIVES IN THIS FILE FOR THE REASON `ShotType` DOES ──────────────────────────────
 *
 * It was declared in studio/spendCaps.ts, which imports studio/previewStore.ts, which imports
 * server/db — and server/db THROWS AT MODULE LOAD without DATABASE_URL. So studio/agent/types.ts
 * importing this one constant pulled the whole database into the planner's import graph, and the
 * planner's suite died on "DATABASE_URL must be set" before a single test ran.
 *
 * This file imports NOTHING, so declaring it here adds no edge to anybody's graph. spendCaps
 * re-exports it for its own readers.
 */
export const MAX_PLAN_ITEMS = 6;

/** `local` (PR 19) runs in-process and calls nothing: it serves `image.crop` alone. */
export type ProviderName = "openrouter" | "vertex" | "fal" | "local";

/**
 * What KIND of video segment this is — the axis video routing turns on (studio/video/shotType.ts).
 *
 *   identity    the athlete is in it. Veo: the only route that both holds her face (V2b, 3/3) and
 *               accepts a real person at all.
 *   broll       nobody is in it. seedance-2.0-fast, which won the bake-off's b-roll arm at
 *               $0.0914/s against Veo's $0.20/s. It can do NOTHING else — it refuses real-person
 *               image-to-video 6/6 by stated policy.
 *   transition  a bridge between two clips, anchored at both ends. Kling. LIVE (V10, #532): selected
 *               by the brief's frozen last frame in studio/preview.ts `plannedInputs`, never by
 *               `shotTypeFor`, which reads references only.
 *
 * ─── ⚠️  IT LIVES HERE, WITH `GenerationTask` AND `ProviderName`, FOR A LOAD-BEARING REASON ────
 *
 * Not taste, and not "types belong in types.ts". It was declared in studio/video/shotType.ts, which
 * imports `PlannedReference` from studio/preview.ts — and studio/config.ts needed it, which put
 * studio/preview.ts into the import graph of everything that reaches config. stitchRunner.test.ts's
 * "no spend surface" guard caught it immediately: that walk reads IMPORT SPECIFIERS out of the
 * source and does not care that `import type` is erased at runtime — correctly, because a type
 * import is one refactor away from being a value import, and then the stitch runner really would
 * pull the preview store and the spend gate into a path that must never reach them.
 *
 * This file imports NOTHING, so declaring it here adds no edge to anybody's graph. It is also
 * simply where it belongs: a `TaskRoute` is a provider and a model, and those two live here.
 */
export type ShotType = "identity" | "broll" | "transition";

/**
 * ─── THE STRUCTURED SHOT SPEC — what she can SET about a clip, beside what she says about it ─────
 *
 * Four optional slots the video compiler writes into its templates deterministically. The frame for
 * all of them: the prompt is COMPILED FROM STRUCTURE, never rewritten by a model out of her sight —
 * what she approved is what runs. A chip she tapped is a fact on the brief; a sentence a model
 * improved is not.
 *
 * ⚠️ SMALL ON PURPOSE. Every value here is one the compiler can phrase, in plain words, with
 * confidence that the phrase means the same thing to every video model we route to. It is not a
 * cinematography glossary, and a value earns its place by being phraseable — not by existing.
 *
 * ⚠️ CLOSED SETS, ALL FOUR, INCLUDING `environment`. Free text there would be a second direction
 * box with none of the first one's fencing. A NAME off the wire, never an expansion — the rule
 * `parseStitchSpec` and the video templates already follow.
 *
 * Lives here for the reason `ShotType` does: this file imports nothing, so the route, the brief,
 * the compiler and the stitch graph can all read the vocabulary without gaining an edge.
 */
/*
 * ─── THE COMPOSER'S GROWTH (PR 15, R-2, docs/probes/composer.md) ─────────────────────────────────
 *
 * The first three values of each list are the originals. Every value after them, and the two lists
 * `SHOT_COMPOSITIONS` and `SHOT_MOTIONS`, exist so that EVERY member of the planner's capability
 * vocabulary (studio/agent/capabilities.ts, Mia's §8) has a slot of the same meaning — before this,
 * 36 of 48 members had none and rode onto the direction as prose, past the compiler's refusals.
 * Each value is phrased in studio/video/prompts.ts by lookup, as before; a value with no phrase there
 * does not compile. The planner maps onto the new values only behind STUDIO_COMPOSER
 * (`toShotSpec`); with the flag off nothing writes them, and a brief with no slot compiles
 * byte-identically (the goldens are the pin).
 */
export const SHOT_FRAMINGS = [
  "wide",
  "medium",
  "close",
  "pov",
  "over-the-shoulder",
  "low-angle",
  "high-angle",
  "overhead",
] as const;
export const SHOT_MOVEMENTS = [
  "static",
  "push-in",
  "tracking",
  "orbit",
  "pull-out",
  "dolly",
  "crane",
  "pan",
  "tilt",
  "handheld",
  "whip-pan",
] as const;
export const SHOT_LIGHTINGS = [
  "golden-hour",
  "stadium",
  "overcast",
  "warm-lamp",
  "natural",
  "studio",
  "hard-light",
  "soft-light",
  "rim-light",
  "backlight",
  "neon",
  "low-key",
  "high-key",
] as const;
/** How the frame is arranged (§8 composition). A photo already has one; text-to-video takes it. */
export const SHOT_COMPOSITIONS = [
  "centered",
  "rule-of-thirds",
  "symmetrical",
  "negative-space",
  "foreground-framing",
  "layered-depth",
  "shallow-depth-of-field",
] as const;
/** What moves in the scene and how (§8 motion). Text-to-video takes it; a shot of her says it in words. */
export const SHOT_MOTIONS = [
  "walking",
  "running",
  "turning",
  "jumping",
  "celebrating",
  "interacting-with-product",
  "slow-motion",
  "speed-ramp",
] as const;
export const SHOT_ENVIRONMENTS = [
  "stadium",
  "training-ground",
  "gym",
  "locker-room",
  "street",
  "studio",
] as const;

export type ShotFraming = (typeof SHOT_FRAMINGS)[number];
export type ShotMovement = (typeof SHOT_MOVEMENTS)[number];
export type ShotLighting = (typeof SHOT_LIGHTINGS)[number];
export type ShotEnvironment = (typeof SHOT_ENVIRONMENTS)[number];
export type ShotComposition = (typeof SHOT_COMPOSITIONS)[number];
export type ShotMotion = (typeof SHOT_MOTIONS)[number];

/** Every slot optional. A spec with no slots set is not a spec — see `normalizeShotSpec`. */
export interface ShotSpec {
  framing?: ShotFraming;
  movement?: ShotMovement;
  lighting?: ShotLighting;
  environment?: ShotEnvironment;
  composition?: ShotComposition;
  motion?: ShotMotion;
}

/** The slots, in the order the compiler and the UI list them. */
export const SHOT_SLOTS = {
  framing: SHOT_FRAMINGS,
  movement: SHOT_MOVEMENTS,
  lighting: SHOT_LIGHTINGS,
  environment: SHOT_ENVIRONMENTS,
  composition: SHOT_COMPOSITIONS,
  motion: SHOT_MOTIONS,
} as const satisfies Record<keyof ShotSpec, readonly string[]>;

/**
 * A spec with only its SET slots, in canonical key order — or `undefined` when none is set.
 *
 * ⚠️ `undefined`, NOT `{}`, AND THAT IS THE ADDITIVE RULE. `{}` on the brief is a key that "frozen
 * before this existed" does not have, for a clip that asked for nothing. Canonical order is so two
 * briefs that mean the same thing serialize the same way.
 *
 * It does NOT validate: a value outside the closed set is the route's to refuse with a 400. This
 * only drops what is absent.
 */
export function normalizeShotSpec(
  spec: ShotSpec | undefined,
): ShotSpec | undefined {
  if (!spec) return undefined;
  const out: ShotSpec = {};
  for (const slot of Object.keys(SHOT_SLOTS) as (keyof ShotSpec)[]) {
    const v = spec[slot];
    if (v !== undefined) (out as Record<string, string>)[slot] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Which provider capacity a reference is destined for — and the ONLY thing an adapter may use to
 * decide where a reference goes. Before this existed, array position was the only surviving signal
 * (the planner knew a reference's role and dropped it at this boundary), so a mood board and a
 * portrait of the athlete were indistinguishable by the time they reached a request body.
 *
 * ─── THIS IS OUR VOCABULARY, NOT THE PROVIDER'S. VERIFIED, NOT ASSUMED ──────────────────────────
 *
 * Google DOES ship a typed reference-image API — `SubjectReferenceImage`, `StyleReferenceImage`,
 * and a `SubjectReferenceType` enum with SUBJECT_TYPE_PERSON / SUBJECT_TYPE_PRODUCT. It is in the
 * @google/genai package this repo already depends on (2.7.0). It hangs off `EditImageParameters`
 * — "The reference images for Imagen 3 editing" — which is a DIFFERENT model on a DIFFERENT
 * endpoint from the one we route to.
 *
 * Our path is gemini-3-pro-image via `:generateContent`, where a reference image is a `Part`. The
 * `Part` interface in that same package carries: mediaResolution, codeExecutionResult,
 * executableCode, fileData, functionCall, functionResponse, inlineData, text, thought,
 * thoughtSignature, videoMetadata, toolCall, toolResponse, partMetadata. There is NO type, role or
 * reference-kind field anywhere on it, and the one free-form field (`partMetadata`) is documented
 * "not supported in Vertex AI" — which is exactly our transport.
 *
 * So a slot is three things WE control — the position in the parts array, the label in the prompt's
 * reference manifest, and the per-role cap — and zero things the provider enforces.
 *
 * THAT FACT ALREADY COST A FEATURE, which is the strongest argument for keeping this note where a
 * reader will hit it. A `person`/`product`/`influence` vocabulary once shipped here, and the third
 * one told the athlete a look reference would contribute a mood and never a person. Everything on
 * our side of the line worked; the model ignored the prose, faces leaked, and the role was removed
 * (studio/brief.ts ReferenceRole). What survives is placement, ordering and caps — real properties,
 * none of which depend on the model cooperating.
 *
 * So: do not build a guarantee about what comes OUT of an image on top of this type. It can say
 * where a reference goes. It cannot say what the model does with it.
 */
export type RefSlot = "frame" | "character" | "object" | "style";

/**
 * A reference image: either something already public/signed, or inline bytes.
 *
 * `slot` and `label` are OPTIONAL so every existing caller still type-checks, but the planner sets
 * both on every reference it emits. An adapter that receives no slot falls back to the order it was
 * given, which is the old behaviour and is correct for a caller that never typed its references.
 */
export type ImageRef =
  | { kind: "url"; url: string; slot?: RefSlot; label?: string }
  | {
      kind: "bytes";
      bytes: Buffer;
      mimeType: string;
      slot?: RefSlot;
      label?: string;
    };

/**
 * The window a crop cuts (PR 19, S-7), planned at the quote from the frozen source's own dimensions, UPRIGHT (EXIF
 * orientation applied). The run re-reads the photo, refuses if its upright size is not the planned one, and its
 * output must be exactly this window — the crop's own guard, in place of the edit's aspect guard (R-12).
 */
export interface CropWindow {
  left: number;
  top: number;
  width: number;
  height: number;
  uprightWidth: number;
  uprightHeight: number;
}

/** The normalized inputs. Everything optional except the prompt. */
export interface GenerationInputs {
  prompt: string;
  /** Source images. Required for image.edit; used as style/subject refs elsewhere when supported. */
  references?: ImageRef[];
  /** image.crop only (PR 19): the planned window. Absent on every other task. */
  crop?: CropWindow;
  width?: number;
  height?: number;
  /** e.g. "1:1", "9:16". Providers that take a ratio rather than pixels use this. */
  aspectRatio?: string;
  seed?: number;
  /** How many assets to produce. Defaults to 1. */
  n?: number;
  /** video.generate only. */
  durationSeconds?: number;
  /**
   * video.generate only — the frame the clip must ARRIVE at, sent as `frame_type: "last_frame"`.
   *
   * Deliberately its own field rather than a fifth `RefSlot`. A slot would join SLOT_ORDER, which
   * every image path sorts against and whose order the prompt's reference manifest numbers its
   * lines from (studio/refOrder.ts) — so a slot added for video would move image goldens for no
   * reason. This is read by the video branch alone and is invisible to `references`.
   *
   * ⚠️ FIRST AND LAST MUST BE THE SAME PERSON. The pair is an identity anchor at both ends; two
   * different subjects would ask the model to morph one into the other, and any identity read
   * taken off that clip would be measuring the morph.
   */
  lastFrame?: ImageRef;
}

/**
 * The ids one cost line joins on (PR 11). Every field is present on every line, null where the call
 * site has no such thing: a generate has no edit row, an edit has no asset until accept, and only an
 * interpreter- or typed-op-compiled brief has a prompt version.
 */
export interface GenerationAttribution {
  jobId: string | null;
  previewId: string | null;
  editPreviewId: string | null;
  batchId: string | null;
  promptVersion: string | null;
  assetId: string | null;
}

export interface ProviderOpts {
  /** Override the configured provider/model. Prefer changing config over passing these. */
  provider?: ProviderName;
  model?: string;
  /**
   * Cancels the in-flight request AND the video poll loop. The SSE transport already exposes one
   * (`openSSEStream(...).signal`); thread it through so a client disconnect stops paid work.
   */
  signal?: AbortSignal;
  /** Per-HTTP-call timeout. Not the total budget for a polled video job — see maxPollMs. */
  timeoutMs?: number;
  /** Return the cost estimate and the resolved plan WITHOUT generating. Same as calling estimate(). */
  dryRun?: boolean;
  /** Provider-specific knobs, passed through untouched. The escape hatch that keeps the interface small. */
  providerParams?: Record<string, unknown>;
  /**
   * Ids for the reference images, recorded in the cost log alongside the count (media_assets uuids,
   * typically). Log-only — never sent to a provider. Supplied separately because the references
   * themselves are usually SIGNED urls, which must never be written to disk.
   */
  refIds?: string[];
  /** Skip the cost-log entry for this call. Dry runs are already skipped. */
  noLog?: boolean;
  /**
   * What this generation belongs to, for the cost line (PR 11, R-1). Log-only — never sent to a
   * provider. The router itself holds no id of any kind, so the caller that does (the edit engine,
   * the generate path, the video runner) names them here and the line carries them; whatever a
   * caller cannot know is written as null, never omitted (studio/costLog.ts).
   */
  attribution?: Partial<GenerationAttribution>;
  /** Async video jobs: how often to poll and how long to keep polling. */
  pollIntervalMs?: number;
  maxPollMs?: number;
  /** Progress callback — wire it to an SSE `status` event. */
  onProgress?: (e: {
    status: string;
    jobId?: string;
    elapsedMs: number;
  }) => void;
}

export interface GeneratedAsset {
  /** Set when the provider returns a fetchable URL (video). */
  url?: string;
  /** Set when the provider returns inline bytes (images come back base64). */
  bytes?: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * What a generation costs. `basis` matters: "reported" is the provider's own figure for work that
 * actually ran; "estimated" is our config price table BEFORE running, and is what the pre-generation
 * check shows the athlete. `unpriced` means we have no price for this model — surface "unknown",
 * never a confident $0.
 */
export interface CostEstimate {
  amountUsd: number;
  currency: "USD";
  basis: "estimated" | "reported";
  unpriced?: boolean;
  /** How the number was reached, for the UI's "why" line. */
  detail?: string;
}

export interface GenerationResult {
  task: GenerationTask;
  provider: ProviderName;
  model: string;
  assets: GeneratedAsset[];
  cost: CostEstimate;
  /** Provider job id for async work (video). */
  jobId?: string;
  timings: { startedAt: string; completedAt: string; ms: number };
  /**
   * Targets a masked edit could not apply, by their own labels, when at least one other DID apply.
   *
   * Present only on a PARTIAL success — a job where some crops landed and some did not. Absent on a
   * clean run and on a total failure (which throws). She is shown these by name, because "we changed
   * two of the three things you asked for" is only honest if it says which one is missing.
   */
  failedTargets?: string[];
  /** Untouched provider payload, for debugging. Never rendered. */
  raw?: unknown;
}

/** The plan a dry run returns: what WOULD happen, and what it would cost. */
export interface GenerationPlan {
  task: GenerationTask;
  provider: ProviderName;
  model: string;
  inputs: {
    prompt: string;
    references: number;
    width?: number;
    height?: number;
    n: number;
    durationSeconds?: number;
  };
  cost: CostEstimate;
}

/** Every adapter implements exactly this. */
export interface GenerationAdapter {
  readonly name: ProviderName;
  supports(task: GenerationTask): boolean;
  generate(
    task: GenerationTask,
    inputs: GenerationInputs,
    model: string,
    opts: ProviderOpts,
  ): Promise<GenerationResult>;
  /** Cost WITHOUT generating. Must never make a billable call. */
  estimate(
    task: GenerationTask,
    inputs: GenerationInputs,
    model: string,
    opts: ProviderOpts,
  ): CostEstimate;
  /**
   * The DETACHED video pair, for providers whose video work outlives a request.
   *
   * `generate` submits and polls in one breath, which is right inline and unusable for a queue:
   * studio/videoRunner.ts must submit ONCE, persist the handle on the job row, and let any later
   * tick — on any instance, after any restart — resume polling THAT handle. A call with no seam
   * between the two halves gives it nowhere to persist, so an instance that died mid-poll would
   * come back and buy a second copy of a clip already paid for.
   *
   * OPTIONAL, and that is the point rather than an oversight: `fal` serves segmentation only, has
   * no video to detach, and should not be made to implement two methods it would have to throw
   * from. A provider that cannot do detached video simply does not have this, and the runner
   * refuses such a job instead of guessing.
   *
   * The handle is opaque to the runner — OpenRouter's is a job id, Vertex's an operation name. It
   * is stored and handed back, never parsed.
   */
  video?: {
    submit(
      inputs: GenerationInputs,
      model: string,
      opts: ProviderOpts,
    ): Promise<string>;
    poll(
      handle: string,
      model: string,
      inputs: GenerationInputs,
      opts: ProviderOpts,
    ): Promise<{ assets: GeneratedAsset[]; jobId: string; raw: unknown }>;
  };
}

/** Thrown for every failure the caller can act on (missing key, unsupported task, provider error). */
/**
 * Every code a `GenerationError` can carry.
 *
 * Named so consumers that decide something FROM a code (studio/refusal.ts, the video runner's
 * retry) can take the union as a parameter instead of a bare `string`, where a typo compiles.
 */
export type GenerationErrorCode =
  | "missing_api_key"
  | "unsupported_task"
  | "unknown_provider"
  | "invalid_input"
  | "provider_error"
  /**
   * THE PROVIDER REFUSED WHAT WE SENT IT. Never retry — see studio/refusal.ts.
   *
   * The input is outside the route's policy, so the identical request produces the identical
   * refusal. Seedance answers real-person image-to-video this way 6 times out of 6
   * (`InputImageSensitiveContentDetected.PrivacyInformation`, a stated BytePlus policy —
   * docs/probes/kling-moderation.md §1). A retry here buys the same "no" twice.
   */
  | "content_blocked"
  /**
   * THE PROVIDER RAN, AND ITS OUTPUT FILTER TOOK THE RESULT. Discretionary — a retry may pass.
   *
   * Structurally different from the above: the model generated something and a filter removed
   * it, so the same request can produce a different outcome. ⚠️ IT IS NOT FREE — the clip was
   * generated and billed, and a retry buys a second one. See studio/refusal.ts.
   */
  | "content_filtered"
  | "timeout"
  | "aborted";

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly code: GenerationErrorCode,
    readonly provider?: ProviderName,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}
