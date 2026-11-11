/**
 * oauthConnectStates.migration.test.ts — 0138 (OAuth connect states): on a database without the table it leaves exactly
 * what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no transaction control, and it
 * is on db-migrate.sh once, after 0137.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0138_oauth_connect_states.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name = 'oauth_connect_states' order by 1`),
  constraints: await q(pg, `select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'oauth_connect_states' order by 1, 2`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'oauth_connect_states' order by 1`),
});

describe("0138: the file is the schema", () => {
  it("on a database without the table, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE oauth_connect_states;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ON DELETE CASCADE/g, "");   // the FK's delete rule, not a DELETE
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|ALTER)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0137", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0138_oauth_connect_states/g)).toHaveLength(1);
    expect(sh.indexOf("0138_oauth_connect_states")).toBeGreaterThan(sh.indexOf("0137_offers_time_zone"));
  });
});
