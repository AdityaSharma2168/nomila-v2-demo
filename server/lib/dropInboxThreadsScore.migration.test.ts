/**
 * dropInboxThreadsScore.migration.test.ts — 0088 drops the retired deal score (inbox_threads.score):
 * applied to a database that still has the column it leaves exactly what a shared/schema.ts push creates,
 * it re-runs as a no-op, it touches nothing else (rows and the athlete marketability score survive), and
 * it is on db-migrate.sh's list once, after 0086.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0088_drop_inbox_threads_score.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite, table: string) => q(pg,
  `select column_name, data_type, is_nullable from information_schema.columns where table_name='${table}' order by column_name`);

describe("0088: the file is the schema", () => {
  it("on a database that still has inbox_threads.score, leaves exactly the columns a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`ALTER TABLE inbox_threads ADD COLUMN score jsonb;`); // the pre-0088 shape
    expect((await columns(got, "inbox_threads")).some((c: any) => c.column_name === "score")).toBe(true);
    await got.exec(FILE);
    expect(await columns(got, "inbox_threads")).toEqual(await columns(want, "inbox_threads"));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; keeps the rows; never touches the athlete marketability score; no transaction control", async () => {
    const pg = await pushed();
    await pg.exec(`ALTER TABLE inbox_threads ADD COLUMN score jsonb;`);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO inbox_threads (athlete_id, subject, score) VALUES ($1, 'kept', '{"scoreNumeric": 7}')`, [a]);
    const snapshotCols = await columns(pg, "athlete_snapshots");
    const currentCols = await columns(pg, "athletes_current");

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT subject FROM inbox_threads`)).toEqual([{ subject: "kept" }]);
    expect(await columns(pg, "athlete_snapshots")).toEqual(snapshotCols);
    expect(await columns(pg, "athletes_current")).toEqual(currentCols);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE inbox_threads DROP COLUMN IF EXISTS score;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0086", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0088_drop_inbox_threads_score \\")).toHaveLength(1);
    expect(list.indexOf("0088_drop_inbox_threads_score \\")).toBeGreaterThan(list.indexOf("0086_inbox_messages_body_sha256 \\"));
  });
});
