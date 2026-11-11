/**
 * dealRoutes.ts — read-only deal lookups for the voice worker (internal).
 *
 * GET /athletes/:id/deals           — the athlete's deals, list view
 * GET /athletes/:id/deals/:dealId   — one deal in detail
 * Both mounted at /api/internal/voice (server/index.ts).
 *
 * The caller is TRUSTED INFRASTRUCTURE, not a user: there is no session and no
 * `req.athleteId`, so the athlete id comes from the path and the shared secret is
 * the entire authorization boundary. See ./auth for the guard and why the secret
 * is its own rather than shared with CRON_SECRET.
 *
 * TENANCY: `:id` is passed as the tool's `athleteId`, so both tools filter every
 * query by it server-side. On the detail route `:dealId` is only ever ANDed with
 * that athlete id inside `get_deal` — another athlete's deal resolves to null and
 * answers 404, never their data.
 *
 * ── The reason these routes exist rather than proxying the tools ──────────────
 * `get_deal`'s result carries `thread.subject` and `thread.summary`: BRAND-AUTHORED
 * EMAIL TEXT, i.e. attacker-controlled. The tool wraps it in <external_content>
 * delimiters, but that is a PROMPT construct — it means nothing over HTTP, it would
 * be read aloud verbatim by a TTS layer, and handing it to a voice worker that feeds
 * a model reintroduces exactly the injection surface the wrapper exists to contain.
 * So the mapping below reduces the whole thread to a `hasThread` boolean. Not one
 * character of external text crosses this boundary. `negotiation_state` (untyped
 * jsonb, nothing speakable) is dropped for the same reason.
 */

import { Router, type Request, type Response } from "express";
import { listDealsTool } from "../mila/tools/listDeals";
import { getDealTool } from "../mila/tools/getDeal";
import { modelViewOf } from "../mila/tools/modelView";
import { MILA } from "../mila/config";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";
import { voiceAuthorized, sendVoiceRefusal, UUID_RE } from "./auth";
import {
  OFFER_UNITS,
  type MoneyState,
  type OfferUnit,
  type VoiceOffer,
} from "../mila/offerMoney";
import { readDeliverables } from "../mila/deliverables";
import { dealShape, presentFields } from "./logShape";
import type { Ord, RecAction, Tier } from "../skills/dealScoreGrid";

const logger = createLogger("voice/deals");

const router = Router();

// Derived from the tool's own argsSchema rather than restated, so a change to
// listDeals' accepted values is a type error here instead of a silent drift.
type ListArgs = Parameters<typeof listDealsTool.execute>[1];
type DealStatus = NonNullable<ListArgs["status"]>;
type SortBy = NonNullable<ListArgs["sort_by"]>;

// The literal values still have to be listed for runtime validation; the
// annotations above tie them to the schema. An unknown value is rejected here
// with a 400 rather than reaching execute() and throwing a Zod error into the
// 500 path.
const DEAL_STATUSES: readonly DealStatus[] = [
  "detected",
  "pending",
  "negotiating",
  "accepted",
  "completed",
  "rejected",
];
const SORT_BY: readonly SortBy[] = ["value", "recency"];
const LIMIT_MIN = 1;
const LIMIT_MAX = 10;

const isDealStatus = (v: string): v is DealStatus =>
  DEAL_STATUSES.some((s) => s === v);
const isSortBy = (v: string): v is SortBy => SORT_BY.some((s) => s === v);

/** The voice wire shape for one deal in a list. */
interface VoiceDealSummary {
  dealId: string | null;
  brand: string | null;
  /**
   * The SPEAKABLE figure, or null. Resolved from the thread's structured offer
   * fields — never `deals.amount`, which is a detection-time snapshot that goes
   * stale and which server/lib/dealVoice.ts forbids speaking. Null does NOT mean
   * "free": read `moneyState` to know which silence this is.
   */
  amount: number | null;
  /**
   * Why `amount` is what it is. On the summary because ranking answers come from
   * ONE list call, so the worker has to be able to say "the biggest confirmed
   * number" without treating an uncorroborated deal as a zero.
   */
  moneyState: MoneyState;
  status: string | null;
  dealType: string | null;
  verdict: Ord | null;
  /** ISO 8601, or null when the deal is undated. Lets the worker say "last week". */
  detectedAt: string | null;
  /** The 1–10 grid score, or null when unscored OR out of range. */
  scoreNumeric: number | null;
}

/**
 * Detail adds `hasThread` — never the thread's text — plus the graded fit
 * components behind the verdict.
 *
 * Those four exist so the worker can answer "why is it a good fit" with the
 * actual reasons ("exact sport match, premium brand, athletic audience") rather
 * than reciting the number. They are on DETAIL ONLY, deliberately: the list
 * route already returns up to ten deals, and four more fields per row is payload
 * the model has to hold and reason over to answer a question nobody asked yet.
 *
 * ALL FOUR ARE CLOSED ENUMS. In the stored jsonb each sits beside a model-written
 * `label` (plus `category` and `brandSummary` on brandAnalysis) generated from
 * brand EMAIL TEXT. None of those cross this wire — see the header on why free
 * text must not, and `readFit` in server/mila/tools/getDeal.ts for where they are
 * dropped. `verdictOf`/`tierOf` below re-validate anyway: defense in depth, so an
 * upstream relaxation cannot put an unknown string into speech.
 */
interface VoiceDealDetail extends VoiceDealSummary {
  hasThread: boolean;
  /**
   * The money in full: the point figure or the range, plus what the figure buys
   * (`unit`), whether it repeats, any commission percentage, and whether the
   * number MOVED since detection. Detail-only for the same reason as the fit
   * grades — the list route would carry it ten times over to answer a question
   * nobody asked yet.
   *
   * Numbers and closed enums throughout. `offer_display` ("$75/creative · 15%")
   * is the model-written equivalent and is deliberately unreachable from here.
   */
  offer: VoiceOffer;
  /** sportFit × audienceFit × brandTier → this. The composed fit grade. */
  fitBand: Ord | null;
  sportFit: Ord | null;
  audienceFit: Ord | null;
  brandTier: Tier | null;

  /**
   * The already-reconciled call, plus what gates how firmly it can be spoken.
   *
   * `recommendation` is NOT raw model output: reconcileRecommendation merged it
   * with the grid score under documented rules, and notably CAPS its own
   * auto-correction at `negotiate` — the pipeline never manufactures an
   * `accept`. That is why the worker reports it and owns the call separately
   * rather than speaking it as an instruction.
   *
   * `economicsState` has three values and the middle one is the subtle one:
   * `tbd` means deliverables are known but no price is stated, which the scoring
   * prompt is explicit about — economics is PENDING, not bad, and the score is
   * not depressed for it. Collapsing `tbd` into `unpriced` would make the worker
   * hedge a fit that was fully assessed.
   *
   * `recommendationConfidence: "low"` means UNDER-ASSESSED, not weak: it is set
   * for an unknown-rate athlete or an empty thread, and the prompt states that
   * completeness "NEVER lowers the score floor".
   */
  recommendation: RecAction | null;
  recommendationConfidence: Level | null;
  urgency: Level | null;
  economicsState: EconState | null;
  /** Presence only. The redFlags STRINGS are brand-email-derived and never cross. */
  hasRedFlag: boolean | null;

  /**
   * The four term grades behind the score. `rateComparison` is the money one —
   * and it is ONE OF FOUR, never a verdict on the deal. The scoring prompt makes
   * market comparison "a non-dominant OVERLAY, never the primary driver", so a
   * `poor` rateComparison can legitimately sit inside a deal scored 7/10 and
   * recommended for acceptance. The worker's description carries that rule.
   */
  exclusivity: Ord | null;
  brandRelevance: Ord | null;
  rateComparison: Ord | null;
  deliverableScope: Ord | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// The timestamp columns arrive from drizzle as Date objects, not strings, so
// `str` would silently null them. An Invalid Date would throw on toISOString().
const iso = (v: unknown): string | null =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null;

// The grid emits 1–10 (composeScore, server/skills/dealScoreGrid.ts) — 0 is not
// a producible value. Out of range means the stored jsonb is wrong, so report
// nothing rather than a plausible-looking number: clamping 9999 to 10 would have
// the worker speak "a perfect ten" off corrupt data. Same reject-don't-coerce
// posture as pickTopArea in scoreRoute.ts.
const GRID_MIN = 1;
const GRID_MAX = 10;
const gridScore = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= GRID_MIN && v <= GRID_MAX
    ? v
    : null;

// The verdict enum, typed against Ord (server/skills/dealScoreGrid.ts) so a fifth
// verdict there is a type error here rather than a value this silently drops.
//
// Defense in depth: get_deal and list_deals ALREADY filter verdict against these
// same four values, so nothing out-of-range reaches this mapper today. The guard
// exists so the voice wire stays closed if that upstream check is ever relaxed —
// an unrecognized verdict must never reach speech. Exported so the guard itself
// is directly testable; the route-level fixture alone would pass on the tools'
// filtering whether or not this existed.
const VERDICTS: readonly Ord[] = ["poor", "fair", "good", "great"];
const isOrd = (v: string): v is Ord => VERDICTS.some((k) => k === v);
export const verdictOf = (v: unknown): Ord | null =>
  typeof v === "string" && isOrd(v) ? v : null;

// The brand-tier vocabulary, typed against Tier for the same reason `verdictOf`
// is typed against Ord: a fifth tier in dealScoreGrid.ts becomes a type error
// here rather than a value this silently drops. Exported so the guard is
// directly testable independently of the tool's own filtering.
const TIERS: readonly Tier[] = ["emerging", "mid", "established", "premium"];
const isTier = (v: string): v is Tier => TIERS.some((t) => t === v);
export const tierOf = (v: unknown): Tier | null =>
  typeof v === "string" && isTier(v) ? v : null;

/**
 * The recommendation vocabularies. Typed against `RecAction` for the same reason
 * the two above are typed against Ord/Tier: a fifth action in dealScoreGrid.ts
 * becomes a type error here rather than a value this silently drops.
 *
 * Exported so ./dealBriefRoute re-validates with the identical guards — the two
 * routes must never disagree about what is speakable.
 */
export type Level = "high" | "medium" | "low";
export type EconState = "priced" | "unpriced" | "tbd";

const REC_ACTIONS: readonly RecAction[] = [
  "accept",
  "negotiate",
  "reject",
  "delete",
];
const LEVELS: readonly Level[] = ["high", "medium", "low"];
const ECON_STATES: readonly EconState[] = ["priced", "unpriced", "tbd"];

export const recActionOf = (v: unknown): RecAction | null =>
  typeof v === "string" && REC_ACTIONS.some((a) => a === v)
    ? (v as RecAction)
    : null;
export const levelOf = (v: unknown): Level | null =>
  typeof v === "string" && LEVELS.some((l) => l === v) ? (v as Level) : null;
export const econStateOf = (v: unknown): EconState | null =>
  typeof v === "string" && ECON_STATES.some((s) => s === v)
    ? (v as EconState)
    : null;
/** Tri-state on purpose: null when the deal is unscored — see readRecommendation. */
export const redFlagOf = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const MONEY_STATES: readonly MoneyState[] = [
  "stated",
  "range",
  "unverified",
  "unstated",
];
const moneyStateOf = (v: unknown): MoneyState =>
  typeof v === "string" && MONEY_STATES.some((s) => s === v)
    ? (v as MoneyState)
    : // An unrecognised state must not read as a spoken figure. `unverified` is
      // the conservative landing: it suppresses the number without claiming
      // nobody named one.
      "unverified";

const unitOf = (v: unknown): OfferUnit | null =>
  typeof v === "string" && OFFER_UNITS.some((u) => u === v)
    ? (v as OfferUnit)
    : null;

const pct = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : null;

/**
 * The speakable offer, re-validated at the wire.
 *
 * `resolveVoiceOffer` already bounds and enum-checks every field; this restates
 * the checks for the same reason `verdictOf`/`tierOf` do — defense in depth, so
 * an upstream relaxation cannot put an unbounded number or an unknown word into
 * speech. Numbers and closed enums only; nothing here can carry prose.
 */
export function offerOf(v: unknown): VoiceOffer {
  const o = isRecord(v) ? v : {};
  return {
    amount: num(o.amount),
    low: num(o.low),
    high: num(o.high),
    unit: unitOf(o.unit),
    recurring: typeof o.recurring === "boolean" ? o.recurring : null,
    commissionPct: pct(o.commissionPct),
    // Re-run the allow-list rather than trusting the shape through: the keys
    // are the spoken words here, and this is the last place before TTS.
    deliverables: readDeliverables(o.deliverables),
    moneyState: moneyStateOf(o.moneyState),
    moved: o.moved === true,
  };
}

/**
 * Tool row → wire shape. Field-by-field and allow-list only: anything the tool
 * grows later (thread text, jsonb, a truncation flag) stays out unless it is
 * added here on purpose.
 *
 * MONEY: `amount` is the tool's `offer.amount`, NOT its `amount`. The latter is
 * `deals.amount`, a detection-time snapshot that drifts stale, and speaking it
 * is what server/lib/dealVoice.ts:14-17 forbids. The column is dropped here and
 * never reaches the worker. `moneyState` rides along on the summary so a ranking
 * answer can tell a real figure from one we could not corroborate.
 */
function toSummary(row: Record<string, unknown>): VoiceDealSummary {
  const offer = offerOf(row.offer);
  return {
    dealId: str(row.id),
    brand: str(row.brand_name),
    amount: offer.amount,
    moneyState: offer.moneyState,
    status: str(row.status),
    dealType: str(row.deal_type),
    verdict: verdictOf(row.verdict),
    detectedAt: iso(row.detected_at),
    scoreNumeric: gridScore(row.score_numeric),
  };
}

/**
 * Parsed query params, or the name of the first invalid one. Validating up front
 * keeps a bad param a 400 instead of an exception inside the tool.
 */
function parseListQuery(
  query: Request["query"],
): { ok: true; args: ListArgs } | { ok: false; param: string } {
  const args: ListArgs = {};

  const { status, sort_by: sortBy, limit } = query;

  if (status !== undefined) {
    if (typeof status !== "string" || !isDealStatus(status)) {
      return { ok: false, param: "status" };
    }
    args.status = status;
  }

  if (sortBy !== undefined) {
    if (typeof sortBy !== "string" || !isSortBy(sortBy)) {
      return { ok: false, param: "sort_by" };
    }
    args.sort_by = sortBy;
  }

  if (limit !== undefined) {
    if (typeof limit !== "string") return { ok: false, param: "limit" };
    // Integer only — Number("") is 0 and Number("3.5") is 3.5, both invalid.
    const parsed = Number(limit);
    if (
      limit.trim() === "" ||
      !Number.isInteger(parsed) ||
      parsed < LIMIT_MIN ||
      parsed > LIMIT_MAX
    ) {
      return { ok: false, param: "limit" };
    }
    args.limit = parsed;
  }

  return { ok: true, args };
}

// GET /athletes/:id/deals — the athlete's deals.
// Read-only: no writes, no model call, no side effects.
router.get("/athletes/:id/deals", async (req: Request, res: Response) => {
  // Set before the guard so EVERY response from this route carries it — the
  // app-wide no-store middleware covers /api/v1/me|admin|auth only.
  res.setHeader("Cache-Control", "no-store");

  const voiceAuth = await voiceAuthorized(req, req.params.id);
  if (!voiceAuth.ok) {
    sendVoiceRefusal(res, voiceAuth);
    return;
  }

  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid athlete id" });
    return;
  }

  const parsed = parseListQuery(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: `Invalid ${parsed.param}` });
    return;
  }

  try {
    // The agent loop wraps every tool call in withTimeout; this path bypasses
    // the loop, so the bound has to be applied here.
    // modelViewOf: the voice worker is a model too — the retired deal score never crosses
    // (verdict / scoreNumeric arrive null). See server/mila/tools/modelView.
    const raw = await withTimeout(
      listDealsTool.execute(id, parsed.args),
      MILA.TOOL_TIMEOUT_MS,
      "voice list_deals",
    );
    const result = modelViewOf(listDealsTool, raw);
    // The chat model view fences brand_name (untrusted brand text) for an in-prompt read; this
    // typed wire carries it as a plain field, as before — the worker fences tool output itself.
    const rawBrand = new Map<string, unknown>(
      (isRecord(raw) && Array.isArray((raw as { deals?: unknown }).deals) ? (raw as { deals: unknown[] }).deals : [])
        .filter(isRecord)
        .map((d) => [String(d.id), d.brand_name]),
    );

    // No deals is a normal state, not an error: 200 with an empty array so the
    // worker doesn't have to treat "none yet" as a failure.
    //
    // list_deals returns an OBJECT — { deals, showing, total, filtered_by_status, by_status } — since
    // cross-thread grouping was added. This read used to be `Array.isArray(result) ? … : []`, which is
    // false for an object, so the route answered `{ deals: [] }` for every athlete regardless of what
    // she actually had. The array branch is kept only as a tolerant fallback; the object is the shape.
    const rows = Array.isArray(result)
      ? result
      : isRecord(result) && Array.isArray((result as { deals?: unknown }).deals)
        ? ((result as { deals: unknown[] }).deals)
        : [];
    const deals = rows
      .filter(isRecord)
      .map((r) => toSummary(rawBrand.has(String(r.id)) ? { ...r, brand_name: rawBrand.get(String(r.id)) } : r));

    // Counts and enums only — never a brand, an amount or an id. `money` is the
    // per-deal moneyState tally, which is the one thing worth seeing live: it
    // separates "she spoke a figure" from "she hedged". See ./logShape.
    logger.info(
      {
        athleteId: id,
        tool: "list_deals",
        outcome: deals.length ? "hit" : "empty",
        count: deals.length,
        fields: presentFields(deals[0]),
        money: deals.reduce<Record<string, number>>((acc, d) => {
          acc[d.moneyState] = (acc[d.moneyState] ?? 0) + 1;
          return acc;
        }, {}),
      },
      "Voice tool — list_deals",
    );
    res.json({ deals });
  } catch (err: any) {
    // athleteId only — never the secret, the headers, or thread text.
    logger.error(
      { athleteId: id, error: err.message },
      "Voice deal list failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /athletes/:id/deals/:dealId — one deal.
// `get_deal` ANDs dealId with the athlete id, so a deal belonging to someone
// else is indistinguishable from one that doesn't exist: both 404.
router.get(
  "/athletes/:id/deals/:dealId",
  async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const voiceAuth = await voiceAuthorized(req, req.params.id);
    if (!voiceAuth.ok) {
      sendVoiceRefusal(res, voiceAuth);
      return;
    }

    const { id, dealId } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid athlete id" });
      return;
    }
    if (!UUID_RE.test(dealId)) {
      res.status(400).json({ error: "Invalid deal id" });
      return;
    }

    try {
      const result = modelViewOf(getDealTool, await withTimeout(
        getDealTool.execute(id, { deal_id: dealId }),
        MILA.TOOL_TIMEOUT_MS,
        "voice get_deal",
      ));

      if (!isRecord(result)) {
        res.status(404).json({ error: "No deal" });
        return;
      }

      // `thread` collapses to a boolean here and nowhere else — see the header.
      const detail: VoiceDealDetail = {
        ...toSummary(result),
        hasThread: isRecord(result.thread),
        offer: offerOf(result.offer),
        fitBand: verdictOf(result.fit_band),
        sportFit: verdictOf(result.sport_fit),
        audienceFit: verdictOf(result.audience_fit),
        brandTier: tierOf(result.brand_tier),
        recommendation: recActionOf(result.recommendation),
        recommendationConfidence: levelOf(result.recommendation_confidence),
        urgency: levelOf(result.urgency),
        economicsState: econStateOf(result.economics_state),
        hasRedFlag: redFlagOf(result.has_red_flag),
        exclusivity: verdictOf(result.exclusivity),
        brandRelevance: verdictOf(result.brand_relevance),
        rateComparison: verdictOf(result.rate_comparison),
        deliverableScope: verdictOf(result.deliverable_scope),
      };
      logger.info(
        {
          athleteId: id,
          tool: "get_deal",
          outcome: "hit",
          ...dealShape(detail),
        },
        "Voice tool — get_deal",
      );
      res.json(detail);
    } catch (err: any) {
      logger.error(
        { athleteId: id, dealId, error: err.message },
        "Voice deal detail failed",
      );
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
