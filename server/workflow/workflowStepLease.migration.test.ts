/**
 * workflowStepLease.migration.test.ts — 0148 (workflow_steps.lease_owner / lease_token / lease_reclaims): on a database
 * without the columns it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, existing rows read
 * NULL / NULL / 0, it is additive only with no transaction control, and it is on db-migrate.sh once, after 0147.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0148_workflow_step_lease.sql"), "utf8");
const DROP = "ALTER TABLE workflow_steps DROP COLUMN lease_owner; ALTER TABLE workflow_steps DROP COLUMN lease_token; ALTER TABLE workflow_steps DROP COLUMN lease_reclaims;";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = (pg: PGlite) => q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns
  where table_name = 'workflow_steps' and column_name in ('lease_owner','lease_token','lease_reclaims') order by column_name`);

describe("0148: the file is the schema", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates; re-runs as a no-op; old rows read NULL / NULL / 0", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(DROP);
    expect(await shape(got)).toEqual([]);
    const a = (await q(got, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const run = (await q(got, `INSERT INTO workflow_runs (athlete_id, process, active_scope, definition_version, status) VALUES ($1, 'p', 'p', 1, 'running') RETURNING id`, [a]))[0].id;
    await q(got, `INSERT INTO workflow_steps (run_id, step, ordinal, kind, status) VALUES ($1, 's', 0, 'code', 'running')`, [run]);
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    expect(await shape(want)).toHaveLength(3);
    expect(await q(got, `SELECT lease_owner, lease_token, lease_reclaims FROM workflow_steps`)).toEqual([{ lease_owner: null, lease_token: null, lease_reclaims: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ALTER TABLE workflow_steps ADD COLUMN IF NOT EXISTS/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|COMMIT|ROLLBACK|ALTER|TRUNCATE)\b/i);
    expect(body).not.toMatch(/^\s*(BEGIN|START\s+TRANSACTION)\s*;/im);
  });

  it("is on db-migrate.sh exactly once, after 0147", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0148_workflow_step_lease/g)).toHaveLength(1);
    expect(sh.indexOf("0148_workflow_step_lease")).toBeGreaterThan(sh.indexOf("0147_mastra_engine"));
  });
});
