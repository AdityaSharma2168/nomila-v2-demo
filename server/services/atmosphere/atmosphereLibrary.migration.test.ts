/**
 * atmosphereLibrary.migration.test.ts — 0120 adds atmosphere_library (shared) and atmosphere_library_placements, with
 * a source check that allows Unsplash or Pexels photos (owner decision 10 Oct 2026): applied to a database without
 * them it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op with rows present; its checks
 * and unique indexes hold, including Pexels rows now inserting and an unknown source still rejected; deleting an
 * athlete takes her placements and leaves the shared library; it has no transaction control; and it is on
 * db-migrate.sh's list exactly once, after 0119. PGlite only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0120_atmosphere_library.sql"), "utf8");
const TABLES = ["atmosphere_library", "atmosphere_library_placements"];

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    out[t] = {
      columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = $1 order by 1`, [t]),
      constraints: await q(pg, `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = $1 order by 1`, [t]),
      indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = $1 order by 1`, [t]),
    };
  }
  return out;
};
const UNDO = `DROP TABLE atmosphere_library_placements; DROP TABLE atmosphere_library;`;
const LIB = `INSERT INTO atmosphere_library (source, source_id, source_url, licence, category, sport, purposes, gcs_path, content_type, width, height, bytes, check_result)`;
const row = (id: string, category: string, sport: string | null) =>
  [id, `https://unsplash.com/photos/${id}`, "Unsplash License", category, sport, ["performance"], `atmosphere/shared/x/${id}.webp`, "image/webp", 1600, 1067, 200_000, "{}"];
const VALUES = `VALUES ('unsplash',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;

describe("0120: shared atmosphere library", () => {
  it("on a database without the tables, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; the checks and unique indexes hold; an athlete's deletion leaves the library", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const lib = (await q(pg, `${LIB} ${VALUES} RETURNING id, curated, active, tags`, row("AAAAAAAAAAA", "sport", "sport_x")))[0];
    expect(lib).toMatchObject({ curated: false, active: true, tags: [] });
    const gen = (await q(pg, `${LIB} ${VALUES} RETURNING id`, row("BBBBBBBBBBB", "general", null)))[0].id;
    await q(pg, `INSERT INTO atmosphere_library_placements (athlete_id, screen, slot_key, library_id) VALUES ($1,'home','header',$2)`, [a, lib.id]);
    await pg.exec(FILE); await pg.exec(FILE);
    expect((await q(pg, `SELECT count(*)::int AS n FROM atmosphere_library_placements`))[0].n).toBe(1);

    // A sport photo needs its sport; a general or sign-in photo has none; only known sources and categories.
    await expect(pg.query(`${LIB} ${VALUES}`, row("CCCCCCCCCCC", "sport", null))).rejects.toThrow(/atmosphere_library_sport_check/);
    await expect(pg.query(`${LIB} ${VALUES}`, row("DDDDDDDDDDD", "signin", "sport_x"))).rejects.toThrow(/atmosphere_library_sport_check/);
    await expect(pg.query(`${LIB} ${VALUES}`, row("EEEEEEEEEEE", "hero", null))).rejects.toThrow(/atmosphere_library_category_check/);
    await expect(pg.query(`INSERT INTO atmosphere_library (source, source_id, source_url, licence, category, gcs_path, content_type, width, height, bytes, check_result) VALUES ('pixabay','1','u','l','general','p','image/webp',1,1,1,'{}')`)).rejects.toThrow(/atmosphere_library_source_check/);
    // Pexels is an allowed source alongside Unsplash (owner decision 10 Oct 2026).
    const pexels = (await q(pg, `INSERT INTO atmosphere_library (source, source_id, source_url, licence, category, gcs_path, content_type, width, height, bytes, check_result) VALUES ('pexels','1','https://www.pexels.com/photo/x-1/','Pexels License','general','atmosphere/shared/general/1.webp','image/webp',1,1,1,'{}') RETURNING id`))[0].id;
    // One row per photo.
    await expect(pg.query(`${LIB} ${VALUES}`, row("AAAAAAAAAAA", "general", null))).rejects.toThrow(/atmosphere_library_source_uq/);
    // A photo at most once per screen.
    await expect(pg.query(`INSERT INTO atmosphere_library_placements (athlete_id, screen, slot_key, library_id) VALUES ($1,'home','other',$2)`, [a, lib.id])).rejects.toThrow(/atmosphere_library_placements_screen_image_uq/);
    await q(pg, `INSERT INTO atmosphere_library_placements (athlete_id, screen, slot_key, library_id) VALUES ($1,'home','other',$2)`, [a, gen]);
    // Deleting the athlete takes her placements; the shared library stays.
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect((await q(pg, `SELECT count(*)::int AS n FROM atmosphere_library_placements`))[0].n).toBe(0);
    expect((await q(pg, `SELECT count(*)::int AS n FROM atmosphere_library`))[0].n).toBe(3);
    expect(pexels).toBeTruthy();

    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0119", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0120_atmosphere_library \\")).toHaveLength(1);
    expect(lines.indexOf("0120_atmosphere_library \\")).toBeGreaterThan(lines.indexOf("0119_memory_display_gaps \\"));
  });
});
