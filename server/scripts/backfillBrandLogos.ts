/**
 * backfillBrandLogos.ts — give every brand the best logo we can actually get.
 *
 * WHY: logo.clearbit.com was shut down by HubSpot and no longer resolves, so 104 of 169
 * rows held dead image URLs. Those were repaired to Google's favicon service, which is
 * keyless and answers for every domain — including the enterprise sites that 403 our own
 * scraper — but it returns a FAVICON: 500b–2.4KB at 128px. Fine for a 24px tile, thin
 * anywhere larger.
 *
 * Yoku's CDN serves real logos (gorjana 25KB, Gatorade 50KB) and needs no API key. It
 * does not have every brand, but `fallback/404` makes it say so honestly rather than
 * returning a lettermark we would then store as if it were the real thing. So: ask Yoku,
 * keep it when it has one, otherwise keep the favicon. Nothing is ever stored unverified.
 *
 *   npx tsx --require dotenv/config server/scripts/backfillBrandLogos.ts
 *   npx tsx --require dotenv/config server/scripts/backfillBrandLogos.ts --apply
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { inboxBrands } from "../../shared/schema";
import { yokuLogoUrl, googleFaviconUrl } from "../lib/brandLogoSources";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 4;

async function hasYokuLogo(domain: string): Promise<boolean> {
  try {
    const res = await fetch(yokuLogoUrl(domain, { verify: true }), {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    return res.ok && (res.headers.get("content-type") ?? "").startsWith("image");
  } catch {
    return false;
  }
}

async function main() {
  console.log(APPLY ? "APPLY mode — logo_url will be written.\n" : "DRY-RUN — nothing written. Pass --apply.\n");

  const rows = await db
    .select({ id: inboxBrands.id, name: inboxBrands.name, domain: inboxBrands.domain, logo_url: inboxBrands.logo_url })
    .from(inboxBrands)
    .where(and(isNotNull(inboxBrands.domain), sql`${inboxBrands.domain} <> ''`));

  console.log(`${rows.length} brand(s) with a domain.\n`);

  let upgraded = 0, kept = 0, written = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const b = rows[cursor++];
      const domain = b.domain!;
      const yoku = await hasYokuLogo(domain);
      const next = yoku ? yokuLogoUrl(domain) : googleFaviconUrl(domain);

      if (yoku) {
        upgraded++;
        console.log(`  ✓ ${(b.name ?? "?").slice(0, 26).padEnd(26)} ${domain.padEnd(28)} real logo`);
      } else {
        kept++;
      }

      if (APPLY && next !== b.logo_url) {
        await db.update(inboxBrands).set({ logo_url: next }).where(eq(inboxBrands.id, b.id));
        written++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nReal logos: ${upgraded}   favicon fallback: ${kept}   rows written: ${written}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
