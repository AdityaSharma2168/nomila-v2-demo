/**
 * dropSnapshotScoreAndScoringWeights.migration.test.ts — 0127 (legacy retirement P3-2) drops athlete_snapshots.score
 * and the scoring_weights table: applied to a database that still has both it leaves exactly what a shared/schema.ts
 * push creates, it re-runs as a no-op, it keeps every snapshot row and its other columns, it carries no transaction
 * control, and it is on db-migrate.sh's list once, after 0126 — while the two scoring_weights inserts that db-migrate
 * used to re-run (0040 / 0042) are gone from the list and the tree.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0127_drop_snapshot_score_and_scoring_weights";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

/** As it was before 0127 (scoring_weights as shared/schema.ts declared it). */
const PRE_0127 = `
  ALTER TABLE athlete_snapshots ADD COLUMN score jsonb;
  CREATE TABLE scoring_weights (id serial PRIMARY KEY, version text NOT NULL UNIQUE, status text DEFAULT 'active',
    config jsonb NOT NULL, created_at timestamptz DEFAULT now(),
    CONSTRAINT scoring_weights_status_check CHECK (status IN ('active','inactive','draft')));
  CREATE UNIQUE INDEX idx_scoring_weights_active ON scoring_weights (status) WHERE status = 'active';
  INSERT INTO scoring_weights (version, config) VALUES ('v7.2.0', '{}');
`;

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const columns = (pg: PGlite, table: string) => q(pg,
  `select column_name, data_type, is_nullable from information_schema.columns where table_name='${table}' order by column_name`);
const hasTable = async (pg: PGlite, t: string) => (await q(pg, `select to_regclass('${t}') as r`))[0].r !== null;

describe("0127: the file is the schema", () => {
  it("on a database that still has the column and the table, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    expect(await hasTable(want, "scoring_weights")).toBe(false);
    await got.exec(PRE_0127);
    expect(await hasTable(got, "scoring_weights")).toBe(true);
    await got.exec(FILE);
    expect(await columns(got, "athlete_snapshots")).toEqual(await columns(want, "athlete_snapshots"));
    expect(await hasTable(got, "scoring_weights")).toBe(false);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; keeps every snapshot row and its other columns; no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(PRE_0127);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    await q(pg, `INSERT INTO athlete_snapshots (athlete_id, trigger, research, score) VALUES ($1, 'manual', '{"story_arc":"kept"}', '{"displayScore":691}')`, [a]);

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT research->>'story_arc' AS arc FROM athlete_snapshots`)).toEqual([{ arc: "kept" }]);

    const code = FILE.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).map((l) => l.trimEnd()).join("\n").trim();
    expect(code).toBe("ALTER TABLE athlete_snapshots DROP COLUMN IF EXISTS score;\nDROP TABLE IF EXISTS scoring_weights;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0126 — and the scoring_weights inserts are gone", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0126_drop_athletes_current_legacy_score_columns \\"));
    for (const gone of ["0040_weights_v7_1_no_story_arc_bonus", "0042_weights_v7_2_no_major_schools"]) {
      expect(list).not.toContain(gone + " \\");
      expect(existsSync(join(ROOT, "migrations", `${gone}.sql`))).toBe(false);
    }
  });
});
