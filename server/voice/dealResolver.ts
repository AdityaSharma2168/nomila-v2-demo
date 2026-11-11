/**
 * dealResolver.ts — "does this athlete have a deal with this brand?", by NAME.
 *
 * The lookup behind `get_deal_brief`. Split out of ./dealBriefRoute for the same
 * reason `findCachedBrand` lives beside its tool: the route stays a route, and
 * the matching rule — which has two sharp edges — is testable on its own.
 *
 * ── Why name matching and NOT the thread's brand_id ───────────────────────────
 * THIS IS THE IMPORTANT PART. `deals` has no `brand_id` column; the only
 * structural deal→brand link is indirect, through `inbox_threads.deal_id` +
 * `inbox_threads.brand_id`. Following that FK is the obvious implementation and
 * it is WRONG on live data: the athlete's Prime Hydration deal is linked to a
 * thread whose `brand_id` points at Finish Line. A brand-precedence built on it
 * would answer a question about one brand with another brand's profile, silently
 * and confidently.
 *
 * So the match runs on `normalizeBrand(deals.brand_name)` against
 * `normalizeBrand(<what the athlete said>)` — the SAME normalizer `findCachedBrand`
 * uses, so a name that resolves to an `inbox_brands` row here resolves to the same
 * row there, and the deal half and the brand half of an answer cannot disagree
 * about which brand they are describing.
 *
 * The mis-linked thread rows are a data problem owned elsewhere; this module
 * routes around them rather than depending on them being fixed.
 *
 * ── Duplicate-brand deals are REAL, not hypothetical ──────────────────────────
 * One athlete in the database holds two separate "Handshake AI" deals. A
 * brand-keyed lookup is genuinely ambiguous there, so this returns every match,
 * most recent first, and lets the caller both answer from the newest and disclose
 * that the others exist. Silently picking one and saying nothing would be the
 * worst option: the athlete would get a confident answer about a deal they may
 * not have meant.
 *
 * ── Exact match only ─────────────────────────────────────────────────────────
 * A brand lookup matches on `normalizeBrand` only. The incident-only fuzzy
 * fallback (brandMatch behind MILA_FUZZY_BRAND plus a per-call opt-in) was
 * never switched on and was deleted 2 Nov 2026 (owner decision); the brandMatch
 * module itself followed on 3 Nov 2026 (the agent's deal tools use their own
 * agent/deals/map brandMatches). A spoken partial name ("Prime" for "Prime
 * Hydration") finds nothing here, as it always has live.
 *
 * TENANCY: every query filters by the server-supplied `athleteId`. `brand_name`
 * is matched in memory rather than in SQL because normalizeBrand is a JS function
 * and an athlete holds tens of deals, not thousands — no expression index, no
 * second normalization implementation in SQL that could drift from the first.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads } from "../../shared/schema";
import { normalizeBrand } from "../lib/brandResolver";
import { createLogger } from "../logger";
import { mailboxZeroRetentionEnabled } from "../lib/mailbox/retention";
import { contentWords, haystackOf, matchesAll } from "./campaignMatch";

const logger = createLogger("voice/dealResolver");

/** One of the athlete's deals that matches the named brand. */
export interface MatchedDeal {
  dealId: string;
  brandName: string;
  detectedAt: Date | null;
}

/** One row as loaded from the DB, before it becomes a MatchedDeal. */
interface DealRow {
  id: string;
  brand_name: string;
  detected_at: Date | null;
}

/**
 * Ordering is `detected_at` descending with undated deals LAST: an undated row
 * is missing information, not new information, so it must never outrank a dated
 * one just because null sorts high. `created_at` is not used as a tiebreak —
 * it records when we ingested the row, not when the deal happened.
 */
function toSortedMatches(rows: DealRow[]): MatchedDeal[] {
  return rows
    .map((r) => ({
      dealId: r.id,
      brandName: r.brand_name,
      detectedAt: r.detected_at ?? null,
    }))
    .sort((a, b) => {
      // Undated last, regardless of direction.
      if (a.detectedAt && b.detectedAt) {
        const byDate = b.detectedAt.getTime() - a.detectedAt.getTime();
        if (byDate !== 0) return byDate;
      } else if (!a.detectedAt !== !b.detectedAt) {
        return a.detectedAt ? -1 : 1;
      }
      // ── Deterministic tiebreak ──────────────────────────────────────────────
      // Two deals with the same detected_at — or both undated — used to compare
      // equal, and a stable sort then preserved INPUT order. The input is a
      // SELECT with no ORDER BY, and Postgres does not promise row order without
      // one, so identical calls could return duplicates in different orders and
      // callers reading [0] got a different deal on different requests.
      //
      // That was observable: the voice draft card reported "no in-app send" for
      // a brand whose Gmail thread plainly existed, because the resolve landed on
      // the duplicate row with no messages. Ordering by id is arbitrary but
      // TOTAL, which is the property that was missing.
      return a.dealId < b.dealId ? -1 : a.dealId > b.dealId ? 1 : 0;
    });
}

/**
 * What a brand lookup concluded: the deals under the exactly-matched brand, or
 * none. (`findAthleteDealsByBrand` is the same answer as a plain array.)
 */
export type BrandResolution =
  | { outcome: "match"; deals: MatchedDeal[] }
  | { outcome: "none" };

/**
 * The athlete's deals whose brand name normalizes to the same key as `brand`,
 * most recent first, plus WHY when there are none.
 */
export async function resolveAthleteDealsByBrand(
  athleteId: string,
  brand: string,
): Promise<BrandResolution> {
  const key = normalizeBrand(brand);
  if (!key) return { outcome: "none" };

  const rows = await db
    .select({
      id: deals.id,
      brand_name: deals.brand_name,
      detected_at: deals.detected_at,
    })
    .from(deals)
    .where(eq(deals.athlete_id, athleteId));

  const exact = rows.filter((r) => normalizeBrand(r.brand_name ?? "") === key);
  return exact.length > 0 ? { outcome: "match", deals: toSortedMatches(exact) } : { outcome: "none" };
}

/**
 * The deals only, flattening every non-match to an empty array.
 *
 * Kept as the default entry point because most callers genuinely do not care WHY
 * there were none — `get_deal_brief` says "I don't have them on file" for both.
 * Reach for `resolveAthleteDealsByBrand` when the difference changes what the
 * athlete is told.
 */
export async function findAthleteDealsByBrand(
  athleteId: string,
  brand: string,
): Promise<MatchedDeal[]> {
  const resolution = await resolveAthleteDealsByBrand(athleteId, brand);
  return resolution.outcome === "match" ? resolution.deals : [];
}

/* ══ CAMPAIGN RESOLUTION ═════════════════════════════════════════════════════
 *
 * Everything above answers "which deal is with this BRAND?". Everything below
 * answers "which deal is this CAMPAIGN?" — and it exists because the first
 * question cannot answer the second at all.
 *
 * ── The failure ───────────────────────────────────────────────────────────────
 * "Are there any deals about a FIFA World Cup campaign?" names no brand. Every
 * brand lookup compares name-shaped strings, so it finds nothing,
 * ./dealBriefRoute answers `notCached`, and the worker — correctly, per its own
 * instructions — tells the athlete they have no such deal. On live data that was
 * false: the deal is stored under brand_name "Tec-Do" (the AGENCY, not the
 * advertiser), and the words the athlete used appear only in the thread's
 * subject, the thread's summary, and the classifier's summary in
 * `deals.raw_data`.
 *
 * ── What is searched, and what is NOT returned ────────────────────────────────
 * Three text sources, unioned per deal: `deals.raw_data.summary`,
 * `inbox_threads.subject`, `inbox_threads.summary`. All three are brand-authored
 * or model-written-from-brand-authored, i.e. UNTRUSTED.
 *
 * They are MATCHED ON and never RETURNED. What crosses back is a dealId and a
 * brand name, both of which already cross the voice wire today (./dealRoutes).
 * Not one character of email text enters the model's context through this path —
 * ./threadRoutes remains the only door for that, and it is still opened
 * deliberately, once, on a dealId the athlete has effectively confirmed. This is
 * the distinction that made the change acceptable: `raw_data.summary` is
 * documented in server/mila/tools/getDeal.ts as never returned, and it still
 * isn't.
 *
 * The injection surface it does open is bounded and worth naming: a brand can
 * write a subject line designed to match a campaign the athlete asks about, and
 * so surface THEIR deal instead of the intended one. But every candidate is
 * already this athlete's own deal — the query is athlete-scoped exactly as the
 * brand path is — so the worst case is the wrong one of your own deals, not a
 * stranger's, and not text you didn't ask for.
 *
 * ── Why only the MATCHING deals come back ────────────────────────────────────
 * The brand path returns every deal under the winning brand, because the athlete
 * named the brand and all of them are equally theirs. This path must not, and
 * the live data shows why: the athlete holds TWO deals under "Tec-Do", from two
 * different threads. One is the FIFA campaign; the other is a skincare enquiry
 * detected seven minutes later. Widening to "all deals of the winning brand"
 * would sort the NEWER, unrelated one first and brief it — with the right brand
 * name attached, which is precisely what would make it hard to notice.
 *
 * So `matched` is filtered before it is grouped, and `otherDealCount` upstream
 * stays truthful: it counts other deals that are ALSO this campaign, which is
 * the only reading that makes sense for a campaign-keyed answer.
 *
 * ── No deploy flag, deliberately ─────────────────────────────────────────────
 * This path runs only after the brand path returned nothing, so it can add
 * resolutions where there are currently none and cannot alter a single lookup
 * that succeeds today; and its one caller (./dealBriefRoute) only speaks.
 * Reverting is deleting the call site.
 */

/**
 * What a campaign lookup concluded. Same three-way shape as `BrandResolution`,
 * and `ambiguous` carries BRAND names for the same reason: they are the
 * athlete's own stored names, already how every deal reaches voice, so the
 * worker can ask "the Tec-Do one or the Poke World Cup one?" instead of
 * inventing a way to describe two campaigns.
 */
export type CampaignResolution =
  | { outcome: "match"; deals: MatchedDeal[] }
  | { outcome: "ambiguous"; names: string[] }
  | { outcome: "none" };

/** Reads `raw_data.summary` without trusting the blob's shape. */
function summaryOf(rawData: unknown): string | null {
  const summary = (rawData as { summary?: unknown } | null)?.summary;
  return typeof summary === "string" ? summary : null;
}

/**
 * The athlete's deals whose campaign text contains every content word of
 * `phrase`, most recent first, plus WHY when there are none.
 *
 * Strict by construction — see ./campaignMatch for why a miss is the cheap
 * failure and a wrong match is not.
 *
 * TENANCY: both queries filter on the server-supplied `athleteId`, and the
 * thread query filters on it AGAIN rather than trusting the deal join, so a
 * mis-linked thread row cannot pull another athlete's text into the haystack.
 */
export async function resolveAthleteDealsByCampaign(
  athleteId: string,
  phrase: string,
): Promise<CampaignResolution> {
  const words = contentWords(phrase);
  // A phrase with no identity in it ("the deal") must never select everything.
  // ./campaignMatch refuses an empty set too; this is the cheaper stop.
  if (words.length === 0) return { outcome: "none" };

  const rows = await db
    .select({
      id: deals.id,
      brand_name: deals.brand_name,
      detected_at: deals.detected_at,
      // Read for ONE key — `summary`. The rest of the blob (contact_name,
      // contact_email, deadline, thread ids) is PII and is neither read nor
      // returned; see `summaryOf`.
      raw_data: deals.raw_data,
    })
    .from(deals)
    .where(eq(deals.athlete_id, athleteId));

  if (rows.length === 0) return { outcome: "none" };

  const threadRows = await db
    .select({
      deal_id: inboxThreads.deal_id,
      // Zero retention: the stored subject is not read; the campaign text is the derived
      // summaries alone.
      subject: mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
      summary: inboxThreads.summary,
    })
    .from(inboxThreads)
    .where(
      and(
        eq(inboxThreads.athlete_id, athleteId),
        inArray(
          inboxThreads.deal_id,
          rows.map((r) => r.id),
        ),
      ),
    );

  // A deal can carry more than one thread; every one of them contributes.
  const threadTextByDeal = new Map<string, (string | null)[]>();
  for (const t of threadRows) {
    if (!t.deal_id) continue;
    const bucket = threadTextByDeal.get(t.deal_id) ?? [];
    bucket.push(t.subject, t.summary);
    threadTextByDeal.set(t.deal_id, bucket);
  }

  const matched = rows.filter((r) =>
    matchesAll(
      words,
      haystackOf([
        summaryOf(r.raw_data),
        ...(threadTextByDeal.get(r.id) ?? []),
      ]),
    ),
  );

  if (matched.length === 0) {
    // Never log the phrase: it is model-supplied, untrusted free text. Counts
    // and outcomes only.
    logger.info(
      {
        athleteId,
        outcome: "none",
        words: words.length,
        candidates: rows.length,
      },
      "Campaign match did not resolve",
    );
    return { outcome: "none" };
  }

  // ── Group by brand. A tie ACROSS brands is a question, not an answer. ───────
  // Keyed on normalizeBrand so two spellings of one brand are one group, with a
  // per-deal fallback key for a brand_name that normalizes to empty — those must
  // not collapse into a single phantom group.
  const byKey = new Map<string, { name: string; rows: typeof matched }>();
  for (const r of matched) {
    const key = normalizeBrand(r.brand_name ?? "") || `id::${r.id}`;
    const group = byKey.get(key);
    if (group) group.rows.push(r);
    else byKey.set(key, { name: r.brand_name, rows: [r] });
  }

  if (byKey.size > 1) {
    const names = [...byKey.values()].map((g) => g.name);
    logger.info(
      {
        athleteId,
        outcome: "ambiguous",
        words: words.length,
        tied: names.length,
      },
      "Campaign match tied across brands",
    );
    // Every tied name, unsliced. The route decides how many are speakable.
    return { outcome: "ambiguous", names };
  }

  const [only] = [...byKey.values()];
  logger.info(
    {
      athleteId,
      outcome: "match",
      words: words.length,
      candidates: rows.length,
      deals: only.rows.length,
    },
    "Campaign match resolved",
  );
  return { outcome: "match", deals: toSortedMatches(only.rows) };
}
