/**
 * platformSpendIndexes.migration.test.ts — 0150 (the platform day total's indexes): on a database without them it
 * creates exactly what a shared/schema.ts push creates; each statement runs on its own (CONCURRENTLY, no transaction);
 * a re-run is a no-op; it is on db-migrate.sh exactly once, after 0149.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0150_platform_spend_indexes.sql"), "utf8");
const NAMES = ["idx_agent_runs_started", "idx_generation_jobs_created", "idx_chat_voice_created"];

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
/** One statement at a time, the way `psql -f` sends them: CONCURRENTLY refuses an implicit multi-statement block. */
const statements = FILE.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
const run = async (pg: PGlite) => { for (const s of statements) await pg.query(s); };
const defs = async (pg: PGlite) =>
  (await pg.query<{ indexname: string; indexdef: string }>(`select indexname, indexdef from pg_indexes where indexname = any($1) order by 1`, [NAMES]))
    .rows.map((r) => r.indexdef.replace(/\s+/g, " ").replace(/ CONCURRENTLY/i, ""));

describe("0150: the platform day total's indexes", () => {
  it("creates what a schema push has, one statement at a time, and re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    for (const n of NAMES) await got.query(`DROP INDEX ${n}`);
    expect(await defs(got)).toEqual([]);
    await run(got);
    expect(await defs(got)).toEqual(await defs(want));
    expect(await defs(got)).toHaveLength(3);
    await run(got);
    expect(await defs(got)).toHaveLength(3);
    await want.close(); await got.close();
  }, 120_000);

  it("is CONCURRENTLY + IF NOT EXISTS only: no transaction control, nothing dropped", () => {
    const body = FILE.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|DELETE|BEGIN|COMMIT|ROLLBACK|TRUNCATE|UPDATE)\b/i);
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
  });

  it("is on db-migrate.sh exactly once, after 0149, and never with --single-transaction", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0150_platform_spend_indexes/g)).toHaveLength(1);
    expect(sh.indexOf("0150_platform_spend_indexes")).toBeGreaterThan(sh.indexOf("0149_brand_book_overrides"));
    expect(sh).toMatch(/run_sql -f "migrations\/\$\{f\}\.sql"/);
  });
});
