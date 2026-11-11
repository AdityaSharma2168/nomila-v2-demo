/**
 * meetings.ts — a calendar invite is a MEETING about a deal, never a deal (lib/calendarInvite decides at ingest).
 *
 * Like paperwork (./paperwork), the invite's thread is linked to the deal through its classification
 * (`classification.meeting.deal_id`), never through inbox_threads.deal_id — one thread per deal is assumed by every
 * reader that joins threads to deals and by every "where deal_id = X limit 1" that picks a reply target.
 *
 * Placement is deterministic and only ever lands on one of HER open deals:
 *   1. counterparty  — a deal whose conversation already holds mail from the invite's sender or organiser
 *                      (matched as the stored address or its pseudonym, so it works under zero retention);
 *   2. brand_domain  — else a deal whose brand's domain is the sender's / organiser's organisation domain.
 * Among the candidates: the most recently active open deal (not rejected / completed, its opportunity open).
 * None → the thread is kept with an "unmatched" marker and no deal.
 *
 * Stored: the decision only — event, date / time as the invite states them, and the title ONLY when message content
 * is retained (null under MAILBOX_ZERO_RETENTION). Never throws into the caller.
 */
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { connectedAccounts, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { brandDomainOf } from "../lib/senderProfile";
import { pseudonymousSender } from "../lib/mailbox/retention";
import type { CalendarInvite, MeetingEvent, MeetingStart } from "../lib/calendarInvite";
import { lockBrand } from "./opportunities";
import { createLogger } from "../logger";

const logger = createLogger("skills/meetings");

/** legacy_fold: a calendar-invite pseudo-deal folded into a meeting by scripts/opps/foldPaperworkAndSplit --fold-invite. */
export type MeetingMatch = "counterparty" | "brand_domain" | "legacy_fold";

export interface MeetingMarker {
  state:              "matched" | "unmatched";
  event:              MeetingEvent;
  start:              MeetingStart | null;
  /** Null under zero retention (it is the invite's own words). */
  title:              string | null;
  deal_id?:           string;
  opportunity_id?:    string;
  brand_id?:          number;
  matched_by?:        MeetingMatch;
  /** inbox_messages ids on this thread the observation was read from (provenance). */
  source_message_ids: string[];
  observed_at:        string;
}

const CLOSED_DEAL = ["rejected", "completed", "archived", "declined", "lost"];

/** The marker on a thread's classification, if any. */
export function readMeeting(classification: unknown): MeetingMarker | null {
  const m = (classification as { meeting?: unknown } | null | undefined)?.meeting;
  return m && typeof m === "object" && "state" in (m as object) ? (m as MeetingMarker) : null;
}

/** Her open deals, newest activity first (thread mail, opportunity activity, detection). */
async function openDeals(athleteId: string, where: any) {
  const rows = await db
    .select({
      deal_id: deals.id, opportunity_id: deals.opportunity_id, brand_id: deals.brand_id, status: deals.status,
      opp_brand: opportunities.brand_id, opp_status: opportunities.status,
      activity: sql<string | null>`greatest(max(${inboxThreads.last_message_at}), max(${opportunities.last_activity_at}), max(${deals.detected_at}))`,
    })
    .from(deals)
    .leftJoin(opportunities, eq(opportunities.id, deals.opportunity_id))
    .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
    .where(and(eq(deals.athlete_id, athleteId), where))
    .groupBy(deals.id, opportunities.id);
  return rows
    .filter((r) => !CLOSED_DEAL.includes(String(r.status ?? "")) && (r.opportunity_id == null || r.opp_status === "open"))
    .sort((a, b) => new Date(b.activity ?? 0).getTime() - new Date(a.activity ?? 0).getTime());
}

/**
 * The deal a meeting with these addresses belongs to, or null. Exported for tests and the fold script.
 *
 * `opts` exists for scripts/opps/foldAutoCore (the all-athlete invite fold), never for ingest:
 *   excludeDealIds — deals that may not be the answer (the invite pseudo-deals themselves);
 *   brandIds       — brands already attributed to the invite, used as step 2's brand set alongside the domain
 *                    lookup (a Google-Calendar invite's only stored sender is the notifier, filtered out above).
 */
export async function matchMeeting(
  athleteId: string,
  addresses: string[],
  opts: { excludeDealIds?: string[]; brandIds?: number[] } = {},
): Promise<{ dealId: string; opportunityId: string | null; brandId: number | null; matchedBy: MeetingMatch } | null> {
  const exclude = new Set(opts.excludeDealIds ?? []);
  const allowed = (rows: Awaited<ReturnType<typeof openDeals>>) => rows.filter((r) => !exclude.has(r.deal_id));
  const own = new Set((await db.select({ u: connectedAccounts.platform_username }).from(connectedAccounts)
    .where(eq(connectedAccounts.athlete_id, athleteId))).map((r) => String(r.u ?? "").toLowerCase()));
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => a.includes("@") && !own.has(a) && !/@(?:[a-z0-9-]+\.)*google\.com$/.test(a)))];
  const extraBrands = [...new Set(opts.brandIds ?? [])];
  if (!addrs.length && !extraBrands.length) return null;

  // 1. counterparty: a deal thread already holding mail from one of these addresses (stored or pseudonymous form).
  const forms = [...new Set(addrs.flatMap((a) => [a, pseudonymousSender(a)].filter((x): x is string => !!x)))];
  const threadRows = !forms.length ? [] : await db.selectDistinct({ deal_id: inboxThreads.deal_id }).from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.thread_id))
    .where(and(eq(inboxMessages.athlete_id, athleteId), isNotNull(inboxThreads.deal_id), inArray(sql`lower(${inboxMessages.sender_email})`, forms)));
  const byCounterparty = threadRows.length
    ? allowed(await openDeals(athleteId, inArray(deals.id, threadRows.map((r) => r.deal_id!))))
    : [];
  const pick = (rows: Awaited<ReturnType<typeof openDeals>>, matchedBy: MeetingMatch) => rows[0]
    ? { dealId: rows[0].deal_id, opportunityId: rows[0].opportunity_id, brandId: rows[0].opp_brand ?? rows[0].brand_id ?? null, matchedBy }
    : null;
  if (byCounterparty.length) return pick(byCounterparty, "counterparty");

  // 2. brand_domain: the organisation's domain is a brand row's domain.
  const domains = [...new Set(addrs.map((a) => brandDomainOf(a.split("@")[1])).filter((d): d is string => !!d))];
  if (!domains.length && !extraBrands.length) return null;
  const byDomain = domains.length ? (await db.select({ id: inboxBrands.id }).from(inboxBrands).where(inArray(inboxBrands.domain, domains))).map((b) => b.id) : [];
  const brands = [...new Set([...byDomain, ...extraBrands])];
  if (!brands.length) return null;
  return pick(allowed(await openDeals(athleteId, or(inArray(deals.brand_id, brands), inArray(opportunities.brand_id, brands)))), "brand_domain");
}

/**
 * Record one calendar invite on its thread: matched to her deal, or held unmatched. Returns the marker written, or
 * null on failure (the thread then simply carries no marker). The deal row is never touched.
 */
export async function placeMeeting(p: {
  athleteId:     string;
  threadId:      string;
  invite:        CalendarInvite;
  senderAddress: string | null;
  retainContent: boolean;
}): Promise<MeetingMarker | null> {
  const { athleteId, threadId, invite } = p;
  try {
    const match = await matchMeeting(athleteId, [p.senderAddress, invite.organizer].filter((a): a is string => !!a));
    const msgs = await db.select({ id: inboxMessages.id, at: inboxMessages.received_at }).from(inboxMessages)
      .where(eq(inboxMessages.thread_id, threadId)).orderBy(inboxMessages.received_at);
    const lastAt = msgs.length ? new Date(msgs[msgs.length - 1].at ?? Date.now()) : new Date();
    const base = {
      event: invite.event, start: invite.start, title: p.retainContent ? invite.title : null,
      source_message_ids: msgs.map((m) => m.id), observed_at: new Date().toISOString(),
    };
    const marker: MeetingMarker = match
      ? { state: "matched", ...base, deal_id: match.dealId, ...(match.opportunityId ? { opportunity_id: match.opportunityId } : {}),
          ...(match.brandId != null ? { brand_id: match.brandId } : {}), matched_by: match.matchedBy }
      : { state: "unmatched", ...base };

    await db.transaction(async (tx) => {
      if (match) {
        if (match.brandId != null) await lockBrand(tx, athleteId, match.brandId);
        if (match.opportunityId) {
          await tx.update(opportunities).set({
            last_activity_at: sql`greatest(${opportunities.last_activity_at}, ${lastAt.toISOString()}::timestamptz)`,
            going_quiet_at: null,
          }).where(and(eq(opportunities.id, match.opportunityId), eq(opportunities.athlete_id, athleteId)));
        }
        if (match.brandId != null) await tx.update(inboxThreads).set({ brand_id: match.brandId }).where(eq(inboxThreads.id, threadId));
      }
      // Merge-only: nothing else kept on the classification is touched.
      await tx.update(inboxThreads)
        .set({ classification: sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) || ${JSON.stringify({ meeting: marker })}::jsonb` })
        .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)));
    });
    logger.info({ athleteId, threadId, state: marker.state, event: marker.event, matchedBy: marker.matched_by, dealId: marker.deal_id }, "Meeting observed");
    return marker;
  } catch (e: any) {
    logger.warn({ threadId, err: e?.message }, "Meeting placement skipped");
    return null;
  }
}

