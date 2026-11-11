/**
 * evalDealEngineParity.ts — parity eval: the deal engine on Kimi (today) vs on the routine tier (D7), on real threads.
 *
 * For each sampled deal thread it runs the summary BOTH ways (summarizeThread with persist:false — nothing is written)
 * and compares what the deal card depends on: the stage, the latest cash figure, the product value, the unit, whether
 * an offer line exists, and (Flash only) how many term-sheet fields were filled. For each brand with two or more deals
 * it runs the same-deal partition both ways and compares the groupings.
 *
 * Read-only. Writes NOTHING to the database. The report holds counts and per-thread booleans keyed by a short hash of
 * the thread id — never a subject, a body, a name or a figure — so it can be shared. Live model calls: this is a
 * script the owner runs on dev, never a test.
 *
 *   npx tsx --require dotenv/config server/scripts/deals/evalDealEngineParity.ts --limit 40
 *   npx tsx --require dotenv/config server/scripts/deals/evalDealEngineParity.ts --athlete <uuid> --limit 80 --out parity.json
 *
 * Pass bar for switching the flags on (proposed): stage agreement ≥ 85%, cash agreement ≥ 90% where either side states
 * cash, no Flash failure rate above Kimi's, and partition agreement ≥ 85% of brands.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, pool } from "../../db";
import { deals, inboxThreads } from "../../../shared/schema";
import { summarizeThread } from "../../skills/threadSummarizer";
import { partitionOrNull, type GroupRow } from "../../skills/dealGrouping";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const LIMIT = Number(arg("--limit") ?? 40);
const ATHLETE = arg("--athlete");
const OUT = arg("--out");
/** --only summary | partition: run one half. */
const ONLY = arg("--only");

const tag = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 10);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const same = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= Math.max(1, 0.01 * Math.max(a, b)));

async function withFlag<T>(name: string, on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[name];
  process.env[name] = on ? "true" : "";
  try { return await fn(); } finally { process.env[name] = prev ?? ""; }
}

async function main() {
  const threads = await db
    .select({ id: inboxThreads.id })
    .from(inboxThreads)
    .where(and(isNotNull(inboxThreads.deal_id), ATHLETE ? eq(inboxThreads.athlete_id, ATHLETE) : undefined))
    .orderBy(desc(inboxThreads.last_message_at))
    .limit(ONLY === "partition" ? 0 : LIMIT);

  const rows: Array<Record<string, unknown>> = [];
  let kimiFail = 0, flashFail = 0, stageAgree = 0, cashCompared = 0, cashAgree = 0, both = 0;
  for (const t of threads) {
    const kimi = await withFlag("DEALS_SUMMARY_FLASH", false, () => summarizeThread(t.id, { persist: false }).catch(() => null));
    const flash = await withFlag("DEALS_SUMMARY_FLASH", true, () => summarizeThread(t.id, { persist: false }).catch(() => null));
    if (!kimi) kimiFail++;
    if (!flash) flashFail++;
    const kos = (kimi as any)?.key_details?.offer_struct ?? {};
    const fos = (flash as any)?.key_details?.offer_struct ?? {};
    const terms = (flash as any)?.key_details?.terms ?? {};
    const row = {
      thread: tag(t.id),
      kimi_ok: !!kimi,
      flash_ok: !!flash,
      stage_same: kimi && flash ? (kimi as any).deal_stage === (flash as any).deal_stage : null,
      cash_same: kimi && flash ? same(num(kos.amount), num(fos.amount)) : null,
      cash_stated: kimi && flash ? num(kos.amount) != null || num(fos.amount) != null : null,
      product_same: kimi && flash ? same(num(kos.product_value), num(fos.product_value)) : null,
      unit_same: kimi && flash ? (kos.unit ?? null) === (fos.unit ?? null) : null,
      offer_line_same: kimi && flash ? !!(kimi as any).offer_display === !!(flash as any).offer_display : null,
      flash_terms_filled: Object.keys(terms).filter((k) => k !== "unknown").length,
    };
    if (kimi && flash) {
      both++;
      if (row.stage_same) stageAgree++;
      if (row.cash_stated) { cashCompared++; if (row.cash_same) cashAgree++; }
    }
    rows.push(row);
  }

  // Partition parity: brands with ≥2 deals for one athlete.
  const clusters = await db.execute(sql`
    SELECT athlete_id, coalesce(brand_id::text, lower(brand_name)) AS k, json_agg(json_build_object(
      'id', id, 'brand_name', brand_name, 'detected_at', detected_at, 'raw_data', json_build_object('summary', raw_data->>'summary')
    ) ORDER BY detected_at) AS rows
    FROM ${deals}
    WHERE ${ATHLETE ? sql`athlete_id = ${ATHLETE}` : sql`true`}
    GROUP BY athlete_id, k HAVING count(*) BETWEEN 2 AND 8
    LIMIT ${ONLY === "summary" ? 0 : 25}`);
  const partRows: Array<Record<string, unknown>> = [];
  let brands = 0, partAgree = 0, partBoth = 0, partKimiFail = 0, partFlashFail = 0;
  const key = (g: GroupRow[][] | null) => (g ? g.map((x) => x.map((r) => r.id).sort().join(",")).sort().join("|") : null);
  for (const c of (clusters as any).rows ?? clusters) {
    const cluster = c.rows as GroupRow[];
    const k = await withFlag("DEALS_PARTITION_FLASH", false, () => partitionOrNull(cluster, () => undefined));
    const f = await withFlag("DEALS_PARTITION_FLASH", true, () => partitionOrNull(cluster, () => undefined));
    brands++;
    if (!k) partKimiFail++;
    if (!f) partFlashFail++;
    if (k && f) { partBoth++; if (key(k) === key(f)) partAgree++; }
    partRows.push({ cluster: tag(cluster.map((r) => r.id).join(",")), threads: cluster.length, kimi_groups: k?.length ?? null, flash_groups: f?.length ?? null, same: k && f ? key(k) === key(f) : null });
  }

  const report = {
    generated_at: new Date().toISOString(),
    scope: ATHLETE ? "one athlete" : "all athletes",
    summary: {
      threads: threads.length, both_ok: both, kimi_failed: kimiFail, flash_failed: flashFail,
      stage_agreement: both ? +(stageAgree / both).toFixed(3) : null,
      cash_agreement: cashCompared ? +(cashAgree / cashCompared).toFixed(3) : null,
      flash_avg_terms_filled: rows.length ? +(rows.reduce((n, r) => n + (r.flash_terms_filled as number), 0) / rows.length).toFixed(2) : null,
    },
    // agreement is measured where BOTH answered; a failed call is counted separately, never as a disagreement.
    partition: { brands, both_ok: partBoth, agreement: partBoth ? +(partAgree / partBoth).toFixed(3) : null, kimi_failed: partKimiFail, flash_failed: partFlashFail },
    rows,
    partition_rows: partRows,
  };
  const text = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, text);
  console.log(JSON.stringify({ summary: report.summary, partition: report.partition }, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
