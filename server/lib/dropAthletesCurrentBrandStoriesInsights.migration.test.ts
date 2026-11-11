/**
 * dropAthletesCurrentBrandStoriesInsights.migration.test.ts — 0091 drops the dead v1 columns
 * athletes_current.brand_stories and athletes_current.insights: applied to a database that still has them it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, it keeps the rows and never touches the
 * live `insights` columns on media_assets / content_posts, and it is on db-migrate.sh's list once, after 0088.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0091_drop_athletes_current_brand_stories_insights";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite, table: string) => q(pg,
  `select column_name, data_type, is_nullable from information_schema.columns where table_name='${table}' order by column_name`);
const PRE_0091 = `ALTER TABLE athletes_current ADD COLUMN brand_stories jsonb; ALTER TABLE athletes_current ADD COLUMN insights jsonb;`;

describe("0091: the file is the schema", () => {
  it("on a database that still has both columns, leaves exactly the columns a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(PRE_0091);
    expect((await columns(got, "athletes_current")).filter((c: any) => ["brand_stories", "insights"].includes(c.column_name))).toHaveLength(2);
    await got.exec(FILE);
    expect(await columns(got, "athletes_current")).toEqual(await columns(want, "athletes_current"));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; keeps the rows; never touches media_assets / content_posts insights; no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(PRE_0091);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO athletes_current (athlete_id, story_arc) VALUES ($1, 'kept')`, [a]);
    const media = await columns(pg, "media_assets");
    const posts = await columns(pg, "content_posts");

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT story_arc FROM athletes_current`)).toEqual([{ story_arc: "kept" }]);
    expect(await columns(pg, "media_assets")).toEqual(media);
    expect(await columns(pg, "content_posts")).toEqual(posts);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE athletes_current DROP COLUMN IF EXISTS brand_stories;\nALTER TABLE athletes_current DROP COLUMN IF EXISTS insights;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0088", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0088_drop_inbox_threads_score \\"));
  });
});
