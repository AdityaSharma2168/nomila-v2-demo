/**
 * dedupeBrandsCore.ts — find brand rows that are the same company and merge each set into one row.
 *
 * Why: a company's regional arm writes under its legal-entity name ("adidas America Inc." from adidas-group.com) while
 * its brand row was made from its brand name ("adidas", adidas.com). Two rows split one brand's deals, opportunities,
 * paperwork and research — a payment notice could not tell which adidas it paid. The resolver now matches the
 * legal-entity name to the existing row (lib/brandName sameBrandName); this script merges the rows made before it.
 *
 * A set merges only when every row in it:
 *   - shares brandIdentityKey (the same name, or a legal-entity name whose regional tail is dropped), and
 *   - is the same kind (agency with agency, brand with brand), and
 *   - has a compatible domain: none, the same one, or a domain whose own label carries the shared key
 *     ("adidas-group.com" for "adidas"). Two unrelated domains under one name are different companies → skipped.
 * The canonical row is the one already named plainly (its name key IS the identity key), then the oldest.
 *
 * planMerges is pure (tested); applyMerge repoints every reference in one transaction, folds an athlete's open
 * opportunities for the merged brand into one (one open opportunity per brand), then deletes the merged rows.
 * Reports carry ids, names and domains only.
 */
import { sql } from "drizzle-orm";
import { brandIdentityKey, sameNameKey } from "../../lib/brandName";

export interface BrandRow {
  id: number;
  name: string;
  domain: string | null;
  is_agency: boolean | null;
  created_at: Date | string | null;
}

export interface MergePlan { key: string; canonical: BrandRow; merged: BrandRow[] }
export interface SkippedSet { key: string; rows: BrandRow[]; reason: "domain_conflict" | "agency_mismatch" }

/** The domain's own label, without the public suffix: "adidas-group.com" → "adidasgroup", "nike.co.uk" → "nike". */
export function domainLabel(domain: string | null | undefined): string {
  const parts = String(domain ?? "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length < 2) return parts.join("").replace(/[^a-z0-9]/g, "");
  const sld = parts.length >= 3 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3
    ? parts[parts.length - 3] : parts[parts.length - 2];
  return sld.replace(/[^a-z0-9]/g, "");
}

// A company's own corporate or regional site: the brand key plus one of these ("adidas-group", "nikeusa", "acmehq").
// Anything else after the key is another company ("deltafaucet" is not "delta").
const CORPORATE_LABEL = /^(group|corp|inc|co|company|usa|us|america|na|uk|eu|europe|global|intl|international|hq|brand|brands|official|shop|store|online)?$/;

function domainsCompatible(rows: BrandRow[], key: string): boolean {
  const domains = [...new Set(rows.map((r) => (r.domain ?? "").toLowerCase().replace(/^www\./, "")).filter(Boolean))];
  if (domains.length <= 1) return true;
  return domains.every((d) => { const l = domainLabel(d); return l.startsWith(key) && CORPORATE_LABEL.test(l.slice(key.length)); });
}

const time = (d: Date | string | null) => (d ? new Date(d).getTime() : Number.MAX_SAFE_INTEGER);

export function planMerges(rows: BrandRow[]): { merges: MergePlan[]; skipped: SkippedSet[] } {
  const groups = new Map<string, BrandRow[]>();
  for (const r of rows) {
    const key = brandIdentityKey(r.name);
    if (key.length < 2) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const merges: MergePlan[] = [];
  const skipped: SkippedSet[] = [];
  for (const [key, set] of groups) {
    if (set.length < 2) continue;
    if (new Set(set.map((r) => !!r.is_agency)).size > 1) { skipped.push({ key, rows: set, reason: "agency_mismatch" }); continue; }
    if (!domainsCompatible(set, key)) { skipped.push({ key, rows: set, reason: "domain_conflict" }); continue; }
    const ordered = [...set].sort((a, b) =>
      Number(sameNameKey(b.name) === key) - Number(sameNameKey(a.name) === key)
      || time(a.created_at) - time(b.created_at)
      || a.id - b.id);
    merges.push({ key, canonical: ordered[0], merged: ordered.slice(1) });
  }
  merges.sort((a, b) => a.key.localeCompare(b.key));
  return { merges, skipped };
}

/** Columns that point at a brand with no uniqueness around them: a plain repoint. */
const PLAIN_REFS: Array<[string, string]> = [
  ["deals", "brand_id"], ["deals", "broker_brand_id"], ["inbox_senders", "brand_id"], ["inbox_threads", "brand_id"],
  ["generation_jobs", "brand_id"], ["shopify_shops", "brand_id"], ["deal_reads", "brand_id"],
  ["counterparty_research", "brand_id"], ["creative_intents", "brand_id"], ["opportunities", "brand_id"],
];
/** Columns unique together with another column: the merged row's entry yields to the canonical row's. */
const KEYED_REFS: Array<{ table: string; with: string; onConflict: "delete" | "unlink" }> = [
  { table: "brand_fit_narratives", with: "athlete_id", onConflict: "delete" },
  { table: "content_brands", with: "asset_id", onConflict: "delete" },
  { table: "card_overrides", with: "athlete_id", onConflict: "delete" },
  // A studio profile carries its own analyses: never deleted, its brand link is cleared instead.
  { table: "studio_brand_profiles", with: "athlete_id", onConflict: "unlink" },
];
/** Columns the canonical row takes from a merged row when it has none of its own. */
const FILL = ["domain", "logo_url", "category", "description", "brand_tier", "audience_summary", "sport_categories",
  "known_athlete_partnerships", "enriched_at", "enrichment", "image_url", "images"];

export interface MergeResult { key: string; canonical: number; merged: number[]; counts: Record<string, number>; foldedOpportunities: number }

const n = (r: any): number => Number(r?.rowCount ?? r?.rows?.length ?? 0);

/** Merge one plan in its own transaction. `dbx` is the drizzle db (its .transaction). */
export async function applyMerge(dbx: any, plan: MergePlan, now = new Date()): Promise<MergeResult> {
  const c = plan.canonical.id;
  const ids = plan.merged.map((r) => r.id);
  const counts: Record<string, number> = {};
  let foldedOpportunities = 0;
  await dbx.transaction(async (tx: any) => {
    const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    // The canonical row first takes what it lacks (its own values always win).
    for (const col of FILL) {
      await tx.execute(sql`UPDATE inbox_brands SET ${sql.identifier(col)} = (
          SELECT m.${sql.identifier(col)} FROM inbox_brands m WHERE m.id IN (${idList}) AND m.${sql.identifier(col)} IS NOT NULL
          ORDER BY m.created_at NULLS LAST, m.id LIMIT 1)
        WHERE id = ${c} AND ${sql.identifier(col)} IS NULL`);
    }
    for (const { table, with: other, onConflict } of KEYED_REFS) {
      const t = sql.identifier(table), o = sql.identifier(other);
      const clash = onConflict === "delete"
        ? await tx.execute(sql`DELETE FROM ${t} m WHERE m.brand_id IN (${idList})
            AND EXISTS (SELECT 1 FROM ${t} k WHERE k.brand_id = ${c} AND k.${o} = m.${o})`)
        : await tx.execute(sql`UPDATE ${t} m SET brand_id = NULL WHERE m.brand_id IN (${idList})
            AND EXISTS (SELECT 1 FROM ${t} k WHERE k.brand_id = ${c} AND k.${o} = m.${o})`);
      // Two merged rows can clash with each other too: keep one per partner key, the rest yield the same way.
      const sibling = onConflict === "delete"
        ? await tx.execute(sql`DELETE FROM ${t} m WHERE m.brand_id IN (${idList}) AND EXISTS (
            SELECT 1 FROM ${t} k WHERE k.brand_id IN (${idList}) AND k.${o} = m.${o} AND k.brand_id < m.brand_id)`)
        : await tx.execute(sql`UPDATE ${t} m SET brand_id = NULL WHERE m.brand_id IN (${idList}) AND EXISTS (
            SELECT 1 FROM ${t} k WHERE k.brand_id IN (${idList}) AND k.${o} = m.${o} AND k.brand_id < m.brand_id)`);
      const moved = await tx.execute(sql`UPDATE ${t} SET brand_id = ${c} WHERE brand_id IN (${idList})`);
      counts[table] = n(moved) + n(clash) + n(sibling);
    }
    for (const [table, col] of PLAIN_REFS) {
      const r = await tx.execute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(col)} = ${c} WHERE ${sql.identifier(col)} IN (${idList})`);
      counts[`${table}.${col}`] = n(r);
    }
    // Nomi Cards: one per athlete + brand (+ opportunity). A merged row's card yields to the canonical row's.
    const kitsGone = await tx.execute(sql`DELETE FROM media_kits m WHERE m.brand_id IN (${idList}) AND EXISTS (
        SELECT 1 FROM media_kits k WHERE k.brand_id = ${c} AND k.athlete_id = m.athlete_id
          AND k.opportunity_id IS NOT DISTINCT FROM m.opportunity_id)`);
    const kitsSibling = await tx.execute(sql`DELETE FROM media_kits m WHERE m.brand_id IN (${idList}) AND EXISTS (
        SELECT 1 FROM media_kits k WHERE k.brand_id IN (${idList}) AND k.brand_id < m.brand_id AND k.athlete_id = m.athlete_id
          AND k.opportunity_id IS NOT DISTINCT FROM m.opportunity_id)`);
    const kits = await tx.execute(sql`UPDATE media_kits SET brand_id = ${c} WHERE brand_id IN (${idList})`);
    counts.media_kits = n(kits) + n(kitsGone) + n(kitsSibling);
    // Shared links name their brand as text.
    const shares = await tx.execute(sql`UPDATE card_shares SET brand_id = ${String(c)} WHERE brand_id IN (${sql.join(ids.map((i) => sql`${String(i)}`), sql`, `)})`);
    counts.card_shares = n(shares);

    // One open opportunity per athlete and brand: fold the rest into the one with the most deals, then the oldest.
    const dupes = await tx.execute(sql`SELECT athlete_id FROM opportunities WHERE brand_id = ${c} AND status = 'open'
        GROUP BY athlete_id HAVING count(*) > 1`);
    for (const { athlete_id } of (dupes as any).rows ?? []) {
      const opps = ((await tx.execute(sql`SELECT o.id, (SELECT count(*) FROM deals d WHERE d.opportunity_id = o.id)::int AS deals
          FROM opportunities o WHERE o.athlete_id = ${athlete_id} AND o.brand_id = ${c} AND o.status = 'open'
          ORDER BY deals DESC, o.opened_at ASC, o.id ASC`)) as any).rows as Array<{ id: string }>;
      const [keep, ...rest] = opps;
      const restList = sql.join(rest.map((o) => sql`${o.id}`), sql`, `);
      await tx.execute(sql`UPDATE deals SET opportunity_id = ${keep.id} WHERE opportunity_id IN (${restList})`);
      await tx.execute(sql`DELETE FROM media_kits m WHERE m.opportunity_id IN (${restList}) AND EXISTS (
          SELECT 1 FROM media_kits k WHERE k.athlete_id = m.athlete_id AND k.brand_id = m.brand_id AND k.opportunity_id = ${keep.id})`);
      await tx.execute(sql`UPDATE media_kits SET opportunity_id = ${keep.id} WHERE opportunity_id IN (${restList})`);
      await tx.execute(sql`UPDATE opportunities k SET
          opened_at = LEAST(k.opened_at, (SELECT min(o.opened_at) FROM opportunities o WHERE o.id IN (${restList}))),
          last_activity_at = GREATEST(k.last_activity_at, (SELECT max(o.last_activity_at) FROM opportunities o WHERE o.id IN (${restList})))
        WHERE k.id = ${keep.id}`);
      await tx.execute(sql`UPDATE opportunities SET status = 'closed', close_reason = 'not_relevant', closed_at = ${now}
        WHERE id IN (${restList})`);
      foldedOpportunities += rest.length;
    }
    await tx.execute(sql`DELETE FROM inbox_brands WHERE id IN (${idList})`);
  });
  return { key: plan.key, canonical: c, merged: ids, counts, foldedOpportunities };
}

export function renderPlan(merges: MergePlan[], skipped: SkippedSet[]): string {
  const row = (r: BrandRow) => `#${r.id} "${r.name}" (${r.domain ?? "no domain"})`;
  return [
    `# Brand dedupe — ${merges.length} merge set(s), ${skipped.length} skipped`,
    "",
    "## Merges (canonical ← merged)",
    ...merges.map((m) => `- ${m.key}: ${row(m.canonical)} ← ${m.merged.map(row).join(", ")}`),
    "",
    "## Skipped (same name, kept apart)",
    ...skipped.map((s) => `- ${s.key} [${s.reason}]: ${s.rows.map(row).join(", ")}`),
  ].join("\n");
}
