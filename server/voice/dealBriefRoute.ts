/**
 * dealBriefRoute.ts — one brand-keyed question, one answer, no id.
 *
 * POST /athletes/:id/deal-brief, mounted at /api/internal/voice (server/index.ts).
 * The caller is TRUSTED INFRASTRUCTURE: no session, no `req.athleteId`, and the
 * shared secret is the entire authorization boundary. See ./auth.
 *
 * ── Why this exists: the four-hop dead end ────────────────────────────────────
 * Nothing answered "tell me about my Prime Hydration deal". `get_deal` needed a
 * uuid, `get_brand_brief` knew nothing about deals, and `list_deals` was a list.
 * So the model had to call list_deals, extract a uuid, call get_deal, get back a
 * verdict with no depth, then call get_brand_brief and be told notCached.
 *
 * That bind produced three symptoms live, all of them the same wound:
 *   - an intermittent MALFORMED_FUNCTION_CALL that ended the turn in silence;
 *   - a fabricated "I'll look into it" that invented a fit we did not hold;
 *   - and finally the bind spoken out loud — "I'm not seeing a specific deal ID
 *     for them right now" — the model narrating its own plumbing to the athlete.
 *
 * This route takes a BRAND NAME and nothing else. There is no argument the model
 * can fail to produce, so there is no call to garble, no id to be missing, and no
 * hop that can dead-end. That is a by-construction fix for the shape of the
 * problem; it is NOT a verified fix for the MALFORMED fault itself, which is
 * intermittent and model-side. Expect frequency to drop, do not expect proof.
 *
 * ── Precedence: deal > inbox > none ───────────────────────────────────────────
 * A brand the athlete has a DEAL with is a brand we know something about, even if
 * `inbox_brands` never enriched it. Prime Hydration is exactly that case: an open
 * $3,000 deal with a live thread, and an unenriched brand row, so the brand-only
 * endpoint correctly-but-uselessly answered `notCached`.
 *
 * Matching is by NAME (./dealResolver) and never by the linked thread's brand_id
 * — see that module's header for the live mis-link that would otherwise answer
 * Prime with Finish Line's profile.
 *
 * ── What crosses this wire ────────────────────────────────────────────────────
 * The same allow-list discipline as ./dealRoutes and ./brandBriefRoute, composed
 * rather than reimplemented: the deal half is `get_deal`'s already-mapped result
 * (closed enums + numbers, `thread` collapsed to a boolean), and the brand half
 * is the enum plus app-generated narrative from ./brandFitStore. No brand-authored
 * text, no thread text, no jsonb labels. Both halves are re-validated here even
 * though their sources validate too — this is the surface that reaches a TTS
 * layer, where any free text would be read aloud verbatim.
 */

import { Router, type Request, type Response } from "express";
import { findCachedBrand } from "../mila/tools/getBrandFit";
import { getDealTool } from "../mila/tools/getDeal";
import { modelViewOf } from "../mila/tools/modelView";
import { MILA } from "../mila/config";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import {
  findAthleteDealsByBrand,
  resolveAthleteDealsByCampaign,
} from "./dealResolver";
import { getBrandFitReasons, type BrandFitReasons } from "./brandFitStore";
import { enqueueBrandFitFill } from "./brandFitFill";
import {
  verdictOf,
  tierOf,
  recActionOf,
  levelOf,
  econStateOf,
  redFlagOf,
  offerOf,
  type Level,
  type EconState,
} from "./dealRoutes";
import {
  resolveRateRead,
  type VoiceOffer,
  type VoiceRateRead,
} from "../mila/offerMoney";
import { readBrandProfile, type VoiceBrandProfile } from "./brandProfile";
import { dealShape, presentFields } from "./logShape";
import {
  enqueueBrandNarration,
  getCachedBrandSummary,
  type BrandNarrationInput,
} from "./brandNarration";
import type { Ord, RecAction, Tier } from "../skills/dealScoreGrid";

const logger = createLogger("voice/dealBrief");

const router = Router();

/** Bounds the non-model reads. Same stalled-pool backstop as the sibling routes. */
const READ_TIMEOUT_MS = 2_000;

/** Longest brand name accepted. Model-supplied free text is always bounded. */
const BRAND_MAX_CHARS = 120;

type BrandKnowledge = "full" | "thin";

/** The deal half. Mirrors ./dealRoutes' detail shape — enums and numbers only. */
interface VoiceBriefDeal {
  dealId: string | null;
  brand: string | null;
  /**
   * The SPEAKABLE figure, from the thread's structured offer — never
   * `deals.amount`, whose detection-time snapshot drifts stale and which
   * server/lib/dealVoice.ts:14-17 forbids speaking. Null when nothing is safe to
   * say; `offer.moneyState` says which silence it is.
   */
  amount: number | null;
  /** The money in full. Numbers and closed enums — see ./dealRoutes. */
  offer: VoiceOffer;
  /**
   * WHAT ONE POST IS WORTH, computed here rather than asked of the model.
   *
   * Live, she had "four posts, three thousand dollars" and "your rate's two
   * twenty a post" and said "three thousand is comfortably above your usual
   * per-post rate" — a TOTAL against a PER-POST rate. It landed right by luck;
   * at $1,200 across six posts the same method calls $200-a-post "comfortably
   * above" $220. And on a $500 single post she skipped the arithmetic entirely
   * and read `rateComparison` aloud, which said "low" while the division said
   * 2.3x.
   *
   * So the division is done in ../mila/offerMoney and handed over as a fact.
   * Note what that makes possible: `rateComparison` is KIMI'S judgment off the
   * email (`fr = parsed.factorRatings`), not the rate-card comparison it looks
   * like, so it can disagree with plain arithmetic — and now the arithmetic is
   * on the wire to be believed instead.
   */
  rateRead: VoiceRateRead;
  status: string | null;
  dealType: string | null;
  detectedAt: string | null;
  verdict: Ord | null;
  scoreNumeric: number | null;
  hasThread: boolean;
  fitBand: Ord | null;
  sportFit: Ord | null;
  audienceFit: Ord | null;
  brandTier: Tier | null;
  /**
   * The already-reconciled call and its gates. Identical shape and identical
   * guards to ./dealRoutes' detail — the two surfaces must never disagree about
   * what is speakable, which is why the validators are imported rather than
   * restated. See that interface for what each field means and what it does not.
   */
  recommendation: RecAction | null;
  recommendationConfidence: Level | null;
  urgency: Level | null;
  economicsState: EconState | null;
  hasRedFlag: boolean | null;
  exclusivity: Ord | null;
  brandRelevance: Ord | null;
  rateComparison: Ord | null;
  deliverableScope: Ord | null;
}

/**
 * `source` names which precedence tier answered, so the worker can tell "your
 * deal with them" from "a brand we hold but you have no deal with" without
 * inferring it from which keys happen to be present.
 */
interface VoiceDealBrief {
  source: "deal" | "brand";
  /**
   * How the deal was found, when it was NOT found by brand name.
   *
   * Absent means the ordinary thing happened: the athlete said a brand and we
   * matched it. `"campaign"` means they described the WORK — "the FIFA World Cup
   * campaign", "the reaction video deal" — and ./dealResolver resolved it from
   * the thread's text instead. The worker needs the difference because the
   * answer it speaks has to name the brand back: the athlete never said
   * "Tec-Do", so a reply that opens with the deal's terms and no brand leaves
   * them unsure which deal was found.
   *
   * Only ever present alongside `source: "deal"`.
   */
  matchedBy?: "campaign";
  deal?: VoiceBriefDeal;
  /**
   * The `inbox_brands` row this answer resolved to, when we hold one. Present
   * for MEMORY, not for speech: the worker records what was discussed and the
   * artifact keys brands by id (ids are ours; names are extracted from brand
   * email). Absent when the brand is unenriched — the Prime Hydration shape,
   * where a deal exists and no brand row was ever researched.
   */
  brandId?: number;
  /** Present and > 0 only when the athlete holds MORE deals with this brand. */
  otherDealCount?: number;
  brandKnowledge?: BrandKnowledge;
  /**
   * The researched tier and the sports they market in — allow-listed against
   * fixed lists in ./brandProfile, so the words are ours rather than the row's.
   * Omitted entirely when we hold no enriched brand, and omitted when both
   * fields came back empty, so its presence always means there is something to
   * say.
   *
   * Deliberately NOT added to ./brandBriefRoute or ./brandKnowledgeRoute in this
   * change: those two are documented as returning byte-identical cold bodies,
   * and `get_deal_brief` is the only brand-keyed tool the worker registers, so
   * widening one of the pair here would break that invariant for no live gain.
   */
  brandProfile?: VoiceBrandProfile;
  /**
   * ONE SENTENCE ABOUT THE COMPANY, WRITTEN BY US — not the row's description.
   *
   * `inbox_brands.description`, `.audience_summary` and `enrichment.content_style`
   * are web-grounded free text and none of them cross this wire. They are the
   * INPUT to ./brandNarration's constrained summarizer, and this is its output,
   * re-gated on the way back. See that module for why summarizing beats
   * filtering on attacker-influenceable prose.
   *
   * Absent on a cold brand (nothing narrated yet — a fill is enqueued after the
   * response) and absent on a brand whose narration produced nothing. Both are
   * ordinary; the brand still has its tier, partners and categories.
   */
  brandSummary?: string;
  reasons?: BrandFitReasons;
}

interface VoiceDealBriefMiss {
  notCached: true;
}

const MISS: VoiceDealBriefMiss = { notCached: true };

/**
 * A campaign phrase that fits two or more of the athlete's brands equally well.
 *
 * Answered as a 200 with the tied brand names rather than a miss: the athlete
 * DOES have matching deals, so `notCached` would be a false claim about their
 * records. She asks which one and the next call resolves.
 *
 * Capped at 3 because this is spoken aloud, and a longer list reads as a menu
 * rather than a question.
 */
const AMBIGUOUS_MAX = 3;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
// `num` used to live here for `amount`. It went with the column: money now comes
// from `offerOf` (./dealRoutes), which does its own bounds checking.
const iso = (v: unknown): string | null =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null;

// Same 1–10 bound as ./dealRoutes: out of range means the stored jsonb is wrong,
// so report nothing rather than a plausible-looking number.
const GRID_MIN = 1;
const GRID_MAX = 10;
const gridScore = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= GRID_MIN && v <= GRID_MAX
    ? v
    : null;

/** `get_deal`'s result → the wire shape. Allow-list only; `thread` never crosses. */
function toBriefDeal(row: Record<string, unknown>): VoiceBriefDeal {
  // Money comes from the tool's resolved `offer`, and `deals.amount` is dropped
  // at this boundary — see VoiceBriefDeal.amount and ./dealRoutes' toSummary.
  const offer = offerOf(row.offer);
  return {
    rateRead: resolveRateRead(offer),
    dealId: str(row.id),
    brand: str(row.brand_name),
    amount: offer.amount,
    offer,
    status: str(row.status),
    dealType: str(row.deal_type),
    detectedAt: iso(row.detected_at),
    verdict: verdictOf(row.verdict),
    scoreNumeric: gridScore(row.score_numeric),
    hasThread: isRecord(row.thread),
    fitBand: verdictOf(row.fit_band),
    sportFit: verdictOf(row.sport_fit),
    audienceFit: verdictOf(row.audience_fit),
    brandTier: tierOf(row.brand_tier),
    recommendation: recActionOf(row.recommendation),
    recommendationConfidence: levelOf(row.recommendation_confidence),
    urgency: levelOf(row.urgency),
    economicsState: econStateOf(row.economics_state),
    hasRedFlag: redFlagOf(row.has_red_flag),
    exclusivity: verdictOf(row.exclusivity),
    brandRelevance: verdictOf(row.brand_relevance),
    rateComparison: verdictOf(row.rate_comparison),
    deliverableScope: verdictOf(row.deliverable_scope),
  };
}

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Whether the profile holds anything worth putting on the wire. An enriched row
 * whose tier is null and whose every sport failed the allow-list has nothing to
 * say, and sending `{ tier: null, sportCategories: [] }` would invite the model
 * to narrate the absence.
 */
const hasBrandProfile = (p: VoiceBrandProfile): boolean =>
  p.tier !== null ||
  p.partnershipStyle !== null ||
  p.sportCategories.length > 0 ||
  p.productCategories.length > 0 ||
  p.partnerships.length > 0;

/**
 * The brand half: how much we hold, plus the precomputed narrative if there is
 * one. Returns null when we hold no enriched brand row at all — which is NOT a
 * miss on the deal branch, only on the brand branch.
 *
 * Reject-don't-coerce on the reasons: all three angles or none, because a partial
 * fit rationale read aloud is worse than the honest short answer.
 */
async function brandHalf(
  athleteId: string,
  brand: string,
): Promise<{
  brandKnowledge: BrandKnowledge;
  brandId: number;
  brandName: string;
  reasons: BrandFitReasons | null;
  profile: VoiceBrandProfile;
  /**
   * The cached sentence, or undefined when this brand has never been narrated.
   * Three-valued — see ./brandNarration. `null` means we tried and got nothing.
   */
  summary: string | null | undefined;
  /**
   * The RAW prose, carried for the fill and nothing else. It is never mapped
   * onto the wire; the only thing that reads it is the summarizer.
   */
  narrationInput: BrandNarrationInput;
} | null> {
  const row = await withTimeout(
    findCachedBrand(brand, null),
    READ_TIMEOUT_MS,
    "voice deal_brief brand lookup",
  );
  if (!row || row.enriched_at == null) return null;

  const reasons = await withTimeout(
    getBrandFitReasons(athleteId, row.id),
    READ_TIMEOUT_MS,
    "voice deal_brief store read",
  );

  return {
    brandKnowledge: row.audience_summary?.trim() ? "full" : "thin",
    brandId: row.id,
    brandName: row.name,
    // Two allow-listed fields off the same row. Everything else on it —
    // description, audience_summary, partnerships, the enrichment blob — stays
    // behind; see ./brandProfile on why these two are different.
    profile: readBrandProfile(row),
    summary: getCachedBrandSummary(row.id),
    narrationInput: {
      brandId: row.id,
      brandName: row.name,
      description: row.description,
      audienceSummary: row.audience_summary,
      contentStyle: (row.enrichment as { content_style?: unknown } | null)
        ?.content_style,
    },
    reasons:
      reasons &&
      nonEmptyString(reasons.audience) &&
      nonEmptyString(reasons.credibility) &&
      nonEmptyString(reasons.whitespace)
        ? reasons
        : null,
  };
}

// POST /athletes/:id/deal-brief — everything we hold on one named brand.
// Cache-only and precomputed: never researches, never narrates on the request
// path, never needs an id.
router.post("/athletes/:id/deal-brief", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");

  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) {
    sendVoiceRefusal(res, voiceAuth);
    return;
  }

  // Load-bearing: it scopes the deal match, the athlete reads inside get_deal,
  // and the store key. Shape-validated so bad input can't reach the DB.
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

  let coldFill: { brandId: number; brandName: string } | null = null;

  try {
    // ── 1. Deal first. ────────────────────────────────────────────────────────
    let matches = await withTimeout(
      findAthleteDealsByBrand(id, brand),
      READ_TIMEOUT_MS,
      "voice deal_brief deal lookup",
    );

    // ── 1b. Campaign. Only when the brand path found nothing. ─────────────────
    // The athlete may have named the WORK rather than the company — "the FIFA
    // World Cup campaign" for a deal stored under the agency's name. This pass
    // matches the phrase against the deal's own text server-side; see
    // ./dealResolver for what is searched and why none of it is returned.
    //
    // Ordered strictly after the brand path so every lookup that resolves today
    // resolves identically, and it never runs on that path.
    let matchedBy: "brand" | "campaign" = "brand";
    if (matches.length === 0) {
      const campaign = await withTimeout(
        resolveAthleteDealsByCampaign(id, brand),
        READ_TIMEOUT_MS,
        "voice deal_brief campaign lookup",
      );

      if (campaign.outcome === "ambiguous") {
        // Never log the phrase — model-supplied untrusted text. Counts only.
        logger.info(
          {
            athleteId: id,
            tool: "get_deal_brief",
            outcome: "ambiguous",
            tied: campaign.names.length,
          },
          "Voice tool — get_deal_brief (campaign ambiguous)",
        );
        res.json({ ambiguous: campaign.names.slice(0, AMBIGUOUS_MAX) });
        return;
      }

      if (campaign.outcome === "match") {
        matches = campaign.deals;
        matchedBy = "campaign";
      }
    }

    if (matches.length > 0) {
      // Most recent wins; the rest are disclosed by count so she can say "you've
      // got two with them, I'm looking at the newer one" rather than picking one
      // silently. See ./dealResolver on why this ambiguity is real.
      const chosen = matches[0];
      // The retired deal score never reaches the voice model (verdict / scoreNumeric → null).
      const detail = modelViewOf(getDealTool, await withTimeout(
        getDealTool.execute(id, { deal_id: chosen.dealId }),
        MILA.TOOL_TIMEOUT_MS,
        "voice deal_brief get_deal",
      ));

      if (isRecord(detail)) {
        // On a campaign match the athlete never said the brand, so `brand` is a
        // campaign phrase and would find no brand row. Use the name we RESOLVED
        // instead, so a campaign-keyed answer carries the same brand half a
        // brand-keyed one would.
        const brandForHalf =
          matchedBy === "campaign" ? chosen.brandName : brand;
        const brandInfo = await brandHalf(id, brandForHalf).catch(() => null);
        // Legacy retirement, phase 1 (owner decision 8 Oct 2026): no computed rate card to compare against, so
        // rateRead carries the per-deliverable figure only (athleteRate / rateMultiple are null — the worker
        // already treats them as absent). Rates are being rebuilt.
        const body: VoiceDealBrief = {
          source: "deal",
          deal: toBriefDeal(detail),
        };
        if (matchedBy === "campaign") body.matchedBy = "campaign";
        if (matches.length > 1) body.otherDealCount = matches.length - 1;
        if (brandInfo) {
          body.brandId = brandInfo.brandId;
          body.brandKnowledge = brandInfo.brandKnowledge;
          // Only when there is something in it — an empty object on the wire
          // reads to the model as "we looked and found nothing", which is a
          // different claim from "we did not have this".
          if (hasBrandProfile(brandInfo.profile)) {
            body.brandProfile = brandInfo.profile;
          }
          if (brandInfo.summary) body.brandSummary = brandInfo.summary;
          if (brandInfo.reasons) body.reasons = brandInfo.reasons;
          else coldFill = brandInfo;
        }

        logger.info(
          {
            athleteId: id,
            tool: "get_deal_brief",
            outcome: "deal",
            matchedBy,
            matches: matches.length,
            // Top-level keys, then the deal's own shape. Presence and enums
            // only — see ./logShape on why no value crosses into a log.
            fields: presentFields(body),
            ...dealShape(body.deal),
            brandProfile: presentFields(body.brandProfile),
            hasReasons: !!body.reasons,
          },
          "Voice tool — get_deal_brief (deal branch)",
        );
        res.json(body);
        // Fill AFTER responding: a deal answer must never wait on, or be changed
        // by, a narrative that isn't ready.
        if (coldFill) enqueueFill(id, coldFill);
        // `undefined` means never attempted; `null` means attempted and empty,
        // which must NOT retry — see ./brandNarration's cache docblock.
        if (brandInfo && brandInfo.summary === undefined) {
          enqueueNarration(brandInfo.narrationInput);
        }
        return;
      }
      // The deal vanished between the match and the read (or belongs to someone
      // else, which get_deal reports the same way). Fall through to the brand
      // branch rather than 500ing — the brand half may still be worth speaking.
    }

    // ── 2. Brand. ─────────────────────────────────────────────────────────────
    const brandInfo = await brandHalf(id, brand);
    if (!brandInfo) {
      // Never log the brand: it is model-supplied, untrusted free text.
      logger.info(
        { athleteId: id, tool: "get_deal_brief", outcome: "miss" },
        "Voice tool — get_deal_brief (notCached)",
      );
      res.json(MISS);
      return;
    }

    const body: VoiceDealBrief = {
      source: "brand",
      brandId: brandInfo.brandId,
      brandKnowledge: brandInfo.brandKnowledge,
    };
    if (hasBrandProfile(brandInfo.profile)) {
      body.brandProfile = brandInfo.profile;
    }
    if (brandInfo.summary) body.brandSummary = brandInfo.summary;
    if (brandInfo.reasons) body.reasons = brandInfo.reasons;
    else coldFill = brandInfo;

    logger.info(
      {
        athleteId: id,
        tool: "get_deal_brief",
        outcome: "brand",
        brandId: brandInfo.brandId,
        fields: presentFields(body),
        brandProfile: presentFields(body.brandProfile),
        brandKnowledge: body.brandKnowledge,
        hasReasons: !!body.reasons,
      },
      "Voice tool — get_deal_brief (brand branch)",
    );
    res.json(body);
    if (coldFill) enqueueFill(id, coldFill);
    if (brandInfo.summary === undefined) {
      enqueueNarration(brandInfo.narrationInput);
    }
  } catch (err: any) {
    if (typeof err?.message === "string" && err.message.includes("timed out")) {
      logger.info(
        { athleteId: id, outcome: "timeout" },
        "Voice deal brief timed out",
      );
      res.json(MISS);
      return;
    }
    logger.error(
      { athleteId: id, error: err.message },
      "Voice deal brief failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Starts the brand-summary narration. Guarded for the same reason `enqueueFill`
 * is: the response is already on the wire, so a throw here could only escape as
 * an unhandled rejection.
 */
function enqueueNarration(input: BrandNarrationInput): void {
  try {
    enqueueBrandNarration(input);
  } catch (err: any) {
    logger.error(
      { brandId: input.brandId, error: err?.message },
      "Brand narration enqueue threw",
    );
  }
}

/**
 * Starts the narrative fill for a pair we answered without one. Guarded because
 * the response is already sent: a throw here could only escape as an unhandled
 * rejection, never as a status the caller sees.
 */
function enqueueFill(
  athleteId: string,
  target: { brandId: number; brandName: string },
): void {
  try {
    enqueueBrandFitFill(athleteId, target.brandId, target.brandName);
  } catch (err: any) {
    logger.error(
      { athleteId, brandId: target.brandId, error: err?.message },
      "Deal brief fill enqueue threw",
    );
  }
}

export default router;
