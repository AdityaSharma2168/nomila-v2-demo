/**
 * backfillCandidateLogos.ts — give every brand behind an open opportunity a logo it can show, for ANY athlete.
 *
 * A logo is public identity, not a claim (the identity gate still governs research and fit text). Two gaps:
 *   1. a brand row WITH a domain but no usable logo_url → lib/brandLogoCheck's verdict (Yoku, else a good icon, else none);
 *   2. a brand row with NO domain (free-mail or third-party sender) and no name search inside the cap window →
 *      the name search's candidate domain and its logo (enrichment.candidate; never the row's domain — that stays
 *      evidence-only). A person with no company finds nothing and keeps the initial disc.
 * Only missing logo fields are written; names, domains and identity verdicts are never touched.
 *
 *   npx tsx server/scripts/brands/backfillCandidateLogos.ts [--env path/.env]            # DRY-RUN: lists, writes nothing
 *   npx tsx server/scripts/brands/backfillCandidateLogos.ts [--env path/.env] --apply    # COST: one web search per
 *                                                                                        # domain-less brand
 *   --force  also search domain-less brands searched inside the window that still have no candidate (a one-off rerun
 *            after the search itself improved); a brand that already has a candidate is never searched again.
 *   --all    every brand row, not only brands behind an open opportunity.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { readOnlyPgOptions } from "../opps/readOnly";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const apply = argv.includes("--apply");
  const force = argv.includes("--force");
  const all = argv.includes("--all");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);
  const { db, pool } = await import("../../db.js");
  const { brandDomainFromInput, brandNeedsCandidateLookup, readCandidate } = await import("../../lib/brandIdentity.js");
  const { isDeadLogoUrl } = await import("../../lib/brandLogoSources.js");
  const { assessLogo } = await import("../../lib/brandLogoCheck.js");
  const { storeLogoCheck } = await import("../../lib/brandResolver.js");
  const { BRAND_RESEARCH_CAP_DAYS, lookupBrandCandidate } = await import("../../services/brandIdentityRefresh.js");
  try {
    const rows = (await db.execute(all
      ? sql`SELECT b.id, b.name, b.domain, b.logo_url, b.enrichment, b.is_agency FROM inbox_brands b ORDER BY b.id`
      : sql`
      SELECT DISTINCT b.id, b.name, b.domain, b.logo_url, b.enrichment, b.is_agency
      FROM inbox_brands b JOIN opportunities o ON o.brand_id = b.id
      WHERE o.status = 'open' ORDER BY b.id`)).rows as Array<{ id: number; name: string; domain: string | null; logo_url: string | null; enrichment: unknown; is_agency: boolean | null }>;
    const now = new Date();
    const needLogo = rows.filter((r) => brandDomainFromInput(r.domain) && (!r.logo_url || isDeadLogoUrl(r.logo_url)));
    const needLookup = rows.filter((r) => force
      ? !r.is_agency && !brandDomainFromInput(r.domain) && !readCandidate(r.enrichment)
      : brandNeedsCandidateLookup(r, now, BRAND_RESEARCH_CAP_DAYS));
    const pictured = rows.filter((r) => brandDomainFromInput(r.domain) || readCandidate(r.enrichment)).length;
    console.log(`${rows.length} brand(s) behind open opportunities; ${pictured} already have a domain or candidate.`);
    console.log(`${needLogo.length} with a domain but no logo: ${needLogo.map((r) => `${r.name} (${r.domain})`).join(", ") || "none"}`);
    console.log(`${needLookup.length} with no domain, due a name search: ${needLookup.map((r) => r.name).join(", ") || "none"}`);
    if (!apply) { console.log("DRY-RUN: nothing written. Re-run with --apply."); return; }

    let logos = 0, found = 0, notFound = 0, microUsd = 0;
    for (const r of needLogo) {
      const domain = brandDomainFromInput(r.domain)!;
      const a = await assessLogo(domain, r.name);
      await storeLogoCheck(r.id, domain, a, now);   // the logo good enough to show, or none (the initial)
      if (a.url) logos++;
    }
    for (const r of needLookup) {
      let evidence = "";
      const out = await lookupBrandCandidate(r.id, { now, force, onResult: (x) => { microUsd += x.costMicroUsd ?? 0; evidence = x.evidence ?? ""; } });
      if (out === "found") found++; else if (out === "not_found") notFound++;
      const [after] = (await db.execute(sql`SELECT enrichment FROM inbox_brands WHERE id = ${r.id}`)).rows as Array<{ enrichment: unknown }>;
      const c = readCandidate(after?.enrichment);
      console.log(`  ${r.name}: ${out}${c ? ` → ${c.domain} (${c.confidence ?? c.source})` : ""}${evidence ? ` — ${evidence}` : ""}`);
    }
    console.log(`APPLIED: ${logos} logo(s) set; name search found ${found}, found nothing for ${notFound}; search cost ≈ $${(microUsd / 1e6).toFixed(3)}.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
