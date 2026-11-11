/**
 * milaSessions.migration.test.ts (moved from agent/tf/milaTfChat.migration.test.ts; the Mastra turn keeps its sessions and
 * turn items in these tables) — 0141 (first written for Mila on TrueForge): on a database without the two tables it leaves exactly what
 * a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no transaction control, deleting the
 * athlete takes both tables' rows and deleting a run takes its items, and it is on db-migrate.sh once, after 0140.
 * The later columns on mila_tf_sessions come from 0147 (OUR_COLUMNS_SQL, its own part): 0141 + those = the schema.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";
import { OUR_COLUMNS_SQL } from "./mastra/ddl";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0141_mila_tf_chat.sql"), "utf8");
const TABLES = ["mila_tf_sessions", "mila_tf_turn_items"];
const list = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_name in (${list}) order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2, 3`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});

describe("0141: the file is the schema", () => {
  it("on a database without the tables, leaves (with 0147's columns) exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE mila_tf_turn_items; DROP TABLE mila_tf_sessions;");
    await got.exec(FILE);
    await got.exec(FILE);
    await got.exec(OUR_COLUMNS_SQL);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("deleting a run takes its items; deleting the athlete takes everything", async () => {
    const pg = await pushed();
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const run = (await q(pg, `INSERT INTO agent_runs (athlete_id, skill_id, skill_version, trigger, provider, model, effort) VALUES ($1,'chat','tf:x','chat','trueforge','mila-dev','low') RETURNING id`, [a]))[0].id;
    await q(pg, `INSERT INTO mila_tf_sessions (athlete_id, tf_session_id) VALUES ($1, 'tfs-1')`, [a]);
    await q(pg, `INSERT INTO mila_tf_turn_items (athlete_id, run_id, kind, payload) VALUES ($1, $2, 'card', '{}'), ($1, $2, 'tool', '{}')`, [a, run]);
    await expect(q(pg, `INSERT INTO mila_tf_turn_items (athlete_id, run_id, kind, payload) VALUES ($1, $2, 'other', '{}')`, [a, run])).rejects.toThrow();
    await q(pg, `DELETE FROM agent_runs WHERE id = $1`, [run]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM mila_tf_turn_items`)).toEqual([{ n: 0 }]);
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM mila_tf_sessions`)).toEqual([{ n: 0 }]);
    await pg.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ON DELETE CASCADE/g, "");   // the FK's delete rule, not a DELETE
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|ALTER)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0140", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0141_mila_tf_chat/g)).toHaveLength(1);
    expect(sh.indexOf("0141_mila_tf_chat")).toBeGreaterThan(sh.indexOf("0140_drop_retired_intelligence_tables"));
  });
});
