/**
 * fal adapter — SAM-3 segmentation, consumed as `image.segment`.
 *
 * The only adapter in this directory that does not make a picture. It takes ONE image and ONE
 * concrete noun and returns a binary PNG mask of that thing, which studio/composite.ts uses as the
 * alpha of a paste-back so an edit changes a garment's SHAPE rather than its bounding rectangle.
 *
 * ─── ① THE IMAGE GOES AS A DATA URI. THIS IS A PRIVACY DECISION, NOT A TRANSPORT ONE ────────────
 *
 * fal's API accepts `image_url` as either a fetchable URL or a `data:` URI. We send the bytes.
 *
 * The alternative — handing over the signed GCS url we already have — is one line shorter and is
 * the thing we are refusing. A signed url is a FETCHABLE LINK TO AN ATHLETE'S PHOTOGRAPH held by a
 * third party for the life of the signature: retriable, loggable on their side, and outside our
 * control the moment it is sent. A data URI is the same pixels with none of that afterlife.
 *
 * ⚠️ THIS IS ENFORCED BY THE TYPE, NOT BY CONVENTION, and the difference is the point. `ImageRef` is
 * a union of `{kind:"url"}` and `{kind:"bytes"}`; this adapter REFUSES the url arm outright rather
 * than resolving it. A future caller cannot reintroduce the leak by passing the reference it
 * happens to be holding — the refusal is a type the compiler already knows about and a throw the
 * tests already pin. Do not add a fetch-and-inline branch here to "support both": the whole value of
 * this function is that there is no path from a signed url to fal.
 *
 * ─── ② WHY THIS IS A ROUTER ADAPTER AND NOT A MODULE OFF TO ONE SIDE ────────────────────────────
 *
 * studio/autoMask.ts calls Gemini directly, so there is a precedent for a vision call outside the
 * router, and it would have been less ceremony to follow it. It is the wrong precedent for this
 * call. Segmentation SPENDS — flat $0.005, small but real and multiplied by the crop count — and
 * every other paid call in this feature is counted by studio/router.ts on its way through. Going
 * around the router would make this the one generation in the product that bills without appearing
 * in the cost log, which is exactly the thing the log exists to make impossible.
 *
 * The generation shape fits without being stretched: `inputs.prompt` is the garment noun (and the
 * router's own validate() already refuses an empty one), `references[0]` is the crop, and
 * `assets[0].bytes` is the mask.
 *
 * ─── ③ WIRE SHAPE ──────────────────────────────────────────────────────────────────────────────
 *
 *   POST https://fal.run/fal-ai/sam-3/image        (SYNCHRONOUS — see the note on SYNC_BASE)
 *   headers  Authorization: Key <FAL_KEY>
 *   body     { image_url: "data:image/png;base64,…", prompt: "<noun>", apply_mask: false }
 *   result   { masks: [{ url | content, ... }], ... }
 *
 * `apply_mask: false` is what makes the response a MASK rather than a cut-out of the original with
 * the background removed. We want the alpha, not the pixels — compositing the provider's cut-out
 * would paste its idea of the garment's colour over the athlete's own photograph.
 *
 * ⚠️ THE RESPONSE SHAPE IS READ DEFENSIVELY AND ON PURPOSE. Unlike the Vertex shapes in vertex.ts,
 * which carry a "verified against the live project" date, this one is written from fal's published
 * schema and the probe runs — it has NOT been pinned here against a live response. So `maskFrom`
 * accepts the several shapes fal uses across its image endpoints (a url, an inline data uri, a bare
 * base64 string) and returns null rather than guessing when it recognises none. A null mask is a
 * clean fallback to the rectangle, which is the whole reason this feature can afford to be
 * uncertain here. If you pin the shape against a live response, record the date the way vertex.ts
 * does and narrow this.
 */
import { createLogger } from "../../logger";
import { segmentTimeoutMs } from "../config";
import { estimateCost } from "../pricing";
import {
  GenerationError,
  type CostEstimate, type GenerationAdapter, type GenerationResult,
  type GenerationTask, type GeneratedAsset, type ImageRef,
} from "../types";

const logger = createLogger("studio/fal");

/**
 * The SYNCHRONOUS host, not `queue.fal.run`.
 *
 * fal serves both: a queue API (submit → poll status → fetch result) and a synchronous one that
 * blocks and returns the result. Segmentation ran 1-3s in the probes, which is inside any sane HTTP
 * budget, and the queue form would add two round trips and a poll loop to save nothing. Video needs
 * a queue; a 2-second mask does not. If a future fal model on this adapter is slow enough to need
 * the queue, that is a second code path, not a change to this one.
 */
const SYNC_BASE = () => process.env.FAL_BASE_URL ?? "https://fal.run";

function key(): string {
  const k = process.env.FAL_KEY?.trim();
  if (!k) {
    throw new GenerationError(
      "FAL_KEY is not set. Provision it in Secret Manager and map it into the Cloud Run service " +
        "before enabling STUDIO_GARMENT_MASK.",
      "missing_api_key",
      "fal",
    );
  }
  return k;
}

/**
 * The one reference, as a data URI. Throws on a url reference — see ① in the header.
 *
 * Exported so the refusal is testable directly rather than only through a mocked fetch: the
 * property being protected is "a signed url cannot reach fal", and that deserves its own assertion.
 */
export function dataUriFor(references: ImageRef[] | undefined): string {
  const ref = references?.[0];
  if (!ref) {
    throw new GenerationError("image.segment requires the image to segment", "invalid_input", "fal");
  }
  if (ref.kind !== "bytes") {
    // Deliberately not "unsupported": from the caller's side this IS invalid input, and the message
    // has to say why rather than read as a capability gap somebody might try to fill in.
    throw new GenerationError(
      "the segmenter takes image BYTES, never a url — a signed url would hand a third party a " +
        "fetchable link to an athlete's photograph",
      "invalid_input",
      "fal",
    );
  }
  return `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}`;
}

/** One of the shapes fal returns a mask in, or null when the entry carries none. See ③. */
async function decodeMask(
  first: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  if (first == null) return null;

  // A bare base64 string, or an object carrying one under a couple of names fal has used.
  const inline =
    typeof first === "string"
      ? first
      : (first as { content?: unknown; data?: unknown })?.content ??
        (first as { data?: unknown })?.data;
  if (typeof inline === "string" && inline.length) {
    const comma = inline.startsWith("data:") ? inline.indexOf(",") + 1 : 0;
    if (comma >= 0) return Buffer.from(inline.slice(comma), "base64");
  }

  const url = (first as { url?: unknown })?.url;
  if (typeof url === "string" && url.length) {
    if (url.startsWith("data:")) {
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    }
    // A fal-hosted mask url. Fetching it sends nothing of the athlete's — it is a link fal minted
    // for its OWN output, and the mask is a black-and-white silhouette, not her photograph.
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

/**
 * EVERY mask fal returned, in order. Empty when the payload carries none.
 *
 * ⚠️ THIS USED TO BE `masks[0]` AND SILENTLY DISCARDED THE REST. SAM is an instance segmenter: a
 * plural noun on a crop holding two socks can legitimately answer with two masks, and keeping only
 * the first threw one away with nothing logged. It was not the cause of the paired-garment bug —
 * that was one mask scored against two rectangles, and the live payloads carried
 * `masks.length === 1` — but it is the same failure waiting on a frame where SAM does find both.
 *
 * CHOOSING among them is deliberately NOT done here. An adapter's job is to report what the
 * provider said; which mask belongs to which region is a question about geometry the adapter has
 * never seen, and studio/segment.ts answers it against the region rectangle.
 */
export async function masksFrom(
  payload: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Buffer[]> {
  const masks = (payload as { masks?: unknown[] } | null)?.masks;
  if (!Array.isArray(masks)) return [];
  const out: Buffer[] = [];
  for (const entry of masks) {
    const decoded = await decodeMask(entry, fetchImpl, signal);
    if (decoded) out.push(decoded);
  }
  return out;
}

export const falAdapter: GenerationAdapter = {
  name: "fal",

  // Segmentation only. fal serves plenty of generators; routing one here is a separate decision
  // with its own pricing and its own review, and claiming support for it now would let a config
  // typo silently move image.generate onto a provider nobody costed.
  supports: (task: GenerationTask) => task === "image.segment",

  // Flat per-call price (config MODELS.sam3), so there is nothing in inputs or opts that moves it.
  // It still goes through estimateCost rather than returning a literal, so an unpriced model reports
  // `unpriced` here exactly as it would anywhere else instead of a confident $0.
  estimate: (_task, inputs, model, opts): CostEstimate => estimateCost(inputs, model, opts),

  async generate(task, inputs, model, opts): Promise<GenerationResult> {
    if (task !== "image.segment") {
      throw new GenerationError(`fal does not support ${task}`, "unsupported_task", "fal");
    }
    const startedAt = new Date();
    const cost = estimateCost(inputs, model, opts);
    const fetchImpl = globalThis.fetch;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), opts.timeoutMs ?? segmentTimeoutMs());
    const onAbort = () => ctrl.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const res = await fetchImpl(`${SYNC_BASE()}/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${key()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: dataUriFor(inputs.references),
          prompt: inputs.prompt,
          // See ③ — the alpha, not a cut-out of her photograph.
          apply_mask: false,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // The STATUS and a bounded slice of the body, never the request — the request body IS the
        // athlete's photograph as base64, and this message ends up in a log line via segment.ts.
        //
        // ⚠️ THE ECHO IS THE SUBTLE PART. A 4xx validation error commonly quotes the offending field
        // back at you, and here the offending field would be `image_url` — so a naive slice of the
        // response can carry a fragment of her photograph into our logs even though we never logged
        // the request. Data URIs are stripped before the slice, not after, so the truncation cannot
        // leave a half-one behind. Same rule costLog.safeRef keeps.
        const body = (await res.text().catch(() => "")).replace(/data:[^"'\s]{0,200}/g, "data:[redacted]");
        throw new GenerationError(
          `fal segmentation failed (${res.status}): ${body.slice(0, 200)}`,
          "provider_error",
          "fal",
          res.status,
        );
      }

      const payload = (await res.json()) as unknown;
      const found = await masksFrom(payload, fetchImpl, ctrl.signal);
      const completedAt = new Date();

      // ZERO ASSETS IS A LEGITIMATE ANSWER HERE, NOT AN ERROR, and it is the vocabulary miss the
      // whole noun layer exists to make detectable: SAM returns an empty mask list when the noun
      // names nothing it can see ("jersey" on a crop top). The caller reads an empty `assets` as
      // "no mask" and composites the rectangle. Throwing would turn a clean, expected fallback into
      // a crop failure and cost her the edit.
      // ALL of them, not the first. See masksFrom.
      const assets: GeneratedAsset[] = found.map((bytes) => ({ bytes, mimeType: "image/png" }));

      logger.info(
        {
          model,
          ms: completedAt.getTime() - startedAt.getTime(),
          // The NOUN is safe to log — it is a closed-vocabulary garment word (studio/autoMask.ts
          // validates it against a whitelist), never her sentence and never a brand's email.
          noun: inputs.prompt,
          found: assets.length,
          maskBytes: found.reduce((n, b) => n + b.length, 0),
        },
        assets.length ? "segmentation returned a mask" : "segmentation found nothing for that noun",
      );

      return {
        task,
        provider: "fal",
        model,
        assets,
        cost,
        timings: {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          ms: completedAt.getTime() - startedAt.getTime(),
        },
      };
    } catch (err) {
      if (err instanceof GenerationError) throw err;
      const aborted = ctrl.signal.aborted;
      throw new GenerationError(
        // The MESSAGE, never the error object — a serialized fetch error can carry the request body
        // with it, and the request body is her photograph.
        `fal segmentation ${aborted ? "timed out" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
        aborted ? "timeout" : "provider_error",
        "fal",
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  },
};
