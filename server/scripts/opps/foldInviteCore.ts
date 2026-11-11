/**
 * foldInviteCore.ts — fold a calendar-invite pseudo-deal (minted before skills/meetings existed) into a target deal
 * as a MEETING, the way ingest records one now. Behind `foldPaperworkAndSplit.ts --fold-invite <deal> --into <deal>`.
 *
 *   plan  — read-only: the pseudo-deal, its one thread, the target, the meeting read off the stored subject (the same
 *           lib/calendarInvite decision ingest makes), and every prior value (the rollback record).
 *   apply — one transaction: the thread gets a matched `classification.meeting` marker on the target (matched_by
 *           legacy_fold) and loses deal_id; the pseudo-deal is retired (status rejected, off its opportunity and
 *           group, raw_data.retired = { as: "meeting", prior }); its opportunity, when the pseudo-deal was its only
 *           member, is closed as not_relevant.
 *   undo  — puts every prior value back from the plan (the JSON receipt the CLI writes).
 *
 * Reads the stored subject, so it refuses under MAILBOX_ZERO_RETENTION (new invites are decided at ingest instead).
 * No model is called. Tenancy: every read and write filters the athlete.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { dealPeriods, deals, inboxMessages, inboxThreads, opportunities, payments, pendingActions } from "../../../shared/schema";
import { detectCalendarInvite, meetingLabel } from "../../lib/calendarInvite";
import type { MeetingMarker } from "../../skills/meetings";
import { refuseUnderZeroRetention } from "../privacy/storedContentGuard";

export interface InviteFoldPlan {
  athlete_id: string;
  generated_at: string;
  pseudo_deal_id: string;
  target_deal_id: string;
  thread_id: string | null;
  meeting: Pick<MeetingMarker, "event" | "start" | "title"> & { label: string; signals: string[] } | null;
  target: { opportunity_id: string | null; brand_id: number | null; status: string | null } | null;
  prior: {
    deal: { status: string | null; opportunity_id: string | null; deal_group_id: string | null } | null;
    thread: { deal_id: string | null; status: string | null; meeting: unknown } | null;
    opportunity: { id: string; status: string | null; close_reason: string | null; closed_at: string | null; lead_thread_id: string | null } | null;
  };
  /** The pseudo-deal's opportunity is closed only when it holds nothing else. */
  close_opportunity: boolean;
  problems: string[];
  applied?: { at: string };
}

const iso = (v: unknown) => (v == null ? null : new Date(v as any).toISOString());

export async function planInviteFold(dbx: any, athleteId: string, pseudoDealId: string, targetDealId: string): Promise<InviteFoldPlan> {
  refuseUnderZeroRetention("foldPaperworkAndSplit --fold-invite");
  const problems: string[] = [];
  const [d] = await dbx.select().from(deals).where(and(eq(deals.id, pseudoDealId), eq(deals.athlete_id, athleteId))).limit(1);
  const [tgt] = await dbx.select().from(deals).where(and(eq(deals.id, targetDealId), eq(deals.athlete_id, athleteId))).limit(1);
  if (!d) problems.push("the invite deal is not hers");
  if (!tgt) problems.push("the target deal is not hers");
  if (pseudoDealId === targetDealId) problems.push("the invite deal and the target are the same deal");
  if (d && tgt && d.brand_id != null && tgt.brand_id != null && d.brand_id !== tgt.brand_id) problems.push("the target is a different brand");
  if (tgt && ["rejected"].includes(String(tgt.status))) problems.push("the target deal is rejected");
  if (d && (d.signed_at || (d.raw_data as any)?.contract)) problems.push("the invite deal has signing or a contract on it");
  if (d && (d.raw_data as any)?.retired) problems.push("the invite deal is already retired");

  const threads = d ? await dbx.select({
    id: inboxThreads.id, deal_id: inboxThreads.deal_id, status: inboxThreads.status, classification: inboxThreads.classification,
    subject: inboxThreads.subject,
  }).from(inboxThreads).where(and(eq(inboxThreads.athlete_id, athleteId), eq(inboxThreads.deal_id, d.id))) : [];
  if (d && threads.length !== 1) problems.push(`the invite deal has ${threads.length} threads (expected exactly one)`);
  const t = threads[0] ?? null;

  let meeting: InviteFoldPlan["meeting"] = null;
  if (t) {
    const [m] = await dbx.select({ sender: inboxMessages.sender_email, n: sql<number>`count(*) over ()` }).from(inboxMessages)
      .where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, t.id))).orderBy(inboxMessages.received_at).limit(1);
    const inv = detectCalendarInvite({ from: m?.sender ?? "", subject: t.subject ?? "", body: "" });
    if (!inv) problems.push("the thread does not read as a calendar invite (subject shape)");
    else meeting = { event: inv.event, start: inv.start, title: inv.title, label: meetingLabel(inv), signals: inv.signals };
  }
  if (d) {
    const blockers = await Promise.all([
      dbx.select({ id: dealPeriods.id }).from(dealPeriods).where(eq(dealPeriods.deal_id, d.id)).limit(1),
      dbx.select({ id: payments.id }).from(payments).where(eq(payments.deal_id, d.id)).limit(1),
      dbx.select({ id: pendingActions.id }).from(pendingActions).where(eq(pendingActions.deal_id, d.id)).limit(1),
    ]);
    if (blockers.some((b: unknown[]) => b.length)) problems.push("the invite deal has periods, payments or a pending action");
  }

  let opp: InviteFoldPlan["prior"]["opportunity"] = null;
  let closeOpp = false;
  if (d?.opportunity_id) {
    const [o] = await dbx.select().from(opportunities).where(and(eq(opportunities.id, d.opportunity_id), eq(opportunities.athlete_id, athleteId))).limit(1);
    if (o) {
      opp = { id: o.id, status: o.status, close_reason: o.close_reason, closed_at: iso(o.closed_at), lead_thread_id: o.lead_thread_id };
      const others = await dbx.select({ id: deals.id }).from(deals).where(and(eq(deals.athlete_id, athleteId), eq(deals.opportunity_id, o.id), ne(deals.id, d.id))).limit(1);
      closeOpp = !others.length && o.status === "open" && o.id !== tgt?.opportunity_id;
    }
  }
  return {
    athlete_id: athleteId, generated_at: new Date().toISOString(), pseudo_deal_id: pseudoDealId, target_deal_id: targetDealId,
    thread_id: t?.id ?? null, meeting,
    target: tgt ? { opportunity_id: tgt.opportunity_id ?? null, brand_id: tgt.brand_id ?? null, status: tgt.status ?? null } : null,
    prior: {
      deal: d ? { status: d.status ?? null, opportunity_id: d.opportunity_id ?? null, deal_group_id: d.deal_group_id ?? null } : null,
      thread: t ? { deal_id: t.deal_id, status: t.status ?? null, meeting: (t.classification as any)?.meeting ?? null } : null,
      opportunity: opp,
    },
    close_opportunity: closeOpp,
    problems,
  };
}

export async function applyInviteFold(dbx: any, plan: InviteFoldPlan): Promise<InviteFoldPlan> {
  if (plan.problems.length || !plan.thread_id || !plan.meeting || !plan.target) throw new Error(`not applying: ${plan.problems.join("; ") || "incomplete plan"}`);
  const now = new Date();
  const marker: MeetingMarker = {
    state: "matched", event: plan.meeting.event, start: plan.meeting.start, title: plan.meeting.title,
    deal_id: plan.target_deal_id, ...(plan.target.opportunity_id ? { opportunity_id: plan.target.opportunity_id } : {}),
    ...(plan.target.brand_id != null ? { brand_id: plan.target.brand_id } : {}), matched_by: "legacy_fold",
    source_message_ids: [], observed_at: now.toISOString(),
  };
  await dbx.transaction(async (tx: any) => {
    await tx.update(inboxThreads).set({
      deal_id: null,
      classification: sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) || ${JSON.stringify({ meeting: marker })}::jsonb`,
    }).where(and(eq(inboxThreads.id, plan.thread_id!), eq(inboxThreads.athlete_id, plan.athlete_id)));
    await tx.update(deals).set({
      status: "rejected", opportunity_id: null, deal_group_id: null,
      raw_data: sql`coalesce(${deals.raw_data}, '{}'::jsonb) || ${JSON.stringify({ retired: { as: "meeting", at: now.toISOString(), target_deal_id: plan.target_deal_id, thread_id: plan.thread_id, prior: plan.prior } })}::jsonb`,
    }).where(and(eq(deals.id, plan.pseudo_deal_id), eq(deals.athlete_id, plan.athlete_id)));
    if (plan.close_opportunity && plan.prior.opportunity) {
      await tx.update(opportunities).set({ status: "closed", close_reason: "not_relevant", closed_at: now, lead_thread_id: null, going_quiet_at: null })
        .where(and(eq(opportunities.id, plan.prior.opportunity.id), eq(opportunities.athlete_id, plan.athlete_id)));
    }
  });
  return { ...plan, applied: { at: now.toISOString() } };
}

/** Put every prior value back from an applied plan (the JSON receipt). */
export async function undoInviteFold(dbx: any, plan: InviteFoldPlan): Promise<void> {
  if (!plan.applied || !plan.thread_id || !plan.prior.deal || !plan.prior.thread) throw new Error("not an applied invite-fold receipt");
  await dbx.transaction(async (tx: any) => {
    const o = plan.prior.opportunity;
    if (plan.close_opportunity && o) {
      await tx.update(opportunities).set({ status: o.status, close_reason: o.close_reason, closed_at: o.closed_at ? new Date(o.closed_at) : null, lead_thread_id: o.lead_thread_id })
        .where(and(eq(opportunities.id, o.id), eq(opportunities.athlete_id, plan.athlete_id)));
    }
    await tx.update(deals).set({
      status: plan.prior.deal!.status, opportunity_id: plan.prior.deal!.opportunity_id, deal_group_id: plan.prior.deal!.deal_group_id,
      raw_data: sql`coalesce(${deals.raw_data}, '{}'::jsonb) - 'retired'`,
    }).where(and(eq(deals.id, plan.pseudo_deal_id), eq(deals.athlete_id, plan.athlete_id)));
    const priorMeeting = plan.prior.thread!.meeting;
    await tx.update(inboxThreads).set({
      deal_id: plan.prior.thread!.deal_id,
      classification: priorMeeting
        ? sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) || ${JSON.stringify({ meeting: priorMeeting })}::jsonb`
        : sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) - 'meeting'`,
    }).where(and(eq(inboxThreads.id, plan.thread_id!), eq(inboxThreads.athlete_id, plan.athlete_id)));
  });
}

export function renderInviteFold(plan: InviteFoldPlan, mode: "dry-run" | "apply" | "undo"): string {
  const s = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");
  const lines = [`# Calendar-invite fold — ${mode} — athlete ${plan.athlete_id}`, `generated ${plan.generated_at}`, ""];
  if (plan.meeting) {
    lines.push(`- deal ${s(plan.pseudo_deal_id)} (thread ${s(plan.thread_id)}, was ${plan.prior.deal?.status}, opportunity ${s(plan.prior.deal?.opportunity_id)}) → meeting "${plan.meeting.label}" (${plan.meeting.event}; read from ${plan.meeting.signals.join(", ")}) on deal ${s(plan.target_deal_id)} (opportunity ${s(plan.target?.opportunity_id)}, ${plan.target?.status})`);
    lines.push(`- the invite deal is retired (status rejected, off its opportunity and group); thread deal_id cleared`);
    lines.push(plan.close_opportunity
      ? `- opportunity ${s(plan.prior.opportunity?.id)} held only the invite → closed as not_relevant`
      : `- opportunity ${s(plan.prior.opportunity?.id)} is left as it is`);
  }
  for (const p of plan.problems) lines.push(`- PROBLEM: ${p}`);
  if (plan.applied) lines.push("", `Applied at ${plan.applied.at}. Undo: --undo-invite-fold <this plan's .json>`);
  return lines.join("\n");
}
