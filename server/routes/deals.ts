/**
 * deals.ts — Authenticated deal endpoints.
 *
 * GET  /api/v1/me/deals              — list deals (filters: status, category)
 * GET  /api/v1/me/deals/:id          — deal detail with thread, messages, brand
 * PATCH /api/v1/me/deals/:id         — update status / negotiation notes
 * POST /api/v1/me/deals/:id/draft    — stream AI draft reply (SSE), tone-aware
 */

import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { deliveredOnly } from "../services/relay/delivered";
import { db } from "../db";
import { composeDealVoice } from "../lib/dealVoice";
import { computeDealRank, threadAgeDays, type DealRankInput } from "../lib/dealRanking";
import {
  deals,
  inboxThreads,
  inboxMessages,
  inboxBrands,
  athletes,
  agentActions,
  payments,
} from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { generateDealDraft } from "../services/dealDraft";
import {
  type ReplyIntent,
  type DraftStyle,
  type DraftVoice,
} from "../lib/draftPrompt";
import { draftLimiter } from "../lib/rateLimit";
import { signedAttachmentUrl } from "../lib/inboxAttachmentStore";
import { mailboxLiveReadsEnabled } from "../lib/mailbox";
import { mailboxZeroRetentionEnabled, sendableAddress } from "../lib/mailbox/retention";
import { derivedThreadTitle, presentThread, threadColumns } from "../lib/threadTitle";
import { resolveMoneyForDeals } from "../services/dealValueStore";
import { resolveThreadInbox, resolveThreadInboxes, toInboxPayload } from "../services/threadInbox";
import { createLogger } from "../logger";
import { observedStageOf } from "../lib/observedStage";
import { paperworkForDeals } from "../skills/paperwork";
import { DISPOSITIONS, disposeDeal, type Disposition } from "../services/dealDispose";
import { partnerIntakeEnabled } from "../services/partner/config";
import { markOpportunityRequestsSeen } from "../services/partner/prequal";
import { dealPositions, readOpportunityBoard } from "../services/opportunityBoard";
import { clearMaybeOnOpen, readOpportunityDetail } from "../services/opportunityDetail";
import { searchDeals } from "../services/opportunitySearch";
import { isReplyIntent as isSharedReplyIntent, type ReplyIntent as SharedReplyIntent } from "../../shared/deals";
import { confirmSigned } from "../skills/dealSigning";
import { readBrandPage } from "../services/brandPage";
import { splitDeal } from "../skills/dealSplit";
import { threadOnDeal } from "../lib/dealAttachmentScope";

const logger = createLogger("routes/deals");
const router = Router();

// ─── Shared types ─────────────────────────────────────────────────────────────

const VALID_DEAL_STATUSES = ["detected","pending","negotiating","accepted","completed","rejected"] as const;
type DealStatus = typeof VALID_DEAL_STATUSES[number];

// WS3 §3.1 adds `request_terms` as a first-class intent (see draftPrompt.ReplyIntent).
const VALID_INTENTS: readonly ReplyIntent[] = ["accept", "negotiate", "request_terms", "decline"];
const VALID_STYLES:  readonly DraftStyle[]  = ["friendly", "professional"];
const VALID_VOICES:  readonly DraftVoice[]  = ["athlete", "agent"];

// Prompt assembly, email framing, the leak linter, and draft generation itself now
// live in ../services/dealDraft (the single draft core shared with Mila's
// draft_reply tool); the route below is a thin SSE shell over it.

// Input caps (A14) — keep uncontrolled strings out of the notes JSONB history.
const MAX_NOTES_LEN        = 2000;
const MAX_HISTORY_ENTRIES  = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A non-UUID :id makes Postgres throw (500); validate shape → 404 up front.
const isUuid = (s: string): boolean => UUID_RE.test(s);
// INTENT_INSTRUCTIONS (incl. WS3 §3.1 request_terms) live in ../lib/draftPrompt.

// ─── Shared deal loader (used by GET /deals) ─────────────────────────────────
// One query + one enrichment pass so the list and the Brief agree on voice, rank,
// and thread-age. Ranking (WS3 §3.7) is decided HERE, server-side, not on the client.

// Canonical-deal selection within a cross-thread group: most-advanced status wins, then the
// most recent. Terminal states sort low so an active thread represents the group.
const GROUP_STATUS_RANK: Record<string, number> = {
  accepted: 4, negotiating: 3, pending: 2, detected: 1, completed: 0, rejected: -1,
};

/** Sum of stated $ figures on a row's offer — used to pick the richest-offer member of a group. */
function offerScore(row: any): number {
  const amounts = (row?.conversation_state as any)?.key_details?.amounts;
  return Array.isArray(amounts) ? amounts.reduce((n: number, x: any) => n + (Number(x) || 0), 0) : 0;
}

/**
 * Collapse rows sharing a deal_group_id to ONE synthesized row + group_size.
 *
 * A cross-thread group is several email threads that are the same deal, each carrying a
 * different slice of the truth: the negotiation thread has the offer, the Adobe-Sign thread has
 * the signed status. Picking one row wholesale would drop the other's slice — so we synthesize:
 *   · base   = the most-advanced-status, then most-recent member (identity, stage, summary)
 *   · offer  = borrowed from the richest-offer member when the base itself has none
 *   · activity = message_count summed + last_message_at maxed across the whole group
 * Groups of one pass straight through.
 */
function collapseDealGroups<
  T extends { id: string; deal_group_id: string | null; status: string | null; detected_at: Date | string | null },
>(rows: T[]): (T & { group_size: number })[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.deal_group_id ?? r.id;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const out: (T & { group_size: number })[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      // A deal with no group siblings still owns its own schedule. Assigning this only in
      // the multi-member branch below meant an uploaded contract — which by definition has
      // no email threads beside it — never received a periods_deal_id, so its money
      // resolved to null and the whole schedule UI (per-year line, conditional row,
      // charitable row, economics read) rendered for nobody. Invisible for exactly the
      // document the feature was built for.
      out.push({ ...arr[0], group_size: 1, periods_deal_id: (arr[0] as any).id });
      continue;
    }

    // Display only: the member furthest along by its REAL stage (deals.status) represents the group;
    // the summarizer's observed stage is never shown (owner, 22 Oct). Nothing is written.
    const shown = (r: any) => r.status ?? "";
    const sorted = [...arr].sort((a, b) => {
      const sr = (GROUP_STATUS_RANK[shown(b)] ?? 0) - (GROUP_STATUS_RANK[shown(a)] ?? 0);
      if (sr !== 0) return sr;
      return String(b.detected_at ?? "").localeCompare(String(a.detected_at ?? ""));
    });
    const base: any = sorted[0];
    const merged: any = { ...base, group_size: arr.length };

    // Whole-group activity, not just the canonical thread's.
    merged.message_count =
      arr.reduce((n, a: any) => n + (a.message_count ?? 0), 0) || base.message_count;
    merged.last_message_at =
      arr.map((a: any) => a.last_message_at).filter(Boolean).sort().pop() ?? base.last_message_at;

    // Borrow the offer if the most-advanced member doesn't carry one (e.g. a signed thread
    // whose figure lives back on the negotiation thread).
    if (!(base.conversation_state as any)?.offer_display) {
      const offerRow: any = arr
        .filter((a: any) => (a.conversation_state as any)?.offer_display)
        .sort((a: any, b: any) => offerScore(b) - offerScore(a))[0];
      if (offerRow) {
        const baseCs: any = base.conversation_state ?? {};
        const offCs: any = offerRow.conversation_state ?? {};
        merged.conversation_state = {
          ...baseCs,
          offer_display: offCs.offer_display,
          key_details: {
            ...(baseCs.key_details ?? {}),
            offer:        baseCs.key_details?.offer        ?? offCs.key_details?.offer,
            offer_struct: baseCs.key_details?.offer_struct ?? offCs.key_details?.offer_struct,
            amounts:      offCs.key_details?.amounts       ?? baseCs.key_details?.amounts,
          },
        };
        merged.amount = base.amount ?? offerRow.amount;
      }
    }

    // The SCHEDULE is carried by whichever member is the uploaded contract. Borrow the id
    // of that member rather than the rows themselves — the resolver reads them by deal id,
    // and a union across members would double-count every figure it produces.
    //
    // Deliberately PICKS one rather than merging: periods live on exactly one member by
    // construction, nothing enforces it, and the safe failure is the most recent complete
    // schedule rather than a silent sum of two.
    if (!base.period_count) {
      const withPeriods = arr
        .filter((a: any) => (a.period_count ?? 0) > 0)
        .sort((a: any, b: any) => String(b.detected_at ?? "").localeCompare(String(a.detected_at ?? "")))[0];
      if (withPeriods) {
        merged.periods_deal_id = (withPeriods as any).id;
        merged.period_count    = (withPeriods as any).period_count;
      }
    } else {
      merged.periods_deal_id = base.id;
    }

    // The term lives on the paper, and the paper rarely arrives on the thread carrying the
    // offer — a signed-contract thread holds the dates while the negotiation thread holds
    // the figure. Borrowed independently of the offer above for that reason: the
    // most-advanced member is usually the one WITH the term, so the offer-borrow branch
    // does not run, and a term-only borrow nested inside it would never happen.
    if (!base.term_end) {
      const termRow: any = arr.find((a: any) => a.term_end);
      if (termRow) {
        merged.term_end   = termRow.term_end;
        merged.term_start = base.term_start ?? termRow.term_start;
      }
    }

    out.push(merged);
  }
  return out;
}

export type DealView = "active" | "archived" | "all";

/**
 * Safety bound on rows read for one view — NOT a page size.
 *
 * ── WHY THIS IS NOT A CURSOR ────────────────────────────────────────────────
 * The obvious fix for a cap that truncates is to paginate it. That is wrong here, and the
 * data says so: collapseDealGroups runs AFTER this query, and cross-thread groups are spread
 * out in time — gorjana's six threads span 31 days. Split that group across two pages and the
 * collapse sees three rows on each, so the same deal renders TWICE, each half carrying a
 * partial message count and only one of them the offer. computeDealRank has the same problem:
 * it ranks whatever the page contains.
 *
 * Grouping and ranking are whole-set operations. A page is not a set.
 *
 * So the bound is set high enough that no real athlete reaches it — the largest today has 204
 * deals in total and 35 once filed ones are excluded — and reaching it is LOGGED rather than
 * passed off as a complete list. A silent 100 is what hid seven deals for months; a loud 1000
 * cannot hide anything without saying so.
 *
 * If an athlete ever does hit it, the fix is to collapse groups in SQL, or to paginate over
 * already-collapsed rows — not to slice this query.
 */
const DEAL_ROW_CAP = 1000;

async function loadRankedDeals(
  athleteId: string,
  status: string | undefined,
  now: Date,
  dealId?: string,
  view: DealView = "all",
) {
  const filters = [eq(deals.athlete_id, athleteId)];
  if (status && VALID_DEAL_STATUSES.includes(status as DealStatus)) {
    filters.push(eq(deals.status, status));
  }
  // Single deal, in the LIST shape. Deal detail resolves its deal by scanning the list
  // client-side (DealDetailScreen: deals.find(d => d.id === dealId)), which is what makes the
  // list a client-side store and why it cannot be paged: page it and opening a deal breaks.
  //
  // GET /deals/:id exists but returns a different, nested shape ({ deal, thread, messages,
  // brand, ... }), so pointing the screen at it means hand-writing a second mapper across
  // ~25 fields — and every field that mapper gets subtly wrong is a silent rendering bug.
  // Returning one row through THIS query keeps the shape identical by construction: same
  // select, same client mapper, nothing to drift.
  // Fetches the whole GROUP, not the one row. Cross-thread grouping means a deal can be
  // several email threads — gorjana is six rows under one deal_group_id, AEGISLAB seven —
  // and collapseDealGroups below merges them: it sums message_count, takes the latest
  // last_message_at, and borrows an offer from whichever sibling carries one when the
  // canonical row has none.
  //
  // Filtering to a single id would hand that collapse a group of one, so Deal Detail would
  // render a deal with group_size 1, a partial message count and no borrowed offer — LESS
  // than the list shows for the same deal, with nothing to indicate anything was missing.
  //
  // The subquery yields NULL for an ungrouped deal, and `deal_group_id = NULL` never matches,
  // so those correctly fall back to the id alone.
  if (dealId) {
    filters.push(sql`(${deals.id} = ${dealId} OR ${deals.deal_group_id} = (
      SELECT deal_group_id FROM deals WHERE id = ${dealId}
    ))`);
  }

  // Filed vs live, decided in SQL rather than by sorting and hoping the cap is generous.
  //
  // Filing lives on the THREAD (inbox_threads.status = 'archived'), not on the deal, which is
  // why this reads across the join. A deal with no thread — an uploaded contract — is live by
  // definition and must not be filtered out by a null.
  //
  // Before this, every view fetched the same 100 rows and the client threw away what it did
  // not need: for the athlete with 204 deals that was 65 archived rows, ~70% of the payload,
  // discarded on arrival on a phone. Ordering archived last stopped live deals being HIDDEN by
  // the cap; this stops them being FETCHED at all.
  if (view === "active") {
    filters.push(sql`COALESCE(${inboxThreads.status}, '') <> 'archived'`);
  } else if (view === "archived") {
    filters.push(sql`${inboxThreads.status} = 'archived'`);
  }

  const rows = await db
    .select({
      id:          deals.id,
      brand_name:  deals.brand_name,
      term_start:  deals.term_start,
      term_end:    deals.term_end,
      // Live period count. The schedule lives on ONE member of a cross-thread group — the
      // uploaded contract — while collapseDealGroups picks its canonical member by status
      // rank, which is usually a different one. Without this the group card would show no
      // schedule at all while the periods sat on a sibling row.
      period_count: sql<number>`(
        SELECT COUNT(*)::int FROM deal_periods dp
        WHERE dp.deal_id = ${deals.id} AND dp.superseded_at IS NULL
      )`,
      deal_type:   deals.deal_type,
      amount:      deals.amount,
      status:      deals.status,
      saved:       deals.saved,
      detected_at: deals.detected_at,
      deal_group_id: deals.deal_group_id,
      opportunity_id: deals.opportunity_id,
      // TRIMMED to the keys the list actually reads. `raw_data` stores nine keys; the client
      // maps exactly two out of it (summary, deliverables) — `category` and `deadline` come
      // from inbox_threads.classification, not from here, and contact_name/contact_email/
      // note/seed/thread_id/gmail_thread_id have no client reader at all. Shipping them cost
      // 18 kB per list load for one athlete, on a phone, to be discarded on arrival.
      // Same JSON shape, fewer keys, so no client change. Detail still gets the whole row
      // from GET /deals/:id.
      raw_data: sql<Record<string, unknown> | null>`
        CASE WHEN ${deals.raw_data} IS NULL THEN NULL ELSE jsonb_build_object(
          'summary',      ${deals.raw_data}->'summary',
          'deliverables', ${deals.raw_data}->'deliverables'
        ) END`,
      // Thread
      thread_id:          inboxThreads.id,
      // Zero retention: no stored subject is read; `title` (below) is Nomila's own.
      subject:            mailboxZeroRetentionEnabled() ? sql<string | null>`NULL` : inboxThreads.subject,
      summary:            inboxThreads.summary,
      classification:     inboxThreads.classification,
      thread_status:      inboxThreads.status,
      last_message_at:    inboxThreads.last_message_at,
      message_count:      inboxThreads.message_count,
      latest_draft:       inboxThreads.latest_draft,
      // NOT trimmed in SQL, deliberately — see trimForWire() at the end of this function.
      // collapseDealGroups and offerScore both read key_details.amounts / .offer /
      // .offer_struct off this blob AFTER the query, to borrow an offer from a sibling
      // thread. Trimming here silently breaks that: the borrow finds nothing, and a grouped
      // deal loses the figure it should have inherited. Trim on the way OUT instead.
      conversation_state: inboxThreads.conversation_state,
      // Source platform of the thread (gmail | instagram | outlook), from its messages.
      source: sql<string | null>`(
        SELECT m.platform FROM inbox_messages m
        WHERE m.thread_id = ${inboxThreads.id}
        ORDER BY m.received_at DESC NULLS LAST
        LIMIT 1
      )`,
      // Brand
      brand_id:                   inboxThreads.brand_id,
      brand_logo:                 inboxBrands.logo_url,
      brand_image:                inboxBrands.image_url,
      brand_images:               inboxBrands.images,
      brand_category:             inboxBrands.category,
      brand_description:          inboxBrands.description,
      brand_audience_summary:     inboxBrands.audience_summary,
      brand_sport_categories:     inboxBrands.sport_categories,
      brand_known_partnerships:   inboxBrands.known_athlete_partnerships,
      // The pages brand research's web search saw (researchBrand enrichment.sources): shown as links beside the
      // profile above, as OpenAI's terms ask wherever information from web results is shown.
      brand_sources:              sql<unknown>`${inboxBrands.enrichment}->'sources'`,
    })
    .from(deals)
    .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
    .leftJoin(inboxBrands, eq(inboxBrands.id, inboxThreads.brand_id))
    .where(and(...filters))
    // LIVE DEALS FIRST, then newest. The ordering is load-bearing, not cosmetic.
    //
    // The client fetches this list once and derives every view from it, including the counts
    // and the Archived tab. So the 100-row cap is spent on whatever this query returns first
    // — and with 169 of one athlete's 204 deals auto-archived, filed rows were crowding out
    // live ones by date alone. Seven non-archived deals, five of them marked negotiating, sat
    // outside the window and could not be reached from anywhere in the app. It gets worse
    // every time auto-archive files something.
    //
    // Sorting archived last guarantees every live deal is inside the cap before a single
    // filed one takes a slot. `COALESCE` because a deal with no thread has a null status and
    // must sort with the live rows, not the archived ones.
    //
    // This is a floor, not the finished job. Archived deals are still truncated (they always
    // were), the counts are still computed from a capped list, and ~74% of the payload is
    // rows the client discards on arrival. The real fix is a per-view query with server-side
    // counts and a cursor — that changes the response shape, so it changes the client too.
    .orderBy(sql`(COALESCE(${inboxThreads.status}, '') = 'archived') ASC`, desc(deals.detected_at))
    .limit(DEAL_ROW_CAP);

  // Loud, not silent. Truncating a list and returning it as if it were whole is the failure
  // this replaced: the old cap of 100 hid seven live deals behind filed ones for months with
  // nothing anywhere to say so. If this ever fires, grouping and ranking are also operating on
  // a partial set, so it is a correctness alarm and not a capacity note.
  if (rows.length >= DEAL_ROW_CAP) {
    logger.error(
      { athleteId, view, cap: DEAL_ROW_CAP },
      "deal row cap reached — the list is truncated and grouping/ranking are running on a partial set",
    );
  }

  // Promote awaiting_response_from out of the JSONB so the client doesn't
  // need to parse conversation_state to show "waiting for your reply" badges.
  // WS2/WS3: compose Mila's agent voice server-side (single source of the spoken
  // line — client never re-derives it) via the tested `composeDealVoice` core.
  // WS3 §3.7: attach the deterministic rank + thread-age so the order is authoritative.
  // Cross-thread rollup: deals sharing a deal_group_id are the SAME underlying deal (separate
  // email threads). Collapse each group to one canonical row (most-advanced status, then most
  // recent) carrying a group_size, so the list shows a single brand card. No-op until the
  // grouping script has set any deal_group_id.
  const collapsed = collapseDealGroups(rows);

  // Paperwork (e-sign / payment mail) observed for these deals — linked through the paperwork
  // thread's classification, never as a second thread on the deal. A group shows its members'.
  const paperworkByDeal = await paperworkForDeals(athleteId, rows.map((r) => r.id));
  const paperworkByGroup = new Map<string, { thread_id: string; event: string; at: string }[]>();
  for (const r of rows) {
    const list = paperworkByDeal.get(r.id);
    if (!list) continue;
    const key = r.deal_group_id ?? r.id;
    paperworkByGroup.set(key, [...(paperworkByGroup.get(key) ?? []), ...list]);
  }

  // Resolve every schedule in one pass. A deal with no periods is simply absent from the
  // map, and absence means "an ordinary single-figure deal" — never "worth nothing".
  const moneyByDeal = await resolveMoneyForDeals(
    collapsed.map((r: any) => r.periods_deal_id).filter(Boolean),
  );

  // The opportunity board decides the order (the 1–10 deal score is retired outright).
  const enriched = collapsed.map((r) => {
    const awaiting = (r.conversation_state as any)?.key_details?.awaiting_response_from ?? null;
    const rankInput: DealRankInput = {
      awaitingResponseFrom: awaiting,
      deadline:             (r.classification as any)?.deadline ?? null,
      lastMessageAt:        r.last_message_at,
      detectedAt:           r.detected_at,
    };
    // Cents on the wire, formatted by the client. The schedule is what makes a card able
    // to say "$20K/yr through 2028" instead of one number that is wrong for most questions.
    const baseMoney = (r as any).periods_deal_id ? moneyByDeal.get((r as any).periods_deal_id) ?? null : null;
    // `economics` (money vs the retired computed annual value) is gone with the v3 rate card (legacy retirement P2-5);
    // sent as null so installed builds that read the key see "no read".
    const money = baseMoney ? { ...baseMoney, economics: null } : null;

    return {
      ...r,
      score: null, // the deal score is gone (0088 dropped inbox_threads.score); kept null for app builds that still read the key
      money,
      // The summarizer's read of the stage (outreach | negotiating | agreed | signed | declined),
      // READ-ONLY. It never changes `status`; a screen may say "looks like negotiating" from it.
      observed_stage:         observedStageOf(r.conversation_state),
      paperwork:              (paperworkByGroup.get(r.deal_group_id ?? r.id) ?? [])
        .sort((a, b) => b.at.localeCompare(a.at)),
      awaiting_response_from: awaiting,
      ...(mailboxZeroRetentionEnabled()
        ? { title: derivedThreadTitle({ brandName: r.brand_name, classification: r.classification, conversationState: r.conversation_state }) }
        : {}),
      thread_age_days:        threadAgeDays(rankInput, now),
      rank:                   computeDealRank(rankInput, now),
      voice: composeDealVoice(
        {
          brand_name: r.brand_name,
          advertiser: (r.classification as any)?.advertiser ?? null,
          amount:     r.amount,
          status:     r.status,
          deal_type:  r.deal_type,
          raw_data:   r.raw_data as any,
        },
        {
          summary:            r.summary,
          conversation_state: r.conversation_state as any,
        },
      ),
    };
  });

  // Server-authoritative order: the opportunity board's order (services/opportunityBoard — the ONE order the screen
  // and Mila read); a deal outside any open opportunity sorts after. Within one opportunity: highest rank first,
  // fresher-then-id as the stable tiebreak.
  const boardPos = dealPositions(await readOpportunityBoard(athleteId, now));
  enriched.sort((a, b) => {
    const pa = boardPos.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = boardPos.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    if (b.rank !== a.rank) return b.rank - a.rank;
    const aa = a.thread_age_days ?? Number.MAX_SAFE_INTEGER;
    const ba = b.thread_age_days ?? Number.MAX_SAFE_INTEGER;
    if (aa !== ba) return aa - ba;
    return String(a.id).localeCompare(String(b.id));
  });

  // Each card's own inbox (plan §4.6): the connection its thread answers through, with
  // can_draft / can_send for THAT row — one batched lookup for the whole list.
  const inboxByThread = await resolveThreadInboxes(
    athleteId,
    enriched.map((r) => r.thread_id).filter((id): id is string => !!id),
  );

  return enriched
    .map((r) => ({ ...r, inbox: r.thread_id ? toInboxPayload(inboxByThread.get(r.thread_id)) : null }))
    .map(trimForWire);
}

/**
 * Drop the parts of `conversation_state` no list view reads, on the way to the client.
 *
 * This blob is 77 kB of the list's 141 kB heavy payload for the athlete with 204 deals, and
 * the client maps exactly three paths out of it. `deal_stage` and the full `summary` are
 * carried for nobody.
 *
 * Done HERE and not in the query, because the server itself needs the whole thing first:
 * collapseDealGroups borrows `key_details.offer` / `.offer_struct` / `.amounts` from a
 * sibling thread when the canonical row has no offer of its own, and offerScore ranks
 * siblings by those amounts. Trimming in SQL removed the fields that borrow depends on —
 * the query returned less, the grouping quietly found nothing to borrow, and a grouped deal
 * would have lost its figure with no error anywhere. Wire-shaping is the last step.
 */
function trimForWire<T extends { conversation_state?: unknown }>(row: T): T {
  const cs = row.conversation_state as Record<string, any> | null | undefined;
  if (!cs) return row;
  return {
    ...row,
    conversation_state: {
      conversation_state: cs.conversation_state ?? null,
      offer_display:      cs.offer_display ?? null,
      key_details:        { ask: cs.key_details?.ask ?? null },
    },
  };
}

// ─── GET /api/v1/me/deals ────────────────────────────────────────────────────

// NO `category` PARAM, DELIBERATELY. There used to be one, filtering on
// `raw_data.category` — a key nothing writes. `buildDealRawData` (skills/dealDetector)
// stores thread_id, gmail_thread_id, summary, contact_name, contact_email, deadline and
// deliverables, and the classifier's category goes to `inbox_threads.classification`
// instead. So the filter matched nothing: `?category=PAID` returned an empty list rather
// than an error, which is the worst way for a parameter to be wrong. Verified against
// production — 0 of 270 deals carry the key.
//
// It was also unreachable. Nothing called it: the app fetches the whole list and filters
// locally (client/components/deals/ClassicListV2.tsx), against a category that
// `mapCategory()` resolves from `classification.category` — correctly. The voice worker
// uses its own route (voice/dealRoutes.ts), which accepts only status/sort_by/limit and
// 400s on anything else.
//
// If server-side category filtering is ever wanted, read `inbox_threads.classification
// ->> 'category'`, which is where the value actually lives and is already indexed by use.
router.get("/deals", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { status, id, view } = req.query as Record<string, string>;

  // Defaults to "all", so a client that has not been updated keeps the behaviour it had.
  // An unrecognised value falls back to "all" rather than 400ing: this parameter narrows a
  // list, and the safe failure is showing too much, never silently showing nothing.
  const dealView: DealView =
    view === "active" || view === "archived" || view === "all" ? view : "all";

  // `?id=` returns that one deal in the LIST shape — see loadRankedDeals. It exists so Deal
  // Detail can stop resolving its deal by scanning the whole list, which is the thing
  // currently forcing this endpoint to return everything.
  //
  // Shape-validated first: a non-UUID reaches Postgres as a uuid comparison and throws a 500,
  // the same trap `/deals/:id` already guards against. Still scoped to the caller's athlete_id
  // by the base filter, so a valid id belonging to someone else returns an empty list rather
  // than another athlete's deal.
  if (id !== undefined && !isUuid(id)) {
    res.status(400).json({ error: "id must be a uuid" });
    return;
  }

  res.json(await loadRankedDeals(athleteId, status, new Date(), id, dealView));
});

// ─── GET /api/v1/me/deals/counts ─────────────────────────────────────────────
// How many live, how many filed. Two integers, no rows.
//
// The list can now be fetched per view, which means the client no longer holds the archived
// rows it used to count locally. This supplies that number without shipping 169 deals to
// produce it — which is the whole point of the per-view split.
//
// Declared BEFORE /deals/:id so "counts" is not captured as an :id, the same reason
// /deals/:id is declared last.
router.get("/deals/counts", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { rows } = await db.execute<{ active: number; archived: number }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(t.status, '') <> 'archived')::int AS active,
      COUNT(*) FILTER (WHERE t.status = 'archived')::int               AS archived
    FROM deals d LEFT JOIN inbox_threads t ON t.deal_id = d.id
    WHERE d.athlete_id = ${athleteId}
  `);
  res.json(rows[0] ?? { active: 0, archived: 0 });
});

// ─── GET /api/v1/me/deals/search ─────────────────────────────────────────────
// All deals (services/opportunitySearch): ?q=&tab=active|done|closed&type=<deal type | other>&limit= (default 50, max 200). Every deal she has,
// open or not, matched on brand and agency names, type, status, ask and amounts; tab and type counts; filed mail under
// Closed → "Not a deal". 404 unless DEALS_SEARCH. Declared BEFORE /deals/:id so "search" is not captured as an :id.
router.get("/deals/search", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  res.json(await searchDeals(req.athleteId!, { q: str(req.query.q), tab: str(req.query.tab), type: str(req.query.type), limit: str(req.query.limit) }, new Date()));
});

// ─── GET /api/v1/me/opportunities ────────────────────────────────────────────
// The opportunity board (Opportunities PR 3): What matters · the ask-for-terms batch · In motion ·
// Explore all · To verify, in the ONE deterministic order (lib/opportunityOrder). Read-only, computed on
// read. Replaces GET /deals/brief, which had no client caller and ranked by the retired score.
router.get("/opportunities", requireAuth, async (req: Request, res: Response): Promise<void> => {
  res.json(await readOpportunityBoard(req.athleteId!, new Date()));
});

// ─── GET /api/v1/me/opportunities/:id ────────────────────────────────────────
// The card's detail (PR 4): the brand deck + Nomila's letter, all from derived fields. 404 when it isn't hers; a closed
// one is a 404 too, unless DEALS_BOARD_V2 (then it is shown read-only). Read-only; the email itself is read live from the thread, never from here.
router.get("/opportunities/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isUuid(id)) { res.status(400).json({ error: "id must be a uuid" }); return; }
  // D5: opening a Maybe email makes it a real deal (DEALS_MAYBE; a no-op while off).
  await clearMaybeOnOpen(req.athleteId!, id);
  const detail = await readOpportunityDetail(req.athleteId!, id, new Date());
  if (!detail) { res.status(404).json({ error: "not found" }); return; }
  // A request from her public card: opening its card moves the visitor's page to "[First] is reviewing".
  if (partnerIntakeEnabled()) await markOpportunityRequestsSeen(req.athleteId!, id);
  res.json(detail);
});

// ─── GET /api/v1/me/opportunities/:id/brand ─────────────────────────────────
// The brand page (docs/design/brand-page-deals.md D5): every deal she has with this opportunity's brand — open or
// won — each with its status, take, ONE primary action, paperwork timeline and conversation. Derived fields only.
// 404 when the opportunity isn't hers; every query inside filters her athlete id.
router.get("/opportunities/:id/brand", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!isUuid(id)) { res.status(400).json({ error: "id must be a uuid" }); return; }
  const page = await readBrandPage(req.athleteId!, id, new Date());
  if (!page) { res.status(404).json({ error: "not found" }); return; }
  res.json(page);
});

// ─── POST /api/v1/me/opportunities/:id/signed ───────────────────────────────
// Her "Yes, it's signed" (docs/design/brand-page-deals.md D2). The ONLY write that marks a deal signed from the
// opportunity: signed_at on the target deal (a real member, never a paperwork pseudo-deal), the opportunity
// closed as won, a reversible receipt. Body: { deal_id? }. Returns the signed PDF Nomila can offer to read into
// the terms (her next tap, never automatic). "Not yet" has no endpoint: it changes nothing.
router.post("/opportunities/:id/signed", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const dealId = req.body?.deal_id == null ? null : String(req.body.deal_id);
  if (!isUuid(id) || (dealId != null && !isUuid(dealId))) { res.status(400).json({ error: "ids must be uuids" }); return; }
  const out = await confirmSigned(req.athleteId!, id, dealId);
  if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
  res.json(out);
});

// ─── POST /api/v1/me/deals/:id/split ─────────────────────────────────────────
// "This is a separate deal" (docs/design/brand-page-deals.md D7). Body: { chain? } — a provider thread id folded
// into this deal's conversation (its messages become their own thread, deal and opportunity); without it, the
// deal moves to its own opportunity. Her tap only; reversible receipt.
router.post("/deals/:id/split", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const chain = req.body?.chain == null ? null : String(req.body.chain).slice(0, 200);
  if (!isUuid(id)) { res.status(404).json({ error: "Deal not found" }); return; }
  const out = await splitDeal(req.athleteId!, id, chain);
  if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
  res.json(out);
});

// ─── Deal activity timeline helpers ──────────────────────────────────────────

type DealActivityItem = {
  ts: string | null;
  type: "detected" | "message" | "agent" | "payment";
  title: string;
  detail?: string | null;
  direction?: string | null;
};

const AGENT_ACTION_LABELS: Record<string, string> = {
  file:         "Filed",
  auto_decline: "Auto-declined",
  reclassify:   "Reclassified",
  mute_sender:  "Muted sender",
  reopen:       "Reopened",
  auto_archive: "Auto-archived",
  confirm_signed: "Marked signed",
  split_deal:   "Split into its own deal",
};
function agentActionLabel(action: string, undone: boolean, payload?: unknown): string {
  // D4 stores "marked agreed" under the existing 'reopen' verb with payload.kind "deal_agreed" (skills/dealAgree.ts).
  // Her "it's done" / "bring it back" (services/dealMark, payload.kind "deal_marked") uses the same verb.
  const p = payload as Record<string, unknown> | null | undefined;
  const kind = p?.kind;
  const base = kind === "deal_agreed" ? "Marked agreed"
    : kind === "deal_marked" ? (p?.mark === "completed" ? "Marked completed" : "Brought back")
    : (AGENT_ACTION_LABELS[action] ?? action);
  return undone ? `${base} (undone)` : base;
}
function paymentLabel(kind: string, status: string): string {
  return `${kind === "deposit" ? "Deposit" : "Payment"} ${status}`;
}
/** Normalize a drizzle timestamp (Date | string | null) to an ISO string for sorting/JSON. */
function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
}

// ─── GET /api/v1/me/deals/:id ────────────────────────────────────────────────

router.get("/deals/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;

  if (!isUuid(dealId)) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  const [deal] = await db
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);

  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  // Thread
  const [thread] = await db
    .select(threadColumns())
    .from(inboxThreads)
    .where(eq(inboxThreads.deal_id, dealId))
    .limit(1);

  // Messages. Under MAILBOX_LIVE_READS the deal payload carries no stored body: the
  // conversation is read live by the thread view (GET /inbox/threads/:id). Under
  // MAILBOX_ZERO_RETENTION no stored subject or sender name is read either, and a sender kept
  // as a pseudonym is never shown (masked below).
  const zeroRetention = mailboxZeroRetentionEnabled();
  const rawMessages = thread
    ? await db
        .select({
          id:           inboxMessages.id,
          sender_email: inboxMessages.sender_email,
          sender_name:  zeroRetention ? sql<string | null>`NULL` : inboxMessages.sender_name,
          direction:    inboxMessages.direction,
          subject:      zeroRetention ? sql<string | null>`NULL` : inboxMessages.subject,
          body:         mailboxLiveReadsEnabled() ? sql<string | null>`NULL` : inboxMessages.body,
          received_at:  inboxMessages.received_at,
          attachments:  inboxMessages.attachments,
        })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.thread_id, thread.id), deliveredOnly()))   // held / blocked relay messages were never delivered
        .orderBy(asc(inboxMessages.received_at))
        .limit(20)
    : [];
  const messages = zeroRetention
    ? rawMessages.map((m) => ({ ...m, sender_email: sendableAddress(m.sender_email) }))
    : rawMessages;

  // Deal-level attachment list for the card's Attachments section. Flattened out of
  // the messages so the client doesn't have to walk the thread, and deduped by
  // gcs_path — the same brief commonly rides both an original and a Fwd:.
  //
  // gcs_path is deliberately NOT sent: it is an internal object location, and the
  // only legitimate way to reach the bytes is the signed-url endpoint below, which
  // re-checks ownership. Callers get an opaque {messageId, index} pair instead.
  const seenPaths = new Set<string>();
  const attachments = messages.flatMap((m) =>
    (m.attachments ?? []).flatMap((a, index) => {
      // A live-ref attachment (MAILBOX_LIVE_READS) has no object path; it is unique per message.
      const key = a.gcs_path ?? `${m.id}:${a.attachment_ref ?? index}`;
      if (seenPaths.has(key)) return [];
      seenPaths.add(key);
      return [{
        messageId:   m.id,
        index,
        filename:    a.filename,
        contentType: a.content_type,
        bytes:       a.bytes,
        // False = stored but never read (over the parse cap), so the UI can say so
        // instead of implying its terms fed the deal.
        parsed:      a.parsed,
        receivedAt:  m.received_at,
        // True = the file was not copied to Nomila; it lives in the mailbox.
        ...(a.gcs_path ? {} : { inMailbox: true }),
      }];
    }),
  );

  // Brand
  const brand = thread?.brand_id
    ? await db
        .select({ name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url, category: inboxBrands.category })
        .from(inboxBrands)
        .where(eq(inboxBrands.id, thread.brand_id))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  // ── Activity timeline — union of already-per-deal, timestamped sources, newest-first.
  // Real data only: the deal's detection, thread messages (agent receipts), and money
  // movements (payments). Deposits/settlements only appear once the escrow engine has run,
  // so an un-funded deal honestly shows just detection + correspondence.
  const [actionRows, paymentRows] = await Promise.all([
    db.select({
        action:     agentActions.action,
        payload:    agentActions.payload,
        reason:     agentActions.reason,
        created_at: agentActions.created_at,
        undone_at:  agentActions.undone_at,
      })
      .from(agentActions)
      .where(eq(agentActions.deal_id, dealId))
      .orderBy(desc(agentActions.created_at))
      .limit(30),
    db.select({
        kind:              payments.kind,
        status:            payments.status,
        brand_total_cents: payments.brand_total_cents,
        created_at:        payments.created_at,
      })
      .from(payments)
      .where(eq(payments.deal_id, dealId))
      .orderBy(desc(payments.created_at))
      .limit(30),
  ]);

  const activity: DealActivityItem[] = [];
  activity.push({ ts: toIso(deal.detected_at), type: "detected", title: "Deal detected", detail: deal.source ?? null });
  for (const m of messages) {
    activity.push({
      ts:        toIso(m.received_at),
      type:      "message",
      direction: m.direction,
      title:     m.direction === "outbound" ? "You replied" : `Message from ${m.sender_name || m.sender_email || "the brand"}`,
      detail:    m.subject ?? null,
    });
  }
  for (const a of actionRows) {
    activity.push({ ts: toIso(a.created_at), type: "agent", title: agentActionLabel(a.action, !!a.undone_at, a.payload), detail: a.reason ?? null });
  }
  for (const p of paymentRows) {
    activity.push({
      ts:     toIso(p.created_at),
      type:   "payment",
      title:  paymentLabel(p.kind, p.status),
      detail: p.brand_total_cents != null ? `$${Math.round(p.brand_total_cents / 100)}` : null,
    });
  }
  activity.sort((x, y) => (y.ts ?? "").localeCompare(x.ts ?? ""));

  const payment = { payment_status: deal.payment_status, deposit_status: deal.deposit_status };

  // The inbox this deal's thread answers through (plan §4.6) — see services/threadInbox.
  const inbox = thread ? toInboxPayload(await resolveThreadInbox(athleteId, thread.id)) : null;

  // Read-only observations: the summarizer's stage read and any paperwork matched to this deal.
  const observed_stage = observedStageOf(thread?.conversation_state);
  const paperwork = (await paperworkForDeals(athleteId, [dealId])).get(dealId) ?? [];

  res.json({ deal, thread: thread ? presentThread(thread, brand?.name ?? deal.brand_name) : thread, messages, brand, attachments, activity, payment, inbox, observed_stage, paperwork });
});

// ─── GET /api/v1/me/deals/:id/attachments/:messageId/:index/url ───────────────
// Mints a short-lived signed GCS read URL for one attachment.
//
// Returns the URL as JSON rather than a 302: the app opens these with RN's Linking,
// which cannot attach an auth header to a redirect, so the redirect would arrive at
// GCS unauthenticated. The client fetches the URL here (authenticated) and hands the
// resulting signed URL to the browser.
//
// Ownership is re-checked here rather than trusted from the list response — this
// endpoint is reachable directly, and the object path is per-athlete.
router.get("/deals/:id/attachments/:messageId/:index/url", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { id: dealId, messageId } = req.params;
  const index = Number(req.params.index);

  if (!isUuid(dealId) || !isUuid(messageId) || !Number.isInteger(index) || index < 0) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  // The message must belong to a thread on THIS athlete's deal — one query, so a
  // guessed messageId from another tenant can't resolve. "On the deal" includes its paperwork threads and its
  // opportunity's other threads (the signed PDF on the brand page's paperwork timeline), all hers.
  const [row] = await db
    .select({ attachments: inboxMessages.attachments })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.thread_id))
    .where(and(
      eq(inboxMessages.id, messageId),
      eq(inboxMessages.athlete_id, athleteId),
      threadOnDeal(athleteId, dealId),
    ))
    .limit(1);

  const attachment = row?.attachments?.[index];
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  // Not rehosted (MAILBOX_LIVE_READS): there is no object to sign. The file stays in
  // the mailbox; "Save as contract" reads it live (dealContracts from-attachment).
  if (!attachment.gcs_path) {
    res.status(409).json({ error: "This file lives in your mailbox — open it there", code: "ATTACHMENT_IN_MAILBOX" });
    return;
  }

  try {
    const url = await signedAttachmentUrl(attachment.gcs_path);
    res.json({ url, filename: attachment.filename, contentType: attachment.content_type });
  } catch (err: any) {
    // Signing needs a real service-account key; local user ADC cannot sign, so this
    // is expected to fail outside Cloud Run.
    logger.error({ dealId, messageId, index, error: err.message }, "Attachment URL signing failed");
    res.status(502).json({ error: "Could not generate a link for this attachment" });
  }
});

// ─── PATCH /api/v1/me/deals/:id ──────────────────────────────────────────────

router.patch("/deals/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;
  const { status, notes, saved } = req.body as { status?: string; notes?: string; saved?: boolean };

  if (!isUuid(dealId)) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  if (status && !VALID_DEAL_STATUSES.includes(status as DealStatus)) {
    res.status(400).json({ error: `status must be one of: ${VALID_DEAL_STATUSES.join(", ")}` });
    return;
  }
  if (notes !== undefined && typeof notes !== "string") {
    res.status(400).json({ error: "notes must be a string" });
    return;
  }
  const trimmedNotes = typeof notes === "string" ? notes.slice(0, MAX_NOTES_LEN) : undefined;

  // Serialize the negotiation_state read-modify-write so a double-tap / two devices
  // can't silently drop one update (A15). SELECT … FOR UPDATE locks the row.
  const updated = await db.transaction(async (tx) => {
    const [deal] = await tx
      .select({ id: deals.id, negotiation_state: deals.negotiation_state })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
      .for("update")
      .limit(1);
    if (!deal) return null;

    const existingState = (deal.negotiation_state as any) ?? {};
    const updatedState = trimmedNotes
      ? {
          ...existingState,
          history: [
            ...(existingState.history ?? []),
            { status, notes: trimmedNotes, timestamp: new Date().toISOString() },
          ].slice(-MAX_HISTORY_ENTRIES),
        }
      : existingState;

    const [row] = await tx
      .update(deals)
      .set({
        ...(status ? { status } : {}),
        ...(typeof saved === "boolean" ? { saved } : {}),
        negotiation_state: updatedState,
      })
      .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
      .returning();
    return row;
  });

  if (!updated) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  logger.info({ dealId, athleteId, status, hasNotes: !!trimmedNotes }, "Deal updated");
  res.json(updated);
});

// ─── POST /api/v1/me/deals/:id/dispose ───────────────────────────────────────
// The athlete says what a deal actually IS, in her words — the labelled half of the
// dismiss sheet behind the X on Deal Detail.
//
// WHY THIS IS NOT JUST PATCH status='rejected': these look identical in the deals table
// and mean quite different things about the CLASSIFIER.
//
//   not_a_deal      → we should never have surfaced this. A precision failure.
//   not_interested  → a real offer, correctly surfaced, and the answer is no.
//   expired         → a real offer, correctly surfaced, whose moment has passed. Our
//                     CLASSIFICATION was right and our TIMING was wrong, which is a
//                     different failure and must not be recorded as the first one.
//
// Collapsing the two is exactly why 2,000 filed messages taught us nothing: the receipt
// records what the machine guessed, never what she says it is. Each disposition writes
// `payload.athlete_label`, which is the first ground-truth label in the system that a
// human actually asserted — her own sender memory (lib/senderMemory.ts) reads these, and
// unlike a reply or an advanced status they cannot be produced by the pipeline itself.
//
// Body: { disposition: 'not_a_deal' | 'not_interested' | 'expired', note?: string }
// The logic lives in services/dealDispose (shared with Mila's deals_close tool, D1).

router.post("/deals/:id/dispose", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;
  const { disposition, note } = req.body as { disposition?: string; note?: string };

  if (!isUuid(dealId)) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  if (!disposition || !DISPOSITIONS.includes(disposition as Disposition)) {
    res.status(400).json({ error: `disposition must be one of: ${DISPOSITIONS.join(", ")}` });
    return;
  }
  const trimmedNote = typeof note === "string" ? note.slice(0, MAX_NOTES_LEN) : null;
  const r = await disposeDeal(athleteId, dealId, disposition as Disposition, trimmedNote);
  if (!r.ok) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  res.json({ ok: true, disposition, dealId });
});


// ─── POST /api/v1/me/deals/:id/draft ─────────────────────────────────────────
// Streams a Kimi-generated reply draft as SSE.
// Event shape: { token: string } per chunk, then { done: true } at end.
// Completed draft stored on inbox_threads.latest_draft.
//
// Body params:
//   reply_intent        "accept" | "negotiate" | "decline"   (required)
//   style               "friendly" | "professional"           (default: "friendly")
//   selected_terms      string[]   topics to negotiate        (negotiate only)
//   custom_instruction  string     free-form user override    (optional)
//   include_media_kit   boolean                               (default: false)

router.post("/deals/:id/draft", requireAuth, draftLimiter, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;

  if (!isUuid(dealId)) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  const {
    reply_intent       = "accept",
    style              = "friendly",
    voice              = "athlete",
    selected_terms     = [] as string[],
    custom_instruction = "",
    include_media_kit  = false,
    intent,
    term_asks,
    figure,
  } = req.body as {
    reply_intent?:       string;
    style?:              string;
    voice?:              string;
    selected_terms?:     string[];
    custom_instruction?: string;
    include_media_kit?:  boolean;
    /** The deal type's own intent (shared/deals REPLY_INTENTS) — the reply sheet's chip. Optional; used with DEALS_REPLY_V2. */
    intent?:             string;
    /** Her "their term → your ask" rows: { term: a TermKey or "other", ask: her words }. */
    term_asks?:          Array<{ term?: string; ask?: string }>;
    /** The ONE figure she typed (counter / share_rate / propose_paid). */
    figure?:             number;
  };

  if (!VALID_INTENTS.includes(reply_intent as ReplyIntent)) {
    res.status(400).json({ error: `reply_intent must be one of: ${VALID_INTENTS.join(", ")}` });
    return;
  }
  if (!VALID_STYLES.includes(style as DraftStyle)) {
    res.status(400).json({ error: `style must be one of: ${VALID_STYLES.join(", ")}` });
    return;
  }
  if (!VALID_VOICES.includes(voice as DraftVoice)) {
    res.status(400).json({ error: `voice must be one of: ${VALID_VOICES.join(", ")}` });
    return;
  }
  if (!Array.isArray(selected_terms) || !selected_terms.every((t) => typeof t === "string")) {
    res.status(400).json({ error: "selected_terms must be an array of strings" });
    return;
  }
  if (intent !== undefined && !isSharedReplyIntent(intent)) {
    res.status(400).json({ error: "intent must be one of the deal type's reply intents" });
    return;
  }
  if (term_asks !== undefined && (!Array.isArray(term_asks) || !term_asks.every((t) => t && typeof t.ask === "string" && (t.term === undefined || typeof t.term === "string")))) {
    res.status(400).json({ error: "term_asks must be an array of { term, ask }" });
    return;
  }
  if (figure !== undefined && (typeof figure !== "number" || !Number.isFinite(figure) || figure <= 0)) {
    res.status(400).json({ error: "figure must be a positive number" });
    return;
  }
  // The deal must exist and belong to the caller — a clean 404 as JSON, before we
  // open the SSE stream (an error mid-stream can't be a 404).
  const [deal] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);

  if (!deal) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  // ── SSE stream ───────────────────────────────────────────────────────────────

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Abort the Vertex call if the stream stalls or the client disconnects, so a
  // hung generation stops burning quota + holding the request open.
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  // The shared draft core does the strip-guarded generation (deterministic
  // greeting/signature + sanitize + negotiate leak-lint + retry). `onToken` keeps
  // this route's live stream: the deterministic greeting first, then each body
  // delta. The client swaps its streamed tokens for the final email via `replace`.
  const result = await generateDealDraft({
    athleteId,
    dealId,
    replyIntent:       reply_intent as ReplyIntent,
    style:             style as DraftStyle,
    voice:             voice as DraftVoice,
    selectedTerms:     selected_terms,
    customInstruction: custom_instruction,
    includeMediaKit:   include_media_kit,
    typeIntent:        intent as SharedReplyIntent | undefined,
    termAsks:          term_asks?.slice(0, 8).map((t) => ({ term: String(t.term ?? "other"), ask: String(t.ask).slice(0, 200) })),
    counterAmount:     figure ?? null,
    signal:            controller.signal,
    onToken:           (token) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ token })}\n\n`); },
  });

  // Client disconnected mid-stream — the abort already fired; nothing to send.
  if (res.writableEnded) return;

  if (result.ok) {
    res.write(`data: ${JSON.stringify({ replace: result.fullText })}\n\n`);
    // thread_id: the thread this draft was written for. Propose on it (pending-actions thread_id) so the
    // reply goes out on the conversation it quotes; propose also prefers the thread holding this body.
    res.write(`data: ${JSON.stringify({ done: true, thread_id: result.threadId })}\n\n`);
    res.end();
    return;
  }

  // A refusal is the leak-lint's brand-safe fallback; not_found here can only be a
  // race (we 404'd pre-stream), so it maps to the generic generation error.
  const errorMessage =
    result.reason === "refusal" || result.reason === "mailbox_unavailable"
      ? result.message
      : "Draft generation failed — try again";
  res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  res.end();
});

// ─── PUT /api/v1/me/deals/:id/draft ──────────────────────────────────────────
// Save (or overwrite) a user-edited draft on the deal thread.
//
// `mirror_to_gmail` decides whether this also writes a native Gmail Draft. The app
// autosaves the editor on close (false) so nothing is ever lost, and sends true only
// for an explicit "Save as draft" — see the note in services/saveThreadDraft.

router.put("/deals/:id/draft", requireAuth, draftLimiter, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;
  const { body, reply_intent, style, voice, mirror_to_gmail } = req.body as {
    body?: string;
    reply_intent?: string;
    style?: string;
    voice?: string;
    mirror_to_gmail?: boolean;
  };

  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }

  const { saveThreadDraft } = await import("../services/saveThreadDraft.js");
  const result = await saveThreadDraft({
    athleteId,
    dealId,
    body,
    mirrorToGmail: mirror_to_gmail === true,
    meta: { reply_intent, style, voice },
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, latest_draft: result.latest_draft });
});

// ─── DELETE /api/v1/me/deals/:id/draft ───────────────────────────────────────
// Abandon the draft (and any mirrored Gmail Draft). The app calls this when the
// athlete empties the editor and closes — otherwise the text they just deleted is
// restored on the next open.

router.delete("/deals/:id/draft", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId    = req.params.id;

  if (!isUuid(dealId)) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }

  const { clearThreadDraft } = await import("../services/saveThreadDraft.js");
  const result = await clearThreadDraft({ athleteId, dealId });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

// ─── PATCH /api/v1/me/preferences ────────────────────────────────────────────
// Per-type floor keys — mirror `deal_type_rates` / `rate_card` deal types.
const MINIMUM_RATE_KEYS = ["socialPost", "appearance", "ambassador", "autograph", "licensing"] as const;

// Saves athlete's deal preferences (minimum_rate, minimum_rates, agent_name, agency_name).
// Body: { minimum_rate?: number; minimum_rates?: Record<dealType, number>;
//         agent_name?: string; agency_name?: string }
//
// `minimum_rates` is the per-type floor the athlete sets against her suggested rates. It merges
// per-key (setting one type doesn't clear the others). `minimum_rate` (single) is kept for
// back-compat with the negotiate-draft path.

router.patch("/preferences", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { minimum_rate, minimum_rates, reply_signature, agent_name, agency_name, agent_role } = req.body as {
    minimum_rate?:    number;
    minimum_rates?:   Record<string, number>;
    reply_signature?: { sign_off?: string; name?: string } | null;
    agent_name?:      string;
    agency_name?:     string;
    /** The team member's role ("Manager"), signed under their name when she sends as her team (D2). */
    agent_role?:      string;
  };

  const patch: Record<string, any> = {};
  if (minimum_rate !== undefined) {
    if (typeof minimum_rate !== "number" || minimum_rate < 0) {
      res.status(400).json({ error: "minimum_rate must be a non-negative number" });
      return;
    }
    patch.minimum_rate = minimum_rate;
  }

  // Per-type floors (WS2) — the athlete's per-deal-type minimum. Merges key-by-key below.
  if (minimum_rates !== undefined) {
    if (typeof minimum_rates !== "object" || minimum_rates === null || Array.isArray(minimum_rates)) {
      res.status(400).json({ error: "minimum_rates must be an object of dealType → number" });
      return;
    }
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(minimum_rates)) {
      if (!MINIMUM_RATE_KEYS.includes(k as any)) continue; // ignore unknown deal types
      if (typeof v !== "number" || !isFinite(v) || v < 0) {
        res.status(400).json({ error: `minimum_rates.${k} must be a non-negative number` });
        return;
      }
      clean[k] = Math.round(v);
    }
    patch.minimum_rates = clean; // deep-merged with existing below
  }

  // Athlete-voice signature (sign_off + name). Empty strings are valid — they
  // mean "use the default" (Best, + athlete first name) at draft time.
  if (reply_signature !== undefined) {
    const so = reply_signature?.sign_off;
    const nm = reply_signature?.name;
    if (
      reply_signature === null ||
      typeof reply_signature !== "object" ||
      (so !== undefined && typeof so !== "string") ||
      (nm !== undefined && typeof nm !== "string")
    ) {
      res.status(400).json({ error: "reply_signature must be { sign_off?: string, name?: string }" });
      return;
    }
    patch.reply_signature = {
      sign_off: (so ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 40),
      name:     (nm ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 60),
    };
  }

  // Agent-voice sign-off names (empty string clears the override → prompt falls
  // back to "{LastName} Management")
  for (const [key, val] of [["agent_name", agent_name], ["agency_name", agency_name], ["agent_role", agent_role]] as const) {
    if (val !== undefined) {
      if (typeof val !== "string" || val.length > 100) {
        res.status(400).json({ error: `${key} must be a string of at most 100 characters` });
        return;
      }
      patch[key] = val.trim();
    }
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No valid fields provided" });
    return;
  }

  // Merge with existing prefs inside a transaction with SELECT … FOR UPDATE, so a
  // concurrent PATCH (e.g. minimum_rate + reply_signature saved together) can't drop
  // one field via a lost read-modify-write (A15).
  const merged = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ deal_preferences: athletes.deal_preferences })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .for("update")
      .limit(1);

    const next: Record<string, any> = { ...((existing?.deal_preferences as object) ?? {}), ...patch };
    // Per-type floors merge key-by-key (a partial save keeps the untouched types).
    if (patch.minimum_rates) {
      next.minimum_rates = {
        ...((existing?.deal_preferences as any)?.minimum_rates ?? {}),
        ...patch.minimum_rates,
      };
    }
    await tx.update(athletes).set({ deal_preferences: next }).where(eq(athletes.id, athleteId));
    return next;
  });

  logger.info({ athleteId, patch }, "Athlete deal preferences updated");
  res.json({ ok: true, deal_preferences: merged });
});

// ─── GET /api/v1/me/preferences ──────────────────────────────────────────────
// Returns the athlete's saved deal preferences (used to prefill the settings form).

router.get("/preferences", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const [row] = await db
    .select({ deal_preferences: athletes.deal_preferences })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);
  res.json({ deal_preferences: row?.deal_preferences ?? {} });
});

export default router;
