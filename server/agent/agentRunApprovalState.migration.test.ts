/**
 * agentRunApprovalState.migration.test.ts — 0144 (agent_runs.approval_state): on a database without the column it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, existing runs read NULL, the CHECK refuses an
 * unknown state, it is additive only with no transaction control, and it is on db-migrate.sh once, after 0143.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0144_agent_run_approval_state.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name = 'agent_runs' and column_name = 'approval_state'`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'agent_runs'::regclass and conname = 'agent_runs_approval_state_check'`),
});

describe("0144: the file is the schema", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_approval_state_check; ALTER TABLE agent_runs DROP COLUMN approval_state;");
    expect((await shape(got)).columns).toEqual([]);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    expect((await shape(want)).constraints).toHaveLength(1);
    await want.close(); await got.close();
  }, 120_000);

  it("existing runs read NULL; the CHECK takes the five states and refuses anything else", async () => {
    const pg = await pushed();
    await pg.exec("ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_approval_state_check; ALTER TABLE agent_runs DROP COLUMN approval_state;");
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const run = (await q(pg, `INSERT INTO agent_runs (athlete_id, skill_id, skill_version, trigger, provider, model, effort, status, ended_at)
      VALUES ($1, 'chat', 'x', 'chat', 'trueforge', 'm', 'low', 'completed', now()) RETURNING id`, [a]))[0].id;
    await pg.exec(FILE);
    expect(await q(pg, `SELECT status, approval_state FROM agent_runs WHERE id = $1`, [run])).toEqual([{ status: "completed", approval_state: null }]);
    for (const s of ["awaiting_approval", "resumed", "completed", "cancelled", "failed"]) await q(pg, `UPDATE agent_runs SET approval_state = $1 WHERE id = $2`, [s, run]);
    await expect(q(pg, `UPDATE agent_runs SET approval_state = 'waiting' WHERE id = $1`, [run])).rejects.toThrow();
    await pg.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ALTER TABLE agent_runs ADD (COLUMN IF NOT EXISTS|CONSTRAINT)/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|COMMIT|ROLLBACK|ALTER|TRUNCATE)\b/i);
    expect(body).not.toMatch(/^\s*(BEGIN|START\s+TRANSACTION)\s*;/im);
  });

  it("is on db-migrate.sh exactly once, after 0143", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0144_agent_run_approval_state/g)).toHaveLength(1);
    expect(sh.indexOf("0144_agent_run_approval_state")).toBeGreaterThan(sh.indexOf("0143_mila_proactive"));
  });
});
