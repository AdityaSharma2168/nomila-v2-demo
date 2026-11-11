/**
 * athleteOtherSports.migration.test.ts — 0122 (the athlete's other sports): on a database without the column it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, an existing athlete reads an empty list (their
 * `sport` untouched), and it is on db-migrate.sh once, after 0121.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0122_athlete_other_sports.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name = 'athletes' order by 1`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'athletes' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'athletes' order by 1`),
});

describe("0122: the file is the schema", () => {
  it("on a database without the column, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE athletes DROP COLUMN other_sports;");
    await got.query("INSERT INTO athletes (full_name, sport) VALUES ($1, $2)", ["Test Athlete", "Test sport"]);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    // An existing athlete: the main sport untouched, no other sports.
    expect(await q(got, "select sport, other_sports from athletes")).toEqual([{ sport: "Test sport", other_sports: [] }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0121", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0122_athlete_other_sports/g)).toHaveLength(1);
    expect(sh.indexOf("0122_athlete_other_sports")).toBeGreaterThan(sh.indexOf("0121_public_page_stats"));
  });
});
