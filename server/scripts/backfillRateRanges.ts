/**
 * backfillRateRanges.ts — store the early rate ranges existing athletes were already shown in onboarding (deals design
 * §8; D9 approved 12 Oct 2026), so Your rates and the deal Money line have a suggestion for them too.
 *
 * Reads only agent_runs.output of the onboarding skill (the stored turn's cards); writes athlete_rate_ranges through
 * the same saveShownRanges the live turn uses. Oldest run first, so the latest shown wins; a range saved later by a live
 * turn is never overwritten. Generic: every athlete with a stored card, or one with --athlete <id>. No model call.
 *
 *   npx tsx --require dotenv/config server/scripts/backfillRateRanges.ts                 # dry-run: what would be saved
 *   npx tsx --require dotenv/config server/scripts/backfillRateRanges.ts --apply
 *   npx tsx --require dotenv/config server/scripts/backfillRateRanges.ts --athlete <uuid> [--apply]
 */
import { pool } from "../db";
import { backfillRateRanges } from "../services/rates";

const APPLY = process.argv.includes("--apply");
const at = process.argv.indexOf("--athlete");
const ATHLETE = at > 0 ? process.argv[at + 1] : undefined;

async function main() {
  console.log(APPLY ? "APPLY mode — athlete_rate_ranges will be written.\n" : "DRY-RUN — nothing written. Pass --apply.\n");
  const out = await backfillRateRanges({ apply: APPLY, athleteId: ATHLETE });
  console.log(`${out.runs} onboarding run(s) with a rate-range card · ${out.athletes} athlete(s) · ${out.saved} range(s) ${APPLY ? "saved" : "would be saved"}`);
  if (out.skipped.length) console.log(`Not stored (names no rate type): ${[...new Set(out.skipped)].join(" | ")}`);
}

main().then(() => pool.end()).catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
