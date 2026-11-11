/**
 * scripts/mastra/exportDdl.ts — (re)write migrations/0147_mastra_engine.sql from the INSTALLED @mastra/pg:
 * exportSchemas("mastra") (no database connection), under a fixed header. The Mastra engine's store runs with
 * disableInit, so these tables are created only by our migration path (scripts/db-migrate.sh), never at runtime.
 *
 *   npx tsx scripts/mastra/exportDdl.ts            write the file
 *   npx tsx scripts/mastra/exportDdl.ts --check    exit 1 when the file differs from what the installed @mastra/pg
 *                                                  exports (engine.migration.test.ts runs the same comparison)
 *
 * A @mastra/pg bump that changes the DDL needs a NEW numbered migration (this file is applied already); --check fails
 * until it is written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mastraMigrationSql, MASTRA_MIGRATION_FILE } from "../../server/agent/engine/mastra/ddl";

const file = join(__dirname, "..", "..", "migrations", MASTRA_MIGRATION_FILE);
const want = mastraMigrationSql();
if (process.argv.includes("--check")) {
  const got = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (got !== want) { console.error(`${MASTRA_MIGRATION_FILE} differs from the installed @mastra/pg export`); process.exit(1); }
  console.log(`${MASTRA_MIGRATION_FILE} matches the installed @mastra/pg export`);
} else {
  writeFileSync(file, want);
  console.log(`wrote migrations/${MASTRA_MIGRATION_FILE}: ${(want.match(/CREATE TABLE/gi) ?? []).length} tables`);
}
