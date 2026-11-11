/**
 * athleteIndexReport.ts — Phase A Step 2c: the Athlete Index duplicate report (design §5.3). DRY RUN ONLY.
 *
 *   npx tsx --require dotenv/config server/scripts/athleteIndexReport.ts --duplicates
 *
 * Lists (1) pairs of index rows whose names are similar (nameSim ≥ 0.8) with compatible sport/team
 * and the tier each would fall in, (2) exact identifiers (email, handle) that map to more than one
 * row — the ambiguity the tiers refuse to resolve, and (3) every possible_duplicate decision recorded
 * in athlete_index_matches. Never merges, never writes.
 */

import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { getIdentityPolicy } from "../services/intelligence/identity/config";

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

async function main() {
  const policy = await getIdentityPolicy();
  console.log(`athlete index duplicate report (policy ${policy.version})\n`);

  const pairs = rowsOf(await db.execute(sql`
    SELECT a.athlete_id AS a_id, a.full_name AS a_name, a.sport AS a_sport, a.team_or_school AS a_team, a.claimability AS a_claim,
           b.athlete_id AS b_id, b.full_name AS b_name, b.sport AS b_sport, b.team_or_school AS b_team, b.claimability AS b_claim,
           greatest(similarity(a.full_name, b.full_name), similarity(a.name_norm, b.name_norm)) AS name_sim
    FROM athlete_index_v a JOIN athlete_index_v b ON a.athlete_id < b.athlete_id
    WHERE greatest(similarity(a.full_name, b.full_name), similarity(a.name_norm, b.name_norm)) >= 0.8
    ORDER BY name_sim DESC LIMIT 200`));
  console.log(`similar-name pairs (nameSim >= 0.8): ${pairs.length}`);
  for (const p of pairs) {
    const sportOk = !p.a_sport || !p.b_sport || String(p.a_sport).toLowerCase() === String(p.b_sport).toLowerCase();
    console.log(`  ${Number(p.name_sim).toFixed(2)}  ${p.a_name} (${p.a_sport ?? "-"} / ${p.a_team ?? "-"} / ${p.a_claim})  <->  ${p.b_name} (${p.b_sport ?? "-"} / ${p.b_team ?? "-"} / ${p.b_claim})  ${sportOk ? "" : "[sport differs]"}`);
  }

  const emails = rowsOf(await db.execute(sql`SELECT lower(email) AS email, count(*) AS n FROM athletes WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1`));
  console.log(`\nemails on more than one row: ${emails.length}`);
  for (const e of emails) console.log(`  ${String(e.email).replace(/^(.{2}).*(@.*)$/, "$1***$2")}  x${e.n}`);

  const handles = rowsOf(await db.execute(sql`
    SELECT platform, lower(handle) AS handle, count(DISTINCT athlete_id) AS n FROM social_identities WHERE status = 'active' AND handle IS NOT NULL GROUP BY platform, lower(handle) HAVING count(DISTINCT athlete_id) > 1`));
  console.log(`\nactive handles on more than one athlete: ${handles.length}`);
  for (const h of handles) console.log(`  ${h.platform}:@${h.handle}  x${h.n}`);

  const dups = rowsOf(await db.execute(sql`SELECT at, path, tier, claim_proof, decision, chosen_athlete_id, created_athlete_id, query FROM athlete_index_matches WHERE decision = 'possible_duplicate' ORDER BY at DESC LIMIT 200`));
  console.log(`\npossible_duplicate decisions recorded: ${dups.length}`);
  for (const d of dups) console.log(`  ${new Date(d.at).toISOString()}  ${d.path}  tier=${d.tier}  created=${d.created_athlete_id ?? "-"}  best=${d.chosen_athlete_id ?? "-"}  name="${(d.query as any)?.name ?? ""}"`);
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
