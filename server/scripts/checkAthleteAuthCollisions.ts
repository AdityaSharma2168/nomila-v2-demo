/**
 * checkAthleteAuthCollisions.ts — Phase A Step 2c closure pre-flight (design §5.4, §10 step 3).
 *
 *   npx tsx --require dotenv/config server/scripts/checkAthleteAuthCollisions.ts
 *
 * Reports every auth_id shared by more than one athletes row. The partial unique index
 * athletes_auth_id_uq (0049, a separate PR) may only be added when this prints NO COLLISIONS on
 * BOTH dev and prod. Read-only; exits 1 on collisions so a CI or deploy step can gate on it.
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../db";

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

async function main() {
  const rows = rowsOf(await db.execute(sql`SELECT auth_id, count(*) AS n, array_agg(id ORDER BY created_at) AS ids FROM athletes WHERE auth_id IS NOT NULL GROUP BY auth_id HAVING count(*) > 1 ORDER BY n DESC`));
  const total = rowsOf(await db.execute(sql`SELECT count(*) AS n, count(auth_id) AS with_auth FROM athletes`))[0];
  console.log(`athletes: ${total?.n} rows, ${total?.with_auth} with auth_id`);
  if (!rows.length) { console.log("✅ NO COLLISIONS — safe to add UNIQUE INDEX athletes_auth_id_uq ON athletes (auth_id) WHERE auth_id IS NOT NULL"); return 0; }
  console.log(`❌ ${rows.length} auth_id value(s) on more than one row:`);
  for (const r of rows) console.log(`  ${String(r.auth_id).slice(0, 6)}…  x${r.n}  ids=${(r.ids as string[]).join(",")}`);
  return 1;
}

main().then(async (code) => { await pool.end(); process.exit(code); }).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
