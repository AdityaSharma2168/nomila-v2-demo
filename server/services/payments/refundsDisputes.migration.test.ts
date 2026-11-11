/**
 * refundsDisputes.migration.test.ts — 0098 is the schema: the payments + financial_ledger_records columns and the
 * widened payments_status_check the file produces equal what a shared/schema.ts push creates; it re-runs as a no-op,
 * keeps existing rows valid (every old status still passes), accepts 'charged_back', and is on db-migrate.sh's list
 * exactly once, after 0097.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0098_payments_refunds_disputes";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

const PAY_COLS = ["refunded_cents", "refunded_at", "refund_reason", "refund_requested_by", "stripe_transfer_reversal_id", "stripe_dispute_id", "dispute_status"];
const LEDGER_COLS = ["refunded_cents", "stripe_transfer_reversal_id", "stripe_dispute_id"];
const OLD_CHECK = `CHECK (status IN ('pending','requires_action','authorized','reauthorized','funded','settled','released','expired','refunded','canceled','failed','disputed'))`;

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const cols = (pg: PGlite, table: string, names: string[]) => q(pg,
  `select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name='${table}' and column_name in (${names.map((n) => `'${n}'`).join(",")}) order by column_name`);
const statusCheck = (pg: PGlite) => q(pg, `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payments_status_check'`);

/** The pre-0098 shape: drop the new columns, restore the old check. */
async function preMigration(): Promise<PGlite> {
  const pg = await pushed();
  for (const c of PAY_COLS) await pg.exec(`ALTER TABLE payments DROP COLUMN ${c};`);
  for (const c of LEDGER_COLS) await pg.exec(`ALTER TABLE financial_ledger_records DROP COLUMN ${c};`);
  await pg.exec(`ALTER TABLE payments DROP CONSTRAINT payments_status_check; ALTER TABLE payments ADD CONSTRAINT payments_status_check ${OLD_CHECK};`);
  return pg;
}

describe("0098: the file is the schema", () => {
  it("adds exactly the columns and the status check a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await preMigration();
    expect(await cols(got, "payments", PAY_COLS)).toEqual([]);
    await got.exec(FILE);
    expect(await cols(got, "payments", PAY_COLS)).toEqual(await cols(want, "payments", PAY_COLS));
    expect((await cols(got, "payments", PAY_COLS)).length).toBe(7);
    expect(await cols(got, "financial_ledger_records", LEDGER_COLS)).toEqual(await cols(want, "financial_ledger_records", LEDGER_COLS));
    expect(await statusCheck(got)).toEqual(await statusCheck(want));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op, keeps existing rows valid, and accepts charged_back", async () => {
    const pg = await preMigration();
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    const d = (await pg.query<{ id: string }>(`INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'Acme') RETURNING id`, [a])).rows[0].id;
    await pg.query(`INSERT INTO payments (deal_id, athlete_id, kind, status) VALUES ($1, $2, 'deal_payment', 'settled')`, [d, a]);

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT status, refunded_cents, stripe_dispute_id FROM payments`)).toEqual([{ status: "settled", refunded_cents: null, stripe_dispute_id: null }]);
    await pg.query(`UPDATE payments SET status = 'charged_back'`);
    await expect(pg.query(`UPDATE payments SET status = 'bogus'`)).rejects.toThrow();
    expect(FILE).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0097", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = `${NAME} \\`;
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0097_payments_brand_confirm_token \\"));
  });
});
