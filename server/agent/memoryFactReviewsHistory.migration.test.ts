/**
 * memoryFactReviewsHistory.migration.test.ts — 0117 widens memory_fact_reviews' action check with 'restore' and
 * 'dispute': applied to a database with the old check, it leaves exactly what a shared/schema.ts push creates; it
 * re-runs as a no-op with rows present (no row changes); the new check still refuses an unknown action; it has no
 * transaction control; and it is on db-migrate.sh's list exactly once, after 0115. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { FACT_HISTORY_ACTIONS } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0117_memory_fact_reviews_history_actions.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'memory_fact_reviews' order by 1`),
  constraints: await q(pg, `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'memory_fact_reviews' order by 1`),
});
/** Back to the state before 0117: the 0106 check. */
const UNDO = `ALTER TABLE memory_fact_reviews DROP CONSTRAINT memory_fact_reviews_action_check; ALTER TABLE memory_fact_reviews ADD CONSTRAINT memory_fact_reviews_action_check CHECK (action IN ('confirm','correct','remove'));`;

describe("0117: memory_fact_reviews records restore and dispute", () => {
  it("on a database with the old check, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; every history action is allowed; an unknown one is refused", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const f = (await q(pg, `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5) RETURNING id`, [a]))[0].id;
    await q(pg, `INSERT INTO memory_fact_reviews (athlete_id, fact_id, action) VALUES ($1,$2,'confirm')`, [a, f]);
    await expect(pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action) VALUES ($1,$2,'restore')`, [a, f])).rejects.toThrow(/memory_fact_reviews_action_check/);
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT action FROM memory_fact_reviews`)).toEqual([{ action: "confirm" }]);
    for (const action of FACT_HISTORY_ACTIONS) {
      await pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action, correction) VALUES ($1,$2,$3,$4)`, [a, f, action, action === "correct" ? "words" : null]);
      expect(FILE).toContain(`'${action}'`);
    }
    await expect(pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action) VALUES ($1,$2,'delete')`, [a, f])).rejects.toThrow(/memory_fact_reviews_action_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0115", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0117_memory_fact_reviews_history_actions \\")).toHaveLength(1);
    expect(lines.indexOf("0117_memory_fact_reviews_history_actions \\")).toBeGreaterThan(lines.indexOf("0115_memory_facts_topic_source_type \\"));
  });
});
