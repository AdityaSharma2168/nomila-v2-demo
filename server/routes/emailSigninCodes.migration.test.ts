/**
 * emailSigninCodes.migration.test.ts — 0129 (sign in with a 6-digit email code): on a database without the table it
 * leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no transaction
 * control, and it is on db-migrate.sh once, after 0125.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0129_email_signin_codes.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name = 'email_signin_codes' order by 1`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'email_signin_codes' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'email_signin_codes' order by 1`),
});

describe("0129: the file is the schema", () => {
  it("on a database without the table, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE email_signin_codes;");
    await got.exec(FILE);
    await got.exec(FILE);
    const w = await shape(want);
    expect(w.columns.length).toBe(10);
    expect(await shape(got)).toEqual(w);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control (its one ALTER only adds columns, IF NOT EXISTS)", () => {
    const body = FILE.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
    const alters = body.match(/ALTER\s+TABLE[^;]*;/gi) ?? [];
    expect(alters.map((a) => a.replace(/\s+/g, " "))).toEqual([
      "ALTER TABLE email_signin_codes ADD COLUMN IF NOT EXISTS locked_at timestamptz, ADD COLUMN IF NOT EXISTS locked_ip_hmac text;",
    ]);
  });

  it("a table left by an earlier draft (no lockout columns) gets them, and ends up exactly as the schema", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE email_signin_codes DROP COLUMN locked_at, DROP COLUMN locked_ip_hmac;");
    await got.exec("INSERT INTO email_signin_codes (email_hmac, code_hmac, ip_hmac, expires_at) VALUES ('e', 'c', 'i', now());");
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    expect(await q(got, "select locked_at, locked_ip_hmac from email_signin_codes")).toEqual([{ locked_at: null, locked_ip_hmac: null }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is on db-migrate.sh exactly once, after 0125", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0129_email_signin_codes/g)).toHaveLength(1);
    expect(sh.indexOf("0129_email_signin_codes")).toBeGreaterThan(sh.indexOf("0125_content_playbooks"));
  });
});
