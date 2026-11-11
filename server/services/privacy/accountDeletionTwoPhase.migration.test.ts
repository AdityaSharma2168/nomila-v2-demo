/**
 * accountDeletionTwoPhase.migration.test.ts — 0145 (account deletion in two phases): on a database without its column,
 * table and index it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with
 * no transaction control, existing athletes read as not deleting, the ledger is unique per (run, system, ref) and checks
 * its status, and it is on db-migrate.sh once, after 0143.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0145_account_deletion_two_phase.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
    where table_name = 'account_deletion_items' or (table_name = 'athletes' and column_name = 'deletion_requested_at') order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'account_deletion_items' order by 1, 2, 3`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename = 'account_deletion_items' order by 1, 2`),
});

describe("0145: the file is the schema", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE account_deletion_items; ALTER TABLE athletes DROP COLUMN deletion_requested_at;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("existing athletes read as not deleting; one ledger row per (run, system, ref); status is checked", async () => {
    const pg = await pushed();
    await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig Test')`);
    expect(await q(pg, `SELECT deletion_requested_at FROM athletes`)).toEqual([{ deletion_requested_at: null }]);
    const run = "11111111-1111-4111-8111-111111111111";
    await q(pg, `INSERT INTO account_deletion_items (run_id, system, ref) VALUES ($1, 'trueforge', 's1')`, [run]);
    await expect(q(pg, `INSERT INTO account_deletion_items (run_id, system, ref) VALUES ($1, 'trueforge', 's1')`, [run])).rejects.toThrow();
    await expect(q(pg, `INSERT INTO account_deletion_items (run_id, system, ref, status) VALUES ($1, 'trueforge', 's2', 'done')`, [run])).rejects.toThrow();
    expect(await q(pg, `SELECT status, rows, attempts FROM account_deletion_items`)).toEqual([{ status: "pending", rows: 0, attempts: 0 }]);
    await pg.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|ALTER)\b/i);
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS account_deletion_items/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_items_ref/);
  });

  it("is applied by db-migrate.sh exactly once, after 0143", () => {
    const script = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(script.match(/0145_account_deletion_two_phase/g)).toHaveLength(1);
    expect(script.indexOf("0145_account_deletion_two_phase")).toBeGreaterThan(script.indexOf("0143_mila_proactive"));
  });
});
