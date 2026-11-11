/**
 * brandKnowledgeRoute.ts — how much we know about a brand, for the voice worker.
 *
 * POST /athletes/:id/brand-knowledge, mounted at /api/internal/voice (server/index.ts).
 * POST rather than GET only because the key is a free-text brand name from the
 * model rather than an id; the route is a pure read — no writes, no side effects.
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, and the shared secret is the entire authorization boundary.
 * See ./auth for the guard and why the secret is its own rather than CRON_SECRET.
 *
 * ── What this answers, and what it deliberately does NOT ──────────────────────
 * It answers "how much do we know about this brand": `brandKnowledge: "full"` when
 * we hold a real profile, `"thin"` when we hold the brand but little past the
 * basics, `notCached` when we don't hold it at all.
 *
 * It does NOT answer "is this brand a fit for this athlete", and it reads NOTHING
 * about the athlete to produce its answer. An earlier version did: it wrapped
 * `get_brand_fit`, which calls `narrateWhyFits` for a one-sentence audience-overlap
 * line. That is a synchronous Gemini PRO call, measured at >10s on a live brand
 * (Celsius), which on a call is a stall no timeout makes acceptable — raising the
 * cap from 4s to 10s did not fix it, because the problem is structural, not a
 * matter of tuning. The sentence is gone rather than made unreliable, and what
 * remains is the part that was ever grounded: what our records actually contain.
 * `get_brand_fit` (chat) keeps the narrative; a chat pause is invisible.
 *
 * Consequence worth stating: the model must supply the fit judgment itself and own
 * it out loud. The worker's tool description says so explicitly and forbids
 * speaking `brandKnowledge` as if it were a rating of the fit.
 *
 * ── `:id` does NO scoping work on this endpoint ───────────────────────────────
 * Unlike ./scoreRoute and ./dealRoutes, where the path id is the tenancy boundary,
 * here it is inert. `inbox_brands` is a GLOBAL reference table with no `athlete_id`
 * column (shared/schema.ts) — a brand row is owned by nobody and carries no
 * per-athlete data — so this endpoint returns the identical answer for every
 * athlete, and no query below filters by the id.
 *
 * It is kept anyway for three reasons: route-shape consistency with the two
 * sibling voice endpoints, per-athlete traceability in the logs, and so the URL
 * doesn't have to change if a genuinely athlete-derived signal ever lands here.
 *
 * The route itself never looks the athlete up. The shared guard does, once: the
 * deletion fence in voiceAuthorized (./auth.ts) reads the athletes row for every
 * voice route alike, so an id for an athlete that doesn't exist (or whose account
 * is being deleted) gets 410 account_deleting here too, not a brand answer.
 *
 * ── Cache-only, now structurally rather than by guard ─────────────────────────
 * `get_brand` may research an unseen brand (~35s of Gemini + a shared write). This
 * endpoint cannot: it calls `findCachedBrand` (server/mila/tools/getBrandFit.ts),
 * a direct indexed read of `inbox_brands` that never inserts, and it has no import
 * path to services/brandIntel or skills/researchBrand. With the narrate call gone
 * there is no model call on ANY path — the test asserts `narrateWhyFits` is never
 * invoked, which is now an invariant of the code's shape rather than a race the
 * timeout has to win.
 *
 * No brand-authored text crosses this wire in any form, because no free text does:
 * the response is one two-value enum. The untrusted-string handling the previous
 * version needed is gone with the string it was protecting.
 */

import { Router, type Request, type Response } from "express";
import { findCachedBrand } from "../mila/tools/getBrandFit";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";

const logger = createLogger("voice/brandKnowledge");

const router = Router();

/**
 * Bounds the DB read, nothing more. There is no model call on this path, so this
 * is a stalled-pool backstop rather than a latency budget — which is why it is 2s
 * and not the 10s the narrate version needed. A timeout still degrades to
 * `notCached` rather than an error, so a database hiccup costs the athlete an
 * "I don't have them" instead of a failed turn.
 */
const READ_TIMEOUT_MS = 2_000;

/** Longest brand name accepted. Model-supplied free text is always bounded. */
const BRAND_MAX_CHARS = 120;

/**
 * How much profile we hold — NOT a rating of the brand, and NOT a judgment of fit.
 * "full" means the row carries an audience summary on top of being enriched;
 * "thin" means enriched but sparse, so anything said about them stands on little.
 */
type BrandKnowledge = "full" | "thin";

/** The voice wire shape on a cache hit. One enum, nothing else. */
interface VoiceBrandKnowledge {
  brandKnowledge: BrandKnowledge;
}

/** The only other answer: we don't hold this brand. Never a research call. */
interface VoiceBrandKnowledgeMiss {
  notCached: true;
}

const MISS: VoiceBrandKnowledgeMiss = { notCached: true };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// POST /athletes/:id/brand-knowledge — what we hold on one brand.
// Read-only and cache-only: one indexed SELECT, no model call, never researches.
router.post(
  "/athletes/:id/brand-knowledge",
  async (req: Request, res: Response) => {
    // Set before the guard so EVERY response from this route carries it — the
    // app-wide no-store middleware covers /api/v1/me|admin|auth only.
    res.setHeader("Cache-Control", "no-store");

    // NOTE: the answer here is shared brand data the path id does not scope, so
    // the service secret alone would be safe. It goes through the same guard
    // (secret + athlete-bound grant) anyway so there is exactly one rule for
    // /api/internal/voice — see ./auth.ts.
    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    // Validated for shape only — see the header: this id does no scoping work.
    // A malformed one is still rejected here so bad input can't reach the DB.
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

    try {
      // Name only: the worker has no domain to give, so resolution goes through
      // normalizeBrand → normalized_name, exactly as the chat tool resolves it.
      const row = await withTimeout(
        findCachedBrand(brand, null),
        READ_TIMEOUT_MS,
        "voice brand_knowledge",
      );

      // Not held, or held but never enriched — the row `get_brand` would research
      // and this endpoint must not. Both are "we don't have them" to the athlete.
      if (!row || row.enriched_at == null) {
        // Never log the brand: it is model-supplied, untrusted free text.
        logger.info(
          { athleteId: id, outcome: "miss" },
          "Voice brand knowledge miss",
        );
        res.json(MISS);
        return;
      }

      // Empty string counts as absent — a row with a blank summary tells us no
      // more than one with none, so it must not read as a full profile.
      const brandKnowledge: BrandKnowledge = row.audience_summary?.trim()
        ? "full"
        : "thin";

      logger.info(
        { athleteId: id, outcome: "hit", brandKnowledge },
        "Voice brand knowledge hit",
      );
      const body: VoiceBrandKnowledge = { brandKnowledge };
      res.json(body);
    } catch (err: any) {
      // withTimeout is the only thing on this path that rejects with that message
      // and the label is ours, so the match is safe.
      if (
        typeof err?.message === "string" &&
        err.message.includes("timed out")
      ) {
        logger.info(
          { athleteId: id, outcome: "timeout" },
          "Voice brand knowledge timed out",
        );
        res.json(MISS);
        return;
      }

      logger.error(
        { athleteId: id, error: err.message },
        "Voice brand knowledge failed",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
