/**
 * archiveStaleDeals — the auto-archive sweep (WS5 deal lifecycle).
 *
 * A deal that came in and went cold — no activity for ARCHIVE_DORMANT_DAYS and never
 * worked (still 'detected'/'pending') — is dead weight in Explore All. This sweep
 * archives its THREAD (so it leaves the Brief + Explore's active view) and appends a
 * REVERSIBLE `agent_actions` receipt (action 'auto_archive'), so it shows under
 * Last-30 → "Set aside by Nomila → Auto-archived" with an Undo. The `deals` row is KEPT
 * — nothing is deleted; Undo just un-archives the thread via the existing
 * payload.from_status flow in POST /agent-actions/:id/undo.
 *
 * Hard gates (mirrors dealDetector.demoteDealThread's caution):
 *   - never an ACTIVE deal (negotiating / accepted / completed) — only untouched cold
 *     ones (detected / pending),
 *   - never an already-archived thread (so re-runs are cheap no-ops),
 *   - only threads with a real last-activity timestamp older than the cutoff,
 *   - never a conversation where it is HER TURN (12 Oct 2026): she has replied on the thread
 *     and the brand wrote back last. A brand waiting on her is not a dormant deal, however
 *     long the wait; it used to be filed silently. (An unanswered first pitch is still
 *     archivable — she never engaged.)
 *
 * OPPS_ONE_PER_BRAND (default off) moves the sweep to the OPPORTUNITY (sweepOpportunities):
 * per-thread archiving buried member threads of a live deal one at a time (gorjana lost three
 * while its lead stayed live) and never looked at value. Under the flag the per-thread pass
 * only sees deals that have no opportunity yet.
 *
 * Runs from the internal cron endpoint (daily). `now` is injectable for tests.
 */

import { db } from "../db";
import { deals, inboxThreads, opportunities } from "../../shared/schema";
import { and, eq, lt, ne, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { writeAgentAction } from "../lib/agentActions";
import {
  readStoredQualification,
  floorFor,
  loadQualificationFloors,
  type QualificationFloors,
  type WorkKind,
} from "./dealQualification";
import { WORKED_DEAL_STATUSES } from "./opportunities";
import { effectiveDealStatus, observedWorkedSql } from "../lib/observedStage";
import { createLogger } from "../logger";
import { enabledChoiceSql, jobGate } from "../agent/welcome/gate";

const logger = createLogger("skills/archiveStaleDeals");

/**
 * HER TURN on this thread: the brand wrote last (code-owned awaiting_response_from) AND she has
 * replied on it at least once. Blocks the sweep.
 */
export function herTurnSql(threadId: unknown, conversationState: unknown) {
  return sql`(
    coalesce(${conversationState} #>> '{key_details,awaiting_response_from}', '') = 'athlete'
    AND EXISTS (SELECT 1 FROM inbox_messages m WHERE m.thread_id = ${threadId} AND m.direction = 'outbound')
  )`;
}

export const ARCHIVE_DORMANT_DAYS = 45;
const DAY_MS = 86_400_000;

// Only untouched / cold deals are archivable — never one being worked or already won.
const ARCHIVABLE_DEAL_STATUSES = ["detected", "pending"];

export interface ArchiveResult {
  /** Threads archived this run. */
  archived: number;
  /** Threads that matched the dormant predicate (== archived unless a write failed). */
  scanned:  number;
  /** OPPS_ONE_PER_BRAND only: opportunities filed (closed · expired) / marked going quiet. */
  opportunitiesClosed?: number;
  opportunitiesQuiet?:  number;
}

/**
 * Archive every dormant, untouched deal-thread across all athletes. Idempotent: an
 * already-archived thread is excluded from the scan, so repeated runs settle to a
 * cheap no-op once the backlog is cleared.
 */
export async function archiveStaleDeals(now: Date = new Date()): Promise<ArchiveResult> {
  const cutoff = new Date(now.getTime() - ARCHIVE_DORMANT_DAYS * DAY_MS);
  const rows = await db
    .select({
      threadId:   inboxThreads.id,
      athleteId:  inboxThreads.athlete_id,
      fromStatus: inboxThreads.status,
      dealId:     inboxThreads.deal_id,
      brandName:  deals.brand_name,
    })
    .from(inboxThreads)
    .innerJoin(deals, eq(deals.id, inboxThreads.deal_id))
    .where(and(
      ne(inboxThreads.status, "archived"),
      isNotNull(inboxThreads.last_message_at),
      lt(inboxThreads.last_message_at, cutoff),
      inArray(deals.status, ARCHIVABLE_DEAL_STATUSES),
      // Protects: a thread the summarizer reads as negotiating or later is not cold
      // (max(status, observed) — the observation no longer moves deals.status).
      sql`not ${observedWorkedSql(inboxThreads.conversation_state)}`,
      // Her turn: a brand waiting on her reply is never filed away.
      sql`not ${herTurnSql(inboxThreads.id, inboxThreads.conversation_state)}`,
      // Opportunities PR 1: verify_first is never auto-filed — it waits for her to verify or decline.
      sql`coalesce(${inboxThreads.classification} ->> 'qualification', '') <> 'verify_first'`,
      // A placed deal is swept with its opportunity, never alone.
      isNull(deals.opportunity_id),
      // MILA_WELCOME: auto-archive is optional — only athletes who said yes (no-op SQL while the flag is off).
      enabledChoiceSql(inboxThreads.athlete_id, "auto_archive"),
    ));

  let archived = 0;
  const chose = jobGate("auto_archive");
  for (const r of rows) {
    try {
      if (!(await chose(r.athleteId))) continue;
      await db
        .update(inboxThreads)
        .set({ status: "archived" })
        .where(and(eq(inboxThreads.id, r.threadId), eq(inboxThreads.athlete_id, r.athleteId)));

      await writeAgentAction({
        athleteId:  r.athleteId,
        action:     "auto_archive",
        threadId:   r.threadId,
        dealId:     r.dealId,
        reversible: true,
        reason:     `No activity in ${ARCHIVE_DORMANT_DAYS}+ days — archived to keep your list clear`,
        payload:    { from_status: r.fromStatus ?? "read", to_status: "archived", brand_name: r.brandName ?? null },
      });
      archived++;
    } catch (err: any) {
      // One bad row must not abort the sweep — log and carry on.
      logger.error({ threadId: r.threadId, error: err?.message }, "Failed to archive a stale deal");
    }
  }

  const opp = await sweepOpportunities(now);

  logger.info({ archived, ...opp }, "Stale-deal archive sweep complete");
  return {
    archived:  archived + opp.threadsArchived,
    scanned:   rows.length,
    opportunitiesClosed: opp.closed,
    opportunitiesQuiet:  opp.quiet,
  };
}

// ─── Per-opportunity sweep (OPPS_ONE_PER_BRAND) ───────────────────────────────

/** One member of an opportunity, as the value test reads it. */
export interface SweepMember {
  dealStatus:     string | null;
  dealType:       string | null;
  amountCash:     string | number | null;
  classification: unknown;
  /** The thread's conversation_state — its observed deal_stage protects (never commits). */
  conversationState?: unknown;
  /** Her turn on this member's thread (herTurnSql): a brand waiting on her keeps it open. */
  herTurn?: boolean | null;
}

/**
 * Worth keeping in front of her, even after 45 quiet days? Valuable = a member deal past
 * `detected` (max(status, observed stage)), OR qualified workable, OR needs_terms from a DIRECT
 * brand (a real brand asking, no price yet), OR stated cash at or above her floor for that kind
 * of work.
 */
export function isValuableOpportunity(members: SweepMember[], floors: QualificationFloors | null): boolean {
  return members.some((m) => {
    if (m.herTurn) return true;
    const status = effectiveDealStatus(m.dealStatus, m.conversationState);
    if (status && WORKED_DEAL_STATUSES.includes(status)) return true;
    const q = readStoredQualification(m.classification);
    if (q?.qualification === "workable") return true;
    if (q?.qualification === "needs_terms" && q.channel === "direct") return true;
    const cash = m.amountCash == null ? NaN : Number(m.amountCash);
    if (Number.isFinite(cash) && cash > 0) {
      // deals.deal_type uses the same vocabulary as the qualification's work kinds.
      const f = floorFor((m.dealType ?? null) as WorkKind | null, floors);
      if (f && cash >= f.floor) return true;
    }
    return false;
  });
}

/**
 * Every open opportunity quiet for ARCHIVE_DORMANT_DAYS: not valuable → closed · expired, all
 * its member threads archived together, ONE reversible receipt. Valuable → stays open and is
 * marked going quiet once (going_quiet_at; new activity clears it). An opportunity holding a
 * verify_first thread is exempt while OPPS_QUALIFIED_INTAKE is on, as in the per-thread pass.
 */
export async function sweepOpportunities(now: Date = new Date()): Promise<{ scanned: number; closed: number; quiet: number; threadsArchived: number }> {
  const cutoff = new Date(now.getTime() - ARCHIVE_DORMANT_DAYS * DAY_MS);
  const quietOnes = await db
    .select({ id: opportunities.id, athleteId: opportunities.athlete_id, leadThreadId: opportunities.lead_thread_id })
    .from(opportunities)
    .where(and(
      eq(opportunities.status, "open"),
      lt(opportunities.last_activity_at, cutoff),
      isNull(opportunities.going_quiet_at),
      // MILA_WELCOME: auto-archive is optional — only athletes who said yes (no-op SQL while the flag is off).
      enabledChoiceSql(opportunities.athlete_id, "auto_archive"),
    ));

  const floorsByAthlete = new Map<string, QualificationFloors | null>();
  const chose = jobGate("auto_archive");
  let closed = 0, quiet = 0, threadsArchived = 0;
  for (const o of quietOnes) {
    try {
      if (!(await chose(o.athleteId))) continue;
      const members = await db
        .select({
          dealId:         deals.id,
          dealStatus:     deals.status,
          dealType:       deals.deal_type,
          amountCash:     deals.amount_cash,
          brandName:      deals.brand_name,
          threadId:       inboxThreads.id,
          threadStatus:   inboxThreads.status,
          classification: inboxThreads.classification,
          conversationState: inboxThreads.conversation_state,
          herTurn:        sql<boolean | null>`${herTurnSql(inboxThreads.id, inboxThreads.conversation_state)}`,
        })
        .from(deals)
        .leftJoin(inboxThreads, eq(inboxThreads.deal_id, deals.id))
        .where(eq(deals.opportunity_id, o.id));

      if (members.some((m) => readStoredQualification(m.classification)?.qualification === "verify_first")) continue;

      if (!floorsByAthlete.has(o.athleteId)) {
        floorsByAthlete.set(o.athleteId, await loadQualificationFloors(o.athleteId).catch(() => null));
      }
      if (isValuableOpportunity(members, floorsByAthlete.get(o.athleteId) ?? null)) {
        await db.update(opportunities).set({ going_quiet_at: now }).where(eq(opportunities.id, o.id));
        quiet++;
        continue;
      }

      const n = await closeOpportunityAsExpired({
        opportunityId: o.id,
        athleteId:     o.athleteId,
        leadThreadId:  o.leadThreadId,
        members,
        now,
        reason:        `No activity in ${ARCHIVE_DORMANT_DAYS}+ days — filed to keep your list clear`,
        by:            "sweep",
      });
      threadsArchived += n;
      closed++;
    } catch (err: any) {
      logger.error({ opportunityId: o.id, error: err?.message }, "Failed to sweep a quiet opportunity");
    }
  }
  return { scanned: quietOnes.length, closed, quiet, threadsArchived };
}

/**
 * Close one opportunity as expired: every member thread archived together and ONE reversible
 * `auto_archive` receipt carrying payload.opportunity_id and each thread's prior status, so
 * Undo reopens the opportunity and puts every thread back. Shared by the sweep and the backfill.
 * Returns the number of threads archived. `conn` lets the backfill run it inside its transaction.
 */
export async function closeOpportunityAsExpired(p: {
  opportunityId: string;
  athleteId:     string;
  leadThreadId:  string | null;
  members:       { dealId: string; brandName: string | null; threadId: string | null; threadStatus: string | null }[];
  now:           Date;
  reason:        string;
  by:            "sweep" | "opps_backfill";
  conn?:         any;
}): Promise<number> {
  const conn = p.conn ?? db;
  const live = p.members.filter((m) => m.threadId && m.threadStatus !== "archived");
  await conn
    .update(opportunities)
    .set({ status: "closed", close_reason: "expired", closed_at: p.now })
    .where(eq(opportunities.id, p.opportunityId));
  if (live.length) {
    await conn
      .update(inboxThreads)
      .set({ status: "archived" })
      .where(and(inArray(inboxThreads.id, live.map((m) => m.threadId!)), eq(inboxThreads.athlete_id, p.athleteId)));
  }
  const lead = p.members.find((m) => m.threadId && m.threadId === p.leadThreadId) ?? live[0] ?? p.members[0];
  await writeAgentAction({
    athleteId:  p.athleteId,
    action:     "auto_archive",
    threadId:   lead?.threadId ?? null,
    dealId:     lead?.dealId ?? null,
    reversible: true,
    reason:     p.reason,
    payload: {
      opportunity_id: p.opportunityId,
      // The lead thread's prior status, for the existing single-thread Undo path…
      from_status:    lead?.threadStatus ?? "read",
      to_status:      "archived",
      // …and every thread this filing archived, so Undo restores them all.
      threads:        live.map((m) => ({ id: m.threadId, from_status: m.threadStatus ?? "read" })),
      brand_name:     lead?.brandName ?? null,
      by:             p.by,
    },
  }, conn);
  return live.length;
}
