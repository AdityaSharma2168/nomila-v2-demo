/**
 * dealEmbed — text embeddings for the deal corpus, and the kNN prior built on them.
 *
 * Layer 3 of the learning loop, and the first one that GENERALISES. The layers below it
 * can only recognise what someone already described:
 *   · structuralNonDeal matches phrasings a human anticipated and wrote a regex for.
 *   · senderMemory recognises addresses seen before, so a new spam domain always lands.
 * Neither can catch a sweepstakes from a brand nobody has ever heard of. Nearest-
 * neighbour over past decisions can: that mail sits near other sweepstakes in vector
 * space whether or not anyone wrote a rule, and no deploy is involved.
 *
 * WHY NOT reuse lib/mediaEmbed's embedText, which already exists.
 * Two hard reasons, not preference:
 *   1. multimodalembedding@001 truncates at `text.slice(0, 1024)` — a marketing email is
 *      routinely longer, so the tail that distinguishes it would be cut off.
 *   2. It is a JOINT image/text space, tuned so a photo and its caption land together.
 *      That costs text-vs-text fidelity, and mediaSearch already documents the symptom:
 *      "Raw multimodal cosine is low-absolute (~0.05–0.2)".
 * The auth, token cache and predict shape below deliberately mirror mediaEmbed so there
 * is one house pattern for calling Vertex; `cosine` is imported from it outright rather
 * than reimplemented.
 *
 * WHY NOT sentence-transformers / SetFit (the industry-standard answer).
 * They are Python; this service is node:20-slim with no Python at all. Adopting them
 * means a second container, its own deploy, cold starts and a model artefact to version
 * and roll back. SetFit's actual idea — few-shot classification from ~50 labelled rows —
 * is exactly right for this problem, and is what the kNN below implements natively, with
 * every verdict traceable to the specific neighbours that produced it.
 */

import { GoogleAuth } from "google-auth-library";
import { cosine } from "./mediaEmbed";
import { htmlToText } from "./emailBody";
import { createLogger } from "../logger";

export { cosine };

const PROJECT  = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
const LOCATION = process.env.EMBED_LOCATION ?? "us-central1";
/** Overridable so the model can be swapped without a deploy once evaluation says to. */
const MODEL    = process.env.DEAL_EMBED_MODEL ?? "text-embedding-004";
const endpointFor = (model: string) =>
  `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${model}:predict`;

const logger = createLogger("lib/dealEmbed");
const auth   = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

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

/**
 * One text the embedder sees, assembled the same way every time.
 *
 * Sender is included because the FROM line carries real signal — `mkt.`, `e.`, `no-reply`
 * and friends are most of what separates a blast from a person writing to an athlete.
 * The body is capped well above multimodal's 1024: enough to reach the offer, short
 * enough to skip the unsubscribe boilerplate that every marketing mail shares and which
 * would otherwise make all of them look alike.
 */
export function corpusText(input: { from?: string | null; subject?: string | null; body?: string | null }): string {
  const from = (input.from ?? "").trim();
  const subject = (input.subject ?? "").trim();
  // Defensive strip. extractEmailBody handles this at ingest, but rows stored before that
  // fix still hold raw markup, and an embedded <table> soup describes the mail client
  // rather than the offer — every HTML mail would look alike whatever it said.
  const raw = input.body ?? "";
  const cleaned = /<\s*(!doctype|html|head|body|table|div)/i.test(raw.slice(0, 500))
    ? htmlToText(raw)
    : raw;
  const body = cleaned.replace(/\s+/g, " ").trim().slice(0, 3000);
  return `From: ${from}\nSubject: ${subject}\n\n${body}`.trim();
}

/** Embed one text. Returns null on any failure — a prior is an optimisation, never a gate. */
export async function embedDealText(text: string, model = MODEL): Promise<number[] | null> {
  const vecs = await embedDealTexts([text], model);
  return vecs?.[0] ?? null;
}

/**
 * Embed a batch. Vertex accepts several instances per call, which matters when building
 * the corpus: one request per row would make a rebuild needlessly slow and rate-limited.
 */
export async function embedDealTexts(texts: string[], model = MODEL): Promise<(number[] | null)[]> {
  if (!texts.length) return [];
  const out: (number[] | null)[] = [];

  // Batch by CHARACTERS, measured conservatively, and split on overflow.
  //
  // A fixed row count silently overflows: 25 rows of real email was 24,045 tokens against
  // a 20,000 limit, the request 400'd, and every row came back null — which read as "this
  // model cannot embed half the corpus" rather than a batching bug, and would have picked
  // the wrong model on invalid numbers.
  //
  // The usual ~4 chars/token rule is wrong for this text: those 25 rows were 38,525 chars
  // for 24,045 tokens, about 1.6 chars per token. Marketing mail is dense with URLs,
  // punctuation and emoji, each of which costs a token for very few characters. So the
  // budget is in characters with a pessimistic ratio, and a 400 still splits and retries
  // rather than losing the batch.
  const CHAR_CAP = 24_000;
  const MAX_ROWS = 12;
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const t of texts) {
    if (cur.length && (curChars + t.length > CHAR_CAP || cur.length >= MAX_ROWS)) {
      batches.push(cur); cur = []; curChars = 0;
    }
    cur.push(t); curChars += t.length;
  }
  if (cur.length) batches.push(cur);

  for (const slice of batches) {
    try {
      const res = await fetch(endpointFor(model), {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ instances: slice.map((t) => ({ content: t.slice(0, 8000) })) }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);
      const j: any = await res.json();
      for (let k = 0; k < slice.length; k++) {
        out.push(j.predictions?.[k]?.embeddings?.values ?? null);
      }
    } catch (e: any) {
      // Halve and retry once: an oversized batch should cost latency, not the whole slice.
      if (slice.length > 1) {
        const mid = Math.ceil(slice.length / 2);
        const [a, b] = await Promise.all([
          embedDealTexts(slice.slice(0, mid), model),
          embedDealTexts(slice.slice(mid), model),
        ]);
        out.push(...a, ...b);
      } else {
        logger.warn({ error: e?.message?.slice(0, 140) }, "embedDealTexts row failed");
        out.push(null);
      }
    }
  }
  return out;
}

// ─── The prior ────────────────────────────────────────────────────────────────

export interface CorpusRow {
  id: string;
  /** true = a real deal, false = junk. The only label kNN votes on. */
  isDeal: boolean;
  category: string;
  embedding: number[];
}

export interface KnnPrior {
  /** Share of the k nearest neighbours that are junk, weighted by similarity. 0..1. */
  junkScore: number;
  /** The nearest neighbour's similarity — how much like ANYTHING seen before this is. */
  topSim: number;
  k: number;
  /** The neighbours themselves, so a decision can always be explained. */
  neighbours: { id: string; isDeal: boolean; sim: number }[];
}

/**
 * Similarity-weighted vote over the k nearest labelled decisions.
 *
 * Weighted, not a plain count, because absolute cosine here is compressed — a neighbour
 * at 0.62 is meaningfully closer than one at 0.41, and a majority vote throws that away.
 * Squaring sharpens the weighting so a single very close match can outvote several loose
 * ones, which is the behaviour wanted: near-duplicate marketing blasts are the case this
 * layer exists to catch.
 */
export function knnPrior(query: number[], corpus: CorpusRow[], k = 7): KnnPrior | null {
  if (!query?.length || !corpus.length) return null;

  const scored = corpus
    .map((r) => ({ id: r.id, isDeal: r.isDeal, sim: cosine(query, r.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.min(k, corpus.length));

  let junkW = 0;
  let total = 0;
  for (const n of scored) {
    const w = Math.max(0, n.sim) ** 2;
    total += w;
    if (!n.isDeal) junkW += w;
  }

  return {
    junkScore: total > 0 ? junkW / total : 0,
    topSim: scored[0]?.sim ?? 0,
    k: scored.length,
    neighbours: scored,
  };
}

// ─── The decision ─────────────────────────────────────────────────────────────

/**
 * Tuned by leave-one-out (server/scripts/evalKnnPrior.ts), not chosen by feel. The
 * original sweep ran over a since-retired harvested corpus; real Gmail content is no
 * longer kept for evaluation, so any re-tune runs on synthetic fixtures. On 48 decisions, k=3 @ 0.75 was the best point that harmed
 * NO real deal: 34 junk calls, 100% precision, 82.9% of junk caught.
 *
 * text-embedding-004 beat text-multilingual-embedding-002 decisively on the metric that
 * matters — multilingual never reached 100% precision at any (k, threshold) in the sweep,
 * topping out at 97.6%. Higher recall is worthless if the cost is hiding a real offer.
 */
export const KNN_K = 3;
export const KNN_JUNK_THRESHOLD = 0.75;

/**
 * A floor on how alike ANYTHING seen before the mail must be.
 *
 * junkScore is a ratio, so three neighbours that are all junk but all barely related
 * score 1.0 — a confident verdict built on nothing. This blocks that: novel mail goes to
 * the classifier, which is what it is for.
 *
 * 0.55 is below the lowest top-similarity among correct junk calls in the sweep (0.623),
 * so it costs no recall today. It cannot separate junk from deals on its own — those
 * ranges overlap (real deals reach 0.779) — and is not meant to. The label vote
 * discriminates; this only refuses to vote on strangers.
 */
export const KNN_MIN_TOP_SIM = 0.55;

/** Should this mail be filed WITHOUT an LLM call? Conservative by construction. */
export function shouldFileAsJunk(prior: KnnPrior | null): boolean {
  if (!prior) return false;
  if (prior.k < KNN_K) return false;              // too little history to vote at all
  if (prior.topSim < KNN_MIN_TOP_SIM) return false;
  return prior.junkScore >= KNN_JUNK_THRESHOLD;
}
