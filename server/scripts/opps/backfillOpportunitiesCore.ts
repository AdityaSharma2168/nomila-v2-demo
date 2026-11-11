/**
 * backfillOpportunitiesCore — Opportunities PR 2: put one athlete's existing deals under
 * opportunities, and file the ones that went quiet before FILE_BEFORE. The CLI wrapper is
 * ./backfillOpportunities.ts; this core takes a drizzle instance so the dry-run can pass a
 * read-only one and the test can run it against PGlite.
 *
 * No model is called. Where grouping would need judgement, the stored groups are reused:
 *   1. Units. Deals sharing a deal_group_id always move together. A unit with a member already
 *      under an opportunity (minted after the deploy) joins that opportunity.
 *   2. Key. A unit is keyed on its earliest deal's brand_id — the advertiser, or the agency's
 *      own row when the agency never named one (ONE opportunity per agency). No brand at all:
 *      the unit is its own opportunity.
 *   3. Per key, the LIVE units (a deal not rejected/completed whose thread is not archived) form
 *      one open opportunity — the existing open one when a mint already made it — and the rest
 *      form one closed history opportunity (won / declined / expired / not_relevant from what
 *      happened to it).
 *   4. Times come from inbox_messages.received_at (the mail's sent time), not ingest time.
 *      lead_thread_id = the earliest deal's thread.
 *   5. Filing. Every open opportunity whose last activity is before FILE_BEFORE — negotiating
 *      ones included (owner-approved) — is closed · expired, its threads archived, with ONE
 *      reversible auto_archive receipt (payload.opportunity_id, by "opps_backfill"). Undo reopens it.
 *   6. Mirror (mirrorGroups, i.e. OPPS_ONE_PER_BRAND): every member's deal_group_id becomes the
 *      opportunity id. The old group ids are in the report, which is the rollback record.
 *
 * Re-runnable: placed deals are never re-placed, so a second run only files, mirrors, and places
 * what is new. applyBackfill plans and writes inside ONE transaction per athlete, holding the
 * per-brand advisory locks the live mint path takes.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { agentActions, deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../../shared/schema";
import { closeOpportunityAsExpired } from "../../skills/archiveStaleDeals";
import { lockBrand } from "../../skills/opportunities";

/** Owner decision: anything quiet since before 1 Aug 2026 is filed. */
export const FILE_BEFORE = new Date("2026-08-01T00:00:00.000Z");

const ENDED_DEAL_STATUSES = new Set(["rejected", "completed"]);
const WON_DEAL_STATUSES = new Set(["accepted", "completed"]);

export interface PlannedDeal {
  id:                string;
  brand_name:        string;
  status:            string | null;
  thread_id:         string | null;
  thread_status:     string | null;
  old_deal_group_id: string | null;
  /** Already under an opportunity before this run (left where it is). */
  placed:            boolean;
}

export interface PlannedOpportunity {
  /** The existing row, or null when this run creates it. */
  existing_id:      string | null;
  brand_id:         number | null;
  brand_name:       string | null;
  agency:           boolean;
  status:           "open" | "closed";
  close_reason:     "won" | "declined" | "expired" | "not_relevant" | null;
  opened_at:        string;
  last_activity_at: string;
  lead_thread_id:   string | null;
  deals:            PlannedDeal[];
  /** Open and quiet since before FILE_BEFORE: closed · expired with a receipt. */
  file:             boolean;
  /** Members whose deal_group_id this run rewrites to the opportunity id. */
  mirror:           number;
}

export interface BackfillPlan {
  athlete_id:    string;
  generated_at:  string;
  file_before:   string;
  mirror_groups: boolean;
  opportunities: PlannedOpportunity[];
  counts: {
    deals: number; deals_to_place: number;
    create_open: number; create_closed: number; attach_to_existing: number;
    open_after: number; file: number; threads_to_archive: number; mirror: number;
  };
}

const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);
const minOf = (xs: number[]) => xs.filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Infinity);
const maxOf = (xs: number[]) => xs.filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity);

/** Read-only: what the backfill would do for one athlete. */
export async function planBackfill(
  dbx: any,
  athleteId: string,
  opts: { now?: Date; mirrorGroups?: boolean; fileBefore?: Date } = {},
): Promise<BackfillPlan> {
  const now = opts.now ?? new Date();
  const fileBefore = opts.fileBefore ?? FILE_BEFORE;
  const mirrorGroups = opts.mirrorGroups ?? false;

  const dealRows: {
    id: string; brand_id: number | null; brand_name: string; status: string | null; deal_group_id: string | null;
    opportunity_id: string | null; detected_at: Date | null; created_at: Date | null; is_agency: boolean | null; brand_label: string | null;
  }[] = await dbx
    .select({
      id: deals.id, brand_id: deals.brand_id, brand_name: deals.brand_name, status: deals.status,
      deal_group_id: deals.deal_group_id, opportunity_id: deals.opportunity_id,
      detected_at: deals.detected_at, created_at: deals.created_at,
      is_agency: inboxBrands.is_agency, brand_label: inboxBrands.name,
    })
    .from(deals)
    .leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(eq(deals.athlete_id, athleteId));

  const threadRows: {
    id: string; deal_id: string; status: string | null; last_message_at: Date | null; created_at: Date | null;
    first_sent: string | null; last_sent: string | null;
  }[] = await dbx
    .select({
      id: inboxThreads.id, deal_id: inboxThreads.deal_id, status: inboxThreads.status,
      last_message_at: inboxThreads.last_message_at, created_at: inboxThreads.created_at,
      first_sent: sql<string | null>`min(${inboxMessages.received_at})`,
      last_sent:  sql<string | null>`max(${inboxMessages.received_at})`,
    })
    .from(inboxThreads)
    .leftJoin(inboxMessages, eq(inboxMessages.thread_id, inboxThreads.id))
    .where(and(eq(inboxThreads.athlete_id, athleteId), isNotNull(inboxThreads.deal_id)))
    .groupBy(inboxThreads.id);

  const archiveReceipts: { thread_id: string | null }[] = await dbx
    .select({ thread_id: agentActions.thread_id })
    .from(agentActions)
    .where(and(eq(agentActions.athlete_id, athleteId), eq(agentActions.action, "auto_archive"), isNull(agentActions.undone_at)));
  const autoArchived = new Set(archiveReceipts.map((r) => r.thread_id).filter(Boolean));

  const existing: {
    id: string; brand_id: number | null; status: string; close_reason: string | null; opened_at: Date; last_activity_at: Date; lead_thread_id: string | null;
  }[] = await dbx
    .select({
      id: opportunities.id, brand_id: opportunities.brand_id, status: opportunities.status, close_reason: opportunities.close_reason,
      opened_at: opportunities.opened_at, last_activity_at: opportunities.last_activity_at, lead_thread_id: opportunities.lead_thread_id,
    })
    .from(opportunities)
    .where(eq(opportunities.athlete_id, athleteId));

  const threadsByDeal = new Map<string, typeof threadRows>();
  for (const th of threadRows) threadsByDeal.set(th.deal_id, [...(threadsByDeal.get(th.deal_id) ?? []), th]);

  const firstOf = (d: (typeof dealRows)[number]) =>
    minOf([...(threadsByDeal.get(d.id) ?? []).flatMap((th) => [t(th.first_sent), t(th.created_at)]), t(d.detected_at), t(d.created_at)]);
  const lastOf = (d: (typeof dealRows)[number]) => {
    const ths = threadsByDeal.get(d.id) ?? [];
    // The sent time when there is one; ingest time only for a thread with no message rows.
    const sent = maxOf(ths.map((th) => t(th.last_sent)));
    if (Number.isFinite(sent)) return sent;
    return maxOf([...ths.map((th) => t(th.last_message_at)), t(d.detected_at), t(d.created_at)]);
  };
  const isLive = (d: (typeof dealRows)[number]) => {
    if (ENDED_DEAL_STATUSES.has(d.status ?? "")) return false;
    const ths = threadsByDeal.get(d.id) ?? [];
    return ths.length === 0 || ths.some((th) => th.status !== "archived");
  };
  const toPlanned = (d: (typeof dealRows)[number]): PlannedDeal => {
    const th = (threadsByDeal.get(d.id) ?? [])[0];
    return {
      id: d.id, brand_name: d.brand_name, status: d.status, thread_id: th?.id ?? null, thread_status: th?.status ?? null,
      old_deal_group_id: d.deal_group_id, placed: !!d.opportunity_id,
    };
  };

  // 1. Units: a stored group moves whole.
  const units = new Map<string, (typeof dealRows)>();
  for (const d of dealRows) {
    const k = d.deal_group_id ? `g:${d.deal_group_id}` : `d:${d.id}`;
    units.set(k, [...(units.get(k) ?? []), d]);
  }

  const planned: PlannedOpportunity[] = [];
  const byExistingId = new Map<string, PlannedOpportunity>();
  const existingPlan = (id: string): PlannedOpportunity => {
    let p = byExistingId.get(id);
    if (!p) {
      const e = existing.find((x) => x.id === id)!;
      const brandDeal = dealRows.find((d) => d.brand_id === e.brand_id);
      p = {
        existing_id: e.id, brand_id: e.brand_id, brand_name: brandDeal?.brand_label ?? brandDeal?.brand_name ?? null,
        agency: brandDeal?.is_agency === true, status: e.status as "open" | "closed", close_reason: e.close_reason as PlannedOpportunity["close_reason"],
        opened_at: new Date(e.opened_at).toISOString(), last_activity_at: new Date(e.last_activity_at).toISOString(),
        lead_thread_id: e.lead_thread_id, deals: [], file: false, mirror: 0,
      };
      byExistingId.set(id, p);
      planned.push(p);
    }
    return p;
  };
  for (const e of existing) existingPlan(e.id);
  for (const d of dealRows) if (d.opportunity_id && byExistingId.has(d.opportunity_id)) byExistingId.get(d.opportunity_id)!.deals.push(toPlanned(d));

  // 2–3. Key the unplaced units; live ones join the brand's open opportunity, the rest its history.
  const fresh = new Map<string, (typeof dealRows)>();   // "open:<brand>" / "closed:<brand>" / "solo:<unit>"
  for (const [unitKey, members] of units) {
    const unplaced = members.filter((d) => !d.opportunity_id);
    if (!unplaced.length) continue;
    const placedMember = members.find((d) => d.opportunity_id && byExistingId.has(d.opportunity_id));
    if (placedMember) {
      byExistingId.get(placedMember.opportunity_id!)!.deals.push(...unplaced.map(toPlanned));
      continue;
    }
    const lead = [...members].sort((a, b) => firstOf(a) - firstOf(b))[0];
    const live = members.some(isLive);
    if (lead.brand_id == null) { fresh.set(`solo:${unitKey}`, unplaced); continue; }
    if (live) {
      const open = existing
        .filter((e) => e.brand_id === lead.brand_id && e.status === "open")
        .sort((a, b) => t(b.last_activity_at) - t(a.last_activity_at))[0];
      if (open) { existingPlan(open.id).deals.push(...unplaced.map(toPlanned)); continue; }
    }
    const k = `${live ? "open" : "closed"}:${lead.brand_id}`;
    fresh.set(k, [...(fresh.get(k) ?? []), ...unplaced]);
  }

  for (const [k, members] of fresh) {
    const sorted = [...members].sort((a, b) => firstOf(a) - firstOf(b));
    const lead = sorted[0];
    const open = k.startsWith("open:") || (k.startsWith("solo:") && members.some(isLive));
    const statuses = members.map((d) => d.status ?? "");
    const closeReason: PlannedOpportunity["close_reason"] = open ? null
      : statuses.some((s) => WON_DEAL_STATUSES.has(s)) ? "won"
      : statuses.every((s) => s === "rejected") ? "declined"
      : members.some((d) => (threadsByDeal.get(d.id) ?? []).some((th) => autoArchived.has(th.id))) ? "expired"
      : "not_relevant";
    planned.push({
      existing_id: null, brand_id: lead.brand_id, brand_name: lead.brand_label ?? lead.brand_name, agency: lead.is_agency === true,
      status: open ? "open" : "closed", close_reason: closeReason,
      opened_at: new Date(minOf(members.map(firstOf))).toISOString(),
      last_activity_at: new Date(maxOf(members.map(lastOf))).toISOString(),
      lead_thread_id: sorted.map((d) => (threadsByDeal.get(d.id) ?? [])[0]?.id).find(Boolean) ?? null,
      deals: sorted.map(toPlanned), file: false, mirror: 0,
    });
  }

  // 4–6. Activity of existing rows that gain members, the filing rule, the mirror.
  for (const p of planned) {
    if (p.existing_id) {
      const gained = dealRows.filter((d) => p.deals.some((x) => x.id === d.id && !x.placed));
      if (gained.length) p.last_activity_at = new Date(Math.max(t(p.last_activity_at), maxOf(gained.map(lastOf)))).toISOString();
    }
    p.file = p.status === "open" && t(p.last_activity_at) < fileBefore.getTime();
    p.mirror = mirrorGroups ? p.deals.filter((d) => !p.existing_id || d.old_deal_group_id !== p.existing_id).length : 0;
  }

  // Existing rows nothing changes for are left out of the plan.
  const plan = planned.filter((p) => !p.existing_id || p.deals.some((d) => !d.placed) || p.file || p.mirror > 0);
  const toPlace = plan.reduce((n, p) => n + p.deals.filter((d) => !d.placed).length, 0);
  return {
    athlete_id: athleteId,
    generated_at: now.toISOString(),
    file_before: fileBefore.toISOString(),
    mirror_groups: mirrorGroups,
    opportunities: plan,
    counts: {
      deals:              dealRows.length,
      deals_to_place:     toPlace,
      create_open:        plan.filter((p) => !p.existing_id && p.status === "open").length,
      create_closed:      plan.filter((p) => !p.existing_id && p.status === "closed").length,
      attach_to_existing: plan.filter((p) => p.existing_id && p.deals.some((d) => !d.placed)).length,
      open_after:         planned.filter((p) => p.status === "open" && !p.file).length,
      file:               plan.filter((p) => p.file).length,
      threads_to_archive: plan.filter((p) => p.file).reduce((n, p) => n + p.deals.filter((d) => d.thread_id && d.thread_status !== "archived").length, 0),
      mirror:             plan.reduce((n, p) => n + p.mirror, 0),
    },
  };
}

/**
 * Plan and write for one athlete inside ONE transaction, under the per-brand advisory locks the
 * mint path takes (so a mail arriving mid-run cannot open a duplicate). Returns the plan applied.
 */
export async function applyBackfill(
  dbx: any,
  athleteId: string,
  opts: { now?: Date; mirrorGroups?: boolean; fileBefore?: Date } = {},
): Promise<BackfillPlan> {
  const now = opts.now ?? new Date();
  return dbx.transaction(async (tx: any) => {
    const brandIds: { brand_id: number | null }[] = await tx
      .selectDistinct({ brand_id: deals.brand_id })
      .from(deals)
      .where(and(eq(deals.athlete_id, athleteId), isNotNull(deals.brand_id)));
    for (const b of brandIds.map((r) => r.brand_id!).sort((a, z) => a - z)) await lockBrand(tx, athleteId, b);

    const plan = await planBackfill(tx, athleteId, { ...opts, now });
    for (const p of plan.opportunities) {
      let id = p.existing_id;
      if (!id) {
        const [row] = await tx.insert(opportunities).values({
          athlete_id: athleteId, brand_id: p.brand_id, status: p.status,
          close_reason: p.close_reason, closed_at: p.status === "closed" ? new Date(p.last_activity_at) : null,
          opened_at: new Date(p.opened_at), last_activity_at: new Date(p.last_activity_at), lead_thread_id: p.lead_thread_id,
        }).returning({ id: opportunities.id });
        id = row.id as string;
        p.existing_id = id;
      } else {
        await tx.update(opportunities)
          .set({ last_activity_at: sql`greatest(${opportunities.last_activity_at}, ${p.last_activity_at}::timestamptz)` })
          .where(eq(opportunities.id, id));
      }
      const toPlace = p.deals.filter((d) => !d.placed).map((d) => d.id);
      if (toPlace.length) {
        await tx.update(deals).set({ opportunity_id: id }).where(and(inArray(deals.id, toPlace), isNull(deals.opportunity_id)));
      }
      if (plan.mirror_groups) {
        await tx.update(deals).set({ deal_group_id: id })
          .where(and(eq(deals.opportunity_id, id), sql`${deals.deal_group_id} is distinct from ${id}::uuid`));
      }
      if (p.file) {
        await closeOpportunityAsExpired({
          opportunityId: id,
          athleteId,
          leadThreadId:  p.lead_thread_id,
          members:       p.deals.map((d) => ({ dealId: d.id, brandName: d.brand_name, threadId: d.thread_id, threadStatus: d.thread_status })),
          now,
          reason:        `No activity since before ${plan.file_before.slice(0, 10)} — filed when opportunities were introduced`,
          by:            "opps_backfill",
          conn:          tx,
        });
      }
    }
    return plan;
  });
}

/** The human-readable dry-run / apply report. */
export function renderMarkdown(plan: BackfillPlan, mode: "dry-run" | "apply"): string {
  const c = plan.counts;
  const line = (p: PlannedOpportunity) => {
    const who = `${p.brand_name ?? "(no brand)"}${p.agency ? " (agency, advertiser not named)" : ""}`;
    const state = p.file ? "open → FILED (closed · expired)" : p.status === "open" ? "open" : `closed · ${p.close_reason}`;
    const deals = p.deals.map((d) => `${d.brand_name} [${d.status}${d.placed ? ", already placed" : ""}]`).join("; ");
    return `- **${who}** — ${p.existing_id ? "existing" : "new"} · ${state} · last activity ${p.last_activity_at.slice(0, 10)} · ${p.deals.length} deal(s): ${deals}`;
  };
  const filed = plan.opportunities.filter((p) => p.file);
  const open = plan.opportunities.filter((p) => p.status === "open" && !p.file);
  const closed = plan.opportunities.filter((p) => p.status === "closed");
  return [
    `# Opportunities backfill — ${mode === "dry-run" ? "DRY RUN (read-only session; nothing written)" : "APPLIED"}`,
    "",
    `Athlete \`${plan.athlete_id}\` · generated ${plan.generated_at} · filing open opportunities quiet since before ${plan.file_before.slice(0, 10)} · deal_group_id mirror ${plan.mirror_groups ? "ON" : "off"}.`,
    "",
    `Deals: ${c.deals} (${c.deals_to_place} to place). Create ${c.create_open} open + ${c.create_closed} closed history; attach to ${c.attach_to_existing} existing.`,
    `Filed: ${c.file} opportunities, ${c.threads_to_archive} threads archived, one reversible auto_archive receipt each. Open afterwards: ${c.open_after}. deal_group_id rewritten: ${c.mirror}.`,
    "",
    `## Filed — quiet since before ${plan.file_before.slice(0, 10)} (${filed.length})`,
    ...filed.map(line),
    "",
    `## Stay open (${open.length})`,
    ...open.map(line),
    "",
    `## Closed history (${closed.length})`,
    ...closed.map(line),
    "",
    "The JSON beside this file holds every deal's old deal_group_id: it is the rollback record.",
    "",
  ].join("\n");
}
