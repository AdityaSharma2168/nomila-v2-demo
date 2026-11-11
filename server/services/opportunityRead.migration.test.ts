/**
 * opportunityRead.migration.test.ts — 0133 (deal_reads, DEALS_READ_MODEL): on a database without the table it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive with no transaction control, one
 * row per athlete + deal with an inputs_key, a deleted brand keeps the read (brand link nulled), a deleted deal takes
 * it, and it is on db-migrate.sh exactly once, after 0132.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0133_deal_reads.sql"), "utf8");
const TABLE = "deal_reads";

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

describe("0133: the file is the schema", () => {
  it("on a database without the table, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE ${TABLE};`);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));

    const [{ id: athleteId }] = await q(got, "INSERT INTO athletes (full_name, sport) VALUES ($1, $2) RETURNING id", ["Test Athlete", "Test sport"]);
    const [{ id: dealId }] = await q(got, "INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'B') RETURNING id", [athleteId]);
    const [{ id: brandId }] = await q(got, "INSERT INTO inbox_brands (name) VALUES ('B') RETURNING id");
    await got.query(`INSERT INTO ${TABLE} (athlete_id, deal_id, brand_id, inputs_key) VALUES ($1, $2, $3, 'k')`, [athleteId, dealId, brandId]);
    await expect(got.query(`INSERT INTO ${TABLE} (athlete_id, deal_id, inputs_key) VALUES ($1, $2, 'k2')`, [athleteId, dealId])).rejects.toThrow();
    await expect(got.query(`INSERT INTO ${TABLE} (athlete_id, deal_id) VALUES ($1, $2)`, [athleteId, dealId])).rejects.toThrow();
    // A brand going away keeps the read (its brand link set null); the deal going away takes it.
    await got.query("DELETE FROM inbox_brands WHERE id = $1", [brandId]);
    expect(await q(got, `select brand_id from ${TABLE}`)).toEqual([{ brand_id: null }]);
    await got.query("DELETE FROM deals WHERE id = $1", [dealId]);
    expect(await q(got, `select count(*)::int as n from ${TABLE}`)).toEqual([{ n: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/DROP CONSTRAINT IF EXISTS/g, "").replace(/ON (DELETE|UPDATE) (cascade|no action|set null)/gi, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0132", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0133_deal_reads/g)).toHaveLength(1);
    expect(sh.indexOf("0133_deal_reads")).toBeGreaterThan(sh.indexOf("0132_athlete_rate_ranges"));
  });
});
