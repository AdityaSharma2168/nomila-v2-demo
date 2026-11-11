/**
 * recheckLogos.ts — re-judge the logo every brand behind an open opportunity shows, for ANY athlete.
 *
 * Applies lib/brandLogoCheck to the domain the card shows (the row's evidence domain, else the name search's
 * candidate): Yoku's full logo, else the site's icon only when ≥ 64px, not a default/tiny icon, not a site-builder
 * host and the homepage names the brand — else nothing, and the card draws the initial. Stores the result as
 * enrichment.logo_check (and the logo itself, and its colour for Home's hero card) so display never falls back to a
 * rejected favicon. Domains, names and
 * identity verdicts are never touched.
 *
 *   npx tsx server/scripts/brands/recheckLogos.ts [--env path/.env]            # DRY-RUN: lists, writes nothing
 *   npx tsx server/scripts/brands/recheckLogos.ts [--env path/.env] --apply    # no model cost; plain HTTP fetches
 *   --all    every brand row with a domain or candidate, not only brands behind an open opportunity.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { readOnlyPgOptions } from "../opps/readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const apply = argv.includes("--apply");
  const all = argv.includes("--all");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);
  const { db, pool } = await import("../../db.js");
  const { brandDomainFromInput, readCandidate } = await import("../../lib/brandIdentity.js");
  const { assessLogo, logoCheckOf } = await import("../../lib/brandLogoCheck.js");
  const { storeLogoCheck } = await import("../../lib/brandResolver.js");
  try {
    const rows = (await db.execute(all
      ? sql`SELECT b.id, b.name, b.domain, b.logo_url, b.enrichment, b.is_agency FROM inbox_brands b ORDER BY b.id`
      : sql`SELECT DISTINCT b.id, b.name, b.domain, b.logo_url, b.enrichment, b.is_agency
            FROM inbox_brands b JOIN opportunities o ON o.brand_id = b.id WHERE o.status = 'open' ORDER BY b.id`,
    )).rows as Array<{ id: number; name: string; domain: string | null; logo_url: string | null; enrichment: unknown; is_agency: boolean | null }>;
    const now = new Date();
    let ok = 0, none = 0, changed = 0;
    for (const r of rows) {
      const own = brandDomainFromInput(r.domain);
      const cand = own ? null : readCandidate(r.enrichment);
      const domain = own ?? brandDomainFromInput(cand?.domain ?? null);
      if (!domain) continue;
      const before = own ? r.logo_url : cand?.logo_url ?? null;
      const a = await assessLogo(domain, r.name);
      if (a.url) ok++; else none++;
      if (a.url !== before) changed++;
      console.log(`  ${r.name} (${domain}${own ? "" : ", candidate"}): ${a.url ? a.source : "INITIAL"} — ${a.reason}${a.url !== before ? "  [changes]" : ""}`);
      if (!apply) continue;
      if (own) { await storeLogoCheck(r.id, domain, a, now); continue; }
      const patch = { candidate: { ...cand, logo_url: a.url }, logo_check: logoCheckOf(domain, a, now) };
      await db.execute(sql`UPDATE inbox_brands SET enrichment = coalesce(enrichment, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${r.id}`);
    }
    console.log(`${ok} with a logo good enough, ${none} drawing the initial; ${changed} change(s).${apply ? " APPLIED." : " DRY-RUN: nothing written. Re-run with --apply."}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
