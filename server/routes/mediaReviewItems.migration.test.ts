/**
 * mediaReviewItems.migration.test.ts — 0131 (camera-roll intake, CAMERA_ROLL_INTAKE): on a database without the table it
 * leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive with no transaction
 * control, it refuses a kind that is not photo or video, deleting an athlete takes her rows with her, and it is on
 * db-migrate.sh exactly once, after 0129 (0130 belongs to an open PR).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0131_media_review_items.sql"), "utf8");
const TABLE = "media_review_items";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name = '${TABLE}' order by 1`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = '${TABLE}' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = '${TABLE}' order by 1`),
});

describe("0131: the file is the schema", () => {
  it("on a database without the table, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`DROP TABLE ${TABLE};`);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));

    const [{ id: athleteId }] = await q(got, "INSERT INTO athletes (full_name, sport) VALUES ($1, $2) RETURNING id", ["Test Athlete", "Test sport"]);
    await got.query(`INSERT INTO ${TABLE} (athlete_id, session_id, item_id, kind) VALUES ($1, 's1', 'i1', 'photo')`, [athleteId]);
    await expect(got.query(`INSERT INTO ${TABLE} (athlete_id, session_id, item_id, kind) VALUES ($1, 's1', 'i2', 'gif')`, [athleteId])).rejects.toThrow();
    await expect(got.query(`INSERT INTO ${TABLE} (athlete_id, session_id, item_id, kind) VALUES ($1, 's1', 'i1', 'video')`, [athleteId])).rejects.toThrow();
    await got.query("DELETE FROM athletes WHERE id = $1", [athleteId]);
    expect(await q(got, `select count(*)::int as n from ${TABLE}`)).toEqual([{ n: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/DROP CONSTRAINT IF EXISTS/g, "").replace(/ON (DELETE|UPDATE) (cascade|no action)/gi, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|TRUNCATE)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0129", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0131_media_review_items/g)).toHaveLength(1);
    expect(sh.indexOf("0131_media_review_items")).toBeGreaterThan(sh.indexOf("0129_email_signin_codes"));
  });
});
