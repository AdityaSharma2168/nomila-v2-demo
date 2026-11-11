/**
 * vertex adapter — Nano Banana (image) and Veo (video) consumed DIRECTLY from Vertex, so they bill
 * against GCP credits instead of per-call OpenRouter spend.
 *
 * AUTH is the existing one, not a new one: `GoogleAuth` with the cloud-platform scope and a cached
 * access token, exactly as server/lib/mediaEmbed.ts and server/lib/kimi.ts already do, on the same
 * ADC that the Mila voice loop's Vertex client uses (server/mila/gemini.ts). No key, no new SA.
 *
 * WIRE SHAPES BELOW WERE VERIFIED AGAINST THE LIVE PROJECT on 2026-08-27, not assumed:
 *
 *   IMAGE (Nano)  POST {global}/publishers/google/models/{m}:generateContent
 *     body    { contents:[{role,parts:[…]}], generationConfig:{ responseModalities:["TEXT","IMAGE"],
 *               imageConfig:{ aspectRatio } } }
 *     result  candidates[0].content.parts[].inlineData.{ mimeType, data(base64) }
 *     usage   usageMetadata.candidatesTokensDetails[modality=IMAGE].tokenCount  (+ thoughtsTokenCount)
 *     NOTE    gemini-3-pro-image and gemini-3.1-flash-image resolve ONLY in the `global` location;
 *             us-central1 returns 404 for both. Reasoning happens implicitly here — unlike the
 *             OpenRouter path there is no `reasoning` block to send.
 *     RATIO   generationConfig.imageConfig.aspectRatio — NOT verified against the live project like
 *             the shapes above, but read off the request builder in the @google/genai version this
 *             repo already depends on (2.7.0): generateContentParametersToVertex puts the config
 *             under `generationConfig`, generateContentConfigToVertex puts `imageConfig` inside it,
 *             and imageConfigToVertex emits `aspectRatio`. Google's own client sends exactly this
 *             body to this endpoint. Accepted values include the three the planner emits — 4:5
 *             (post, carousel), 9:16 (story, reel) and 1:1 (ad).
 *
 *   VIDEO (Veo)   POST {us-central1}/publishers/google/models/{m}:predictLongRunning
 *     body    { instances:[{prompt}], parameters:{ durationSeconds, aspectRatio, sampleCount, generateAudio } }
 *     result  { name: "…/operations/<uuid>" }
 *     poll    POST …/{m}:fetchPredictOperation   body { operationName }
 *             → { done, response:{ videos:[{ bytesBase64Encoded, mimeType }], raiMediaFilteredCount } }
 *     NOTE    Veo is us-central1, NOT global — the opposite of the image models. Video comes back as
 *             base64 bytes; pass parameters.storageUri via providerParams to have Vertex write to GCS
 *             and return gcsUri instead (better for anything long).
 *
 * Vertex reports token usage but never a dollar figure, so cost stays basis:"estimated" — computed
 * from the ACTUAL returned token counts rather than the config assumption, which makes it far
 * tighter than a pre-generation guess.
 */
import { GoogleAuth } from "google-auth-library";
import { safeFetch } from "../../lib/safeFetch";
import { createLogger } from "../../logger";
import { httpTimeoutMs, videoPoll, priceFor, vertexLocationFor } from "../config";
import { estimateCost } from "../pricing";
import { orderBySlot } from "../refOrder";
import { describeReasons, refusalCodeFor } from "../refusal";
import {
  GenerationError,
  type CostEstimate, type GenerationAdapter, type GenerationInputs, type GenerationResult,
  type GenerationTask, type GeneratedAsset, type ImageRef, type ProviderOpts,
} from "../types";

const logger = createLogger("studio/vertex");

const project = () => process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

// Same cached-token pattern as lib/mediaEmbed.ts — trust the credential's real expiry, refresh 5 min early.
let _token = "";
let _exp = 0;
async function token(): Promise<string> {
  if (Date.now() > _exp - 300_000) {
    const c = await auth.getClient();
    const { token: t } = await c.getAccessToken();
    if (!t) throw new GenerationError("Vertex ADC returned no access token", "missing_api_key", "vertex");
    _token = t;
    const e = (c as { credentials?: { expiry_date?: number } }).credentials?.expiry_date;
    _exp = e ?? Date.now() + 3_300_000;
  }
  return _token;
}

const host = (loc: string) => (loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`);
const modelUrl = (loc: string, model: string, method: string) =>
  `https://${host(loc)}/v1/projects/${project()}/locations/${loc}/publishers/google/models/${model}:${method}`;

function combinedSignal(opts: ProviderOpts, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); } };
}

async function post(url: string, body: unknown, opts: ProviderOpts): Promise<any> {
  const { signal, done } = combinedSignal(opts, opts.timeoutMs ?? httpTimeoutMs());
  try {
    const res = await fetch(url, {
      method: "POST", signal,
      headers: {
        Authorization: `Bearer ${await token()}`,
        "Content-Type": "application/json",
        // ADC user credentials carry no quota project of their own; without this the request is
        // billed to gcloud's default project and fails SERVICE_DISABLED. Harmless on Cloud Run,
        // where the runtime SA already belongs to the project.
        "x-goog-user-project": project(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      throw new GenerationError(`Vertex ${url.split("/").pop()} failed (${res.status}): ${text}`, "provider_error", "vertex", res.status);
    }
    return await res.json();
  } catch (err: any) {
    if (err instanceof GenerationError) throw err;
    if (opts.signal?.aborted) throw new GenerationError("Generation aborted by caller", "aborted", "vertex");
    if (err?.name === "AbortError" || /timeout/i.test(String(err?.message))) {
      throw new GenerationError("Vertex request timed out", "timeout", "vertex");
    }
    throw new GenerationError(`Vertex request failed: ${err?.message ?? err}`, "provider_error", "vertex");
  } finally {
    done();
  }
}

/**
 * Vertex takes reference images as inline base64 parts. It will accept a `fileData.fileUri` only for
 * a gs:// URI — a signed https URL is NOT accepted — so a url reference is fetched to bytes here.
 * That is the one real behavioural difference from the OpenRouter path, which takes urls directly.
 */
async function toInlinePart(ref: ImageRef, opts: ProviderOpts): Promise<{ inlineData: { mimeType: string; data: string } }> {
  if (ref.kind === "bytes") {
    return { inlineData: { mimeType: ref.mimeType, data: ref.bytes.toString("base64") } };
  }
  if (ref.url.startsWith("gs://")) {
    throw new GenerationError("gs:// references must be passed via providerParams.fileData, not references[]", "invalid_input", "vertex");
  }
  const { signal, done } = combinedSignal(opts, opts.timeoutMs ?? httpTimeoutMs());
  try {
    // A reference url is a signed storage url today, but it is a url a caller handed us — safeFetch (PR 7,
    // Lane F2): https only, never an internal address, every redirect hop checked and pinned.
    const res = await safeFetch(ref.url, { signal });
    if (!res.ok) throw new GenerationError(`Could not fetch reference image (${res.status})`, "invalid_input", "vertex");
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    return { inlineData: { mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
  } finally {
    done();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Image (Nano) ───────────────────────────────────────────────────────────────────────────────

async function generateImage(task: GenerationTask, inputs: GenerationInputs, model: string, opts: ProviderOpts) {
  if (task === "image.edit" && !inputs.references?.length) {
    throw new GenerationError("image.edit requires at least one reference image", "invalid_input", "vertex");
  }
  // ORDERED BY SLOT, not by however the caller stacked the array. The prompt's reference manifest
  // numbers its lines against this same order (studio/refOrder.ts explains why that has to hold),
  // so a mood board can never occupy the position the manifest describes as her likeness.
  const refParts = await Promise.all(orderBySlot(inputs.references ?? []).map((r) => toInlinePart(r, opts)));
  // Pulled out because imageConfig has to be merged one level deeper than the rest of
  // generationConfig — see the aspectRatio note below.
  const callerConfig = (opts.providerParams?.generationConfig ?? {}) as { imageConfig?: object };
  const body = {
    contents: [{ role: "user", parts: [...refParts, { text: inputs.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      ...(inputs.seed !== undefined ? { seed: inputs.seed } : {}),
      ...callerConfig,
      // Aspect ratio for an IMAGE rides in generationConfig.imageConfig — NOT the top-level
      // `parameters.aspectRatio` that Veo takes below. The two models take the same concept in
      // different places, so this is deliberately not shared with generateVideo.
      //
      // Merged AFTER callerConfig, but with the caller's own imageConfig spread last inside it, so
      // a caller setting a sibling knob (imageSize, personGeneration) keeps the planned ratio
      // instead of silently replacing the whole object — while an explicit aspectRatio still wins.
      ...(inputs.aspectRatio || callerConfig.imageConfig
        ? {
            imageConfig: {
              ...(inputs.aspectRatio ? { aspectRatio: inputs.aspectRatio } : {}),
              ...(callerConfig.imageConfig ?? {}),
            },
          }
        : {}),
    },
    ...Object.fromEntries(Object.entries(opts.providerParams ?? {}).filter(([k]) => k !== "generationConfig")),
  };
  const json = await post(modelUrl(vertexLocationFor(model), model, "generateContent"), body, opts);

  const parts = (json?.candidates?.[0]?.content?.parts ?? []) as Array<{ inlineData?: { mimeType?: string; data?: string } }>;
  const assets: GeneratedAsset[] = parts
    .filter((p) => p.inlineData?.data)
    .map((p) => ({
      bytes: Buffer.from(p.inlineData!.data!, "base64"),
      mimeType: p.inlineData!.mimeType ?? "image/png",
      width: inputs.width, height: inputs.height,
    }));
  if (!assets.length) {
    const finish = json?.candidates?.[0]?.finishReason;
    throw new GenerationError(`Vertex returned no image data${finish ? ` (finishReason ${finish})` : ""}`, "provider_error", "vertex");
  }
  return { assets, raw: json };
}

/** Cost from the tokens Vertex actually reported — tighter than the pre-generation assumption. */
function costFromUsage(usage: any, model: string, fallback: CostEstimate): CostEstimate {
  const price = priceFor(model);
  if (!price || price.unit !== "per_image_token") return fallback;
  const imageTokens = (usage?.candidatesTokensDetails ?? [])
    .filter((d: { modality?: string }) => d.modality === "IMAGE")
    .reduce((s: number, d: { tokenCount?: number }) => s + (d.tokenCount ?? 0), 0);
  if (!imageTokens) return fallback;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  // The INPUT side, recorded but not priced. Reference images are the primary input to a generation
  // now, and this is the only place a real number for them exists — Vertex reports what the prompt
  // actually cost in tokens. It is NOT folded into the figure: the input token RATE for these models
  // is not one we have verified, and inventing one to make the arithmetic look complete is the exact
  // move studio/pricing exists to prevent. Logged so the rate can be CALIBRATED from real runs, the
  // way tokensPerImage was measured rather than guessed.
  const promptTokens = usage?.promptTokenCount ?? 0;
  return {
    amountUsd: Math.round(price.usdPerToken * imageTokens * 1e4) / 1e4,
    currency: "USD", basis: "estimated",
    detail:
      `${imageTokens} actual image tokens × $${price.usdPerToken}/tok` +
      (thoughts ? ` (+${thoughts} reasoning tokens, billed separately)` : "") +
      (promptTokens ? ` (+${promptTokens} input tokens incl. references, billed separately and not priced here)` : "") +
      " — Vertex reports tokens, not dollars",
  };
}

// ─── Video (Veo, async LRO) ─────────────────────────────────────────────────────────────────────

/**
 * SUBMIT ONLY — hand Veo the job and return its operation handle, without waiting for it.
 *
 * Split out of `generateVideo` for the detached runner (studio/videoRunner.ts). A runner that takes
 * over a job whose previous holder died must be able to RESUME POLLING an operation someone else
 * submitted, and that is impossible while submit and poll are one function: the only way to reach
 * the poll loop would be to submit again, which buys a second copy of a video already paid for.
 *
 * The caller is responsible for persisting the returned name before anything else can go wrong with
 * it — see the submit-once pair in studio/videoJobs.ts.
 */
export async function submitVideoOperation(inputs: GenerationInputs, model: string, opts: ProviderOpts): Promise<string> {
  const loc = vertexLocationFor(model);
  // Same ordering rule as the image path. It matters more here, not less: Veo reads only
  // `refParts[0]` as its first frame, so whichever reference sorts first is the ONLY one that
  // reaches the model at all — and the slot order puts the frame, then her likeness, ahead of a
  // mood board rather than leaving it to array position.
  const refParts = await Promise.all(orderBySlot(inputs.references ?? []).map((r) => toInlinePart(r, opts)));
  // ─── ⚠️  `inputs.lastFrame` IS NOT SENT, AND WIRING IT IS NOT JUST A FIELD ────────────────────
  //
  // This builds `instances[0] = { prompt, image }` and stops. `GenerationInputs.lastFrame` may now be
  // SET — studio/preview.ts fills it from `PreviewOptions.lastFrameRef` and resolves it (V10 card 1)
  // — so a last frame can reach this function and is silently dropped here.
  //
  // Nothing is broken by that today, because nothing routes a last frame here: `plannedInputs` makes
  // any clip carrying one a `transition`, and `videoRouteFor("transition")` sends it to Kling over
  // OpenRouter, whose adapter does consume it. THAT PRECEDENCE IS FORCED RATHER THAN CHOSEN, and this
  // is the line that forces it — a transition arriving on the Veo arm would lose its destination here
  // and bill an ordinary image-to-video clip under a bridge's name.
  //
  // ⚠️ SO WHOEVER ADDS IT MUST ALSO REOPEN THAT PRECEDENCE. The moment this arm can carry a last
  // frame, "a last frame means Kling" stops being a constraint and becomes a real Veo-vs-Kling choice
  // — different price ($0.20/s against $0.084/s), different identity behaviour, and no measurement
  // yet comparing them ON A BRIDGE. The probe that exists measured Kling alone
  // (docs/probes/kling-first-last.md). Pick it deliberately in studio/preview.ts's shot-type
  // selection; do not let it fall out of whichever branch happens to be written first.
  //
  // And check the capability before the code: "Veo 3.1 takes a last frame" is asserted in the V9
  // plan and has NO recorded read behind it, unlike OpenRouter's registry (re-read 2026-09-18).
  const body = {
    instances: [{
      prompt: inputs.prompt,
      // Veo takes a first-frame image as `image`, not as a contents part.
      ...(refParts[0] ? { image: { bytesBase64Encoded: refParts[0].inlineData.data, mimeType: refParts[0].inlineData.mimeType } } : {}),
    }],
    parameters: {
      ...(inputs.durationSeconds ? { durationSeconds: inputs.durationSeconds } : {}),
      ...(inputs.aspectRatio ? { aspectRatio: inputs.aspectRatio } : {}),
      sampleCount: inputs.n ?? 1,
      ...(inputs.seed !== undefined ? { seed: inputs.seed } : {}),
      ...((opts.providerParams?.parameters as object) ?? {}),
    },
  };
  const submitted = await post(modelUrl(loc, model, "predictLongRunning"), body, opts);
  const operationName = submitted?.name;
  if (!operationName) throw new GenerationError("Vertex predictLongRunning returned no operation name", "provider_error", "vertex");
  return operationName as string;
}

/**
 * POLL ONLY — wait on an operation someone already submitted, whoever that was.
 *
 * Takes the operation name rather than deriving it, so this is reachable both by `generateVideo`
 * (which just submitted) and by a runner resuming another instance's work after a lease handoff.
 * `inputs` is read only for the dimensions stamped onto the returned assets.
 */
export async function pollVideoOperation(
  operationName: string, model: string, inputs: GenerationInputs, opts: ProviderOpts,
): Promise<{ assets: GeneratedAsset[]; jobId: string; raw: unknown }> {
  const loc = vertexLocationFor(model);
  const started = Date.now();
  const poll = videoPoll();
  const interval = opts.pollIntervalMs ?? poll.intervalMs;
  const maxMs = opts.maxPollMs ?? poll.maxMs;
  opts.onProgress?.({ status: "pending", jobId: operationName, elapsedMs: 0 });

  for (;;) {
    if (opts.signal?.aborted) throw new GenerationError("Generation aborted by caller", "aborted", "vertex");
    if (Date.now() - started > maxMs) {
      throw new GenerationError(`Veo operation unfinished after ${Math.round(maxMs / 1000)}s`, "timeout", "vertex");
    }
    await sleep(interval);
    const op = await post(modelUrl(loc, model, "fetchPredictOperation"), { operationName }, opts);
    opts.onProgress?.({ status: op?.done ? "completed" : "in_progress", jobId: operationName, elapsedMs: Date.now() - started });

    // ⚠️ THE CODE IS READ, NOT JUST THE MESSAGE. `op.error` is a google.rpc.Status, and its
    //    status/code says whether re-submitting these exact bytes could ever work — which is the
    //    difference between a job worth retrying and one that would buy the same "no" twice.
    //    studio/refusal.ts owns that decision; this hands it what the wire carried.
    if (op?.error) {
      const code = refusalCodeFor({
        message: op.error.message ?? null,
        status: op.error.status ?? null,
        code: typeof op.error.code === "number" ? op.error.code : null,
      });
      throw new GenerationError(
        `Veo operation failed: ${op.error.message ?? "no reason given"}`,
        code,
        "vertex",
      );
    }
    if (!op?.done) continue;

    const videos = (op?.response?.videos ?? []) as Array<{ bytesBase64Encoded?: string; gcsUri?: string; mimeType?: string }>;
    if (!videos.length) {
      const filtered = op?.response?.raiMediaFilteredCount;
      // The REASONS were never read until now — only the count was — so a filtered clip's stated
      // cause reached no log and no job row. They are provider prose: reported, capped, and never
      // parsed for meaning (studio/refusal.ts).
      const reasons = (op?.response?.raiMediaFilteredReasons ?? null) as string[] | null;
      const code = refusalCodeFor({
        filteredCount: typeof filtered === "number" ? filtered : null,
        filteredReasons: reasons,
        completedEmpty: true,
      });
      const why = describeReasons(reasons);
      throw new GenerationError(
        filtered
          ? `Veo returned no video — ${filtered} output(s) filtered by safety${why ? ` (${why})` : ""}`
          : "Veo operation completed with no video",
        code, "vertex",
      );
    }
    const assets: GeneratedAsset[] = videos.map((v) => ({
      ...(v.gcsUri ? { url: v.gcsUri } : {}),
      ...(v.bytesBase64Encoded ? { bytes: Buffer.from(v.bytesBase64Encoded, "base64") } : {}),
      mimeType: v.mimeType ?? "video/mp4",
      width: inputs.width, height: inputs.height, durationSeconds: inputs.durationSeconds,
    }));
    return { assets, jobId: operationName, raw: op };
  }
}

/**
 * Submit and wait — the inline shape, unchanged for every caller that already had it. Now just the
 * two halves above, composed.
 */
async function generateVideo(inputs: GenerationInputs, model: string, opts: ProviderOpts) {
  const operationName = await submitVideoOperation(inputs, model, opts);
  return pollVideoOperation(operationName, model, inputs, opts);
}

// ─── Adapter ────────────────────────────────────────────────────────────────────────────────────

export const vertexAdapter: GenerationAdapter = {
  name: "vertex",

  supports: (task: GenerationTask) => task === "image.generate" || task === "image.edit" || task === "video.generate",

  // The detached pair the video runner needs — the two halves `generateVideo` already composed.
  video: { submit: submitVideoOperation, poll: pollVideoOperation },

  // opts is threaded in because it carries providerParams, and providerParams selects the video SKU
  // (parameters.generateAudio) — which is to say it selects the price. Dropping it here is what made
  // a silent Veo clip quote at 2x its real cost.
  estimate: (_task, inputs, model, opts) => estimateCost(inputs, model, opts),

  async generate(task, inputs, model, opts) {
    const startedAt = new Date();
    const fallback = estimateCost(inputs, model, opts);

    const out: { assets: GeneratedAsset[]; raw: any; jobId?: string } = task === "video.generate"
      ? await generateVideo(inputs, model, opts)
      : await generateImage(task, inputs, model, opts);

    const completedAt = new Date();
    const cost = task === "video.generate" ? fallback : costFromUsage(out.raw?.usageMetadata, model, fallback);
    const result: GenerationResult = {
      task, provider: "vertex", model,
      assets: out.assets,
      cost,
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
