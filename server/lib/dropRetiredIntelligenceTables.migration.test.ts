/**
 * dropRetiredIntelligenceTables.migration.test.ts — 0140 drops the old intelligence layer's five tables
 * (recommendation_events, recommendations, brain_runs, intelligence_requests, outreach_plans): applied after the files
 * that create them it leaves exactly what a shared/schema.ts push creates for every KEPT objective table, it re-runs as
 * a no-op, it carries no transaction control, and it is on db-migrate.sh's list once, after 0139.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0140_drop_retired_intelligence_tables";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const CREATES = ["0071_outreach_plans", "0076_brain_substrate", "0077_intelligence_requests"]
  .map((n) => readFileSync(join(ROOT, "migrations", `${n}.sql`), "utf8"));
const DROPPED = ["recommendation_events", "recommendations", "brain_runs", "intelligence_requests", "outreach_plans"];
const KEPT = ["objectives", "objective_events", "objective_proposal_sets"];

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const hasTable = async (pg: PGlite, t: string) => (await q(pg, `select to_regclass('${t}') as r`))[0].r !== null;
const columns = (pg: PGlite, table: string) => q(pg,
  `select column_name, data_type, is_nullable from information_schema.columns where table_name='${table}' order by column_name`);

describe("0140: the file is the schema", () => {
  it("the schema no longer declares the five tables", async () => {
    const want = await pushed();
    for (const t of DROPPED) expect(await hasTable(want, t)).toBe(false);
    for (const t of KEPT) expect(await hasTable(want, t)).toBe(true);
    await want.close();
  }, 60_000);

  it("after the CREATE files it drops all five, keeps the objective tables as pushed, and re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    for (const c of CREATES) await got.exec(c);
    for (const t of DROPPED) expect(await hasTable(got, t)).toBe(true);
    await got.exec(FILE);
    await got.exec(FILE);
    for (const t of DROPPED) expect(await hasTable(got, t)).toBe(false);
    for (const t of KEPT) expect(await columns(got, t)).toEqual(await columns(want, t));
    await want.close(); await got.close();
  }, 60_000);

  it("carries no transaction control and no CASCADE", () => {
    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    expect(code).not.toMatch(/\bCASCADE\b/i);
  });

  it("is listed in db-migrate.sh step 3, once, after 0139", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === `${NAME} \\`)).toHaveLength(1);
    expect(list.indexOf(`${NAME} \\`)).toBe(list.indexOf("0139_athlete_signup_flags \\") + 1);
  });
});
