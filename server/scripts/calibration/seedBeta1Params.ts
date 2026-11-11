/**
 * seedBeta1Params.ts — DEV-ONLY: insert the Beta.1 parameter drafts (frozen engine weights + v0 normalization placeholders)
 * into model_params and optionally activate them. Idempotent on (family, version). Refuses any database but dev (server/lib/devDatabaseGuard.ts).
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/seedBeta1Params.ts             # insert drafts only
 *   npx tsx --require dotenv/config server/scripts/calibration/seedBeta1Params.ts --activate  # and activate on dev
 */
import { pool } from "../../db";
import { assertDevDatabase } from "../../lib/devDatabaseGuard";
import { listParams } from "../../services/intelligence/params";
import { MARKETABILITY_BETA1_FROZEN_PARAMS } from "../../services/marketabilityBeta1FrozenParams";
import { loadBeta1Params, seedBeta1Params } from "../../services/marketabilityBeta1Params";

async function main() {
  await assertDevDatabase(pool);   // dev only: the connected database must be dev, before any write
  const activate = process.argv.includes("--activate");
  // The frozen v1.0-beta.1 engine row (weights, sub-weights, 0–850 mapping) is the reviewed draft parameter row mirrored by the fixture.
  const seeded = await seedBeta1Params({ engine: MARKETABILITY_BETA1_FROZEN_PARAMS, activate, createdBy: "seedBeta1Params" });
  console.log(`seeded: ${JSON.stringify(seeded)}`);
  for (const family of ["marketability", "cohorts", "priors"] as const) {
    const rows = await listParams(family);
    console.log(`  ${family}: ${rows.map((r) => `${r.version} [${r.status}]`).join(", ") || "(none)"}`);
  }
  if (activate) { const l = await loadBeta1Params(); console.log(`active bundle loads: ${JSON.stringify(l.versions)}; priors=${l.bundle.priors.entries.length} cohort tables=${l.bundle.cohorts.tables.length} lookups=${l.bundle.lookups.lookups.length}`); }
}

main().then(() => pool.end()).catch((err) => { console.error(err?.message ?? err); process.exit(1); });
