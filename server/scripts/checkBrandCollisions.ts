/**
 * checkBrandCollisions.ts — READ-ONLY pre-flight for the brand-identity migration.
 *
 * Recomputes normalized_name (with self-validated aliases) for every inbox_brands
 * row and reports any collision that WOULD block `CREATE UNIQUE INDEX(normalized_name)`
 * — i.e. two distinct brands normalizing to the same identity. Run this against prod
 * (or a recent prod dump) ahead of deploy so collisions surface on your schedule, not
 * mid-release. WRITES NOTHING. Mirrors the in-deploy hard gate exactly.
 *
 *   DATABASE_URL=<prod-or-dump> npx tsx --require dotenv/config server/scripts/checkBrandCollisions.ts
 *   → exit 0 = safe to migrate · exit 1 = collisions (listed)
 */
import { db } from "../db";
import { inboxBrands, inboxThreads } from "../../shared/schema";
import { normalizeBrand, validateAliases } from "../lib/brandResolver";

async function main() {
  const brands = await db.select({ id: inboxBrands.id, name: inboxBrands.name, domain: inboxBrands.domain }).from(inboxBrands);
  const threads = await db.select({ classification: inboxThreads.classification }).from(inboxThreads);

  const evidence = [
    ...brands.map((b) => ({ normalized: normalizeBrand(b.name), domain: b.domain })),
    ...threads.map((t) => { const c: any = t.classification ?? {}; return { normalized: normalizeBrand(c.brand_name ?? ""), domain: c.brand_domain ?? null }; }),
  ];
  const { validated, skipped } = validateAliases(evidence);
  const aliasKey = (name: string) => { const k = normalizeBrand(name); return validated.get(k) ?? k; };

  console.log(`Checked ${brands.length} brand rows.`);
  for (const [v, t] of validated) console.log(`  alias VALIDATED: ${v} → ${t}`);
  for (const s of skipped) console.log(`  alias SKIPPED (flag for review): ${s.variant}→${s.target} — ${s.reason}`);

  // Group distinct brand names by their resulting identity (skip empties → become NULL).
  const groups = new Map<string, { id: number; name: string; domain: string | null }[]>();
  for (const b of brands) {
    const key = aliasKey(b.name);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
  }
  const collisions = [...groups.entries()].filter(([, rows]) =>
    new Set(rows.map((r) => r.name.toLowerCase())).size > 1);

  if (!collisions.length) {
    console.log("\n✅ NO COLLISIONS — safe to add UNIQUE(normalized_name).");
    process.exit(0);
  }
  console.log(`\n❌ ${collisions.length} COLLISION(S) — these WOULD abort the deploy gate:`);
  for (const [key, rows] of collisions) {
    console.log(`  normalized "${key}":`);
    rows.forEach((r) => console.log(`    - #${r.id} "${r.name}" (${r.domain ?? "no domain"})`));
  }
  console.log("\nResolve by renaming/merging one side, or add a validated alias, before deploying.");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
