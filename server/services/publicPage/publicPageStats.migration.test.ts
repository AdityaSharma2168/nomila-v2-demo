/**
 * publicPageStats.migration.test.ts — 0121 adds the Front Door page's two count tables (public_page_view_days,
 * public_page_likes): applied to a database without them it leaves exactly what a shared/schema.ts push creates; it
 * re-runs as a no-op with rows present; its guards hold (one row per athlete and day, one like per visitor hash, no
 * negative count, rows go with the athlete); it has no transaction control; and it is on db-migrate.sh's list exactly
 * once, after 0119. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0121_public_page_stats.sql"), "utf8");
const TABLES = ["public_page_view_days", "public_page_likes"];
const list = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_name in (${list}) order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});
const rewind = (pg: PGlite) => pg.exec(`DROP TABLE public_page_likes; DROP TABLE public_page_view_days;`);

describe("0121: the public page's counts", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await rewind(got);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present, and the guards hold", async () => {
    const pg = await pushed();
    await rewind(pg);
    await pg.exec(FILE);
    const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Migration Rower') RETURNING id`);
    await q(pg, `INSERT INTO public_page_view_days (athlete_id, day, views) VALUES ($1, '2026-10-01', 3)`, [a.id]);
    await q(pg, `INSERT INTO public_page_likes (athlete_id, visitor_hash) VALUES ($1, 'h1')`, [a.id]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT views FROM public_page_view_days`)).toEqual([{ views: 3 }]);
    expect(await q(pg, `SELECT visitor_hash FROM public_page_likes`)).toEqual([{ visitor_hash: "h1" }]);

    const bad = async (sql: string, params: unknown[] = []) => { await expect(pg.query(sql, params)).rejects.toThrow(); };
    await bad(`INSERT INTO public_page_view_days (athlete_id, day) VALUES ($1, '2026-10-01')`, [a.id]);          // one row per day
    await bad(`INSERT INTO public_page_view_days (athlete_id, day, views) VALUES ($1, '2026-10-02', -1)`, [a.id]); // never negative
    await bad(`INSERT INTO public_page_likes (athlete_id, visitor_hash) VALUES ($1, 'h1')`, [a.id]);              // one like per visitor
    await bad(`INSERT INTO public_page_likes (athlete_id, visitor_hash) VALUES ('00000000-0000-0000-0000-000000000000', 'h2')`); // a real athlete
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a.id]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM public_page_view_days`)).toEqual([{ n: 0 }]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM public_page_likes`)).toEqual([{ n: 0 }]);

    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0119", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0121_public_page_stats \\")).toHaveLength(1);
    expect(lines.indexOf("0121_public_page_stats \\")).toBeGreaterThan(lines.indexOf("0119_memory_display_gaps \\"));
  });
});
