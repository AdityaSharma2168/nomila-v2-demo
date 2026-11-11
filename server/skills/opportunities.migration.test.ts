/**
 * opportunities.migration.test.ts — 0084 is the schema: the table and the deals column the file
 * creates equal what a shared/schema.ts push creates (columns, indexes, constraints), it re-runs as
 * a no-op, it is additive, and it is on db-migrate.sh's list once, right after 0083.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0084_opportunities.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
/** Pre-0084: schema.ts pushed, then the table and the deals column removed. */
async function pre0084(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP INDEX idx_deals_opportunity; ALTER TABLE deals DROP COLUMN opportunity_id; DROP TABLE opportunities;`);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const catalog = async (pg: PGlite, table: string) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='${table}' order by column_name`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename='${table}' order by indexname`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='${table}'::regclass order by conname`),
});

describe("0084: the file is the schema", () => {
  it("creates exactly what a schema.ts push creates — opportunities and deals.opportunity_id", async () => {
    const want = await pushed();
    const got = await pre0084();
    const a = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Pre 0084') RETURNING id`)).rows[0].id;
    await got.query(`INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'Existing')`, [a]);

    await got.exec(FILE);
    for (const table of ["opportunities", "deals"]) expect(await catalog(got, table)).toEqual(await catalog(want, table));
    expect((await got.query(`SELECT opportunity_id FROM deals`)).rows).toEqual([{ opportunity_id: null }]);   // no backfill
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; additive; no transaction control; the open-brand index is not unique", async () => {
    const pg = await pushed();
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect((await catalog(pg, "opportunities")).columns.length).toBe(10);
    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bINSERT\b|\bCOMMIT\b|\bROLLBACK\b|\bUNIQUE\b|CONCURRENTLY/i);
    expect(code).not.toMatch(/(^|;)\s*BEGIN\s*(;|$)/im);   // BEGIN only as a DO block's body keyword
    await pg.close();
  }, 60_000);

  it("CHECKs: closed_at and close_reason are set exactly when the row is closed", async () => {
    const pg = await pushed();
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Checks') RETURNING id`)).rows[0].id;
    const ins = (status: string, reason: string | null, closed: boolean) => pg.query(
      `INSERT INTO opportunities (athlete_id, status, close_reason, closed_at, opened_at, last_activity_at) VALUES ($1, $2, $3, ${closed ? "now()" : "NULL"}, now(), now())`,
      [a, status, reason]);
    await ins("open", null, false);
    await ins("closed", "expired", true);
    await expect(ins("open", null, true)).rejects.toThrow(/opportunities_closed_check/);
    await expect(ins("closed", "expired", false)).rejects.toThrow(/opportunities_closed_check/);
    await expect(ins("closed", null, true)).rejects.toThrow(/opportunities_closed_check/);
    await expect(ins("closed", "merged", true)).rejects.toThrow(/opportunities_close_reason_check/);
    await ins("open", null, false);   // a second open row for the same (athlete, brand) is allowed by the DB
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, right after 0083", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0084_opportunities \\")).toHaveLength(1);
    expect(list.indexOf("0084_opportunities \\")).toBe(list.indexOf("0083_identity_intelligence_attempts \\") + 1);
  });
});
