/**
 * openrouter adapter — the real one. Serves Nano Banana / Seedream / Seedance / Kling / Veo through
 * two documented OpenRouter surfaces:
 *
 *   images  POST /api/v1/images            → { created, data:[{b64_json, media_type}], usage:{cost} }
 *   videos  POST /api/v1/videos            → 202 { id, polling_url, status:"pending" }
 *           GET  /api/v1/videos/{id}       → { status: pending|in_progress|completed|failed,
 *                                              unsigned_urls:[…], usage:{cost} }
 *           GET  /api/v1/videos/{id}/content?index=N   → the file
 *
 * Plain `fetch`, no SDK — same as lib/mediaEmbed.ts talks to Vertex. That keeps package.json
 * untouched and the wire format visible.
 *
 * Image EDIT is the same /images call with `input_references`; OpenRouter accepts http(s) URLs or
 * base64 data URLs there, so a caller can hand us a signed GCS url (mediaStore.signedUrl) or bytes.
 */
import { createLogger } from "../../logger";
import { httpTimeoutMs, videoPoll, reasoningRequired, MODELS } from "../config";
import { estimateCost, reportedCost } from "../pricing";
import { orderBySlot } from "../refOrder";
import { refusalCodeFor } from "../refusal";
import {
  GenerationError,
  type GenerationAdapter, type GenerationInputs, type GenerationResult, type GenerationTask,
  type GeneratedAsset, type CostEstimate, type ImageRef, type ProviderOpts,
} from "../types";

const logger = createLogger("studio/openrouter");
const base = () => process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Read the key at CALL time, not module load — Secret Manager may populate it after import. */
function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new GenerationError(
      "OPENROUTER_API_KEY is not set. Provision it in Secret Manager and map it into the Cloud Run " +
      "service (or add it to .env locally) before calling the Studio generation router.",
      "missing_api_key", "openrouter",
    );
  }
  return key;
}

/** OpenRouter takes reference images as http(s) urls or base64 data urls. */
function toRefUrl(ref: ImageRef): string {
  return ref.kind === "url" ? ref.url : `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}`;
}

/** One AbortSignal combining the caller's cancel with our own timeout. */
function withTimeout(opts: ProviderOpts, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); },
  };
}

async function call(path: string, init: RequestInit, opts: ProviderOpts): Promise<any> {
  const { signal, done } = withTimeout(opts, opts.timeoutMs ?? httpTimeoutMs());
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        // OpenRouter attributes traffic with these; harmless if unset.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://nomila.co",
        "X-Title": "Nomila Studio",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 400);
      throw new GenerationError(`OpenRouter ${path} failed (${res.status}): ${body}`, "provider_error", "openrouter", res.status);
    }
    return await res.json();
  } catch (err: any) {
    if (err instanceof GenerationError) throw err;
    if (opts.signal?.aborted) throw new GenerationError("Generation aborted by caller", "aborted", "openrouter");
    if (err?.name === "AbortError" || /timeout/i.test(String(err?.message))) {
      throw new GenerationError(`OpenRouter ${path} timed out`, "timeout", "openrouter");
    }
    throw new GenerationError(`OpenRouter ${path} failed: ${err?.message ?? err}`, "provider_error", "openrouter");
  } finally {
    done();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Images ─────────────────────────────────────────────────────────────────────────────────────

async function generateImage(task: GenerationTask, inputs: GenerationInputs, model: string, opts: ProviderOpts): Promise<{ assets: GeneratedAsset[]; raw: any }> {
  if (task === "image.edit" && !inputs.references?.length) {
    throw new GenerationError("image.edit requires at least one reference image", "invalid_input", "openrouter");
  }
  const body: Record<string, unknown> = {
    model,
    prompt: inputs.prompt,
    ...(inputs.n && inputs.n !== 1 ? { n: inputs.n } : {}),
    ...(inputs.seed !== undefined ? { seed: inputs.seed } : {}),
    ...(inputs.aspectRatio ? { aspect_ratio: inputs.aspectRatio } : {}),
    ...(inputs.width && inputs.height ? { size: `${inputs.width}x${inputs.height}` } : {}),
    // Slot order, for the same reason the Vertex path does it — the prompt's reference manifest
    // numbers against this order. `toRefUrl` reads only kind/url/bytes, so `slot` and `label` order
    // the array and never reach the wire.
    ...(inputs.references?.length
      ? { input_references: orderBySlot(inputs.references).map((r) => ({ type: "image_url", image_url: { url: toRefUrl(r) } })) }
      : {}),
    // Nano Banana Pro REQUIRES a reasoning block — the request is rejected without one. Sent in the
    // generic `reasoning` form because that model does not accept `reasoning_effort`. A caller can
    // still override the effort (or disable it on a model where it is optional) via providerParams.
    ...(reasoningRequired(model) ? { reasoning: { enabled: true } } : {}),
    ...(opts.providerParams ?? {}),        // provider-specifics ride through untouched, and win
  };
  const json = await call("/images", { method: "POST", body: JSON.stringify(body) }, opts);
  const data = (json?.data ?? []) as Array<{ b64_json?: string; media_type?: string }>;
  const assets: GeneratedAsset[] = data
    .filter((d) => d.b64_json)
    .map((d) => ({
      bytes: Buffer.from(d.b64_json!, "base64"),
      mimeType: d.media_type ?? "image/png",
      width: inputs.width, height: inputs.height,
    }));
  if (!assets.length) throw new GenerationError("OpenRouter returned no image data", "provider_error", "openrouter");
  return { assets, raw: json };
}

// ─── Video (submit → poll → retrieve) ───────────────────────────────────────────────────────────

/**
 * ─── THE FIRST REFERENCE IS A FRAME, NOT A MOOD BOARD ──────────────────────────────────────────
 *
 * This request body has TWO image fields and they mean different things:
 *
 *   frame_images       "first or last frame images for IMAGE-TO-VIDEO". Entries carry
 *                      `frame_type: "first_frame" | "last_frame"`. THIS is the identity anchor.
 *   input_references   "style or content reference images for REFERENCE-TO-VIDEO". Soft guidance;
 *                      it does not pin a frame.
 *
 * Every reference used to go into `input_references`, so image-to-video on this provider was never
 * actually wired — her photograph arrived as a style hint and the model was free to draw someone
 * else. Nothing had noticed, because this path has never run: video routes to Veo on Vertex
 * (studio/config.ts), and Vertex has always done i2v correctly.
 *
 * The split below is what makes the two providers agree. `vertex.ts` reads `refParts[0]` and only
 * that as its first frame, so the FIRST reference by slot order becomes `frame_images[0]` here and
 * the rest stay style references. The same photograph anchors the clip either way, by construction
 * rather than by agreement — which is what lets a bake-off compare the MODELS rather than two
 * different meanings of the word "reference".
 *
 * Both fields may travel together. Per OpenRouter's video guide, "if both fields are provided,
 * `frame_images` takes precedence and the request is treated as image-to-video" — so extra
 * references can only soften the anchor, never replace it.
 *
 * Every video model in our registry advertises `supported_frame_images` (verified against
 * `GET /api/v1/videos/models` — veo-3.1, seedance-2.0, seedance-2.0-fast, kling-v3.0-std), so this
 * is unconditional. A model that did not would need a capability check here.
 *
 * ─── ② THE LAST FRAME, AND WHY IT IS A SEPARATE INPUT ──────────────────────────────────────────
 *
 * `supported_frame_images` is a LIST, and every model in the registry advertises both members:
 * `["first_frame", "last_frame"]` (re-read from `GET /api/v1/videos/models` on 2026-09-18 —
 * veo-3.1, all three kling v3 tiers, and the whole seedance family). Only the first was ever sent,
 * so a caller could pin where a clip STARTS and never where it ends.
 *
 * That second anchor is what a turn-and-return needs. With a first frame alone the model re-draws
 * her face from nothing on the way back and is free to draw a stranger; with a last frame it is
 * targeting a face it was handed. It is also the join a stitched sequence wants — clip N's last
 * frame and clip N+1's first frame being the same image is continuity by construction rather than
 * a crossfade papering over two different people.
 *
 * ⚠️ `inputs.lastFrame` IS NOT DRAWN FROM `references`, and that is the point. The references array
 * is slot-ordered and its FIRST member is the first frame; picking the last frame out of the same
 * array would make "how many references did you pass" silently change which image ends the clip.
 * They are two different questions, so they are two different inputs.
 */
function videoImageFields(inputs: GenerationInputs): Record<string, unknown> {
  const refs = orderBySlot(inputs.references ?? []);
  const asImage = (r: ImageRef) => ({ type: "image_url", image_url: { url: toRefUrl(r) } });

  // A last frame with no first is a legitimate request on this API (arrive here, from anywhere),
  // so the two are assembled independently rather than nesting the last inside a first-frame guard.
  const frames: Record<string, unknown>[] = [];
  const [first, ...rest] = refs;
  if (first) frames.push({ ...asImage(first), frame_type: "first_frame" });
  if (inputs.lastFrame) frames.push({ ...asImage(inputs.lastFrame), frame_type: "last_frame" });

  return {
    ...(frames.length ? { frame_images: frames } : {}),
    ...(rest.length ? { input_references: rest.map(asImage) } : {}),
  };
}

/**
 * ─── "unsigned_urls" IS A LIE, AND IT COST SEVEN PAID CLIPS ────────────────────────────────────
 *
 * OpenRouter returns finished videos in a field called `unsigned_urls`, which reads as "no
 * credential needed". It is not: the urls are `/api/v1/videos/{id}/content`, ordinary authenticated
 * API endpoints. A bare fetch gets 401.
 *
 * This adapter used to hand the url on undownloaded, with a note saying the caller streams it into
 * GCS. The caller is `storeAsset` (studio/generate.ts) → `rehostFromUrl` (lib/mediaStore.ts), which
 * fetches with NO headers — so on the OpenRouter path every clip would be generated, billed, and
 * then 401 on the way to storage. The V2 bake-off lost all seven of its billed Seedance clips that
 * way, and the only thing that ever downloaded one was a probe script carrying the bearer itself.
 *
 * ⚠️ THE FIX IS HERE AND NOT IN mediaStore. `lib/mediaStore.ts` is shared code used by paths that
 * have nothing to do with this provider; teaching it an OpenRouter bearer would spread one
 * provider's credential across the codebase. The adapter is the one place the credential is known,
 * so the adapter does the fetch. `storeAsset` prefers `bytes` over `url`, so returning bytes means
 * `rehostFromUrl` is never reached on this path and shared code needs no change at all.
 *
 * This also makes the two providers agree rather than diverge: `vertex.ts` already returns Veo's
 * `bytesBase64Encoded` as `bytes`, so buffering a clip is the existing house behaviour.
 *
 * ─── ⚠️ IT DEGRADES, IT DOES NOT THROW ─────────────────────────────────────────────────────────
 *
 * `studio/router.ts` writes the cost line ONLY on success, and its comment reasons about IMAGES,
 * where OpenRouter bills all-or-nothing so a throw costs nothing. FOR VIDEO THAT IS FALSE: the clip
 * is billed at completion, so throwing here — after the money has moved — would lose the clip AND
 * the record of having paid for it. That is precisely the V2 failure.
 *
 * So a failed download returns no bytes instead of raising. The router then logs the spend with the
 * url as `outputRef`, and the job fails downstream at storage with the money on the record and the
 * url recoverable by hand. Worse than a successful download; far better than a silent loss.
 */
async function downloadClip(url: string, jobId: string, opts: ProviderOpts): Promise<{ bytes?: Buffer }> {
  // ONLY to the provider's own host. A completed job could name a CDN we do not control, and our
  // API key must never follow a url off OpenRouter — the same rule fal.ts applies to references.
  const ours = /^https:\/\/openrouter\.ai\//i.test(url);
  // A REAL AbortSignal, not a Promise.race — the same `withTimeout` every other call here uses, so
  // the download is bounded AND a caller's cancel reaches it (`opts.signal` is the SSE stream's).
  // A race would satisfy the timeout and leave the loser streaming a clip nobody is waiting for,
  // holding its buffer until the process exits. On Cloud Run that memory is not free.
  const { signal, done } = withTimeout(opts, opts.timeoutMs ?? httpTimeoutMs());
  try {
    const res = await fetch(url, { signal, ...(ours ? { headers: { Authorization: `Bearer ${apiKey()}` } } : {}) });
    if (!res.ok) {
      logger.error(
        { jobId, status: res.status, outputRef: url.split("?")[0] },
        "clip was generated and BILLED, but the download failed — the url is on the cost log line; " +
        "fetch it by hand rather than re-running, which buys a second copy",
      );
      return {};
    }
    return { bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    // The MESSAGE, never the error object — a serialized fetch error can carry a url whose query
    // string is a credential (the rule costLog.safeRef follows).
    logger.error(
      { jobId, outputRef: url.split("?")[0], error: err instanceof Error ? err.message : String(err) },
      "clip was generated and BILLED, but the download threw — fetch the url by hand, do not re-run",
    );
    return {};
  } finally {
    done();
  }
}

/**
 * ─── SUBMIT AND POLL ARE SEPARATE BECAUSE A HANDLE HAS TO BE PERSISTED BETWEEN THEM ────────────
 *
 * `generateVideo` below still composes the two and is what every inline caller uses. The detached
 * runner (studio/videoRunner.ts) cannot use it: its whole design is submit ONCE, write the handle
 * to the job row, and let any later tick — on any instance, after any restart — resume polling THAT
 * handle. A call that submits and polls in one breath has no seam to persist, so an instance that
 * died mid-poll would come back and buy a second copy of a clip already paid for.
 *
 * `vertex.ts` already has exactly this split (`submitVideoOperation` / `pollVideoOperation`) and
 * these mirror its signatures deliberately, so the runner can hold the two providers in one shape
 * rather than special-casing either.
 *
 * THE HANDLE IS OpenRouter's JOB ID, which is what `GET /api/v1/videos/{id}` takes. Vertex's is an
 * operation name. Neither is parsed by the runner — it stores the string and hands it back.
 */
export async function submitVideoOperation(inputs: GenerationInputs, model: string, opts: ProviderOpts): Promise<string> {
  const submitted = await call("/videos", { method: "POST", body: JSON.stringify(videoBody(inputs, model, opts)) }, opts);
  const jobId = submitted?.id;
  if (!jobId) throw new GenerationError("OpenRouter video submit returned no job id", "provider_error", "openrouter");
  return jobId;
}

/** Resume from a handle — the same loop `generateVideo` runs, entered with the job id already known. */
export async function pollVideoOperation(
  jobId: string, model: string, inputs: GenerationInputs, opts: ProviderOpts,
): Promise<{ assets: GeneratedAsset[]; jobId: string; raw: any }> {
  const started = Date.now();
  const poll     = videoPoll();
  const interval = opts.pollIntervalMs ?? poll.intervalMs;
  const maxMs    = opts.maxPollMs ?? poll.maxMs;
  opts.onProgress?.({ status: "pending", jobId, elapsedMs: 0 });

  for (;;) {
    if (opts.signal?.aborted) throw new GenerationError("Generation aborted by caller", "aborted", "openrouter");
    if (Date.now() - started > maxMs) {
      throw new GenerationError(`Video job ${jobId} unfinished after ${Math.round(maxMs / 1000)}s`, "timeout", "openrouter");
    }
    await sleep(interval);
    const job = await call(`/videos/${encodeURIComponent(jobId)}`, { method: "GET" }, opts);
    const status = job?.status;
    opts.onProgress?.({ status: status ?? "unknown", jobId, elapsedMs: Date.now() - started });

    if (status === "failed") {
      // ⚠️ THIS IS THE DOOR SEEDANCE'S REFUSAL COMES THROUGH, and until now it came through as an
      //    ordinary provider error. `InputImageSensitiveContentDetected.PrivacyInformation` — a
      //    stated BytePlus policy that answered real-person image-to-video 6 times out of 6
      //    (docs/probes/kling-moderation.md §1) — is an input rejection, and re-sending the same
      //    frame buys the same "no". The classifier reads the provider's own string and says so.
      const why = typeof job?.error === "string" ? job.error : JSON.stringify(job?.error ?? null);
      throw new GenerationError(
        `Video job ${jobId} failed: ${job?.error ?? "no reason given"}`,
        refusalCodeFor({ message: why }),
        "openrouter",
      );
    }
    if (status === "completed") {
      const urls = (job?.unsigned_urls ?? []) as string[];
      if (!urls.length) throw new GenerationError(`Video job ${jobId} completed with no output url`, "provider_error", "openrouter");
      const assets: GeneratedAsset[] = await Promise.all(urls.map(async (url) => ({
        // The url is KEPT beside the bytes, never replaced by them. studio/costLog records it as
        // `outputRef` (stripped of its query string), and it is the only handle anyone has on a
        // clip that was billed and then failed to store.
        url,
        ...(await downloadClip(url, jobId, opts)),
        mimeType: "video/mp4",
        width: inputs.width, height: inputs.height, durationSeconds: inputs.durationSeconds,
      })));
      return { assets, jobId, raw: job };
    }
  }
}

/** Submit and wait — the inline shape, unchanged for every caller that already had it. */
async function generateVideo(inputs: GenerationInputs, model: string, opts: ProviderOpts): Promise<{ assets: GeneratedAsset[]; jobId: string; raw: any }> {
  const jobId = await submitVideoOperation(inputs, model, opts);
  return pollVideoOperation(jobId, model, inputs, opts);
}

/** The request body, shared by the composed call and the runner's submit. */
function videoBody(inputs: GenerationInputs, model: string, opts: ProviderOpts): Record<string, unknown> {
  return {
    model,
    prompt: inputs.prompt,
    ...(inputs.durationSeconds ? { duration: inputs.durationSeconds } : {}),
    ...(inputs.aspectRatio ? { aspect_ratio: inputs.aspectRatio } : {}),
    ...(inputs.width && inputs.height ? { size: `${inputs.width}x${inputs.height}` } : {}),
    ...(inputs.seed !== undefined ? { seed: inputs.seed } : {}),
    ...videoImageFields(inputs),
    ...(opts.providerParams ?? {}),
    // ─── AUDIO: SEEDANCE MAY ASK, NOTHING ELSE MAY — AND THIS LINE STAYS BELOW providerParams ───
    //
    // OpenRouter's video guide: `generate_audio` "defaults to true for models that support audio
    // output". kling-v3.0-std advertises audio and quotes 0.126/s with it against 0.084/s without,
    // while studio/config.ts prices it FLAT at 0.084 — so an unset flag bought the dearer arm and
    // the pre-generation quote under-quoted by 50%, which is the one direction that check exists
    // to prevent.
    //
    // MEASURED 2026-09-19 (docs/probes/kling-moderation.md §5): four real cells sent this flag and
    // all four invoiced $0.5040 = 6s × $0.084 — the audio-off arm exactly, on the first Kling
    // invoice anyone has seen from this account. So the flag is honoured and the existing flat
    // price is TRUE once it is sent.
    //
    // ⚠️ STILL DELIBERATELY BELOW THE SPREAD, and still an exception to "provider-specifics ride
    // through untouched, and win". A caller who could flip this through `providerParams` would move
    // the WIRE to the 0.126/s arm while pricing still quoted 0.084/s. The carve-out below is not
    // that: it is keyed to the MODEL, so no `providerParams` value can open it for Kling.
    generate_audio: seedanceAudio(model, opts),
  };
}

/**
 * The models whose audio is FREE, and therefore the only ones allowed to ask for it.
 *
 * Seedance is priced `per_video_token` (config.ts) and its published `video_tokens_without_audio`
 * equals its `video_tokens` — so there is no audio arm to buy and no quote to move. `wantsAudio` in
 * studio/pricing is consulted only inside `case "per_second"`, which Seedance never reaches, so
 * turning this on cannot change a Seedance figure by a cent.
 *
 * ⚠️ KLING IS EXCLUDED BY THE MODEL, NOT BY THE CALLER, and that is the whole design. Kling bills
 * 0.126/s with audio against the flat 0.084/s in our table, which has no `usdWithAudio` key — so
 * audio there is a 50% under-quote until the price moves. Audio and its price are one decision;
 * until Kling's price grows a second arm, this set is the thing that must not grow.
 */
const SEEDANCE_AUDIO_MODELS = new Set<string>([MODELS.seedance, MODELS.seedanceFast]);

/**
 * Read from the SAME key pricing reads — `providerParams.parameters.generateAudio` — so the arm the
 * quote priced and the arm the wire buys cannot disagree. The planner is the only thing that sets
 * it (studio/preview `plannedInputs`), off the frozen brief.
 */
function seedanceAudio(model: string, opts: ProviderOpts): boolean {
  if (!SEEDANCE_AUDIO_MODELS.has(model)) return false;
  const params = opts.providerParams?.parameters as
    | { generateAudio?: unknown }
    | undefined;
  return params?.generateAudio === true;
}

// ─── Adapter ────────────────────────────────────────────────────────────────────────────────────

export const openrouterAdapter: GenerationAdapter = {
  name: "openrouter",

  supports: (task) => task === "image.generate" || task === "image.edit" || task === "video.generate",

  // The detached pair the video runner needs. Same two functions `generateVideo` composes, exposed
  // so a handle can be persisted between them.
  video: { submit: submitVideoOperation, poll: pollVideoOperation },

  // `opts` is WITHHELD from pricing here, deliberately — this is not the dropped-opts bug the vertex
  // adapter carries a note about. estimateCost reads the cheaper no-audio video SKU off
  // `providerParams.parameters.generateAudio`, and that key is the verified VERTEX wire field. On this
  // provider it buys nothing: the audio field name is unverified, and generateVideo spreads
  // providerParams at the TOP level of the body rather than under `parameters`. Honouring the flag
  // here would quote $0.20/s while OpenRouter very likely still generates audio and bills $0.40/s —
  // an UNDER-quote, which is the one failure the pre-generation check exists to prevent. So the flag
  // never reaches pricing on this path and every Veo quote lands on the audio arm. Over-quoting is
  // the safe direction. Vertex is the default video provider, so the cheap arm still applies wherever
  // video actually runs; this only affects the STUDIO_VIDEO_PROVIDER=openrouter flip.
  //
  // To close it properly: verify OpenRouter's audio field on /api/v1/videos, send it in generateVideo,
  // and pass opts through here — at which point the two paths agree again.
  estimate: (_task, inputs, model) => estimateCost(inputs, model),

  async generate(task, inputs, model, opts) {
    const startedAt = new Date();
    // Same withholding as `estimate` above — this figure is logged as spend when the provider reports
    // no cost of its own, so it must not be the optimistic one either.
    const fallback = estimateCost(inputs, model);

    const out: { assets: GeneratedAsset[]; raw: any; jobId?: string } = task === "video.generate"
      ? await generateVideo(inputs, model, opts)
      : await generateImage(task, inputs, model, opts);

    const completedAt = new Date();
    const result: GenerationResult = {
      task, provider: "openrouter", model,
      assets: out.assets,
      cost: reportedCost((out.raw as { usage?: unknown } | null)?.usage, fallback),
      jobId: out.jobId,
      timings: { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), ms: completedAt.getTime() - startedAt.getTime() },
      raw: out.raw,
    };
    logger.info(
      { task, model, assets: result.assets.length, costUsd: result.cost.amountUsd, basis: result.cost.basis, ms: result.timings.ms },
      "generation complete",
    );
    return result;
  },
};
