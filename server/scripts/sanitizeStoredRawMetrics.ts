/**
 * sanitizeStoredRawMetrics.ts — operator CLI for the raw-metrics scrub. The logic lives in production code at
 * server/services/rawMetricsSanitizer.ts; this file only parses flags and prints.
 *
 *   npx tsx --require dotenv/config server/scripts/sanitizeStoredRawMetrics.ts              # report only
 *   npx tsx --require dotenv/config server/scripts/sanitizeStoredRawMetrics.ts --apply      # rewrite, keeping each platform's newest row
 *   npx tsx --require dotenv/config server/scripts/sanitizeStoredRawMetrics.ts --apply --all # rewrite every row, newest included
 */
import { scrubStoredRawMetrics } from "../services/rawMetricsSanitizer";

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  const keepLatest = !process.argv.includes("--all");
  console.log(`${apply ? "APPLY" : "DRY RUN"} (keepLatest=${keepLatest})`);
  scrubStoredRawMetrics({ apply, keepLatest, log: console.log })
    .then((r) => { console.log(r); process.exit(r.stillDirty ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
