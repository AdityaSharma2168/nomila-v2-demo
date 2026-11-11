/**
 * brandBriefRoute.ts — the RICH brand answer for the voice worker.
 *
 * POST /athletes/:id/brand-brief, mounted at /api/internal/voice (server/index.ts).
 * POST rather than GET only because the key is a free-text brand name from the
 * model rather than an id; the route is a pure read as far as the CALLER is
 * concerned — the response is computed entirely from reads, and the only write it
 * can cause happens after the response is sent (see §3).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, and the shared secret is the entire authorization boundary.
 * See ./auth for the guard and why the secret is its own rather than CRON_SECRET.
 *
 * ── PRECOMPUTED. This route no longer waits for a model, ever ─────────────────
 * The previous version called `narrateWhyFits` inline — a Gemini call measured
 * >10s on a live brand — and made that affordable by having the worker call this
 * tool ASYNCHRONOUSLY: an immediate acknowledgement, spoken filler over the gap,
 * and the real answer delivered later as its own turn. That machinery is gone,
 * on both sides of the wire, because it was not paying for itself:
 *
 *   - the ack was a tool result with no data in it, which the model answered by
 *     calling the tool again to actually get the data — a re-call storm that
 *     starved the very idle state the filler and the deferred delivery both wait
 *     for, so Mila went silent instead of talking through the wait;
 *   - the deferred result arrived as a second delivery of one answer, and
 *     whichever landed second aborted the first mid-sentence;
 *   - and every layer added to hold that together (duplicate rejection, an
 *     in-flight guard, a repeat-ask memo, four override templates) was managing a
 *     seam that only existed because the answer was slow.
 *
 * So the answer is not slow any more. The narrative is produced AHEAD OF TIME and
 * read from ./brandFitStore, which makes this endpoint one indexed brand lookup
 * plus one store read — fast enough to be an ordinary blocking tool call, which
 * removes the seam and everything built on it. Latency is now bounded by
 * READ_TIMEOUT_MS below, not by a model.
 *
 * ── The three answers ─────────────────────────────────────────────────────────
 *   { notCached: true }                     — we don't hold this brand at all.
 *   { brandKnowledge }                      — we hold it, nothing precomputed yet.
 *   { brandKnowledge, reasons }             — the full answer.
 *
 * The middle one is the COLD PATH and is the same body ./brandKnowledgeRoute
 * returns, byte for byte. It used to be the degraded path (a narrate call that
 * failed or timed out); now it is what an un-backfilled pair gets on first ask,
 * and it fills itself in for next time. The worker's tool description already
 * tells the model what to do with a `reasons`-less hit, and that has not changed:
 * give the brand-knowledge answer and its own judgment, never invent the angles.
 *
 * ── `:id` IS the tenancy boundary here — unlike ./brandKnowledgeRoute ─────────
 * That route's header explains at length that its `:id` does no scoping work,
 * because nothing on it reads the athlete. THAT REASONING DOES NOT TRANSFER, and
 * this route must not be read as a copy of it.
 *
 * A fit narrative is built from the athlete's name, sport, and a coarse audience
 * descriptor, all read under this id inside `get_brand_fit`. So the answer here is
 * DIFFERENT PER ATHLETE, and the id selects whose profile it was written from —
 * both when reading the store (keyed by athlete AND brand) and when filling it.
 * An id for an athlete that doesn't exist finds nothing precomputed and produces
 * nothing on fill, so it degrades to the enum rather than inventing a narrative.
 *
 * What this route deliberately does NOT read is DEALS. v1 is brand-and-athlete
 * only; deal-scope-aware depth is a later change that would widen this boundary.
 *
 * ── Cache-only, structurally ──────────────────────────────────────────────────
 * Same rule as ./brandKnowledgeRoute and `get_brand_fit`: a brand we don't already
 * hold is a miss, never a ~35s research run. `findCachedBrand` is a direct indexed
 * read that never inserts, and this module has no import path to
 * services/brandIntel or skills/researchBrand. `get_brand` is the only brand tool
 * allowed to pay the research cost. The fill in §3 inherits that: it goes through
 * `get_brand_fit`, which is itself cache-only, and it only runs for a brand this
 * route has ALREADY confirmed is held and enriched.
 *
 * ── What crosses this wire ────────────────────────────────────────────────────
 * NARRATOR OUTPUT AND OUR OWN ENUM, NOTHING ELSE. The brand row's category,
 * description, audience_summary, partnerships and enrichment blob are web-derived
 * and attacker-influenceable; `get_brand` wraps them in <external_content> for the
 * chat model, but that is a PROMPT construct — it means nothing over HTTP and a TTS
 * layer would read it aloud verbatim (the reasoning is spelled out in
 * ./dealRoutes). So no raw row text is mapped out below, and the response is
 * allow-listed field by field.
 *
 * The three `reasons` ARE safe to speak unwrapped for the same reason
 * `get_brand_fit` returns them unwrapped: they are APP-GENERATED copy from our own
 * constrained JSON call, not brand-authored text passed through. Storing them
 * between the call and the answer does not change what they are — ./brandFitStore
 * re-validates all three on the way out, so a corrupted store degrades to the enum
 * rather than putting unchecked text on the wire.
 *
 * Note the inherited exposure, flagged and NOT widened: narrateWhyFits interpolates
 * the brand's category + audience_summary undelimited into its own prompt
 * (server/services/narrator.ts:300-310). That is pre-existing shared-code behavior
 * relied on by pitches.ts and mediaKitService.ts. `get_brand_fit` works around it by
 * passing `facts: []`; the fill path calls that tool rather than the narrator
 * directly, so it inherits the workaround unchanged and adds no new untrusted text.
 */

import { Router, type Request, type Response } from "express";
import { findCachedBrand } from "../mila/tools/getBrandFit";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import { getBrandFitReasons, type BrandFitReasons } from "./brandFitStore";
import { enqueueBrandFitFill } from "./brandFitFill";

const logger = createLogger("voice/brandBrief");

const router = Router();

/**
 * Bounds the whole answer now, not just the brand lookup: with the narrative
 * precomputed, the only awaits on this path are one indexed SELECT and one store
 * read. Same 2s as ./brandKnowledgeRoute for the same reason — a stalled-pool
 * backstop rather than a latency budget. A timeout degrades rather than erroring.
 */
const READ_TIMEOUT_MS = 2_000;

/** Longest brand name accepted. Model-supplied free text is always bounded. */
const BRAND_MAX_CHARS = 120;

/**
 * How much profile we hold — NOT a rating of the brand, and NOT a judgment of fit.
 * Derived identically to ./brandKnowledgeRoute so the two surfaces agree.
 */
type BrandKnowledge = "full" | "thin";

/**
 * The voice wire shape on a hit. `reasons` is OMITTED (not null) when nothing is
 * precomputed, so the cold body is byte-identical to ./brandKnowledgeRoute's —
 * the worker gets one shape with one optional key.
 */
interface VoiceBrandBrief {
  brandKnowledge: BrandKnowledge;
  reasons?: BrandFitReasons;
}

/** The only other answer: we don't hold this brand. Never a research call. */
interface VoiceBrandBriefMiss {
  notCached: true;
}

const MISS: VoiceBrandBriefMiss = { notCached: true };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// POST /athletes/:id/brand-brief — the rich brand answer.
// Cache-only and precomputed: never researches, never calls a model on the
// request path, and answers within READ_TIMEOUT_MS or degrades.
router.post(
  "/athletes/:id/brand-brief",
  async (req: Request, res: Response) => {
    // Set before the guard so EVERY response from this route carries it — the
    // app-wide no-store middleware covers /api/v1/me|admin|auth only.
    res.setHeader("Cache-Control", "no-store");

    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    // Unlike ./brandKnowledgeRoute this id is load-bearing — it is half the store
    // key and it scopes the athlete reads inside the fill. Shape-validated here so
    // bad input can't reach the DB.
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid athlete id" });
      return;
    }

    const brand =
      isRecord(req.body) && typeof req.body.brand === "string"
        ? req.body.brand.trim()
        : "";
    if (!brand || brand.length > BRAND_MAX_CHARS) {
      res.status(400).json({ error: "Invalid brand" });
      return;
    }

    let brandId: number;
    let brandName: string;
    let brandKnowledge: BrandKnowledge;
    let reasons: BrandFitReasons | null;

    try {
      // ── 1. Do we hold this brand at all? ──────────────────────────────────────
      // Name only with a null domain, exactly as ./brandKnowledgeRoute calls it, so
      // both surfaces resolve a given brand name to the same row by construction.
      const row = await withTimeout(
        findCachedBrand(brand, null),
        READ_TIMEOUT_MS,
        "voice brand_brief lookup",
      );

      // Not held, or held but never enriched — the row `get_brand` would research
      // and this endpoint must not. Both are "we don't have them" to the athlete.
      if (!row || row.enriched_at == null) {
        // Never log the brand: it is model-supplied, untrusted free text.
        logger.info(
          { athleteId: id, outcome: "miss" },
          "Voice brand brief miss",
        );
        res.json(MISS);
        return;
      }

      brandId = row.id;
      brandName = row.name;
      // Empty string counts as absent — a row with a blank summary tells us no
      // more than one with none, so it must not read as a full profile.
      brandKnowledge = row.audience_summary?.trim() ? "full" : "thin";

      // ── 2. The narrative, if someone already paid for it. ────────────────────
      // Keyed by athlete AND brand: this is where the per-athlete scoping is
      // enforced on the read side. No model call, no fallback to computing it.
      reasons = await withTimeout(
        getBrandFitReasons(id, brandId),
        READ_TIMEOUT_MS,
        "voice brand_brief store read",
      );
    } catch (err: any) {
      // withTimeout is the only thing on this path that rejects with that message
      // and both labels are ours, so the match is safe. A DB or disk hiccup costs
      // the athlete an "I don't have them", never a failed turn.
      if (
        typeof err?.message === "string" &&
        err.message.includes("timed out")
      ) {
        logger.info(
          { athleteId: id, outcome: "lookup_timeout" },
          "Voice brand brief lookup timed out",
        );
        res.json(MISS);
        return;
      }

      logger.error(
        { athleteId: id, error: err.message },
        "Voice brand brief lookup failed",
      );
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    if (reasons) {
      logger.info(
        { athleteId: id, brandId, brandKnowledge, outcome: "hit" },
        "Voice brand brief hit",
      );
      const body: VoiceBrandBrief = { brandKnowledge, reasons };
      res.json(body);
      return;
    }

    // ── 3. Cold pair: answer now, fill for next time. ─────────────────────────
    // The enum is sent FIRST and the fill is started after, deliberately in that
    // order: the response must not be able to wait on a model call, and a fill
    // that is dropped by its own concurrency cap must not change what was said.
    // Nothing below can affect this request's body — it is already written.
    const body: VoiceBrandBrief = { brandKnowledge };
    logger.info(
      { athleteId: id, brandId, brandKnowledge, outcome: "cold" },
      "Voice brand brief cold — enum only, fill enqueued",
    );
    res.json(body);

    // Guarded even though `enqueueBrandFitFill` is written not to throw: the
    // response is already on the wire, so a throw here cannot be turned into an
    // error status — it can only escape this async handler as an unhandled
    // rejection. That is the one way starting the background work could still
    // hurt a request it is supposed to be invisible to.
    try {
      enqueueBrandFitFill(id, brandId, brandName);
    } catch (err: any) {
      logger.error(
        { athleteId: id, brandId, error: err?.message },
        "Brand fit fill enqueue threw",
      );
    }
  },
);

export default router;
