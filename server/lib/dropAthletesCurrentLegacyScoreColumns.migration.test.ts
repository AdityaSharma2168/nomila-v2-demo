/**
 * dropAthletesCurrentLegacyScoreColumns.migration.test.ts — 0126 (legacy retirement P3-1) drops the legacy score,
 * rate-card, follower-copy, research-count and bookkeeping columns from athletes_current: applied to a database that
 * still has them it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it keeps the rows (and
 * the kept columns' values) and the athlete_snapshots rows the dropped FK pointed at, it carries no transaction
 * control, and it is on db-migrate.sh's list once, after 0125.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0126_drop_athletes_current_legacy_score_columns";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

const DROPPED = [
  "display_score", "tier", "internal_score", "capitals", "pav", "deal_type_rates", "rate_card",
  "ig_followers", "tk_followers", "x_followers", "yt_subscribers", "spotify_listeners",
  "achievements_count", "press_count", "brand_mentions_count", "latest_snapshot_id", "score_updated_at", "social_updated_at",
];

/** The columns as they were before 0126 (types as shared/schema.ts declared them). */
const PRE_0126 = `
  ALTER TABLE athletes_current ADD COLUMN latest_snapshot_id uuid REFERENCES athlete_snapshots(id);
  ALTER TABLE athletes_current ADD COLUMN display_score integer;
  ALTER TABLE athletes_current ADD COLUMN tier text;
  ALTER TABLE athletes_current ADD COLUMN internal_score numeric;
  ALTER TABLE athletes_current ADD COLUMN capitals jsonb;
  ALTER TABLE athletes_current ADD COLUMN pav jsonb;
  ALTER TABLE athletes_current ADD COLUMN deal_type_rates jsonb;
  ALTER TABLE athletes_current ADD COLUMN rate_card jsonb;
  ALTER TABLE athletes_current ADD COLUMN ig_followers integer;
  ALTER TABLE athletes_current ADD COLUMN tk_followers integer;
  ALTER TABLE athletes_current ADD COLUMN x_followers integer;
  ALTER TABLE athletes_current ADD COLUMN yt_subscribers integer;
  ALTER TABLE athletes_current ADD COLUMN spotify_listeners integer;
  ALTER TABLE athletes_current ADD COLUMN achievements_count integer;
  ALTER TABLE athletes_current ADD COLUMN press_count integer;
  ALTER TABLE athletes_current ADD COLUMN brand_mentions_count integer;
  ALTER TABLE athletes_current ADD COLUMN score_updated_at timestamptz;
  ALTER TABLE athletes_current ADD COLUMN social_updated_at timestamptz;
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
const constraints = (pg: PGlite) => q(pg,
  `select conname from pg_constraint where conrelid = 'athletes_current'::regclass order by conname`);

describe("0126: the file is the schema", () => {
  it("on a database that still has every legacy column, leaves exactly the columns and constraints a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(PRE_0126);
    expect((await columns(got, "athletes_current")).filter((c: any) => DROPPED.includes(c.column_name))).toHaveLength(DROPPED.length);
    await got.exec(FILE);
    expect(await columns(got, "athletes_current")).toEqual(await columns(want, "athletes_current"));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect((await columns(want, "athletes_current")).map((c: any) => c.column_name)).toEqual(["athlete_id", "research_updated_at", "story_arc", "updated_at"]);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; keeps the rows, the kept values and the snapshots; no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(PRE_0126);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const snap = (await q(pg, `INSERT INTO athlete_snapshots (athlete_id, trigger) VALUES ($1, 'manual') RETURNING id`, [a]))[0].id;
    await q(pg, `INSERT INTO athletes_current (athlete_id, story_arc, latest_snapshot_id, display_score, tier, rate_card, ig_followers)
                 VALUES ($1, 'kept', $2, 691, 'Established', '{"pav":{"mid":1}}', 12000)`, [a, snap]);

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT athlete_id, story_arc FROM athletes_current`)).toEqual([{ athlete_id: a, story_arc: "kept" }]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM athlete_snapshots WHERE id = $1`, [snap])).toEqual([{ n: 1 }]);

    for (const l of FILE.split(/\r?\n/).filter((l) => !l.trim().startsWith("--") && l.trim())) {
      expect(l.trim()).toMatch(/^ALTER TABLE athletes_current DROP COLUMN IF EXISTS [a-z_]+;$/);
    }
    expect(FILE).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
    await pg.close();
  }, 60_000);

  it("drops exactly the listed columns, one statement each", () => {
    const dropped = [...FILE.matchAll(/DROP COLUMN IF EXISTS ([a-z_]+);/g)].map((m) => m[1]);
    expect([...dropped].sort()).toEqual([...DROPPED].sort());
  });

  it("is on db-migrate.sh's list exactly once, after 0125", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0125_content_playbooks \\"));
  });
});
