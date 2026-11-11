/**
 * studio/enrich/config — video enrichment's flag, model and money, pinned in one place.
 *
 * The house rule (server/CLAUDE.md): model strings live in a config module and are never hardcoded
 * at a call site. This is video enrichment's, a satellite of studio/config.ts in the shape of
 * studio/agent/config.ts.
 *
 * ─── WHY FLASH BY DEFAULT (22 Sep 2026, C2 Half A report — Adi accepted the table) ─────────────
 *
 * Costed from the measured library (67 clips, 437 s): Flash at default media resolution is about
 * $0.62 for the lot, Pro about $0.83 — a 34% gap, not a 10× one, because the beat JSON's OUTPUT
 * tokens dominate at these clip lengths. Flash is the default on economics; the enrichment eval
 * card carries a planned Pro cell on a 10-clip sample so the choice becomes evidence. Switching is
 * one env line: STUDIO_ENRICH_VIDEO_MODEL set to the registry's Pro identifier.
 */
import { readCap } from "../../lib/spendCap";
import { GEMINI } from "../../lib/models";
import { studioFlag } from "../studioFlag";

/**
 * VIDEO ENRICHMENT (services/mediaEnrichment.ts → studio/enrich/videoEnrichment.ts). Off unless
 * explicitly enabled. With it off the enrichment worker never loads the video module, never reads
 * an mp4 and never sends one to a model — a video row is tagged from its poster exactly as before.
 * Read at call time, like every STUDIO_* flag.
 */
export const videoEnrichEnabled = (): boolean =>
  studioFlag(process.env.STUDIO_VIDEO_ENRICH);

/** The video tagger's model. Pinned, overridable by env, never chosen at a call site. */
export const videoEnrichModel = (): string =>
  process.env.STUDIO_ENRICH_VIDEO_MODEL ?? GEMINI.flash;

/**
 * The thinking config the tagger is sent — or none. Follows the model, for the reason
 * studio/agent/config.ts gives: Flash's zero budget is the proven shape on this project for a short
 * JSON, and nothing is proven about a zero budget on Pro, so Pro is sent no thinking config at all.
 */
export const videoEnrichThinking = ():
  | { thinkingBudget: number }
  | undefined => {
  const model = videoEnrichModel();
  return model === GEMINI.flash || model === GEMINI.flashLite
    ? { thinkingBudget: 0 }
    : undefined;
};

/** How long one clip's tagging call may take. A clip is minutes at most; the model reads it at 1 fps. */
export const videoEnrichTimeoutMs = (): number =>
  Number(process.env.STUDIO_VIDEO_ENRICH_TIMEOUT_MS ?? 120_000);

/**
 * THE PER-RUN CAP, in dollars of ESTIMATE. One run is one `enrichNextChunk` call (one cron pass or
 * one post-upload kick). When the next clip's estimate would take the run over this, the run stops
 * with a named refusal (VideoEnrichCapExceeded) — the clip is left untouched, counts no attempt and
 * stays a candidate, so the next pass resumes where this one stopped. Resume, not abandon: a cap is
 * a budget, not a verdict on the row.
 */
export const videoEnrichMaxRunUsd = (): number =>
  // Clamped to 20 (10× the default); a value that is not a usable number is the default (lib/spendCap.ts). It was a
  // bare Number(), so "abc" made it NaN and every `>` against it passed.
  readCap("STUDIO_VIDEO_ENRICH_MAX_RUN_USD", 2, VIDEO_ENRICH_MAX_RUN_CEILING_USD);
export const VIDEO_ENRICH_MAX_RUN_CEILING_USD = 20;

/**
 * THE PER-ATHLETE DAILY CAP, in dollars (PR 4, C1). The run cap above bounds one pass; the enrich
 * route runs up to `maxTicks` passes per request and the scheduler fires every 15 minutes, so a
 * pass cap alone bounds nothing over a day. This does: every clip call that reached the model books
 * its settled cost on its row (`metadata.enrich_spend`, videoEnrichment.ts), a pass sums today's
 * per athlete (UTC day), and an athlete at the cap is left for tomorrow — untouched, no attempt.
 * UNSET (or not a finite number ≥ 0) means no daily cap: today's behaviour, unchanged.
 */
export const enrichDailyCapUsd = (): number | null => {
  const raw = process.env.STUDIO_ENRICH_DAILY_CAP_USD;
  if (raw === undefined || raw.trim() === "") return null;
  // Set: clamped to ENRICH_DAILY_CAP_MAX_USD; set but not a usable number → ENRICH_DAILY_CAP_FALLBACK_USD (the value
  // both Cloud Run yamls ship), never "no cap" (lib/spendCap.ts). "0" stays a real value (no enrichment spend).
  return readCap("STUDIO_ENRICH_DAILY_CAP_USD", ENRICH_DAILY_CAP_FALLBACK_USD, ENRICH_DAILY_CAP_MAX_USD, { allowZero: true });
};
export const ENRICH_DAILY_CAP_FALLBACK_USD = 5;
export const ENRICH_DAILY_CAP_MAX_USD = 50;

/** How many clips one pass reads at most — the batch bound. Default 8, as it always was. */
export const videoEnrichChunk = (): number => {
  const n = Number(process.env.STUDIO_VIDEO_ENRICH_CHUNK);
  return Number.isInteger(n) && n > 0 ? n : 8;
};

/**
 * The inline ceiling. Bytes go to the model inline (base64), the same way visionTag sends a photo,
 * and the documented inline limit for video is 100 MB. A clip above it can never succeed on this
 * path, so it is set down on first sight with reason "oversize" — the same deterministic-vs-transient
 * split lib/mediaEmbed.ts draws — and keeps the poster-derived tags it already has.
 */
export const videoEnrichMaxBytes = (): number =>
  Number(process.env.STUDIO_VIDEO_ENRICH_MAX_BYTES ?? 100 * 1024 * 1024);

/**
 * Per-token rates for the ESTIMATE. Gemini 3.5 Flash list price, 22 Sep 2026: $1.50 / M input,
 * $9.00 / M output, video billed as text. Overridable so a price change is config, not a redeploy —
 * and so the eval's Pro cell can be costed at Pro's rates ($2 / $12) with two env lines.
 */
export const videoEnrichUsdPerInputToken = (): number =>
  Number(
    process.env.STUDIO_VIDEO_ENRICH_USD_PER_INPUT_TOKEN ?? 1.5 / 1_000_000,
  );
export const videoEnrichUsdPerOutputToken = (): number =>
  Number(process.env.STUDIO_VIDEO_ENRICH_USD_PER_OUTPUT_TOKEN ?? 9 / 1_000_000);

/**
 * What a second of video costs the model to read, in tokens, at default media resolution and the
 * default 1 fps: about 100 for the frames plus 32 for the audio track (Gemini video-understanding
 * docs, 22 Sep 2026). Used only to estimate BEFORE a call; the meter charges what Vertex reports.
 */
export const VIDEO_TOKENS_PER_SECOND = 132;
/** The prompt itself plus the JSON scaffold the model echoes back — a flat allowance per clip. */
export const VIDEO_PROMPT_TOKENS = 700;
/** Output: a whole-clip block plus roughly one beat every three seconds, ~120 tokens a beat. */
export const VIDEO_OUTPUT_TOKENS_FLAT = 400;
export const VIDEO_OUTPUT_TOKENS_PER_SECOND = 40;
/**
 * A clip whose duration is unknown (both duration columns null or zero — the two uploads on the
 * measured library are exactly this) is estimated as if it were this long. Deliberately generous:
 * an under-estimate would let the cap be passed, an over-estimate only makes the run stop early.
 */
export const VIDEO_ASSUMED_SECONDS = 60;

/**
 * THE USER-TRIGGERED CLIP READ (PR 9.5, F22 B2) — `POST /studio/media/:id/read` and the "Read this
 * clip" affordance behind it. Off unless explicitly enabled; off, the route answers 404 before reading a
 * row (the edit routes' shape) and the client twin (`EXPO_PUBLIC_STUDIO_CLIP_READ`) renders nothing.
 * Needs STUDIO_VIDEO_ENRICH too — a read IS one clip's enrichment, on demand, and it books its cost the
 * same way (`metadata.enrich_spend`, the daily cap). Read at call time, like every STUDIO_* flag.
 */
export const clipReadEnabled = (): boolean =>
  studioFlag(process.env.STUDIO_CLIP_READ);

/**
 * How long a `reading` mark may stand before it is read as dead (R-7): twice the call's own bound. A
 * kick that never wrote its outcome — the process went away mid-read — would otherwise say "reading"
 * forever and refuse every new read of that clip.
 */
export const clipReadStaleMs = (): number => 2 * videoEnrichTimeoutMs();
