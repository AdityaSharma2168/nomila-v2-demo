/**
 * pushNotifications.migration.test.ts — 0130 creates push_devices, push_preferences and push_sends: on a database
 * without them it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op with rows present; it has
 * no transaction control; it is on db-migrate.sh's list exactly once, after 0125. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0130_push_notifications.sql"), "utf8");
/** 0135 adds push_preferences.mila_suggestion after 0130: the schema's shape is 0130 then 0135. */
const ADD_0135 = readFileSync(join(ROOT, "migrations", "0135_push_mila_suggestion.sql"), "utf8");
const TABLES = ["push_devices", "push_preferences", "push_sends"];

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
      constraints: (await q(pg, `select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = $1 order by 2`, [t])),
      indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = $1 order by 1`, [t]),
    };
  }
  return out;
};
const UNDO = `DROP TABLE push_sends; DROP TABLE push_preferences; DROP TABLE push_devices;`;

describe("0130: push_devices, push_preferences, push_sends", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    await got.exec(ADD_0135);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; a token is unique; deleting the athlete takes the rows", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    await q(pg, `INSERT INTO push_devices (athlete_id, token, platform) VALUES ($1, 'ExponentPushToken[abcdefgh12]', 'ios')`, [a]);
    await q(pg, `INSERT INTO push_preferences (athlete_id) VALUES ($1)`, [a]);
    await q(pg, `INSERT INTO push_sends (athlete_id, kind, dedupe_key) VALUES ($1, 'plan_ready', 'plan_ready:r1')`, [a]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT enabled, plan_ready, brand_reply, waiting, quiet_hours, quiet_start, quiet_end FROM push_preferences`)).toEqual([
      { enabled: true, plan_ready: true, brand_reply: true, waiting: true, quiet_hours: true, quiet_start: 1320, quiet_end: 480 },
    ]);
    await expect(pg.query(`INSERT INTO push_devices (athlete_id, token, platform) VALUES ($1, 'ExponentPushToken[abcdefgh12]', 'ios')`, [a])).rejects.toThrow();
    await expect(pg.query(`INSERT INTO push_sends (athlete_id, kind, dedupe_key) VALUES ($1, 'plan_ready', 'plan_ready:r1')`, [a])).rejects.toThrow();
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    for (const t of TABLES) expect(await q(pg, `SELECT count(*)::int AS n FROM ${t}`)).toEqual([{ n: 0 }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("over an earlier draft of the tables (without the review's columns), leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`ALTER TABLE push_preferences DROP COLUMN show_brand_names;
      ALTER TABLE push_sends DROP COLUMN attempts; ALTER TABLE push_sends DROP COLUMN tickets; ALTER TABLE push_sends DROP COLUMN receipts_checked_at;`);
    await got.exec(FILE);
    await got.exec(ADD_0135);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("0135: over 0130's table it adds mila_suggestion (default on) to existing rows, and re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    const a = (await q(got, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    await q(got, `INSERT INTO push_preferences (athlete_id, waiting) VALUES ($1, false)`, [a]);
    await got.exec(ADD_0135);
    await got.exec(ADD_0135);
    expect(await q(got, `SELECT waiting, mila_suggestion FROM push_preferences`)).toEqual([{ waiting: false, mila_suggestion: true }]);
    await q(got, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await shape(got)).toEqual(await shape(want));
    expect(ADD_0135.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0135_push_mila_suggestion \\")).toHaveLength(1);
    expect(lines.indexOf("0135_push_mila_suggestion \\")).toBeGreaterThan(lines.indexOf("0130_push_notifications \\"));
    await want.close(); await got.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0125", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0130_push_notifications \\")).toHaveLength(1);
    expect(lines.indexOf("0130_push_notifications \\")).toBeGreaterThan(lines.indexOf("0125_content_playbooks \\"));
  });
});
