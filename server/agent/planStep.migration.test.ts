/**
 * planStep.migration.test.ts — 0118 (the plan step) adds memory_decisions.kind / detail / parent_decision_id and
 * memory_goals.horizon / game_plan_by: applied to a database without them, it leaves exactly what a shared/schema.ts
 * push creates; it re-runs as a no-op with rows present (existing rows read kind 'other', detail {}, game_plan_by
 * 'mila', horizon NULL — nothing is backfilled); its checks hold; deleting a parent decision keeps the child; it has no
 * transaction control; and it is on db-migrate.sh's list exactly once, after 0117. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { DECISION_KINDS, GAME_PLAN_AUTHORS, GOAL_HORIZONS } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0118_plan_step.sql"), "utf8");
const TABLES = ["memory_decisions", "memory_goals"];
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
/** Back to the state before 0118. */
const UNDO = `
  DROP INDEX idx_memory_decisions_parent;
  ALTER TABLE memory_decisions DROP CONSTRAINT memory_decisions_parent_decision_id_memory_decisions_id_fk;
  ALTER TABLE memory_decisions DROP CONSTRAINT memory_decisions_kind_check;
  ALTER TABLE memory_decisions DROP COLUMN parent_decision_id; ALTER TABLE memory_decisions DROP COLUMN detail; ALTER TABLE memory_decisions DROP COLUMN kind;
  ALTER TABLE memory_goals DROP CONSTRAINT memory_goals_horizon_check; ALTER TABLE memory_goals DROP CONSTRAINT memory_goals_game_plan_by_check;
  ALTER TABLE memory_goals DROP COLUMN game_plan_by; ALTER TABLE memory_goals DROP COLUMN horizon;`;

describe("0118: the plan step's columns", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows keep their defaults; the checks hold", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const oldDecision = (await q(pg, `INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why) VALUES ($1,'onboarding','x','y') RETURNING id`, [a]))[0].id;
    const oldGoal = (await q(pg, `INSERT INTO memory_goals (athlete_id, text, source) VALUES ($1,'Grow','said') RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT kind, detail, parent_decision_id FROM memory_decisions WHERE id = $1`, [oldDecision])).toEqual([{ kind: "other", detail: {}, parent_decision_id: null }]);
    expect(await q(pg, `SELECT horizon, game_plan_by FROM memory_goals WHERE id = $1`, [oldGoal])).toEqual([{ horizon: null, game_plan_by: "mila" }]);

    for (const k of DECISION_KINDS) await pg.query(`INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, kind) VALUES ($1,'plan','x','y',$2)`, [a, k]);
    await expect(pg.query(`INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, kind) VALUES ($1,'plan','x','y','task')`, [a])).rejects.toThrow(/memory_decisions_kind_check/);
    for (const h of GOAL_HORIZONS) await pg.query(`INSERT INTO memory_goals (athlete_id, text, source, horizon) VALUES ($1,'g','said',$2)`, [a, h]);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source, horizon) VALUES ($1,'g','said','someday')`, [a])).rejects.toThrow(/memory_goals_horizon_check/);
    for (const by of GAME_PLAN_AUTHORS) await pg.query(`INSERT INTO memory_goals (athlete_id, text, source, game_plan_by) VALUES ($1,'g','said',$2)`, [a, by]);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source, game_plan_by) VALUES ($1,'g','said','coach')`, [a])).rejects.toThrow(/memory_goals_game_plan_by_check/);

    // An action held for a recommended goal points at its decision; removing that decision keeps the action, unlinked.
    const parent = (await q(pg, `INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, kind) VALUES ($1,'plan','Recommended','why','goal') RETURNING id`, [a]))[0].id;
    const child = (await q(pg, `INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, kind, parent_decision_id, detail) VALUES ($1,'plan','Pitch','why','action',$2,'{"kind":"pitch"}') RETURNING id`, [a, parent]))[0].id;
    await pg.query(`DELETE FROM memory_decisions WHERE id = $1`, [parent]);
    expect(await q(pg, `SELECT parent_decision_id, detail FROM memory_decisions WHERE id = $1`, [child])).toEqual([{ parent_decision_id: null, detail: { kind: "pitch" } }]);

    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    for (const k of DECISION_KINDS) expect(FILE).toContain(`'${k}'`);
    for (const h of GOAL_HORIZONS) expect(FILE).toContain(`'${h}'`);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0117", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0118_plan_step \\")).toHaveLength(1);
    expect(lines.indexOf("0118_plan_step \\")).toBeGreaterThan(lines.indexOf("0117_memory_fact_reviews_history_actions \\"));
  });
});
