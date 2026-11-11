/**
 * agentHarness.migration.test.ts — 0105 adds the harness's five tables and widens pending_actions' kind check: applied
 * to a database without them (and with the old check) it leaves exactly what a shared/schema.ts push creates, it re-runs
 * as a no-op with rows present, the guards hold (vocabularies, a source on every fact, one current brief, running ⇔ no
 * end time, non-negative cost), deleting the athlete takes all of it, deleting a run keeps the memory it wrote, and it is
 * on db-migrate.sh's list exactly once, after 0104. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0105_agent_harness.sql"), "utf8");
// 0106 (agent onboarding) builds on these tables; the chain 0105 → 0106 is what must equal a schema.ts push.
const NEXT = readFileSync(join(ROOT, "migrations", "0106_agent_onboarding.sql"), "utf8");
// 0113 (memory_facts.care_kind) completes the memory_facts shape: the chain 0105 → 0106 → 0113.
const CARE_KIND = readFileSync(join(ROOT, "migrations", "0113_memory_facts_care_kind.sql"), "utf8");
// 0114 (memory_briefs.display) completes the memory_briefs shape: the chain 0105 → 0106 → 0114.
const DISPLAY = readFileSync(join(ROOT, "migrations", "0114_memory_briefs_display.sql"), "utf8");
// 0115 (memory_facts.topic / source_type) completes the memory_facts shape: the chain 0105 → 0106 → 0113 → 0115.
const TOPIC_SOURCE_TYPE = readFileSync(join(ROOT, "migrations", "0115_memory_facts_topic_source_type.sql"), "utf8");
// 0118 (the plan step: memory_decisions.kind / detail / parent_decision_id) completes the memory_decisions shape.
const PLAN_STEP = readFileSync(join(ROOT, "migrations", "0118_plan_step.sql"), "utf8");
// 0119 (memory_facts.date_precision / field / field_value, memory_goals.domain) completes both shapes.
const DISPLAY_GAPS = readFileSync(join(ROOT, "migrations", "0119_memory_display_gaps.sql"), "utf8");
// 0144 (agent_runs.approval_state) completes the agent_runs shape.
const APPROVAL_STATE = readFileSync(join(ROOT, "migrations", "0144_agent_run_approval_state.sql"), "utf8");
// 0150 (the platform day total's agent_runs(started_at) index) completes the agent_runs shape. CONCURRENTLY: one
// statement at a time, as psql -f sends them (an implicit multi-statement block refuses it).
const PLATFORM_INDEXES = readFileSync(join(ROOT, "migrations", "0150_platform_spend_indexes.sql"), "utf8")
  .replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
const TABLES = ["agent_runs", "memory_facts", "memory_briefs", "memory_decisions", "memory_preferences", "pending_actions"];
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
/** Back to the state before 0105: no harness tables, and pending_actions' original kind check. */
const rewind = (pg: PGlite) => pg.exec(`
  ALTER TABLE memory_decisions DROP COLUMN goal_id;
  DROP TABLE mila_tf_turn_items;   -- 0141 (later than 0105) points at agent_runs
  DROP TABLE agent_onboarding_checkpoints; DROP TABLE memory_goals; DROP TABLE memory_fact_reviews;
  DROP TABLE memory_decisions; DROP TABLE memory_facts; DROP TABLE memory_briefs; DROP TABLE memory_preferences; DROP TABLE agent_runs;
  ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_kind_check;
  ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_kind_check CHECK (kind IN ('send_reply'));`);

describe("0105: the file is the schema", () => {
  it("on a database without the tables, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await rewind(got);
    await got.exec(FILE);
    await got.exec(NEXT);
    await got.exec(CARE_KIND);
    await got.exec(DISPLAY);
    await got.exec(TOPIC_SOURCE_TYPE);
    await got.exec(PLAN_STEP);
    await got.exec(DISPLAY_GAPS);
    await got.exec(APPROVAL_STATE);
    for (const s of PLATFORM_INDEXES) await got.query(s);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present, and the guards hold", async () => {
    const pg = await pushed();
    await rewind(pg);
    // A pre-existing send_reply row survives the widened check.
    const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Migration Diver') RETURNING id`);
    await q(pg, `INSERT INTO pending_actions (athlete_id, kind, payload) VALUES ($1, 'send_reply', '{}')`, [a.id]);
    await pg.exec(FILE);

    const [run] = await q(pg, `INSERT INTO agent_runs (athlete_id, skill_id, skill_version, trigger, provider, model, effort) VALUES ($1, 'echo/health', '1.0.0', 'test', 'openai', 'm', 'low') RETURNING id`, [a.id]);
    const [fact] = await q(pg, `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_ref, confidence, run_id) VALUES ($1, 'athlete', 'Her', 'A claim', 'said', 'chat:1', 0.9, $2) RETURNING id`, [a.id, run.id]);
    await q(pg, `INSERT INTO memory_briefs (athlete_id, version, summary, run_id) VALUES ($1, 1, 'Now', $2)`, [a.id, run.id]);
    const [pa] = await q(pg, `INSERT INTO pending_actions (athlete_id, kind, payload) VALUES ($1, 'agent_action', '{"tool":"x"}') RETURNING id`, [a.id]);
    await q(pg, `INSERT INTO memory_decisions (athlete_id, run_id, skill_id, suggested, why, approval_id) VALUES ($1, $2, 'echo/health', 'Do X', 'Because', $3)`, [a.id, run.id, pa.id]);
    await q(pg, `INSERT INTO memory_preferences (athlete_id, kind, statement, source) VALUES ($1, 'voice', 'Short and warm', 'said')`, [a.id]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT status, cost_micro_usd::int c, steps FROM agent_runs`)).toEqual([{ status: "running", c: 0, steps: [] }]);
    expect(await q(pg, `SELECT (SELECT count(*) FROM memory_facts)::int f, (SELECT count(*) FROM memory_briefs)::int b, (SELECT count(*) FROM memory_decisions)::int d, (SELECT count(*) FROM memory_preferences)::int p, (SELECT count(*) FROM pending_actions)::int pa`))
      .toEqual([{ f: 1, b: 1, d: 1, p: 1, pa: 2 }]);

    const bad = async (sql: string, params: unknown[] = []) => { await expect(pg.query(sql, params)).rejects.toThrow(); };
    // vocabularies
    await bad(`INSERT INTO pending_actions (athlete_id, kind, payload) VALUES ($1, 'auto_send', '{}')`, [a.id]);
    await bad(`UPDATE agent_runs SET trigger = 'whim' WHERE id = $1`, [run.id]);
    await bad(`UPDATE agent_runs SET effort = 'max' WHERE id = $1`, [run.id]);
    await bad(`UPDATE agent_runs SET status = 'stopped', ended_at = now(), stop_reason = 'bored' WHERE id = $1`, [run.id]);
    await bad(`UPDATE memory_facts SET type = 'guessed' WHERE id = $1`, [fact.id]);
    await bad(`UPDATE memory_facts SET status = 'deleted' WHERE id = $1`, [fact.id]);
    await bad(`UPDATE memory_facts SET subject_kind = 'child' WHERE id = $1`, [fact.id]);
    await bad(`INSERT INTO memory_preferences (athlete_id, kind, statement, source) VALUES ($1, 'mood', 'x', 'said')`, [a.id]);
    await bad(`INSERT INTO memory_decisions (athlete_id, skill_id, suggested, why, response) VALUES ($1, 's', 'x', 'y', 'ignored')`, [a.id]);
    // a source on every fact; confidence 0–1; a claim is 1–2000 characters
    await bad(`INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, confidence) VALUES ($1, 'athlete', 'Her', 'Unsourced', 'found', 0.5)`, [a.id]);
    await bad(`UPDATE memory_facts SET confidence = 1.5 WHERE id = $1`, [fact.id]);
    await bad(`UPDATE memory_facts SET claim = '' WHERE id = $1`, [fact.id]);
    // running ⇔ no end time; cost never negative
    await bad(`UPDATE agent_runs SET ended_at = now() WHERE id = $1`, [run.id]);
    await bad(`UPDATE agent_runs SET status = 'completed' WHERE id = $1`, [run.id]);
    await bad(`UPDATE agent_runs SET cost_micro_usd = -1 WHERE id = $1`, [run.id]);
    await q(pg, `UPDATE agent_runs SET status = 'completed', ended_at = now() WHERE id = $1`, [run.id]);
    // one current brief per athlete; one row per version
    await bad(`INSERT INTO memory_briefs (athlete_id, version, summary) VALUES ($1, 2, 'Also now')`, [a.id]);
    await bad(`INSERT INTO memory_briefs (athlete_id, version, summary, status) VALUES ($1, 1, 'Dup', 'superseded')`, [a.id]);
    await q(pg, `INSERT INTO memory_briefs (athlete_id, version, summary, status) VALUES ($1, 2, 'Older', 'superseded')`, [a.id]);

    // deleting a run keeps the memory it wrote (run_id → NULL)
    await q(pg, `DELETE FROM agent_runs WHERE id = $1`, [run.id]);
    expect(await q(pg, `SELECT run_id FROM memory_facts`)).toEqual([{ run_id: null }]);
    // deleting the athlete takes all of it (pending_actions is removed by the account deletion, not by cascade)
    await q(pg, `DELETE FROM memory_decisions`);
    await q(pg, `DELETE FROM pending_actions`);
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a.id]);
    expect(await q(pg, `SELECT (SELECT count(*) FROM memory_facts)::int f, (SELECT count(*) FROM memory_briefs)::int b, (SELECT count(*) FROM memory_preferences)::int p, (SELECT count(*) FROM agent_runs)::int r`))
      .toEqual([{ f: 0, b: 0, p: 0, r: 0 }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0104", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0105_agent_harness \\")).toHaveLength(1);
    expect(lines.indexOf("0105_agent_harness \\")).toBeGreaterThan(lines.indexOf("0104_ask_mila \\"));
    expect(lines.indexOf("0104_ask_mila \\")).toBeGreaterThan(-1);
  });
});
