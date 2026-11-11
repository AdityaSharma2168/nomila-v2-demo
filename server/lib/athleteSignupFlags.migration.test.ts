/**
 * athleteSignupFlags.migration.test.ts — 0139 (athletes.signup_flags, the anti-fake plan's admin flags): on a database
 * without the column it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only
 * (one ADD COLUMN, no transaction control), and it is on db-migrate.sh once, after 0138.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0139_athlete_signup_flags.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const columns = async (pg: PGlite) => (await pg.query<any>(`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'athletes' order by 1`)).rows;

describe("0139: the file is the schema", () => {
  it("on a database without the column, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE athletes DROP COLUMN signup_flags;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await columns(got)).toEqual(await columns(want));
    expect((await columns(got)).find((c: any) => c.column_name === "signup_flags")).toEqual({ column_name: "signup_flags", data_type: "jsonb", is_nullable: "YES", column_default: null });
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only (one nullable ADD COLUMN) and carries no transaction control", () => {
    const body = FILE.replace(/\r/g, "").replace(/--[^\n]*/g, "").trim();
    expect(body).toBe("ALTER TABLE athletes ADD COLUMN IF NOT EXISTS signup_flags jsonb;");
  });

  it("is on db-migrate.sh exactly once, after 0138", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0139_athlete_signup_flags/g)).toHaveLength(1);
    expect(sh.indexOf("0139_athlete_signup_flags")).toBeGreaterThan(sh.indexOf("0138_oauth_connect_states"));
  });
});
