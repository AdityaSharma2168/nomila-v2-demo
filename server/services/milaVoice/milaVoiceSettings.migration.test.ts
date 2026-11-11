/**
 * milaVoiceSettings.migration.test.ts — 0152 creates mila_voice_settings: on a database without it, it leaves exactly
 * what a shared/schema.ts push creates; it re-runs as a no-op with rows present; deleting the athlete takes the row; it
 * has no transaction control; it is on db-migrate.sh's list exactly once, after 0150. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0152_mila_voice_settings.sql"), "utf8");
const TABLE = "mila_voice_settings";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = $1 order by 1`, [TABLE]),
  constraints: await q(pg, `select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = $1 order by 2`, [TABLE]),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = $1 order by 1`, [TABLE]),
});

describe("0152: mila_voice_settings", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE ${TABLE};`);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; the defaults; deleting the athlete takes the row", async () => {
    const pg = await pushed();
    await pg.exec(`DROP TABLE ${TABLE};`);
    await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    await q(pg, `INSERT INTO ${TABLE} (athlete_id) VALUES ($1)`, [a]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT voice, conversation_language, post_languages FROM ${TABLE}`)).toEqual([{ voice: null, conversation_language: "auto", post_languages: [] }]);
    await expect(pg.query(`INSERT INTO ${TABLE} (athlete_id) VALUES ($1)`, [a])).rejects.toThrow();
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM ${TABLE}`)).toEqual([{ n: 0 }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's step-3 list exactly once, after 0150", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/^\s*0152_mila_voice_settings \\$/gm)).toHaveLength(1);
    expect(sh.indexOf("0152_mila_voice_settings")).toBeGreaterThan(sh.indexOf("0150_platform_spend_indexes"));
  });
});
