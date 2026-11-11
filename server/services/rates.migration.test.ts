/**
 * rates.migration.test.ts — 0132 (Your rates, RATES_V1): on a database without the table it leaves exactly what a
 * shared/schema.ts push creates, it re-runs as a no-op, it is additive with no transaction control, it refuses a range
 * whose high is under its low or an unknown confidence, one row per athlete × rate type, deleting an athlete takes her
 * rows with her, and it is on db-migrate.sh exactly once, after 0131.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0132_athlete_rate_ranges.sql"), "utf8");
const TABLE = "athlete_rate_ranges";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name = '${TABLE}' order by 1`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = '${TABLE}' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = '${TABLE}' order by 1`),
});

describe("0132: the file is the schema", () => {
  it("on a database without the table, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE ${TABLE};`);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));

    const [{ id: athleteId }] = await q(got, "INSERT INTO athletes (full_name, sport) VALUES ($1, $2) RETURNING id", ["Test Athlete", "Test sport"]);
    const ins = (rateType: string, low: number, high: number, confidence = "low") =>
      got.query(`INSERT INTO ${TABLE} (athlete_id, rate_type, low, high, confidence, label) VALUES ($1, $2, $3, $4, $5, 'x')`, [athleteId, rateType, low, high, confidence]);
    await ins("ig_reel", 350, 550);
    await expect(ins("ig_post", 500, 100)).rejects.toThrow();
    await expect(ins("ig_story", 100, 200, "certain")).rejects.toThrow();
    await expect(ins("ig_reel", 1, 2)).rejects.toThrow();
    await got.query("DELETE FROM athletes WHERE id = $1", [athleteId]);
    expect(await q(got, `select count(*)::int as n from ${TABLE}`)).toEqual([{ n: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/DROP CONSTRAINT IF EXISTS/g, "").replace(/ON (DELETE|UPDATE) (cascade|no action)/gi, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0131", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0132_athlete_rate_ranges/g)).toHaveLength(1);
    expect(sh.indexOf("0132_athlete_rate_ranges")).toBeGreaterThan(sh.indexOf("0131_media_review_items"));
  });
});
