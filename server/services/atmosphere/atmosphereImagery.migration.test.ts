/**
 * atmosphereImagery.migration.test.ts — 0116 adds atmosphere_images, atmosphere_placements and atmosphere_spend_days:
 * applied to a database without them it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op with
 * rows present; its checks and unique indexes hold; it has no transaction control; and it is on db-migrate.sh's list
 * exactly once, after 0115. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0116_atmosphere_imagery.sql"), "utf8");
const TABLES = ["atmosphere_images", "atmosphere_placements", "atmosphere_spend_days"];

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
const UNDO = `DROP TABLE atmosphere_placements; DROP TABLE atmosphere_spend_days; DROP TABLE atmosphere_images;`;
const IMG = `INSERT INTO atmosphere_images (athlete_id, source, source_id, status, gcs_path, credit, licence, query, slot_type, purpose, purpose_key, check_result, reject_reason)`;

describe("0116: atmosphere imagery tables", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; the checks and unique indexes hold", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const img = (await q(pg, `${IMG} VALUES ($1,'pixabay','1','accepted','athletes/x/atmosphere/1.jpg','c','pixabay-content-license','q','goal','p','horizontal:p','{}',NULL) RETURNING id`, [a]))[0].id;
    await q(pg, `INSERT INTO atmosphere_placements (athlete_id, screen, slot_key, image_id) VALUES ($1,'home','header',$2)`, [a, img]);
    await q(pg, `INSERT INTO atmosphere_spend_days (athlete_id, day, micro_usd) VALUES ($1,'2026-10-10',5)`, [a]);
    await pg.exec(FILE); await pg.exec(FILE);
    expect((await q(pg, `SELECT count(*)::int AS n FROM atmosphere_placements`))[0].n).toBe(1);

    // A rejected row keeps no copy and needs a reason; an accepted row needs a copy and no reason.
    await q(pg, `${IMG} VALUES ($1,'pixabay','2','rejected',NULL,'c','l','q','goal','p','horizontal:p','{}','person')`, [a]);
    await expect(pg.query(`${IMG} VALUES ($1,'pixabay','3','rejected','x.jpg','c','l','q','goal','p','horizontal:p','{}','person')`, [a])).rejects.toThrow(/atmosphere_images_stored_check/);
    await expect(pg.query(`${IMG} VALUES ($1,'pixabay','4','accepted',NULL,'c','l','q','goal','p','horizontal:p','{}',NULL)`, [a])).rejects.toThrow(/atmosphere_images_stored_check/);
    await expect(pg.query(`${IMG} VALUES ($1,'unsplash','5','rejected',NULL,'c','l','q','goal','p','horizontal:p','{}','x')`, [a])).rejects.toThrow(/atmosphere_images_source_check/);
    // One row per Pixabay image per athlete; generated rows (no source id) are not limited.
    await expect(pg.query(`${IMG} VALUES ($1,'pixabay','1','rejected',NULL,'c','l','q','goal','p','horizontal:p','{}','x')`, [a])).rejects.toThrow(/atmosphere_images_athlete_source_uq/);
    await q(pg, `${IMG} VALUES ($1,'generated',NULL,'rejected',NULL,'c','l','q','goal','p','horizontal:p','{}','text')`, [a]);
    await q(pg, `${IMG} VALUES ($1,'generated',NULL,'rejected',NULL,'c','l','q','goal','p','horizontal:p','{}','text')`, [a]);
    // An image at most once per screen.
    await expect(pg.query(`INSERT INTO atmosphere_placements (athlete_id, screen, slot_key, image_id) VALUES ($1,'home','other',$2)`, [a, img])).rejects.toThrow(/atmosphere_placements_screen_image_uq/);
    // Deleting the athlete takes everything with it.
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    for (const t of TABLES) expect((await q(pg, `SELECT count(*)::int AS n FROM ${t}`))[0].n).toBe(0);

    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0115", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0116_atmosphere_imagery \\")).toHaveLength(1);
    expect(lines.indexOf("0116_atmosphere_imagery \\")).toBeGreaterThan(lines.indexOf("0115_memory_facts_topic_source_type \\"));
  });
});
