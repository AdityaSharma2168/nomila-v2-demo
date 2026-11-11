/**
 * moderation — the content gate for anything that enters the athlete's library.
 *
 * WHY THIS EXISTS SEPARATELY FROM `brand_safe`. The vision pass (lib/visionTag.ts) returns a
 * `brand_safe` boolean, and it is easy to mistake that for moderation. It is not: it is an
 * undefined, unprompted model guess about SPONSOR-FRIENDLINESS ("would a brand be comfortable
 * next to this"), with no definition, no threshold and no recall guarantee. Nothing in this
 * codebase checked for adult / violent / racy content at all before this module.
 *
 * This calls Google Cloud Vision SafeSearch on the stored object (gs:// uri — the object is
 * already in our bucket, so nothing is re-uploaded) and returns the five likelihood strings plus
 * one verdict. BLOCKING categories are adult, violence and racy at LIKELY or VERY_LIKELY.
 *
 * FAILURE IS DELIBERATELY ASYMMETRIC, and the asymmetry belongs to the CALLERS, not to this
 * module — it reports `error` and lets them choose:
 *   • camera-roll REVIEW fails CLOSED. The review pass scores hundreds of photos the athlete has
 *     not looked at one by one; a silent outage there would pre-tick unscreened content, so an
 *     unavailable check drops the item.
 *   • an ordinary UPLOAD fails OPEN (logged, `metadata.moderation = { error }`). That photo was
 *     chosen deliberately, one at a time, and a transient Vision outage must not stop an athlete
 *     from adding her own picture to her own library.
 *
 * Auth mirrors lib/mediaStore.ts: the SA key in GOOGLE_SERVICE_ACCOUNT_JSON when set (local dev
 * cannot sign or call with a bare user ADC), otherwise ADC (the Cloud Run runtime SA).
 */
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { createLogger } from "../logger";

const logger = createLogger("moderation");
const BUCKET = process.env.MEDIA_BUCKET ?? "nomila-v2-athlete-media";

export type Likelihood = "UNKNOWN" | "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY";

export interface ModerationScores {
  adult: Likelihood;
  violence: Likelihood;
  racy: Likelihood;
  medical: Likelihood;
  spoof: Likelihood;
}

export interface ModerationVerdict {
  /** true ⇒ a blocking category came back LIKELY or VERY_LIKELY. Hard stop. */
  blocked: boolean;
  /** Which blocking categories tripped (empty unless `blocked`). */
  categories: string[];
  /** The five likelihoods to persist as metadata.moderation — null when the check did not run. */
  scores: ModerationScores | null;
  /** Set when the check could not be completed. Callers decide open vs closed; see the header. */
  error?: string;
}

/** Categories that stop an image, and the likelihoods that count as a hit. */
const BLOCKING = ["adult", "violence", "racy"] as const;
const BLOCKING_LIKELIHOODS = new Set<string>(["LIKELY", "VERY_LIKELY"]);

let _client: ImageAnnotatorClient | null = null;
function client(): ImageAnnotatorClient {
  if (_client) return _client;
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  _client = saJson
    ? new ImageAnnotatorClient({ credentials: JSON.parse(saJson), projectId: JSON.parse(saJson).project_id })
    : new ImageAnnotatorClient();
  return _client;
}

const LIKELIHOODS: Likelihood[] = ["UNKNOWN", "VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"];

/** The API answers with either the enum name or its numeric index — normalise both to the name. */
function likelihood(v: unknown): Likelihood {
  if (typeof v === "number") return LIKELIHOODS[v] ?? "UNKNOWN";
  const s = String(v ?? "").toUpperCase();
  return (LIKELIHOODS as string[]).includes(s) ? (s as Likelihood) : "UNKNOWN";
}

/**
 * SafeSearch one object already stored in our media bucket.
 * Never throws — a failure comes back as `{ blocked: false, scores: null, error }`.
 */
export async function moderateGcsImage(gcsPath: string): Promise<ModerationVerdict> {
  try {
    const [res] = await client().safeSearchDetection(`gs://${BUCKET}/${gcsPath}`);
    const a = res?.safeSearchAnnotation;
    if (!a) return { blocked: false, categories: [], scores: null, error: "no_annotation" };
    const scores: ModerationScores = {
      adult:    likelihood(a.adult),
      violence: likelihood(a.violence),
      racy:     likelihood(a.racy),
      medical:  likelihood(a.medical),
      spoof:    likelihood(a.spoof),
    };
    const categories = BLOCKING.filter((c) => BLOCKING_LIKELIHOODS.has(scores[c]));
    if (categories.length) logger.warn({ gcsPath, categories, scores }, "content blocked by SafeSearch");
    return { blocked: categories.length > 0, categories, scores };
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 200);
    logger.warn({ gcsPath, error: message }, "SafeSearch unavailable");
    return { blocked: false, categories: [], scores: null, error: message };
  }
}
