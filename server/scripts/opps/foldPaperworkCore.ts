/**
 * foldPaperworkCore.ts — the plan and the write behind foldPaperworkAndSplit.ts (docs/design/brand-page-deals.md,
 * "gorjana data fix"). Tests exercise this; a person runs the CLI.
 *
 *   1. Every pre-#777 e-sign / payment pseudo-deal (a deal whose every thread came from a WORKFLOW_DOMAINS sender
 *      and carries no paperwork marker) becomes what #777 would have made it: its thread gets a matched
 *      `classification.paperwork` marker on the opportunity's REAL deal (most advanced stored status, then most
 *      messages), thread.deal_id is cleared, and the pseudo-deal is retired — status rejected, off the
 *      opportunity, `raw_data.retired = { as: "paperwork", … }`. The plan records every prior value (rollback).
 *   2. --split-chain <provider thread id>: the folded-in chain becomes its own deal through skills/dealSplit
 *      (receipted, reversible from The Week). The split re-summarises both threads (a model call); applyFold waits
 *      for it, so the CLI never closes the pool under it.
 *
 * Signed is NOT set here: that stays her tap ("Looks signed — confirm?").
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { deals, inboxMessages, inboxThreads } from "../../../shared/schema";
import { legacyPaperworkEvent, loadOpportunityMaterial } from "../../skills/dealSigning";

export interface FoldItem {
  pseudo_deal_id: string;
  thread_id: string;
  opportunity_id: string;
  target_deal_id: string;
  event: string;
  prior: { deal_status: string | null; deal_group_id: string | null; thread_deal_id: string; thread_status: string | null };
}
export interface SplitItem { deal_id: string; thread_id: string; chain: string; messages: number; first_direction: string | null; first_at: string | null; last_at: string | null }
export interface FoldPlan {
  athlete_id: string;
  generated_at: string;
  folds: FoldItem[];
  unresolved: Array<{ pseudo_deal_id: string; reason: string }>;
  split: SplitItem | null;
  split_problem: string | null;
  applied?: { folded: number; split: unknown };
}

export async function planFold(dbx: any, athleteId: string, opts: { brandId?: number | null; splitChain?: string | null } = {}): Promise<FoldPlan> {
  const oppRows = await dbx.select({ opportunity_id: deals.opportunity_id }).from(deals)
    .where(and(eq(deals.athlete_id, athleteId), isNotNull(deals.opportunity_id), ...(opts.brandId != null ? [eq(deals.brand_id, opts.brandId)] : [])));
  const oppIds = [...new Set<string>(oppRows.map((r: any) => r.opportunity_id))];
  const material = await loadOpportunityMaterial(athleteId, oppIds, dbx);
  const realIds = new Set(material.real.map((d) => d.id));
  const folds: FoldItem[] = [];
  const unresolved: FoldPlan["unresolved"] = [];
  for (const t of material.threads.filter((x) => x.role === "legacy_paperwork")) {
    const pseudo = material.members.find((m) => m.id === t.deal_id)!;
    if (!t.belongs_to || !realIds.has(t.belongs_to)) { unresolved.push({ pseudo_deal_id: pseudo.id, reason: "no real deal in its opportunity" }); continue; }
    const [row] = await dbx.select({ status: inboxThreads.status }).from(inboxThreads).where(eq(inboxThreads.id, t.id)).limit(1);
    const [d] = await dbx.select({ status: deals.status, deal_group_id: deals.deal_group_id }).from(deals).where(eq(deals.id, pseudo.id)).limit(1);
    folds.push({
      pseudo_deal_id: pseudo.id, thread_id: t.id, opportunity_id: pseudo.opportunity_id, target_deal_id: t.belongs_to,
      event: legacyPaperworkEvent(t),
      prior: { deal_status: d?.status ?? null, deal_group_id: d?.deal_group_id ?? null, thread_deal_id: pseudo.id, thread_status: row?.status ?? null },
    });
  }

  let split: SplitItem | null = null;
  let splitProblem: string | null = null;
  if (opts.splitChain) {
    const [t] = await dbx.select({ id: inboxThreads.id, deal_id: inboxThreads.deal_id }).from(inboxThreads)
      .where(and(eq(inboxThreads.athlete_id, athleteId), sql`${opts.splitChain} = ANY(${inboxThreads.alias_thread_ids})`)).limit(1);
    if (!t?.deal_id) splitProblem = "no thread of hers holds that chain as a folded-in alias";
    else {
      const [agg] = await dbx.select({
        n: sql<number>`count(*)::int`,
        first_at: sql<string | null>`min(${inboxMessages.received_at})`,
        last_at: sql<string | null>`max(${inboxMessages.received_at})`,
        first_dir: sql<string | null>`(array_agg(${inboxMessages.direction} order by ${inboxMessages.received_at}))[1]`,
      }).from(inboxMessages).where(and(eq(inboxMessages.athlete_id, athleteId), eq(inboxMessages.thread_id, t.id), eq(inboxMessages.gmail_thread_id, opts.splitChain)));
      split = { deal_id: t.deal_id, thread_id: t.id, chain: opts.splitChain, messages: Number(agg?.n ?? 0),
        first_direction: agg?.first_dir ?? null, first_at: agg?.first_at ? new Date(agg.first_at).toISOString() : null, last_at: agg?.last_at ? new Date(agg.last_at).toISOString() : null };
      if (!split.messages) splitProblem = "the chain has no messages on that thread";
    }
  }
  return { athlete_id: athleteId, generated_at: new Date().toISOString(), folds, unresolved, split, split_problem: splitProblem };
}

/** Write the plan: folds in one transaction, then the split through the governed split service. */
export async function applyFold(dbx: any, plan: FoldPlan): Promise<FoldPlan> {
  const now = new Date().toISOString();
  await dbx.transaction(async (tx: any) => {
    for (const f of plan.folds) {
      const marker = {
        state: "matched", kind: f.event === "completed" || f.event === "status" ? "status" : f.event === "payment_sent" ? "payment" : "signature_request",
        event: f.event, deal_id: f.target_deal_id, opportunity_id: f.opportunity_id, matched_by: "legacy_fold",
        source_message_ids: [], observed_at: now,
      };
      await tx.update(inboxThreads).set({
        deal_id: null,
        classification: sql`coalesce(${inboxThreads.classification}, '{}'::jsonb) || ${JSON.stringify({ paperwork: marker })}::jsonb`,
      }).where(and(eq(inboxThreads.id, f.thread_id), eq(inboxThreads.athlete_id, plan.athlete_id)));
      await tx.update(deals).set({
        status: "rejected", opportunity_id: null, deal_group_id: null,
        raw_data: sql`coalesce(${deals.raw_data}, '{}'::jsonb) || ${JSON.stringify({ retired: { as: "paperwork", at: now, target_deal_id: f.target_deal_id, thread_id: f.thread_id, prior: f.prior } })}::jsonb`,
      }).where(and(eq(deals.id, f.pseudo_deal_id), eq(deals.athlete_id, plan.athlete_id)));
    }
  });
  let split: unknown = null;
  if (plan.split && !plan.split_problem) {
    const { splitDeal } = await import("../../skills/dealSplit");
    // Wait for the split's re-summarise (a model call): the CLI closes the pool right after this returns.
    split = await splitDeal(plan.athlete_id, plan.split.deal_id, plan.split.chain, new Date(), { awaitSummaries: true });
  }
  return { ...plan, applied: { folded: plan.folds.length, split } };
}

export function renderFold(plan: FoldPlan, mode: "dry-run" | "apply"): string {
  const lines = [`# Paperwork fold + split — ${mode} — athlete ${plan.athlete_id}`, `generated ${plan.generated_at}`, "",
    `## Fold ${plan.folds.length} e-sign pseudo-deal(s) into paperwork`];
  for (const f of plan.folds) lines.push(`- deal ${f.pseudo_deal_id.slice(0, 8)} (thread ${f.thread_id.slice(0, 8)}, was ${f.prior.deal_status}) → paperwork "${f.event}" on deal ${f.target_deal_id.slice(0, 8)} (opportunity ${f.opportunity_id.slice(0, 8)})`);
  for (const u of plan.unresolved) lines.push(`- UNRESOLVED ${u.pseudo_deal_id.slice(0, 8)}: ${u.reason}`);
  lines.push("", "## Split");
  if (plan.split_problem) lines.push(`- not possible: ${plan.split_problem}`);
  else if (plan.split) lines.push(`- chain ${plan.split.chain}: ${plan.split.messages} message(s) ${plan.split.first_at?.slice(0, 10)} → ${plan.split.last_at?.slice(0, 10)}, first ${plan.split.first_direction} → off deal ${plan.split.deal_id.slice(0, 8)} into a new deal + opportunity (direction ${plan.split.first_direction === "outbound" ? "outbound: Pitched by you" : "inbound"})`);
  else lines.push("- none requested");
  if (plan.applied) lines.push("", `## Applied`, "```", JSON.stringify(plan.applied, null, 2), "```");
  return lines.join("\n");
}

