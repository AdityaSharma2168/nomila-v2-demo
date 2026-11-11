/**
 * dropBrandBackfillBakTables.migration.test.ts — 0093 drops the brand-identity backfill's rollback snapshots
 * (inbox_brands_bak, threads_brand_bak, deals_brand_bak): applied to a database that has them (CREATE TABLE … AS, as
 * the backfill made them) it leaves exactly the tables a shared/schema.ts push creates, it is a no-op on a fresh
 * database and on re-run, it never touches the live tables or the backfill marker, it never cascades, and it is on
 * db-migrate.sh's list once, after 0088 — with the step that re-created the snapshots gone.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0093_drop_brand_backfill_bak_tables";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const tables = (pg: PGlite) => q(pg, `select table_name from information_schema.tables where table_schema='public' order by table_name`);

/** What backfillBrandIdentityWrite.ts made: three CREATE TABLE … AS snapshots. */
const SNAPSHOTS = `
  CREATE TABLE inbox_brands_bak AS SELECT * FROM inbox_brands;
  CREATE TABLE threads_brand_bak AS SELECT id, brand_id, classification FROM inbox_threads;
  CREATE TABLE deals_brand_bak AS SELECT id, brand_name FROM deals;`;

async function seeded(): Promise<PGlite> {
  const pg = await pushed();
  const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
  await pg.query(`INSERT INTO inbox_brands (name, normalized_name) VALUES ('Acme', 'acme')`);
  await pg.query(`INSERT INTO inbox_threads (athlete_id, subject) VALUES ($1, 'kept')`, [a]);
  await pg.query(`INSERT INTO deals (athlete_id, brand_name, deal_type, status) VALUES ($1, 'Acme', 'ambassador', 'detected')`, [a]);
  return pg;
}

describe("0093: the file is the schema", () => {
  it("on a database that has the three snapshots, leaves exactly the tables a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await seeded();
    await got.exec(SNAPSHOTS);
    expect((await q(got, `select count(*)::int as n from threads_brand_bak`))[0].n).toBe(1);
    await got.exec(FILE);
    expect(await tables(got)).toEqual(await tables(want));
    await want.close(); await got.close();
  }, 60_000);

  it("no-op on a fresh database and on re-run; live rows and the backfill marker survive; no CASCADE", async () => {
    const pg = await seeded();
    const before = await tables(pg);
    await pg.exec(FILE);
    expect(await tables(pg)).toEqual(before);
    await pg.exec(SNAPSHOTS);
    await pg.exec(`CREATE TABLE brand_identity_backfill_marker (applied_at timestamptz DEFAULT now()); INSERT INTO brand_identity_backfill_marker DEFAULT VALUES;`);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT name FROM inbox_brands`)).toEqual([{ name: "Acme" }]);
    expect(await q(pg, `SELECT subject FROM inbox_threads`)).toEqual([{ subject: "kept" }]);
    expect(await q(pg, `SELECT brand_name FROM deals`)).toEqual([{ brand_name: "Acme" }]);
    expect((await q(pg, `select count(*)::int as n from brand_identity_backfill_marker`))[0].n).toBe(1);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("DROP TABLE IF EXISTS inbox_brands_bak, threads_brand_bak, deals_brand_bak;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0088; the step that re-created the snapshots and its scripts are gone", () => {
    const text = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    const list = text.split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0088_drop_inbox_threads_score \\"));
    expect(list.filter((l) => !l.startsWith("#") && /backfillBrandIdentity/.test(l))).toEqual([]);
    for (const f of ["backfillBrandIdentityWrite.ts", "backfillBrandIdentity.ts", "backfillBrandThreadsDryRun.ts"]) {
      expect(existsSync(join(ROOT, "server", "scripts", f))).toBe(false);
    }
  });
});
