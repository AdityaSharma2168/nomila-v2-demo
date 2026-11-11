/**
 * financialLedgerRecords.migration.test.ts — 0087 is the schema: the table the file creates equals what a
 * shared/schema.ts push creates (columns, types, nullability, defaults; no foreign key), it re-runs as a no-op, and it
 * is on db-migrate.sh's list exactly once, right after 0086.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0087_financial_ledger_records.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite) => q(pg,
  `select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name='financial_ledger_records' order by column_name`);
const constraints = (pg: PGlite) => q(pg,
  `select contype from pg_constraint where conrelid = 'financial_ledger_records'::regclass and contype in ('p','f') order by contype`);

describe("0087: the file is the schema", () => {
  it("creates exactly the table a schema.ts push creates (with 0098's refund / reversal / dispute columns), with no foreign key", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE financial_ledger_records;`);
    await got.exec(FILE);
    expect((await columns(got)).length).toBe(15);
    await got.exec(readFileSync(join(ROOT, "migrations", "0098_payments_refunds_disputes.sql"), "utf8"));
    expect(await columns(got)).toEqual(await columns(want));
    expect((await columns(got)).length).toBe(18);
    expect(await constraints(got)).toEqual([{ contype: "p" }]);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op and keeps rows", async () => {
    const pg = await pushed();
    await pg.exec(`DROP TABLE financial_ledger_records;`);
    await pg.exec(FILE);
    await pg.query(`INSERT INTO financial_ledger_records (kind, status, currency) VALUES ('deposit', 'released', 'usd')`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT kind, retention_category FROM financial_ledger_records`)).toEqual([{ kind: "deposit", retention_category: "financial_record" }]);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, right after 0086", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0087_financial_ledger_records \\")).toHaveLength(1);
    expect(list.indexOf("0087_financial_ledger_records \\")).toBe(list.indexOf("0086_inbox_messages_body_sha256 \\") + 1);
  });
});
