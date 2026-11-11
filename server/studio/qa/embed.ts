/**
 * studio/qa/embed — embed IMAGE BYTES in Vertex's multimodal space, for identity distance.
 *
 * ─── WHY THIS IS NOT IN lib/mediaEmbed.ts, WHICH ALREADY DOES THIS ─────────────────────────────
 *
 * `lib/mediaEmbed.ts` speaks the same endpoint and the same model, and the only thing it lacks is a
 * bytes entry point: every exported function takes a `gcsPath` and downloads it. QA needs to embed a
 * FACE CROP that exists only in memory and is never stored, so it cannot use any of them.
 *
 * The right fix is a three-line `embedImageBytes` in that file, with `embedImageGcs` delegating to
 * it. That is a change to shared library code used by `services/mediaEnrichment.ts`, which is
 * outside this PR's scope — so it is NOT made here and is written down instead:
 *
 *   PROPOSAL FOR MIA — extract `embedImageBytes(buf: Buffer)` in lib/mediaEmbed.ts and have
 *   `embedImageGcsWithReason` become "download, then call it". Blast radius: one file, one new
 *   export, no behaviour change to the existing two callers (mediaEnrichment's chunk loop and
 *   mediaSearch). This module then deletes its `predict`, its auth block and its token cache, and
 *   keeps only the face-crop logic. ~40 lines duplicated until then, listed here so the duplication
 *   is a recorded decision rather than something a future reader has to guess at.
 *
 * `cosine` IS imported from there rather than re-implemented — it is a pure function, needs no
 * change, and two implementations of a distance metric is exactly the kind of drift that makes a
 * calibrated threshold quietly wrong.
 *
 * ─── ⚠️  WHAT THIS EMBEDDING IS, AND WHAT IT IS NOT ────────────────────────────────────────────
 *
 * `multimodalembedding@001` is a SEMANTIC embedding. It encodes "young woman, dark hair, outdoors,
 * athletic" — it is not trained to separate one person from another, the way a face-recognition
 * embedding (ArcFace and its family) is. Two different people who look alike can sit close together
 * in this space, and that is not a defect of the model, it is what the model is for.
 *
 * So this is a CANDIDATE for identity distance, not an answer. Whether it separates a regenerated
 * face from the same face photographed on a different day is an empirical question, and
 * `scripts/studioQaCalibrate.ts` is the thing that answers it. If it cannot, the honest outcome is
 * a recorded number with no threshold — never a threshold fitted until the corpus is memorized.
 */
import { GoogleAuth } from "google-auth-library";

import { cosine } from "../../lib/mediaEmbed";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";

export { cosine };

const PROJECT = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
const LOCATION = process.env.EMBED_LOCATION ?? "us-central1";
const MODEL = process.env.MEDIA_EMBED_MODEL ?? "multimodalembedding@001";
const ENDPOINT = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

const EMBED_TIMEOUT_MS = Number(
  process.env.STUDIO_QA_EMBED_TIMEOUT_MS ?? 20_000,
);

const logger = createLogger("studio/qa/embed");
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

let _token = "";
let _exp = 0;
async function token(): Promise<string> {
  if (Date.now() > _exp - 300_000) {
    const c = await auth.getClient();
    const { token: t } = await c.getAccessToken();
    _token = t!;
    const e = (c as { credentials?: { expiry_date?: number } }).credentials
      ?.expiry_date;
    _exp = e ?? Date.now() + 3_300_000;
  }
  return _token;
}

/**
 * Embed one image already in memory. Returns null on any failure — never throws, for the reason
 * qa/vision.ts states: nothing in this stage may fail a generation that has already been paid for.
 *
 * `assetId` names the photograph the crop came from on the failure lines, when the caller knows it.
 */
export async function embedImageBytes(
  bytes: Buffer,
  assetId?: string,
): Promise<number[] | null> {
  try {
    const res = await withTimeout(
      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instances: [
            { image: { bytesBase64Encoded: bytes.toString("base64") } },
          ],
        }),
      }),
      EMBED_TIMEOUT_MS,
      "qa embed",
    );
    if (!res.ok) {
      logger.warn(
        {
          assetId,
          status: res.status,
          body: (await res.text()).slice(0, 160),
        },
        "qa embed failed",
      );
      return null;
    }
    const j = (await res.json()) as {
      predictions?: { imageEmbedding?: number[] }[];
    };
    const e = j.predictions?.[0]?.imageEmbedding;
    return Array.isArray(e) && e.length > 0 ? e : null;
  } catch (err: unknown) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "qa embed threw",
    );
    return null;
  }
}

/**
 * Distance, not similarity — 0 is identical, larger is further apart.
 *
 * The whole check reads as "how far did she move", so the number that grows with badness is the one
 * that belongs in a record. `cosine` returns similarity in [-1,1]; this is `1 - that`, which for
 * these embeddings lands in roughly [0,1].
 */
export function embeddingDistance(a: number[], b: number[]): number {
  return 1 - cosine(a, b);
}
