/**
 * foldAutoCore.ts — the all-athlete auto-detect mode behind `foldPaperworkAndSplit.ts --all | --athlete <uuid>`.
 * No hand-picked brand, thread or deal ids: for each athlete it finds, READ-ONLY, the pseudo-deals today's ingest
 * would never have minted, using the SAME classifiers the live fixes use — nothing new is invented here:
 *
 *   paperwork — an e-sign / payment pseudo-deal (#777): skills/dealSigning's isLegacyPaperworkThread, through
 *               ./foldPaperworkCore's planFold over every opportunity she has. Folds into the opportunity's real deal.
 *   invite    — a calendar invite that minted its own deal (#840): lib/calendarInvite's detectCalendarInvite on the
 *               deal's one thread (stored subject + first sender, exactly what ./foldInviteCore reads), placed the way
 *               ingest places a meeting — skills/meetings' matchMeeting (counterparty, then brand), with the invite
 *               pseudo-deals and paperwork pseudo-deals themselves excluded as targets. Each one is then planned
 *               through ./foldInviteCore's planInviteFold, so its own refusals still apply.
 *
 * The split (--split-chain) is NOT auto-detected: which folded-in chain is really a separate pitch is a judgement,
 * so it stays manual (foldPaperworkAndSplit.ts --athlete <uuid> --split-chain <id>).
 *
 *   planAutoFold  — read-only; one AutoFoldPlan per athlete (the CLI writes one JSON file each).
 *   applyAutoFold — applies ONE reviewed plan in ONE transaction. Before writing it re-plans and refuses if any
 *                   reviewed item is no longer detected the same way (stale plan). Items found since the review are
 *                   NOT applied: only what a person reviewed is written.
 *   undoAutoFold  — puts every prior value back from the applied receipt (paperwork folds and invite folds).
 *
 * No model is called. Tenancy: every read and write filters the athlete.
 */
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { detectCalendarInvite } from "../../lib/calendarInvite";
import { matchMeeting } from "../../skills/meetings";
import { zeroRetentionRequested } from "../privacy/storedContentGuard";
import { applyFold, planFold, type FoldItem } from "./foldPaperworkCore";
import { applyInviteFold, planInviteFold, undoInviteFold, type InviteFoldPlan } from "./foldInviteCore";

export const AUTO_FOLD_KIND = "opps-auto-fold";

export interface AutoFoldPlan {
  kind: typeof AUTO_FOLD_KIND;
  version: 1;
  athlete_id: string;
  generated_at: string;
  paperwork: { folds: FoldItem[]; unresolved: Array<{ pseudo_deal_id: string; reason: string }> };
  invites: InviteFoldPlan[];
  invite_unresolved: Array<{ pseudo_deal_id: string; thread_id: string | null; reason: string }>;
  notes: string[];
  applied?: { at: string; paperwork_folded: number; invites_folded: number };
}

export const isEmptyPlan = (p: AutoFoldPlan) =>
  !p.paperwork.folds.length && !p.paperwork.unresolved.length && !p.invites.length && !p.invite_unresolved.length;

interface InviteCandidate { deal_id: string; thread_id: string; brand_ids: number[]; senders: string[] }

/** Deals of hers whose ONLY thread reads as a calendar invite (the #840 decision on the stored subject + sender). */
async function inviteCandidates(dbx: any, athleteId: string): Promise<InviteCandidate[]> {
  const live = await dbx.select({ id: deals.id, brand_id: deals.brand_id, opp_brand: opportunities.brand_id })
    .from(deals).leftJoin(opportunities, eq(opportunities.id, deals.opportunity_id))
    .where(and(eq(deals.athlete_id, athleteId), or(isNull(deals.status), ne(deals.status, "rejected")), sql`${deals.raw_data} -> 'retired' IS NULL`));
  if (!live.length) return [];
  const threads = await dbx.select({ id: inboxThreads.id, deal_id: inboxThreads.deal_id, subject: inboxThreads.subject })
    .from(inboxThreads).where(and(eq(inboxThreads.athlete_id, athleteId), inArray(inboxThreads.deal_id, live.map((d: any) => d.id))));
  const byDeal = new Map<string, typeof threads>();
  for (const t of threads) byDeal.set(t.deal_id, [...(byDeal.get(t.deal_id) ?? []), t]);
  const out: InviteCandidate[] = [];
  for (const d of live) {
    const own = byDeal.get(d.id) ?? [];
    if (own.length !== 1) continue;
    const t = own[0];
    const msgs: Array<{ sender: string | null }> = await dbx.select({ sender: inboxMessages.sender_email }).from(inboxMessages)
      .where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, t.id))).orderBy(inboxMessages.received_at);
    if (!detectCalendarInvite({ from: msgs[0]?.sender ?? "", subject: t.subject ?? "", body: "" })) continue;
    out.push({
      deal_id: d.id, thread_id: t.id,
      brand_ids: [...new Set([d.brand_id, d.opp_brand].filter((b: unknown): b is number => typeof b === "number"))],
      senders: [...new Set(msgs.map((m) => String(m.sender ?? "")).filter((s) => s.includes("@")))],
    });
  }
  return out;
}

/** Read-only: every candidate pseudo-deal of one athlete, planned through the existing fold cores. */
export async function planAutoFold(dbx: any, athleteId: string): Promise<AutoFoldPlan> {
  const notes: string[] = [];
  const paper = await planFold(dbx, athleteId, {});
  const invites: InviteFoldPlan[] = [];
  const inviteUnresolved: AutoFoldPlan["invite_unresolved"] = [];

  if (zeroRetentionRequested()) {
    notes.push("calendar invites not scanned: MAILBOX_ZERO_RETENTION is on (stored subjects are gone; new invites are decided at ingest)");
  } else {
    const cands = await inviteCandidates(dbx, athleteId);
    const exclude = [...cands.map((c) => c.deal_id), ...paper.folds.map((f) => f.pseudo_deal_id), ...paper.unresolved.map((u) => u.pseudo_deal_id)];
    for (const c of cands) {
      const match = await matchMeeting(athleteId, c.senders, { excludeDealIds: exclude, brandIds: c.brand_ids });
      if (!match) { inviteUnresolved.push({ pseudo_deal_id: c.deal_id, thread_id: c.thread_id, reason: "no open deal of the same counterparty to fold it into" }); continue; }
      const plan = await planInviteFold(dbx, athleteId, c.deal_id, match.dealId);
      if (plan.problems.length) inviteUnresolved.push({ pseudo_deal_id: c.deal_id, thread_id: c.thread_id, reason: plan.problems.join("; ") });
      else invites.push(plan);
    }
  }
  return {
    kind: AUTO_FOLD_KIND, version: 1, athlete_id: athleteId, generated_at: new Date().toISOString(),
    paperwork: { folds: paper.folds, unresolved: paper.unresolved }, invites, invite_unresolved: inviteUnresolved, notes,
  };
}

/** Throws unless `x` is a reviewed, not-yet-applied auto-fold plan. */
export function assertAutoFoldPlan(x: any, mode: "apply" | "undo"): AutoFoldPlan {
  if (!x || x.kind !== AUTO_FOLD_KIND || x.version !== 1 || typeof x.athlete_id !== "string") throw new Error("not an opps-auto-fold plan file");
  if (mode === "apply" && x.applied) throw new Error("this plan was already applied (it is a receipt); undo it or re-run the dry-run");
  if (mode === "undo" && !x.applied) throw new Error("not an applied receipt: only the file written by --apply can be undone");
  return x as AutoFoldPlan;
}

/**
 * Apply ONE reviewed plan in ONE transaction. Re-plans first and refuses when any reviewed item has gone stale; the
 * values written (and the prior values recorded) are the fresh ones.
 */
export async function applyAutoFold(dbx: any, reviewed: AutoFoldPlan): Promise<AutoFoldPlan> {
  assertAutoFoldPlan(reviewed, "apply");
  const fresh = await planAutoFold(dbx, reviewed.athlete_id);
  const stale: string[] = [];
  const folds = reviewed.paperwork.folds.map((r) => {
    const f = fresh.paperwork.folds.find((x) => x.pseudo_deal_id === r.pseudo_deal_id && x.thread_id === r.thread_id && x.target_deal_id === r.target_deal_id);
    if (!f) stale.push(`paperwork fold of deal ${r.pseudo_deal_id}`);
    return f!;
  });
  const invites = reviewed.invites.map((r) => {
    const f = fresh.invites.find((x) => x.pseudo_deal_id === r.pseudo_deal_id && x.thread_id === r.thread_id && x.target_deal_id === r.target_deal_id);
    if (!f) stale.push(`invite fold of deal ${r.pseudo_deal_id}`);
    return f!;
  });
  if (stale.length) throw new Error(`stale plan for athlete ${reviewed.athlete_id} — no longer detected the same way: ${stale.join(", ")}. Re-run the dry-run and review again.`);

  const at = new Date().toISOString();
  const appliedInvites: InviteFoldPlan[] = [];
  await dbx.transaction(async (tx: any) => {
    if (folds.length) {
      await applyFold(tx, { athlete_id: reviewed.athlete_id, generated_at: fresh.generated_at, folds, unresolved: [], split: null, split_problem: null });
    }
    for (const inv of invites) appliedInvites.push(await applyInviteFold(tx, inv));
  });
  return {
    ...fresh, paperwork: { folds, unresolved: fresh.paperwork.unresolved }, invites: appliedInvites,
    applied: { at, paperwork_folded: folds.length, invites_folded: appliedInvites.length },
  };
}

/** Put every prior value back from an applied receipt, in one transaction. */
export async function undoAutoFold(dbx: any, receipt: AutoFoldPlan): Promise<void> {
  assertAutoFoldPlan(receipt, "undo");
  const athleteId = receipt.athlete_id;
  await dbx.transaction(async (tx: any) => {
    for (const inv of receipt.invites) await undoInviteFold(tx, inv);
    for (const f of receipt.paperwork.folds) {
      await tx.update(deals).set({
        status: f.prior.deal_status, opportunity_id: f.opportunity_id, deal_group_id: f.prior.deal_group_id,
        raw_data: sql`coalesce(${deals.raw_data}, '{}'::jsonb) - 'retired'`,
      }).where(and(eq(deals.id, f.pseudo_deal_id), eq(deals.athlete_id, athleteId)));
      // A legacy paperwork thread had no paperwork marker before the fold (that is what made it legacy).
      await tx.update(inboxThreads).set({
        deal_id: f.prior.thread_deal_id,
        classification: sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) - 'paperwork'`,
      }).where(and(eq(inboxThreads.id, f.thread_id), eq(inboxThreads.athlete_id, athleteId)));
    }
  });
}

export function renderAutoFold(plan: AutoFoldPlan, mode: "dry-run" | "apply" | "undo"): string {
  const s = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");
  const lines = [`# Auto fold — ${mode} — athlete ${plan.athlete_id}`, `generated ${plan.generated_at}`, "",
    `## Paperwork (e-sign / payment pseudo-deals): ${plan.paperwork.folds.length} to fold`];
  for (const f of plan.paperwork.folds) lines.push(`- deal ${s(f.pseudo_deal_id)} (thread ${s(f.thread_id)}, was ${f.prior.deal_status}) → paperwork "${f.event}" on deal ${s(f.target_deal_id)} (opportunity ${s(f.opportunity_id)})`);
  for (const u of plan.paperwork.unresolved) lines.push(`- LEFT ALONE ${s(u.pseudo_deal_id)}: ${u.reason}`);
  lines.push("", `## Calendar invites that became deals: ${plan.invites.length} to fold`);
  for (const i of plan.invites) lines.push(`- deal ${s(i.pseudo_deal_id)} (thread ${s(i.thread_id)}) → meeting "${i.meeting?.label}" on deal ${s(i.target_deal_id)}${i.close_opportunity ? `; its opportunity ${s(i.prior.opportunity?.id)} closes (held only the invite)` : ""}`);
  for (const u of plan.invite_unresolved) lines.push(`- LEFT ALONE ${s(u.pseudo_deal_id)}: ${u.reason}`);
  for (const n of plan.notes) lines.push("", `NOTE: ${n}`);
  lines.push("", "Split: not auto-detected — a separate pitch inside a folded-in chain is split by hand with --split-chain.");
  if (plan.applied) lines.push("", `Applied at ${plan.applied.at}: ${plan.applied.paperwork_folded} paperwork fold(s), ${plan.applied.invites_folded} invite fold(s). Undo: --undo <this receipt .json>`);
  return lines.join("\n");
}
