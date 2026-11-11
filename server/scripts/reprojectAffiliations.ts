/**
 * reprojectAffiliations.ts — Phase A Step 2d-6 (§4.4): one pass of the current-primary-only projection rule over every
 * athlete. DRY-RUN BY DEFAULT: prints each athlete whose projection would change (before → after); --apply writes.
 *
 *   npx tsx --require dotenv/config server/scripts/reprojectAffiliations.ts            report only
 *   npx tsx --require dotenv/config server/scripts/reprojectAffiliations.ts --apply    write the projection
 */

import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { athletes, athleteAffiliations } from "../../shared/schema";
import { normalizeConference } from "../services/conference";
import { projectPrimary } from "../services/affiliations";

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await db.select({ id: athletes.id, full_name: athletes.full_name, school: athletes.school, division: athletes.division, conference: athletes.conference }).from(athletes).orderBy(athletes.created_at);
  let changes = 0, nulled = 0;
  for (const a of rows) {
    // explicit columns: this report runs against dev BEFORE the deploy applies 0050
    const prim = (await db.select({ org_name: athleteAffiliations.org_name, org_kind: athleteAffiliations.org_kind, level: athleteAffiliations.level, conference: athleteAffiliations.conference, is_primary: athleteAffiliations.is_primary, ended_on: athleteAffiliations.ended_on }).from(athleteAffiliations).where(eq(athleteAffiliations.athlete_id, a.id))).find((r) => r.is_primary && r.ended_on === null);
    const next = prim ? { school: prim.org_name, division: prim.level ?? (prim.org_kind === "pro" ? "Pro" : prim.org_kind === "olympic" ? "Olympic" : null), conference: normalizeConference(prim.conference) } : { school: null, division: null, conference: null };
    const before = { school: a.school, division: a.division, conference: a.conference };
    const same = before.school === next.school && before.division === next.division && before.conference === next.conference;
    if (same) continue;
    changes++; if (!next.school && before.school) nulled++;
    console.log(`${a.id}  ${a.full_name}\n    before ${JSON.stringify(before)}\n    after  ${JSON.stringify(next)}${prim ? "" : "   (no primary current row ⇒ NULL)"}`);
    if (apply) await projectPrimary(a.id);
  }
  console.log(`athletes=${rows.length} changes=${changes} nulled=${nulled} ${apply ? "APPLIED" : "dry-run: nothing written (pass --apply)"}`);
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
