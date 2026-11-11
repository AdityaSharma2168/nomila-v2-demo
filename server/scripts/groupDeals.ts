/**
 * groupDeals.ts — cross-thread deal grouping (deals.deal_group_id).
 *
 * Multiple email threads are often the SAME underlying deal (e.g. gorjana's signature-request,
 * executed-agreement, and gifting threads). This proposes groups by a CONSERVATIVE heuristic and
 * — only with --apply — writes a shared deal_group_id so loadRankedDeals collapses them to one
 * brand card. There is deliberately NO auto-merge in the live minting path; grouping is applied
 * here, after reviewing the dry-run.
 *
 * Heuristic (all must hold): same athlete_id + same brand_id (non-null) + same deal_type +
 * status not 'rejected', and detected within WINDOW_DAYS of the next deal in the cluster.
 *
 * DRY-RUN by default (reads nothing but deals; writes nothing).
 *   npx tsx --require dotenv/config server/scripts/groupDeals.ts
 *   npx tsx --require dotenv/config server/scripts/groupDeals.ts --athlete <uuid>
 *   npx tsx --require dotenv/config server/scripts/groupDeals.ts --athlete <uuid> --apply
 *
 * NOTE: --apply requires the deals.deal_group_id column (migration 0025) to exist — i.e. after
 * the deploy has provisioned it. The dry-run does not reference the column, so it runs anytime.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { deals, inboxBrands } from "../../shared/schema";
// The same-deal decision + window live in skills/dealGrouping so this bulk pass and the
// on-mint pass in upsertDealForThread cannot drift apart and reach different verdicts.
import { partitionSameDeal, WINDOW_DAYS, WINDOW_MS } from "../skills/dealGrouping";

const APPLY = process.argv.includes("--apply");
const aIdx = process.argv.indexOf("--athlete");
const ATHLETE = aIdx >= 0 ? process.argv[aIdx + 1] : null;

type Row = {
  id: string;
  athlete_id: string;
  brand_id: number | null;
  brand_name: string;
  deal_type: string;
  status: string;
  detected_at: Date | null;
  raw_data: any;
};

async function main() {
  console.log(APPLY ? "APPLY mode — deal_group_id will be written.\n" : "DRY-RUN — nothing written. Pass --apply (post-deploy) to write.\n");

  // Exclude agency/MCN/platform brands (is_agency): a single agency legitimately routes MANY
  // distinct deals, so grouping by an agency brand_id would wrongly merge unrelated deals.
  const filters = [
    isNotNull(deals.brand_id),
    sql`${deals.status} <> 'rejected'`,
    sql`${inboxBrands.is_agency} IS NOT TRUE`,
  ];
  if (ATHLETE) filters.push(eq(deals.athlete_id, ATHLETE));

  const rows = (await db
    .select({
      id: deals.id,
      athlete_id: deals.athlete_id,
      brand_id: deals.brand_id,
      brand_name: deals.brand_name,
      deal_type: deals.deal_type,
      status: deals.status,
      detected_at: deals.detected_at,
      raw_data: deals.raw_data,
    })
    .from(deals)
    .leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(...filters))) as Row[];

  // Bucket by athlete + brand + deal_type, then split each bucket into time-proximity clusters.
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.athlete_id}|${r.brand_id}|${r.deal_type}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r);
  }

  // Time-proximity clusters within each brand+type bucket.
  const clusters: Row[][] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => ms(a.detected_at) - ms(b.detected_at));
    let cluster: Row[] = [bucket[0]];
    for (let i = 1; i < bucket.length; i++) {
      if (ms(bucket[i].detected_at) - ms(bucket[i - 1].detected_at) <= WINDOW_MS) {
        cluster.push(bucket[i]);
      } else {
        if (cluster.length >= 2) clusters.push(cluster);
        cluster = [bucket[i]];
      }
    }
    if (cluster.length >= 2) clusters.push(cluster);
  }

  // Tighten: split each cluster into SAME-DEAL subgroups via an LLM check on the summaries, so a
  // brand's DIFFERENT deals in one window don't merge (the "Agency Eight" over-group — 4 distinct
  // gifting offers). On any LLM failure the cluster is left intact + flagged, so the dry-run
  // reviewer still sees it rather than silently dropping the grouping.
  const groups: Row[][] = [];
  for (const cluster of clusters) {
    // Warn to the console here (not the logger) so the dry-run reviewer sees a declined
    // split inline, in the same stream as the groups it is deciding about.
    const subgroups = await partitionSameDeal(cluster, (m) => console.warn(`   ! ${m}`));
    for (const sg of subgroups) if (sg.length >= 2) groups.push(sg);
  }

  if (groups.length === 0) {
    console.log("No multi-thread groups found.");
    return;
  }

  let written = 0;
  for (const g of groups) {
    const gid = randomUUID();
    console.log(`\n▸ ${g[0].brand_name}  ·  ${g[0].deal_type}  ·  ${g.length} threads  →  group ${gid.slice(0, 8)}`);
    for (const r of g) {
      const subj = (r.raw_data?.summary ?? "").slice(0, 74);
      console.log(`    ${r.id.slice(0, 8)} [${r.status}] ${iso(r.detected_at)}  ${subj}`);
    }
    if (APPLY) {
      await db.update(deals).set({ deal_group_id: gid }).where(inArray(deals.id, g.map((r) => r.id)));
      written += g.length;
    }
  }

  console.log(
    `\n${groups.length} group(s), ${groups.reduce((n, g) => n + g.length, 0)} deals. ` +
    (APPLY ? `${written} rows written.` : "DRY-RUN — re-run with --apply (post-deploy) to write."),
  );
}

const ms = (d: Date | null): number => (d ? new Date(d).getTime() : 0);
const iso = (d: Date | null): string => (d ? new Date(d).toISOString().slice(0, 10) : "-");

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
