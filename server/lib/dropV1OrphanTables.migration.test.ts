/**
 * dropV1OrphanTables.migration.test.ts — 0092 drops the five dev-only v1 tables (payment_offers, stripe_events,
 * stripe_connect_accounts, subscriptions, fan_tiers): applied to a database that has them (the dev shape, FKs
 * included) it leaves exactly the tables a shared/schema.ts push creates; on a fresh database it is a no-op; it
 * never cascades (a live FK into one of them makes it FAIL instead); and it is on db-migrate.sh's list once,
 * after 0088.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0092_drop_v1_orphan_tables";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const tables = (pg: PGlite) => q(pg, `select table_name from information_schema.tables where table_schema='public' order by table_name`);

/** The dev shape (columns trimmed to the keys; the FKs are the ones the dev catalog holds). */
const DEV_ORPHANS = `
  CREATE TABLE payment_offers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand_account_id uuid REFERENCES athletes(id),
    athlete_id uuid REFERENCES athletes(id), deal_id uuid REFERENCES deals(id), amount_cents integer, status text);
  CREATE TABLE stripe_events (id text PRIMARY KEY, type text, processed_at timestamptz);
  CREATE TABLE stripe_connect_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES athletes(id), stripe_account_id text);
  CREATE TABLE fan_tiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), athlete_id uuid REFERENCES athletes(id), name text);
  CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES athletes(id),
    creator_account_id uuid REFERENCES athletes(id), fan_tier_id uuid REFERENCES fan_tiers(id), status text);`;

describe("0092: the file is the schema", () => {
  it("on a database that has the five orphans, leaves exactly the tables a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(DEV_ORPHANS);
    await got.exec(`INSERT INTO stripe_events (id, type) VALUES ('evt_1', 'charge.succeeded')`);
    await got.exec(FILE);
    expect(await tables(got)).toEqual(await tables(want));
    await want.close(); await got.close();
  }, 60_000);

  it("is a no-op on a fresh database and on re-run; keeps live rows", async () => {
    const pg = await pushed();
    const before = await tables(pg);
    await pg.exec(FILE);
    expect(await tables(pg)).toEqual(before);
    await pg.exec(DEV_ORPHANS);
    await pg.query(`INSERT INTO athletes (full_name) VALUES ('kept')`);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await tables(pg)).toEqual(before);
    expect(await q(pg, `SELECT full_name FROM athletes`)).toEqual([{ full_name: "kept" }]);
    await pg.close();
  }, 60_000);

  it("never cascades: a live FK into one of them makes it fail, and nothing is dropped", async () => {
    const pg = await pushed();
    await pg.exec(DEV_ORPHANS);
    await pg.exec(`CREATE TABLE live_child (id serial PRIMARY KEY, offer_id uuid REFERENCES payment_offers(id))`);
    await expect(pg.exec(FILE)).rejects.toThrow(/depend/i);
    expect((await tables(pg)).map((t: any) => t.table_name)).toEqual(expect.arrayContaining(["payment_offers", "fan_tiers", "live_child"]));

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("DROP TABLE IF EXISTS payment_offers, stripe_events, stripe_connect_accounts, subscriptions, fan_tiers;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0088; nothing on main names the tables any more", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0088_drop_inbox_threads_score \\"));
    const merge = readFileSync(join(ROOT, "server", "scripts", "mergeDuplicateDealThreads.ts"), "utf8");
    expect(merge).not.toMatch(/FROM payment_offers/);
  });
});
