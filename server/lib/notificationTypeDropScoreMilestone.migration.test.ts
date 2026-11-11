/**
 * notificationTypeDropScoreMilestone.migration.test.ts — 0128 (legacy retirement P3-3) removes 'score_milestone' from
 * notification_log.notif_type_check: applied to a database with the old check it leaves exactly the check a
 * shared/schema.ts push creates, it re-runs as a no-op, it keeps every row and still accepts the four live types, it
 * refuses 'score_milestone', legacy/03_additive.sql re-asserts the SAME list (it re-creates the check on every deploy),
 * no transaction control, and it is on db-migrate.sh's list once, after 0127.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const NAME = "0128_notification_type_drop_score_milestone";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const OLD_CHECK = `ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notif_type_check;
  ALTER TABLE notification_log ADD CONSTRAINT notif_type_check CHECK (type IN ('score_milestone','new_deal','weekly_brief','brand_match','promotion'));`;

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const check = async (pg: PGlite) => (await q(pg,
  `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notif_type_check'`))[0]?.def ?? null;

describe("0128: the file is the schema", () => {
  it("on a database with the old check, leaves exactly the check a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(OLD_CHECK);
    expect(await check(got)).toMatch(/score_milestone/);
    await got.exec(FILE);
    expect(await check(got)).toBe(await check(want));
    expect(await check(got)).not.toMatch(/score_milestone/);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; keeps the rows; the four live types pass and score_milestone is refused", async () => {
    const pg = await pushed();
    await pg.exec(OLD_CHECK);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    await q(pg, `INSERT INTO notification_log (athlete_id, type) VALUES ($1, 'promotion')`, [a]);
    await pg.exec(FILE);
    await pg.exec(FILE);
    for (const t of ["new_deal", "weekly_brief", "brand_match", "promotion"]) {
      await q(pg, `INSERT INTO notification_log (athlete_id, type) VALUES ($1, $2)`, [a, t]);
    }
    await expect(q(pg, `INSERT INTO notification_log (athlete_id, type) VALUES ($1, 'score_milestone')`, [a])).rejects.toThrow(/notif_type_check/);
    expect(await q(pg, `SELECT count(*)::int AS n FROM notification_log`)).toEqual([{ n: 5 }]);
    expect(FILE).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 60_000);

  it("legacy/03_additive.sql re-asserts the same list (it runs before this file on every deploy)", () => {
    const legacy = readFileSync(join(ROOT, "migrations", "legacy", "03_additive.sql"), "utf8");
    const listOf = (s: string) => s.match(/ADD CONSTRAINT notif_type_check CHECK \(type IN \(([^)]*)\)\)/)?.[1];
    expect(listOf(legacy)).toBe(listOf(FILE));
    expect(legacy).not.toMatch(/score_milestone/);
  });

  it("is on db-migrate.sh's list exactly once, after 0127", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = NAME + " \\";
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0127_drop_snapshot_score_and_scoring_weights \\"));
  });
});
