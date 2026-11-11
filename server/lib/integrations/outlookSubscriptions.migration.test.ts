/**
 * outlookSubscriptions.migration.test.ts — 0085 is the schema: the table the file creates equals what a
 * shared/schema.ts push creates (columns, indexes, constraints), it re-runs as a no-op, it is additive, the FK
 * cascades with the connection, and it is on db-migrate.sh's list once, right after 0084.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0085_outlook_subscriptions.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const catalog = async (pg: PGlite, table: string) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='${table}' order by column_name`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename='${table}' order by indexname`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='${table}'::regclass order by conname`),
});

describe("0085: the file is the schema", () => {
  it("creates exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE outlook_subscriptions;`);
    await got.exec(FILE);
    expect(await catalog(got, "outlook_subscriptions")).toEqual(await catalog(want, "outlook_subscriptions"));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; additive; no transaction control; cascades with the connection", async () => {
    const pg = await pushed();
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect((await catalog(pg, "outlook_subscriptions")).columns.length).toBe(12);
    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\bDROP\b|\bALTER\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bINSERT\b|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|CONCURRENTLY/i);

    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    const c = (await pg.query<{ id: string }>(`INSERT INTO connected_accounts (athlete_id, platform, status) VALUES ($1, 'outlook', 'active') RETURNING id`, [a])).rows[0].id;
    const ins = (status: string, graphId: string) => pg.query(
      `INSERT INTO outlook_subscriptions (connected_account_id, graph_subscription_id, resource, expires_at, client_state_hash, status)
       VALUES ($1, $2, 'me/mailFolders(''inbox'')/messages', now(), 'h', $3)`, [c, graphId, status]);
    await expect(ins("paused", "g0")).rejects.toThrow(/outlook_subscriptions_status_check/);
    await ins("active", "g1");
    await expect(ins("active", "g2")).rejects.toThrow(/outlook_subscriptions_connection_uq/);   // one per connection
    await pg.query(`DELETE FROM connected_accounts WHERE id = $1`, [c]);
    expect(await q(pg, `SELECT id FROM outlook_subscriptions`)).toEqual([]);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, right after 0084", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0085_outlook_subscriptions \\")).toHaveLength(1);
    expect(list.indexOf("0085_outlook_subscriptions \\")).toBe(list.indexOf("0084_opportunities \\") + 1);
  });
});
