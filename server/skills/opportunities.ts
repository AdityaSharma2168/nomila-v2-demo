/**
 * opportunities.ts — one opportunity per brand (Opportunities PR 2).
 *
 * Every email about one brand ends up under ONE opportunity: the pitch, the signature
 * requests, the "Completed" notice and the payment mail. The row is thin (shared/schema.ts
 * `opportunities`); money, contract and status stay on the deals, and a deal reaches its
 * opportunity through deals.opportunity_id.
 *
 * Where a deal lands (placeNewDeal, run right after upsertDealForThread mints the deal):
 *   · e-sign / payment mail (WORKFLOW_DOMAINS) never reaches here: it never mints a deal and
 *     never opens an opportunity — ./paperwork matches it to an existing deal or holds it.
 *   · an agency that has not named its advertiser: ONE open opportunity per agency, no split.
 *   · otherwise: an open opportunity for the advertiser → the same-deal partition decides
 *     whether this is a clearly separate engagement (a new row); when it can't tell, ATTACH.
 *     No open opportunity → create one.
 * A reply on a known thread already has its deal, so it only advances last_activity_at
 * (noteThreadActivity) — no model call. When a later email in an agency thread names the
 * advertiser, that thread's deal moves to the advertiser's opportunity.
 *
 * Doubt means attach, the opposite of dealGrouping's on-mint bias, on purpose: nothing is
 * hidden under an opportunity (every deal and thread stays visible under the card), and
 * moving a deal is one opportunity_id update.
 *
 * One OPEN row per (athlete, brand) is enforced here, not by a unique index (a separate
 * engagement may have its own row): the lookup-and-create runs under
 * pg_advisory_xact_lock(athlete, brand), so two threads from one brand arriving together
 * cannot both create one. The model is never called while the lock is held.
 *
 * The opportunity id is copied into deal_group_id, so the group readers show one card per
 * opportunity (OPPS_ONE_PER_BRAND until it was retired on 2 Nov 2026: always on).
 *
 * Never throws into the caller and never blocks minting a deal.
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { partitionOrNull, type GroupRow } from "./dealGrouping";
import { createLogger } from "../logger";

const logger = createLogger("skills/opportunities");

/** Deal statuses past `detected` that mean someone is working it (paperwork matching and the sweep). */
export const WORKED_DEAL_STATUSES = ["pending", "negotiating", "accepted", "completed"];

/** Members considered by the same-engagement partition — the newest, so one prompt stays small. */
const MAX_PARTITION_MEMBERS = 12;

type Dbx = typeof db;
type Tx = Parameters<Parameters<Dbx["transaction"]>[0]>[0];
type Conn = Dbx | Tx;

/** Serialise lookup-and-create for one (athlete, brand) until the transaction ends. */
export async function lockBrand(tx: Conn, athleteId: string, brandId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${athleteId}::text), ${brandId}::int)`);
}

/**
 * The thread's first and newest message SENT times (inbox_messages.received_at is the mail's
 * own Date header). inbox_threads.last_message_at is ingest time, which is why it isn't used.
 */
async function threadTimes(conn: Conn, threadId: string): Promise<{ first: Date; last: Date }> {
  const [r] = await conn
    .select({
      first: sql<string | null>`min(${inboxMessages.received_at})`,
      last:  sql<string | null>`max(${inboxMessages.received_at})`,
    })
    .from(inboxMessages)
    .where(eq(inboxMessages.thread_id, threadId));
  const now = new Date();
  return {
    first: r?.first ? new Date(r.first) : now,
    last:  r?.last ? new Date(r.last) : now,
  };
}

/**
 * The newest message SENT time across everything an opportunity holds: its deals' threads and the paperwork /
 * meeting threads matched to those deals. `oppId` is a value or a column (`o.id` in a raw query). NULL when it
 * holds no message.
 */
export function opportunityLastMessageAt(oppId: unknown) {
  return sql`(SELECT max(m.received_at) FROM inbox_messages m
    JOIN inbox_threads t ON t.id = m.thread_id
    JOIN deals d ON d.opportunity_id = ${oppId} AND d.athlete_id = t.athlete_id
     AND (t.deal_id = d.id
       OR t.classification -> 'paperwork' ->> 'deal_id' = d.id::text
       OR t.classification -> 'meeting' ->> 'deal_id' = d.id::text))`;
}

/** A thread's newest message SENT time from the messages it holds now. `threadId` is a value or a column. */
export function threadLastMessageAt(threadId: unknown) {
  return sql`(SELECT max(m.received_at) FROM inbox_messages m WHERE m.thread_id = ${threadId})`;
}

/**
 * After messages or deals move between threads / opportunities (a split, its undo): set the thread's
 * last_message_at and the opportunity's last_activity_at from the messages they hold NOW. Both used to keep the
 * newest date of what had just moved away, so the deal left behind read as active on the day of the split.
 * Holding no message → the stored value is kept.
 */
export async function resyncThreadLastMessage(conn: Conn, athleteId: string, threadId: string): Promise<void> {
  await conn.update(inboxThreads)
    .set({ last_message_at: sql`coalesce(${threadLastMessageAt(threadId)}, ${inboxThreads.last_message_at})` })
    .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)));
}

export async function resyncOpportunityActivity(conn: Conn, athleteId: string, opportunityId: string): Promise<void> {
  await conn.update(opportunities)
    .set({ last_activity_at: sql`coalesce(${opportunityLastMessageAt(opportunityId)}, ${opportunities.last_activity_at})` })
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId)));
}

async function openFor(conn: Conn, athleteId: string, brandId: number) {
  return conn
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.athlete_id, athleteId), eq(opportunities.brand_id, brandId), eq(opportunities.status, "open")))
    .orderBy(desc(opportunities.last_activity_at));
}

async function isAgencyBrand(conn: Conn, brandId: number): Promise<boolean> {
  const [b] = await conn.select({ is_agency: inboxBrands.is_agency }).from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  return b?.is_agency === true;
}

async function createOpportunity(
  tx: Conn,
  p: { athleteId: string; brandId: number | null; leadThreadId: string; openedAt: Date; lastActivityAt: Date },
): Promise<string> {
  const [row] = await tx
    .insert(opportunities)
    .values({
      athlete_id:       p.athleteId,
      brand_id:         p.brandId,
      status:           "open",
      opened_at:        p.openedAt,
      last_activity_at: p.lastActivityAt,
      lead_thread_id:   p.leadThreadId,
    })
    .returning({ id: opportunities.id });
  return row.id;
}

/**
 * Put a deal under an opportunity and advance the opportunity's activity. New activity clears
 * the sweep's "going quiet" mark. Flag ON: every member's deal_group_id becomes the opportunity
 * id — all members, so a pre-flag opportunity heals the first time it is touched.
 */
async function attach(tx: Conn, dealId: string, opportunityId: string, activityAt: Date): Promise<void> {
  await tx.update(deals).set({ opportunity_id: opportunityId }).where(eq(deals.id, dealId));
  await tx
    .update(opportunities)
    .set({
      last_activity_at: sql`greatest(${opportunities.last_activity_at}, ${activityAt.toISOString()}::timestamptz)`,
      going_quiet_at:   null,
    })
    .where(eq(opportunities.id, opportunityId));
  await tx
    .update(deals)
    .set({ deal_group_id: opportunityId })
    .where(and(eq(deals.opportunity_id, opportunityId), sql`${deals.deal_group_id} is distinct from ${opportunityId}::uuid`));
}

/**
 * Same engagement? Partition the new deal with the newest members of the brand's open
 * opportunities. Returns the opportunity to join, or "split" when the model clearly puts the
 * new deal on its own. A failed call, or an opportunity with no members yet, means attach.
 */
async function sameEngagement(dealId: string, open: { id: string }[]): Promise<{ attach: string } | "split"> {
  const fallback = { attach: open[0].id };
  const cols = { id: deals.id, brand_name: deals.brand_name, detected_at: deals.detected_at, raw_data: deals.raw_data, opportunity_id: deals.opportunity_id };
  const [self] = await db.select(cols).from(deals).where(eq(deals.id, dealId)).limit(1);
  const members = await db
    .select(cols)
    .from(deals)
    .where(and(inArray(deals.opportunity_id, open.map((o) => o.id)), ne(deals.id, dealId)))
    .orderBy(desc(deals.detected_at))
    .limit(MAX_PARTITION_MEMBERS);
  if (!self || !members.length) return fallback;

  const parts = await partitionOrNull<GroupRow & { opportunity_id: string | null }>([self, ...members]);
  if (!parts) return fallback;
  const mine = parts.find((p) => p.some((r) => r.id === dealId)) ?? [];
  const peers = mine.filter((r) => r.id !== dealId && r.opportunity_id);
  if (!peers.length) return "split";

  // The opportunity most of its peers sit in (members are newest-first, so ties go to the newest).
  const votes = new Map<string, number>();
  for (const r of peers) votes.set(r.opportunity_id!, (votes.get(r.opportunity_id!) ?? 0) + 1);
  return { attach: [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] };
}

/**
 * Place a just-minted deal under its opportunity. Returns the opportunity id, or null on any
 * failure. Paperwork (e-sign / payment mail) never mints a deal, so it never reaches here.
 */
export async function placeNewDeal(p: {
  athleteId: string;
  dealId:    string;
  threadId:  string;
  brandId:   number | null;
  /**
   * The same-engagement decision was already made elsewhere and said SEPARATE (a new subject inside an old
   * conversation, decided at ingest — docs/design/brand-page-deals.md D6): open a new opportunity, no model call.
   */
  forceNew?: boolean;
}): Promise<string | null> {
  const { athleteId, dealId, threadId, brandId } = p;
  try {
    const { first, last } = await threadTimes(db, threadId);

    // No brand at all: nothing to key on, so the thread is its own opportunity.
    if (!brandId) {
      return await db.transaction(async (tx) => {
        const id = await createOpportunity(tx, { athleteId, brandId: null, leadThreadId: threadId, openedAt: first, lastActivityAt: last });
        await attach(tx, dealId, id, last);
        return id;
      });
    }

    // Decide outside the lock (it may call the model); re-check inside it.
    const agency = await isAgencyBrand(db, brandId);
    const openBefore = await openFor(db, athleteId, brandId);
    // The agency rule never splits: an agency without a named advertiser keeps its ONE open opportunity.
    const decision = !agency && p.forceNew ? "split"
      : !agency && openBefore.length ? await sameEngagement(dealId, openBefore) : null;

    const placed = await db.transaction(async (tx) => {
      await lockBrand(tx, athleteId, brandId);
      const open = await openFor(tx, athleteId, brandId);
      let id: string;
      if (decision === "split") {
        id = await createOpportunity(tx, { athleteId, brandId, leadThreadId: threadId, openedAt: first, lastActivityAt: last });
      } else if (decision && open.some((o) => o.id === decision.attach)) {
        id = decision.attach;
      } else if (open.length) {
        id = open[0].id;   // an agency's one opportunity, or one a concurrent mint just created
      } else {
        id = await createOpportunity(tx, { athleteId, brandId, leadThreadId: threadId, openedAt: first, lastActivityAt: last });
      }
      await attach(tx, dealId, id, last);
      return id;
    });
    logger.info({ athleteId, dealId, opportunityId: placed, brandId, split: decision === "split" }, "Deal placed under its opportunity");
    return placed;
  } catch (e: any) {
    logger.warn({ dealId, err: e?.message }, "Opportunity placement skipped");
    return null;
  }
}

/**
 * A new message on a thread whose deal already exists: advance the opportunity's activity.
 * If the deal sits in an agency's opportunity and `advertiser()` now resolves to a real
 * advertiser, the deal moves to that advertiser's open opportunity (created if needed).
 * `advertiser` is lazy so the common reply never touches the resolver.
 */
export async function noteThreadActivity(p: {
  athleteId:   string;
  threadId:    string;
  dealId:      string;
  advertiser?: () => Promise<number | null>;
}): Promise<void> {
  try {
    const [d] = await db
      .select({ opportunity_id: deals.opportunity_id, broker_brand_id: deals.broker_brand_id })
      .from(deals)
      .where(eq(deals.id, p.dealId))
      .limit(1);
    if (!d?.opportunity_id) return;   // not placed yet (pre-backfill) — the backfill places it
    const [opp] = await db
      .select({ id: opportunities.id, brand_id: opportunities.brand_id })
      .from(opportunities)
      .where(eq(opportunities.id, d.opportunity_id))
      .limit(1);
    if (!opp) return;
    const { first, last } = await threadTimes(db, p.threadId);

    if (opp.brand_id && p.advertiser && (await isAgencyBrand(db, opp.brand_id))) {
      const advertiserId = await p.advertiser();
      if (advertiserId && advertiserId !== opp.brand_id && !(await isAgencyBrand(db, advertiserId))) {
        const agencyId = opp.brand_id;
        const moved = await db.transaction(async (tx) => {
          await lockBrand(tx, p.athleteId, advertiserId);
          const [open] = await openFor(tx, p.athleteId, advertiserId);
          const id = open?.id
            ?? await createOpportunity(tx, { athleteId: p.athleteId, brandId: advertiserId, leadThreadId: p.threadId, openedAt: first, lastActivityAt: last });
          // The deal and thread now name the advertiser; the agency is kept as the broker.
          await tx
            .update(deals)
            .set({ brand_id: advertiserId, broker_brand_id: d.broker_brand_id ?? agencyId })
            .where(eq(deals.id, p.dealId));
          await tx.update(inboxThreads).set({ brand_id: advertiserId }).where(eq(inboxThreads.id, p.threadId));
          await attach(tx, p.dealId, id, last);
          return id;
        });
        logger.info({ dealId: p.dealId, from: opp.id, to: moved, advertiserId }, "Advertiser named — deal moved off the agency's opportunity");
        return;
      }
    }

    await db
      .update(opportunities)
      .set({
        last_activity_at: sql`greatest(${opportunities.last_activity_at}, ${last.toISOString()}::timestamptz)`,
        going_quiet_at:   null,
      })
      .where(eq(opportunities.id, opp.id));
  } catch (e: any) {
    logger.warn({ dealId: p.dealId, err: e?.message }, "Opportunity activity update skipped");
  }
}

/**
 * Close the deal's opportunity as not relevant when the deal was its last live one — every other deal under it is
 * rejected or set aside (its thread archived). A set-aside deal otherwise leaves an empty card on the board. Returns the
 * closed opportunity's id (the receipt carries it, so Undo reopens it) or null when nothing was closed.
 */
export async function closeOpportunityIfNothingLive(athleteId: string, dealId: string, now: Date = new Date()): Promise<string | null> {
  const [d] = await db.select({ opportunity_id: deals.opportunity_id }).from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId))).limit(1);
  const oppId = d?.opportunity_id ?? null;
  if (!oppId) return null;
  const [o] = await db.select({ status: opportunities.status }).from(opportunities)
    .where(and(eq(opportunities.id, oppId), eq(opportunities.athlete_id, athleteId))).limit(1);
  if (o?.status !== "open") return null;
  const others = await db
    .select({ status: deals.status, thread_status: inboxThreads.status })
    .from(deals)
    .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
    .where(and(eq(deals.opportunity_id, oppId), ne(deals.id, dealId)));
  if (others.some((x) => x.status !== "rejected" && x.thread_status !== "archived")) return null;
  await db.update(opportunities)
    .set({ status: "closed", close_reason: "not_relevant", closed_at: now, going_quiet_at: null })
    .where(and(eq(opportunities.id, oppId), eq(opportunities.status, "open")));
  return oppId;
}
