/**
 * mediaEmbed — multimodal embeddings for the Media Intelligence Layer (docs/media-kit-specs.md
 * Spec 5). Vertex `multimodalembedding@001` puts images AND text in ONE 1408-d space, so a text
 * brief ("an action shot in Adidas") can retrieve the right image. First embedding capability in
 * the codebase. Auth via ADC (same pattern as lib/kimi.ts). Best-effort: returns null on failure.
 */
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";
import { createLogger } from "../logger";

const PROJECT  = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
const LOCATION = process.env.EMBED_LOCATION ?? "us-central1";
const MODEL    = process.env.MEDIA_EMBED_MODEL ?? "multimodalembedding@001";
const BUCKET   = process.env.MEDIA_BUCKET ?? "nomila-v2-athlete-media";
const ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

const logger = createLogger("media-embed");
const auth   = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const bucket = new Storage().bucket(BUCKET);

let _token = "";
let _exp = 0;
async function token(): Promise<string> {
  if (Date.now() > _exp - 300_000) {
    const c = await auth.getClient();
    const { token } = await c.getAccessToken();
    _token = token!;
    const e = (c as any).credentials?.expiry_date as number | undefined;
    _exp = e ?? Date.now() + 3_300_000;
  }
  return _token;
}

async function predict(instance: Record<string, unknown>): Promise<any> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [instance] }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/** Embed a text query into the shared image/text space. */
export async function embedText(text: string): Promise<number[] | null> {
  try {
    const j = await predict({ text: text.slice(0, 1024) });
    return j.predictions?.[0]?.textEmbedding ?? null;
  } catch (e: any) { logger.warn({ error: e?.message?.slice(0, 140) }, "embedText failed"); return null; }
}

/**
 * The API's hard limit on the base64 image string. Vertex answers an over-limit request with
 * "exceeds allowed maximum image string length", and no retry of the same bytes can ever pass.
 */
export const MAX_IMAGE_BASE64_CHARS = 27_000_000;

/** Exact base64 length for a byte count — standard alphabet with padding. No allocation. */
const base64Len = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * Why an embed did not happen.
 *
 *   oversize — the bytes are larger than the API accepts. DETERMINISTIC: the same object will
 *              fail identically forever, so a caller should stop rather than back off.
 *   other    — anything else (quota, 5xx, auth, a malformed response). Transient as far as we
 *              can tell, and the right response is to try again later.
 */
export type EmbedFailure = "oversize" | "other";

export type EmbedOutcome =
  | { ok: true; embedding: number[] }
  | { ok: false; reason: EmbedFailure };

/**
 * Embed an owned image, SAYING WHY when it does not work.
 *
 * ─── THE SIZE CHECK RUNS BEFORE THE CALL, NOT ON THE ERROR ─────────────────────────────────────
 *
 * The obvious implementation matches "exceeds allowed maximum image string length" in the thrown
 * message. This measures the buffer instead, because the length is knowable locally and a provider
 * error string is not a contract — it can be reworded in a release and the match would silently
 * stop working, turning a deterministic failure back into an unbounded retry. Checking first also
 * means an object we KNOW cannot embed costs no upload at all.
 *
 * The string match is kept as a BACKSTOP for the case the local constant drifts from the real
 * limit. Its asymmetry is safe in the same way EXPLICIT_GENERATE's is: a miss falls through to
 * "other" and the caller's ordinary retry budget, so a false negative costs a few attempts, while
 * the check that fires early is the deterministic one that cannot be wrong about its own numbers.
 */
export async function embedImageGcsWithReason(gcsPath: string): Promise<EmbedOutcome> {
  try {
    const [buf] = await bucket.file(gcsPath).download();
    const chars = base64Len(buf.byteLength);
    if (chars > MAX_IMAGE_BASE64_CHARS) {
      logger.warn(
        { gcsPath, bytes: buf.byteLength, base64Chars: chars, cap: MAX_IMAGE_BASE64_CHARS },
        "image is larger than the embedding API accepts — not sending it",
      );
      return { ok: false, reason: "oversize" };
    }
    const j = await predict({ image: { bytesBase64Encoded: buf.toString("base64") } });
    const embedding = j.predictions?.[0]?.imageEmbedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return { ok: false, reason: "other" };
    return { ok: true, embedding };
  } catch (e: any) {
    const msg = String(e?.message ?? "");
    const oversize = /exceeds allowed maximum image string length/i.test(msg);
    logger.warn({ gcsPath, error: msg.slice(0, 140), oversize }, "embedImageGcs failed");
    return { ok: false, reason: oversize ? "oversize" : "other" };
  }
}

/**
 * Embed an owned image (downloaded with our creds, sent as base64 — same as visionTag).
 *
 * Unchanged contract, kept for callers that only need "did it work": one implementation, two
 * shapes. Reach for `embedImageGcsWithReason` when the ANSWER to "why not" changes what you do.
 */
export async function embedImageGcs(gcsPath: string): Promise<number[] | null> {
  const out = await embedImageGcsWithReason(gcsPath);
  return out.ok ? out.embedding : null;
}

/** Cosine similarity in [-1,1] (≈0..1 for these embeddings). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
