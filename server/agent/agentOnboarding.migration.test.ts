/**
 * agentOnboarding.migration.test.ts — 0106 (Research / Understand / onboarding): applied to a 0105 database it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, its checks hold (source still required, removed
 * is a status, a correction needs its words, checkpoints are the contract's), and it is on db-migrate.sh once, after 0105.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { ONBOARDING_CHECKPOINTS, FACT_STATUSES } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0106_agent_onboarding.sql"), "utf8");
// 0117 widens memory_fact_reviews' action check (restore, dispute): the chain 0106 → 0117 is what must equal a push.
const HISTORY_ACTIONS = readFileSync(join(ROOT, "migrations", "0117_memory_fact_reviews_history_actions.sql"), "utf8");
// 0118 (the plan step: memory_goals.horizon / game_plan_by) completes the memory_goals shape: the chain 0106 → 0118.
const PLAN_STEP = readFileSync(join(ROOT, "migrations", "0118_plan_step.sql"), "utf8");
// 0119 (memory_facts.date_precision / field / field_value, memory_goals.domain) completes both shapes.
const DISPLAY_GAPS = readFileSync(join(ROOT, "migrations", "0119_memory_display_gaps.sql"), "utf8");
const TABLES = ["agent_runs", "memory_facts", "memory_briefs", "memory_decisions", "memory_fact_reviews", "memory_goals", "agent_onboarding_checkpoints"];
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
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});

/** Undo 0106 on a pushed database, leaving the 0105 shape. */
const UNDO = `
  DROP INDEX idx_memory_decisions_goal; ALTER TABLE memory_decisions DROP COLUMN goal_id;
  DROP TABLE agent_onboarding_checkpoints; DROP TABLE memory_goals; DROP TABLE memory_fact_reviews;
  DROP INDEX idx_agent_runs_parent_ref;
  ALTER TABLE agent_runs DROP COLUMN output; ALTER TABLE agent_runs DROP COLUMN parent_ref;
  ALTER TABLE memory_facts DROP COLUMN disputes; ALTER TABLE memory_facts DROP COLUMN also_seen_at; ALTER TABLE memory_facts DROP COLUMN sensitive;
  ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_status_check;
  ALTER TABLE memory_facts ADD CONSTRAINT memory_facts_status_check CHECK (status IN ('active','superseded','disputed'));
  ALTER TABLE memory_briefs DROP COLUMN internal;
`;

describe("0106: the file is the schema", () => {
  it("on a 0105 database, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    await got.exec(HISTORY_ACTIONS);
    await got.exec(PLAN_STEP);
    await got.exec(DISPLAY_GAPS);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op; the checks hold", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    await pg.exec(FILE); await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    // A fact still needs a source (0105), and 'removed' is now a status.
    await expect(pg.query(`INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, confidence) VALUES ($1,'athlete','A','c','found',0.5)`, [a])).rejects.toThrow(/memory_facts_source_check/);
    const f = (await q(pg, `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence, status, sensitive) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,'removed',true) RETURNING id, also_seen_at`, [a]))[0];
    expect(f.also_seen_at).toEqual([]);
    // A correction needs the athlete's words; a confirm must not carry any.
    await expect(pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action) VALUES ($1,$2,'correct')`, [a, f.id])).rejects.toThrow(/memory_fact_reviews_correction_check/);
    await expect(pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action, correction) VALUES ($1,$2,'confirm','x')`, [a, f.id])).rejects.toThrow(/memory_fact_reviews_correction_check/);
    await pg.query(`INSERT INTO memory_fact_reviews (athlete_id, fact_id, action) VALUES ($1,$2,'remove')`, [a, f.id]);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source) VALUES ($1,'g','guessed')`, [a])).rejects.toThrow(/memory_goals_source_check/);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source, status) VALUES ($1,'g','said','someday')`, [a])).rejects.toThrow(/memory_goals_status_check/);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source, priority) VALUES ($1,'g','said',0)`, [a])).rejects.toThrow(/memory_goals_priority_check/);
    // A decision serves a goal; removing the goal keeps the decision (history), unlinked.
    const g = (await q(pg, `INSERT INTO memory_goals (athlete_id, text, source, priority, game_plan) VALUES ($1,'Grow','said',1,'Post weekly') RETURNING id`, [a]))[0].id;
    await pg.query(`INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, goal_id) VALUES ($1,'onboarding','x','y',$2)`, [a, g]);
    await pg.query(`DELETE FROM memory_goals WHERE id = $1`, [g]);
    expect(await q(pg, `SELECT goal_id FROM memory_decisions`)).toEqual([{ goal_id: null }]);
    await expect(pg.query(`INSERT INTO agent_onboarding_checkpoints (athlete_id, workflow_run_id, checkpoint) VALUES ($1, gen_random_uuid(), 'anything')`, [a])).rejects.toThrow(/checkpoint_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("the checkpoint and fact-status vocabularies match the contract", () => {
    for (const c of ONBOARDING_CHECKPOINTS) expect(FILE).toContain(`'${c}'`);
    for (const s of FACT_STATUSES) expect(FILE).toContain(`'${s}'`);
  });

  it("is on db-migrate.sh's list exactly once, after 0105", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0106_agent_onboarding \\")).toHaveLength(1);
    expect(lines.indexOf("0106_agent_onboarding \\")).toBeGreaterThan(lines.indexOf("0105_agent_harness \\"));
  });
});
