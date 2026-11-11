/**
 * dealSplit.ts — "This is a separate deal" (docs/design/brand-page-deals.md D7). Governed: only her tap, one
 * transaction under the brand's advisory lock, a reversible receipt (agent_actions 'split_deal').
 *
 *   chain — one email chain folded into a deal's thread (an alias: a provider thread id whose messages sit on
 *           this thread). Its messages move to a NEW thread (external_thread_id = the chain), the alias is
 *           removed, and a new deal (brand from the old deal, direction = the chain's first message) gets a new
 *           opportunity. gorjana's ThetaBreakers pitch is exactly this.
 *   deal  — a deal that already has its own thread but shares an opportunity with other deals: it moves to a new
 *           opportunity of the same brand.
 *
 * Undo is offered only while it is safe: the new thread still holds exactly the moved messages and the new deal
 * has no contract, periods, payments, sign-off or pending action. It moves everything back and removes what the
 * split created.
 *
 * deal_group_id is "the same underlying deal across threads" (routes/deals collapses a group to one card). A split
 * says the opposite, so the split-off deal always gets its OWN group — its new opportunity's id, the id
 * OPPS_ONE_PER_BRAND would give it — whatever the flag says. (Leaving it null, as a flag-off run did, left the
 * deal ungrouped while every sibling carried its opportunity id.)
 *
 * Re-summarising the two threads is a model call after the transaction. The route fires it and moves on; a script
 * that closes its pool afterwards passes { awaitSummaries: true } so the call cannot outlive the pool.
 *
 * Tenancy: every read and write filters the athlete.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { dealPeriods, deals, inboxMessages, inboxThreads, opportunities, payments, pendingActions } from "../../shared/schema";
import { lockBrand, resyncOpportunityActivity, resyncThreadLastMessage } from "./opportunities";
import { writeAgentAction } from "../lib/agentActions";
import { createLogger } from "../logger";

const logger = createLogger("skills/dealSplit");

export type SplitResult =
  | { ok: true; kind: "chain" | "deal"; deal_id: string; new_deal_id: string; new_opportunity_id: string; new_thread_id: string | null; receipt_id: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const resummarize = (threadId: string) =>
  import("./threadSummarizer.js").then(({ summarizeThread }) => summarizeThread(threadId)).catch((err: any) =>
    logger.warn({ threadId, err: err?.message }, "re-summarise after split failed"));

export async function splitDeal(
  athleteId: string, dealId: string, chain?: string | null, now: Date = new Date(), opts: { awaitSummaries?: boolean } = {},
): Promise<SplitResult> {
  const [deal] = await db.select().from(deals).where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId))).limit(1);
  if (!deal) return { ok: false, status: 404, error: "Deal not found" };
  const [opp] = deal.opportunity_id
    ? await db.select().from(opportunities).where(and(eq(opportunities.id, deal.opportunity_id), eq(opportunities.athlete_id, athleteId))).limit(1)
    : [null];
  const brandId = opp?.brand_id ?? deal.brand_id ?? null;

  if (!chain) {
    if (!opp) return { ok: false, status: 409, error: "This deal isn't under an engagement yet" };
    const others = await db.select({ id: deals.id }).from(deals)
      .where(and(eq(deals.athlete_id, athleteId), eq(deals.opportunity_id, opp.id), ne(deals.id, dealId)));
    if (!others.length) return { ok: false, status: 409, error: "This is already its own deal" };
    const [own] = await db.select({ id: inboxThreads.id, last: inboxThreads.last_message_at }).from(inboxThreads)
      .where(and(eq(inboxThreads.athlete_id, athleteId), eq(inboxThreads.deal_id, dealId))).limit(1);
    const out = await db.transaction(async (tx) => {
      if (brandId != null) await lockBrand(tx, athleteId, brandId);
      const [n] = await tx.insert(opportunities).values({
        athlete_id: athleteId, brand_id: brandId, status: "open", opened_at: deal.detected_at ?? now,
        last_activity_at: own?.last ?? now, lead_thread_id: own?.id ?? null,
      }).returning({ id: opportunities.id });
      await tx.update(deals).set({ opportunity_id: n.id, deal_group_id: n.id })
        .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)));
      if (opp.lead_thread_id && opp.lead_thread_id === own?.id) {
        const [lead] = await tx.select({ id: inboxThreads.id }).from(inboxThreads)
          .where(and(eq(inboxThreads.athlete_id, athleteId), inArray(inboxThreads.deal_id, others.map((o) => o.id)))).limit(1);
        await tx.update(opportunities).set({ lead_thread_id: lead?.id ?? null }).where(eq(opportunities.id, opp.id));
      }
      // The opportunity left behind reads its activity from the deals it still holds.
      await resyncOpportunityActivity(tx, athleteId, opp.id);
      const r = await writeAgentAction({
        athleteId, action: "split_deal", dealId, reversible: true, reason: "You said this is a separate deal",
        payload: { source: "athlete", kind: "deal", deal_id: dealId, from_opportunity_id: opp.id, from_lead_thread_id: opp.lead_thread_id, from_deal_group_id: deal.deal_group_id ?? null, new_opportunity_id: n.id, brand_name: deal.brand_name },
      }, tx);
      return { n: n.id, r: r.id };
    });
    logger.info({ athleteId, dealId, to: out.n }, "Deal split onto its own opportunity");
    return { ok: true, kind: "deal", deal_id: dealId, new_deal_id: dealId, new_opportunity_id: out.n, new_thread_id: null, receipt_id: out.r };
  }

  const [thread] = await db.select().from(inboxThreads).where(and(eq(inboxThreads.athlete_id, athleteId), eq(inboxThreads.deal_id, dealId))).limit(1);
  if (!thread) return { ok: false, status: 404, error: "This deal has no conversation" };
  if (chain === thread.external_thread_id) return { ok: false, status: 400, error: "That is the deal's own conversation" };
  const moved = await db.select({ id: inboxMessages.id, at: inboxMessages.received_at, direction: inboxMessages.direction })
    .from(inboxMessages)
    .where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, thread.id), eq(inboxMessages.gmail_thread_id, chain)))
    .orderBy(inboxMessages.received_at);
  if (!moved.length) return { ok: false, status: 404, error: "That email chain isn't on this deal" };
  if (moved.length >= (thread.message_count ?? 0) && moved.length >= (await countMessages(athleteId, thread.id))) {
    return { ok: false, status: 409, error: "That is the whole conversation" };
  }
  const [clash] = await db.select({ id: inboxThreads.id }).from(inboxThreads)
    .where(and(eq(inboxThreads.athlete_id, athleteId), eq(inboxThreads.external_thread_id, chain))).limit(1);
  if (clash) return { ok: false, status: 409, error: "That email chain already has its own conversation" };

  const first = moved[0];
  const last = moved[moved.length - 1];
  const cls = (thread.classification ?? {}) as Record<string, any>;
  const out = await db.transaction(async (tx) => {
    if (brandId != null) await lockBrand(tx, athleteId, brandId);
    const [nt] = await tx.insert(inboxThreads).values({
      athlete_id: athleteId, brand_id: thread.brand_id, subject: null, last_message_at: last.at ?? now, message_count: moved.length,
      status: "deal_detected", summary: null, connected_account_id: thread.connected_account_id, external_thread_id: chain,
      classification: {
        gmail_thread_id: chain, category: cls.category ?? "PAID", brand_name: cls.brand_name ?? null, brand_domain: cls.brand_domain ?? null,
        advertiser: cls.advertiser ?? null, agency_name: cls.agency_name ?? null, via_agency: cls.via_agency ?? false,
        split_from: { thread_id: thread.id, deal_id: dealId, at: now.toISOString() },
      },
    }).returning({ id: inboxThreads.id });
    await tx.update(inboxMessages).set({ thread_id: nt.id })
      .where(and(eq(inboxMessages.athlete_id, athleteId), inArray(inboxMessages.id, moved.map((m) => m.id))));
    await tx.update(inboxThreads).set({
      alias_thread_ids: sql`array_remove(coalesce(${inboxThreads.alias_thread_ids}, '{}'), ${chain})`,
      message_count: sql`greatest(0, coalesce(${inboxThreads.message_count}, 0) - ${moved.length})`,
    }).where(eq(inboxThreads.id, thread.id));
    const [nd] = await tx.insert(deals).values({
      athlete_id: athleteId, brand_id: deal.brand_id, brand_name: deal.brand_name, deal_type: deal.deal_type, status: "detected",
      detected_at: first.at ?? now, source: deal.source ?? "inbox_scan",
      direction: first.direction === "outbound" ? "outbound" : "inbound",
      raw_data: { origin: "split", split_from: dealId, summary: null },
    }).returning({ id: deals.id });
    await tx.update(inboxThreads).set({ deal_id: nd.id }).where(eq(inboxThreads.id, nt.id));
    const [no] = await tx.insert(opportunities).values({
      athlete_id: athleteId, brand_id: brandId, status: "open", opened_at: first.at ?? now, last_activity_at: last.at ?? now, lead_thread_id: nt.id,
    }).returning({ id: opportunities.id });
    await tx.update(deals).set({ opportunity_id: no.id, deal_group_id: no.id }).where(eq(deals.id, nd.id));
    // The thread and opportunity left behind keep only their own dates, not the newest of what moved away.
    await resyncThreadLastMessage(tx, athleteId, thread.id);
    if (opp) await resyncOpportunityActivity(tx, athleteId, opp.id);
    const r = await writeAgentAction({
      athleteId, action: "split_deal", dealId, reversible: true, reason: "You said this is a separate deal",
      payload: {
        source: "athlete", kind: "chain", deal_id: dealId, thread_id: thread.id, chain, message_ids: moved.map((m) => m.id),
        new_thread_id: nt.id, new_deal_id: nd.id, new_opportunity_id: no.id, brand_name: deal.brand_name,
      },
    }, tx);
    return { nt: nt.id, nd: nd.id, no: no.id, r: r.id };
  });
  const summaries = Promise.all([resummarize(thread.id), resummarize(out.nt)]);
  if (opts.awaitSummaries) await summaries;
  logger.info({ athleteId, dealId, newDealId: out.nd, moved: moved.length }, "Email chain split into its own deal");
  return { ok: true, kind: "chain", deal_id: dealId, new_deal_id: out.nd, new_opportunity_id: out.no, new_thread_id: out.nt, receipt_id: out.r };
}

async function countMessages(athleteId: string, threadId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(inboxMessages)
    .where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, threadId)));
  return Number(r?.n ?? 0);
}

/** Undo a split_deal receipt. Returns false when it is no longer safe (nothing is changed then). */
export async function undoSplit(athleteId: string, payload: Record<string, any>): Promise<boolean> {
  if (payload?.kind === "deal") {
    const dealId = String(payload.deal_id ?? "");
    const from = String(payload.from_opportunity_id ?? "");
    const created = String(payload.new_opportunity_id ?? "");
    const [fromOpp] = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.id, from), eq(opportunities.athlete_id, athleteId))).limit(1);
    if (!fromOpp) return false;
    const others = await db.select({ id: deals.id }).from(deals).where(and(eq(deals.athlete_id, athleteId), eq(deals.opportunity_id, created), ne(deals.id, dealId)));
    if (others.length) return false;
    await db.transaction(async (tx) => {
      // The group it had before the split (receipts written before it was recorded: the flag's rule, as then).
      const group = "from_deal_group_id" in payload ? { deal_group_id: payload.from_deal_group_id ?? null } : { deal_group_id: from };
      await tx.update(deals).set({ opportunity_id: from, ...group }).where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)));
      if (payload.from_lead_thread_id) await tx.update(opportunities).set({ lead_thread_id: payload.from_lead_thread_id }).where(eq(opportunities.id, from));
      await tx.delete(opportunities).where(and(eq(opportunities.id, created), eq(opportunities.athlete_id, athleteId)));
      await resyncOpportunityActivity(tx, athleteId, from);
    });
    return true;
  }
  if (payload?.kind !== "chain") return false;
  const ids: string[] = Array.isArray(payload.message_ids) ? payload.message_ids : [];
  const newThread = String(payload.new_thread_id ?? "");
  const newDeal = String(payload.new_deal_id ?? "");
  const newOpp = String(payload.new_opportunity_id ?? "");
  const oldThread = String(payload.thread_id ?? "");

  const onNew = await db.select({ id: inboxMessages.id }).from(inboxMessages).where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, newThread)));
  if (onNew.length !== ids.length || onNew.some((m) => !ids.includes(m.id))) return false;
  const [nd] = await db.select().from(deals).where(and(eq(deals.id, newDeal), eq(deals.athlete_id, athleteId))).limit(1);
  if (!nd || nd.signed_at || (nd.raw_data as any)?.contract) return false;
  const blockers = await Promise.all([
    db.select({ id: dealPeriods.id }).from(dealPeriods).where(eq(dealPeriods.deal_id, newDeal)).limit(1),
    db.select({ id: payments.id }).from(payments).where(eq(payments.deal_id, newDeal)).limit(1),
    db.select({ id: pendingActions.id }).from(pendingActions).where(eq(pendingActions.deal_id, newDeal)).limit(1),
    db.select({ id: deals.id }).from(deals).where(and(eq(deals.opportunity_id, newOpp), ne(deals.id, newDeal))).limit(1),
  ]);
  if (blockers.some((b) => b.length)) return false;

  try {
  await db.transaction(async (tx) => {
    await tx.update(inboxMessages).set({ thread_id: oldThread }).where(and(eq(inboxMessages.athlete_id, athleteId), inArray(inboxMessages.id, ids)));
    await tx.update(inboxThreads).set({
      alias_thread_ids: sql`array_append(array_remove(coalesce(${inboxThreads.alias_thread_ids}, '{}'), ${payload.chain}), ${payload.chain})`,
      message_count: sql`coalesce(${inboxThreads.message_count}, 0) + ${ids.length}`,
    }).where(and(eq(inboxThreads.id, oldThread), eq(inboxThreads.athlete_id, athleteId)));
    await tx.update(deals).set({ opportunity_id: null }).where(eq(deals.id, newDeal));
    await tx.update(inboxThreads).set({ deal_id: null }).where(eq(inboxThreads.id, newThread));
    await tx.delete(opportunities).where(and(eq(opportunities.id, newOpp), eq(opportunities.athlete_id, athleteId)));
    await tx.delete(inboxThreads).where(and(eq(inboxThreads.id, newThread), eq(inboxThreads.athlete_id, athleteId)));
    await tx.delete(deals).where(and(eq(deals.id, newDeal), eq(deals.athlete_id, athleteId)));
    await resyncThreadLastMessage(tx, athleteId, oldThread);
    const [orig] = await tx.select({ opportunity_id: deals.opportunity_id }).from(deals)
      .where(and(eq(deals.id, String(payload.deal_id ?? "")), eq(deals.athlete_id, athleteId))).limit(1);
    if (orig?.opportunity_id) await resyncOpportunityActivity(tx, athleteId, orig.opportunity_id);
  });
  } catch (e: any) {
    // Something now points at the new deal or thread (a receipt, a deliverable): not safe to remove. Rolled back.
    logger.warn({ newDeal, err: e?.message }, "split undo refused");
    return false;
  }
  void resummarize(oldThread);
  return true;
}
