/**
 * dealGrouping.ts — the shared same-deal decision behind cross-thread grouping.
 *
 * Two callers, ONE prompt, so both reach the same verdict:
 *   · server/scripts/groupDeals.ts — the deliberate bulk pass (dry-run, then --apply).
 *   · upsertDealForThread (dealDetector) — the on-mint pass, so a brand-NEW thread joins
 *     the group its siblings are already in instead of appearing as a duplicate card.
 *
 * Why a second entry point at all: message->thread and thread->deal linking are already
 * automatic and permanent, so a REPLY on an existing conversation folds into its deal and
 * keeps that deal's deal_group_id. The gap is only a genuinely new thread — it has no
 * thread to match, so it mints its own deal and lands ungrouped until someone re-runs the
 * bulk script. This closes that gap at the moment the row is created.
 *
 * Safety posture (matches the bulk script): grouping only ever ADDS a deal_group_id.
 * Nothing here merges, deletes, or rewrites a deal, and every failure path leaves the new
 * deal ungrouped — which is exactly today's behaviour. A wrong merge HIDES a real deal, so
 * silence-on-doubt is the correct bias.
 *
 * The opportunity layer (opportunities.ts) asks the same partition the opposite way round:
 * under one-per-brand, attaching hides nothing, so there doubt means ATTACH and the model is
 * only asked whether to split. With OPPS_ONE_PER_BRAND on, the opportunity id becomes the
 * deal_group_id and the on-mint pass below no longer runs.
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxBrands } from "../../shared/schema";
import { kimiInstant } from "../lib/kimi";
import { dealsPartitionFlashEnabled, partitionWithFlash } from "./dealEngineModels";
import { createLogger } from "../logger";

const logger = createLogger("dealGrouping");

/** Same window the bulk script uses — keep the two in step. */
export const WINDOW_DAYS = 45;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The minimum a row needs for the same-deal decision. */
export interface GroupRow {
  id: string;
  brand_name: string | null;
  detected_at: Date | string | null;
  raw_data?: any;
  deal_group_id?: string | null;
}

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "?");
const summaryOf = (r: GroupRow) => String(r.raw_data?.summary ?? "").replace(/\s+/g, " ").slice(0, 160);

const SYS =
  "You decide which email threads concern the SAME underlying brand deal. Threads about one " +
  "offer/agreement/opportunity — e.g. an initial proposal, a contract signature request, and its " +
  "executed notification — are the SAME deal. Threads about DIFFERENT offers, products, or " +
  "opportunities (even from the same sender or agency) are DIFFERENT deals. Return ONLY JSON.";

/**
 * Partition a same-brand cluster into subgroups, each exactly one deal.
 *
 * Returns `[cluster]` (unsplit) on ANY failure — bad JSON, a timeout, or a partition that
 * doesn't account for every row exactly once. Unsplit is the honest fallback for the bulk
 * script (the reviewer still sees the cluster in the dry-run). Callers that must tell a
 * failure apart from a real "these are all one deal" answer use partitionOrNull.
 */
export async function partitionSameDeal<T extends GroupRow>(
  cluster: T[],
  warn: (msg: string) => void = (m) => logger.warn(m),
): Promise<T[][]> {
  return (await partitionOrNull(cluster, warn)) ?? [cluster];
}

/**
 * The same partition, but null when the call FAILED (no evidence either way). A one-group
 * answer is a real answer — "these are all the same deal" — and comes back as `[cluster]`.
 */
export async function partitionOrNull<T extends GroupRow>(
  cluster: T[],
  warn: (msg: string) => void = (m) => logger.warn(m),
): Promise<T[][] | null> {
  if (cluster.length < 2) return [cluster];

  // D7 (DEALS_PARTITION_FLASH): the same decision on the routine tier, brand text fenced; Kimi (end of life) not called.
  if (dealsPartitionFlashEnabled()) {
    try {
      const idx = await partitionWithFlash(
        String(cluster[0].brand_name ?? ""),
        cluster.map((r, i) => ({ index: i, date: iso(r.detected_at), summary: summaryOf(r) })),
      );
      if (!idx) {
        warn(`${cluster[0].brand_name}: partition mismatch (flash) — left unsplit`);
        return null;
      }
      return idx.map((g) => g.map((i) => cluster[i]));
    } catch (e: any) {
      warn(`${cluster[0].brand_name}: partition failed (flash: ${e?.message}) — left unsplit`);
      return null;
    }
  }

  const list = cluster.map((r, i) => `[${i}] (${iso(r.detected_at)}) ${summaryOf(r)}`).join("\n");
  const prompt =
    `All threads below are with the same brand "${cluster[0].brand_name}". Partition their indices ` +
    `into groups where each group is exactly ONE deal.\n\n${list}\n\nReturn ONLY: {"groups":[[0,1],[2]]}`;

  try {
    const resp = await kimiInstant(SYS, prompt, true);
    const raw = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
    const groups: T[][] = (parsed.groups ?? []).map((idxs: unknown) =>
      (Array.isArray(idxs) ? idxs : []).map((i: number) => cluster[i]).filter(Boolean),
    );

    // Every row assigned exactly once, or trust nothing.
    const assigned = groups.reduce((n, g) => n + g.length, 0);
    const distinct = new Set(groups.flat()).size;
    if (!groups.length || assigned !== cluster.length || distinct !== cluster.length) {
      warn(`${cluster[0].brand_name}: partition mismatch (${assigned}/${cluster.length}) — left unsplit`);
      return null;
    }
    return groups.filter((g) => g.length > 0);
  } catch (e: any) {
    warn(`${cluster[0].brand_name}: partition failed (${e?.message}) — left unsplit`);
    return null;
  }
}

/**
 * On-mint grouping: give a just-created deal the deal_group_id of the sibling deal(s) it is
 * genuinely the same deal as, minting a new group id when the match is an ungrouped sibling.
 *
 * Never throws and never blocks minting — every early return leaves the deal ungrouped.
 * The LLM is only consulted when in-window siblings actually exist, so the common case
 * (a brand's first thread) costs one cheap indexed query and no tokens.
 *
 * @returns the deal_group_id written, or null when the deal was left ungrouped.
 */
export async function adoptGroupForNewDeal(params: {
  dealId: string;
  athleteId: string;
  brandId: number | null;
  dealType: string;
  detectedAt?: Date | null;
}): Promise<string | null> {
  const { dealId, athleteId, brandId, dealType } = params;
  const detectedAt = params.detectedAt ?? new Date();

  // brand_id is the grouping key; without it we cannot say two deals share a brand.
  if (!brandId) return null;

  try {
    // An agency legitimately routes MANY distinct deals, so a shared brand_id proves nothing
    // there. Same exclusion the bulk script applies.
    const [brand] = await db
      .select({ is_agency: inboxBrands.is_agency })
      .from(inboxBrands)
      .where(eq(inboxBrands.id, brandId))
      .limit(1);
    if (brand?.is_agency === true) return null;

    // In-window siblings: same athlete + brand + deal_type, not rejected, not this row.
    // Match brand on the FK, falling back to normalized brand_name — deals.brand_id is
    // backfilled by name match at deploy time (migrations/0020), so older rows can still
    // be NULL even though they belong to this brand.
    const cutoff = new Date(ms(detectedAt) - WINDOW_MS);
    const siblings = (await db
      .select({
        id: deals.id,
        brand_name: deals.brand_name,
        detected_at: deals.detected_at,
        raw_data: deals.raw_data,
        deal_group_id: deals.deal_group_id,
      })
      .from(deals)
      .leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
      .where(
        and(
          eq(deals.athlete_id, athleteId),
          eq(deals.deal_type, dealType),
          ne(deals.id, dealId),
          sql`${deals.status} <> 'rejected'`,
          sql`${deals.detected_at} >= ${cutoff.toISOString()}`,
          or(
            eq(deals.brand_id, brandId),
            sql`lower(trim(${deals.brand_name})) = (select lower(${inboxBrands.normalized_name}) from ${inboxBrands} where ${inboxBrands.id} = ${brandId})`,
          ),
        ),
      )) as GroupRow[];

    if (!siblings.length) return null;

    const [self] = (await db
      .select({
        id: deals.id,
        brand_name: deals.brand_name,
        detected_at: deals.detected_at,
        raw_data: deals.raw_data,
      })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1)) as GroupRow[];
    if (!self) return null;

    // Prefer joining an EXISTING group (newest first) over pairing with a loose sibling:
    // an established group carries more evidence about what the deal is.
    const byGroup = new Map<string, GroupRow[]>();
    const loose: GroupRow[] = [];
    for (const s of siblings) {
      if (s.deal_group_id) {
        const arr = byGroup.get(s.deal_group_id);
        if (arr) arr.push(s);
        else byGroup.set(s.deal_group_id, [s]);
      } else loose.push(s);
    }
    const ordered = [...byGroup.entries()].sort(
      (a, b) => Math.max(...b[1].map((r) => ms(r.detected_at))) - Math.max(...a[1].map((r) => ms(r.detected_at))),
    );

    for (const [gid, members] of ordered) {
      if (await sameDealAs(self, members)) {
        await db.update(deals).set({ deal_group_id: gid }).where(eq(deals.id, dealId));
        logger.info({ dealId, gid, members: members.length }, "New deal adopted an existing deal group");
        return gid;
      }
    }

    // No existing group fits. If a LOOSE sibling is the same deal, start a group with it.
    if (loose.length) {
      const match = await firstSameDeal(self, loose);
      if (match) {
        const gid = randomUUID();
        await db.update(deals).set({ deal_group_id: gid }).where(sql`${deals.id} in (${dealId}, ${match.id})`);
        logger.info({ dealId, gid, pairedWith: match.id }, "New deal formed a group with an ungrouped sibling");
        return gid;
      }
    }

    return null;
  } catch (e: any) {
    // Grouping is an enhancement, never a gate on minting a deal.
    logger.warn({ dealId, err: e?.message }, "On-mint grouping skipped");
    return null;
  }
}

/**
 * Is `self` the same deal as ANY of `members`? A failed call counts as NO (silence on doubt).
 * A one-group answer ("all the same deal") counts as YES — it used to be read as "no evidence"
 * (`parts.length < 2 → false`), which is why a pair could never group on mint.
 */
export async function sameDealAs(self: GroupRow, members: GroupRow[]): Promise<boolean> {
  const parts = await partitionOrNull([self, ...members]);
  if (!parts) return false;

  const mine = parts.find((p) => p.some((r) => r.id === self.id));
  if (!mine) return false;
  return mine.some((r) => r.id !== self.id && members.some((m) => m.id === r.id));
}

/** First loose sibling the partition puts in the same group as `self`, if any. Failed call ⇒ null. */
export async function firstSameDeal(self: GroupRow, loose: GroupRow[]): Promise<GroupRow | null> {
  const parts = await partitionOrNull([self, ...loose]);
  if (!parts) return null;

  const mine = parts.find((p) => p.some((r) => r.id === self.id));
  if (!mine) return null;
  const hit = mine.find((r) => r.id !== self.id && loose.some((l) => l.id === r.id));
  return hit ?? null;
}
