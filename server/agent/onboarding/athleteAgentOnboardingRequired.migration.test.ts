/**
 * athleteAgentOnboardingRequired.migration.test.ts — 0124 (fix/existing-users-skip-onboarding: who the agent
 * onboarding gate applies to): on a database without the column it leaves exactly what a shared/schema.ts push
 * creates, it re-runs as a no-op, every existing athlete defaults to false (never required), and it is on
 * db-migrate.sh once, after 0122 (0123 belongs to another open PR).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0124_athlete_agent_onboarding_required.sql"), "utf8");

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

describe("0124: the file is the schema", () => {
  it("on a database without the column, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE athletes DROP COLUMN agent_onboarding_required;");
    await got.query("INSERT INTO athletes (full_name, sport) VALUES ($1, $2)", ["Test Athlete", "Test sport"]);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    // An existing athlete (every row that predates this column): defaults to false — never gated into the new onboarding.
    expect(await q(got, "select agent_onboarding_required from athletes")).toEqual([{ agent_onboarding_required: false }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0122", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0124_athlete_agent_onboarding_required/g)).toHaveLength(1);
    expect(sh.indexOf("0124_athlete_agent_onboarding_required")).toBeGreaterThan(sh.indexOf("0122_athlete_other_sports"));
  });
});
