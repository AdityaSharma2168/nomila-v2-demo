/**
 * researchRunsQueryIdMigration.test.ts — migrations/0081_research_runs_query_id.sql (PR E2a; design record §4.3, D10).
 *
 *   - static: no transaction control / UPDATE / DEFAULT; the CHECK list = research-spec/1 QUERY_IDS = the schema.ts mirror;
 *     listed in db-migrate.sh step 3 exactly once, right after 0080
 *   - applied to a pre-0081 database (0047's one-per-workflow-run index): additive, existing rows stay NULL, and the
 *     result equals what shared/schema.ts declares (columns, constraints, the index definition)
 *   - idempotent: a second application is a no-op and does NOT rebuild the widened index (same oid)
 *   - round-trip semantics: one ok row per (workflow run, query); the NULL slot stays one-per-workflow-run (legacy, v2,
 *     and a v3 run's signals row); rows without a workflow run are unconstrained
 *
 * Statements run one at a time (each autocommits under psql -f). splitStatements is duplicated from
 * identityResolutionMigration.test.ts for the reason objective/migrations.test.ts gives.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../../shared/schema";
import { QUERY_IDS } from "./spec/researchSpecV1";

const ROOT = join(__dirname, "..", "..", "..", "..");
const M0081 = readFileSync(join(ROOT, "migrations", "0081_research_runs_query_id.sql"), "utf8");
/** 0082 owns research_runs_query_id_check since research v3 identity sources (+ READ); the deploy runs it right after 0081. */
const M0082 = readFileSync(join(ROOT, "migrations", "0082_research_identity_sources.sql"), "utf8");
const SCHEMA_TS = readFileSync(join(ROOT, "shared", "schema.ts"), "utf8");
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

function splitStatements(sql: string): string[] {
  const out: string[] = []; let buf = "", i = 0, tag: string | null = null;
  while (i < sql.length) {
    if (tag === null) {
      if (sql[i] === "-" && sql[i + 1] === "-") { const nl = sql.indexOf("\n", i); const end = nl === -1 ? sql.length : nl; buf += sql.slice(i, end); i = end; continue; }
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; buf += tag; i += tag.length; continue; }
      if (sql[i] === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i++; continue; }
      buf += sql[i++]; continue;
    }
    if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; tag = null; continue; }
    buf += sql[i++];
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}
async function applyLikePsql(pg: PGlite, sql: string): Promise<Error | null> {
  for (const statement of splitStatements(sql)) { try { await pg.exec(statement); } catch (err) { return err as Error; } }
  return null;
}
async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
/** Pre-0081: schema.ts pushed, then rewound to 0047's index, no query_id column, no CHECK. */
async function pre0081(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE research_runs DROP CONSTRAINT research_runs_query_id_check;
    DROP INDEX research_runs_workflow_success;
    ALTER TABLE research_runs DROP COLUMN query_id;
    CREATE UNIQUE INDEX IF NOT EXISTS research_runs_workflow_success ON research_runs (workflow_run_id) WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial');`);
  return pg;
}
const columnsOf = async (pg: PGlite) => (await pg.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'research_runs' ORDER BY column_name`)).rows;
const constraintsOf = async (pg: PGlite) => (await pg.query<{ conname: string; def: string }>(
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'research_runs'::regclass ORDER BY conname`)).rows;
const indexOf = async (pg: PGlite) => (await pg.query<{ indexdef: string; oid: number }>(
  `SELECT i.indexdef, c.oid::int AS oid FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname WHERE i.indexname = 'research_runs_workflow_success'`)).rows;

describe("0081 — static", () => {
  const values = (src: string, name: string) => {
    const m = new RegExp(`${name}[\\s\\S]*?IN \\(([^)]*)\\)`).exec(src);
    if (!m) throw new Error(`${name} not found`);
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  };
  test("0081's CHECK list = research-spec/1 QUERY_IDS; the schema.ts mirror adds 0082's READ", () => {
    expect(values(M0081, "ADD CONSTRAINT research_runs_query_id_check")).toEqual([...QUERY_IDS]);
    expect(values(SCHEMA_TS, `check\\("research_runs_query_id_check"`)).toEqual([...QUERY_IDS, "READ"]);
  });
  test("additive and re-runnable by construction: no transaction control, no UPDATE / INSERT / DELETE / DEFAULT / NOT NULL", () => {
    const code = M0081.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|DEFAULT|SET NOT NULL|COMMIT|ROLLBACK|CONCURRENTLY|START TRANSACTION)\b/i);
    expect(code).not.toMatch(/(^|;)\s*BEGIN\s*(;|$)/im);   // BEGIN only as the DO block's body keyword, never a statement
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS query_id text;/);   // nullable, no default
    expect(code).not.toMatch(/DROP CONSTRAINT IF EXISTS research_runs_query_id_check/);   // 0082 owns it (CHECK OWNERSHIP RULE)
    expect(code).toMatch(/conname = 'research_runs_query_id_check'[\s\S]*NOT VALID;/);    // guarded: add only if absent
    expect(code).toMatch(/indexdef LIKE '%query_id%'/);   // replaced only while the live index is still 0047's
  });
  test("listed in db-migrate.sh step 3 once, right after 0080", () => {
    const list = DB_MIGRATE.split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0081_research_runs_query_id \\")).toHaveLength(1);
    expect(list.indexOf("0081_research_runs_query_id \\")).toBe(list.indexOf("0080_identity_resolution \\") + 1);
  });
});

describe("0081 — applied to a pre-0081 database", () => {
  test("existing rows stay NULL; re-runs without rebuilding; ends equal to schema.ts", async () => {
    const want = await pushed();
    const got = await pre0081();
    const a = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Pre 0081') RETURNING id`)).rows[0].id;
    await got.query(`INSERT INTO research_runs (athlete_id, domain, trigger, status, workflow_run_id) VALUES ($1, 'refresh', 'ttl', 'ok', gen_random_uuid())`, [a]);

    expect(await applyLikePsql(got, M0081)).toBeNull();
    const first = await indexOf(got);
    expect(await applyLikePsql(got, M0081)).toBeNull();   // every deploy re-runs it
    expect(await applyLikePsql(got, M0082)).toBeNull();   // …and 0082 right after it (owner of the query_id CHECK)
    const second = await indexOf(got);
    expect(second).toEqual(first);                         // same oid: not rebuilt on an ordinary deploy

    expect((await got.query(`SELECT query_id FROM research_runs`)).rows).toEqual([{ query_id: null }]);
    expect(await columnsOf(got)).toEqual(await columnsOf(want));
    expect(await constraintsOf(got)).toEqual(await constraintsOf(want));
    expect(first.map((r) => r.indexdef)).toEqual((await indexOf(want)).map((r) => r.indexdef));
    expect(first[0].indexdef).toMatch(/\(workflow_run_id, COALESCE\(query_id, ''::text\)\) WHERE \(\(workflow_run_id IS NOT NULL\) AND \(status = ANY/);

    // 0047 re-runs on every deploy before 0081: its CREATE … IF NOT EXISTS is a no-op on the widened index
    await got.exec(`CREATE UNIQUE INDEX IF NOT EXISTS research_runs_workflow_success ON research_runs (workflow_run_id) WHERE workflow_run_id IS NOT NULL AND status IN ('ok','partial')`);
    expect(await indexOf(got)).toEqual(first);
    await want.close(); await got.close();
  });

  test("one ok row per (workflow run, query); the NULL slot stays one per workflow run; no workflow run ⇒ unconstrained", async () => {
    const pg = await pre0081();
    expect(await applyLikePsql(pg, M0081)).toBeNull();
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Round Trip') RETURNING id`)).rows[0].id;
    const wf = (await pg.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    const ins = (q: string | null, status = "ok", w: string | null = wf, domain = "refresh") => pg.query(`INSERT INTO research_runs (athlete_id, domain, trigger, status, workflow_run_id, query_id) VALUES ($1, $2, 'signup', $3, $4, $5)`, [a, domain, status, w, q]);
    for (const q of QUERY_IDS) await ins(q);                                   // a full v3 run: six query rows
    await ins(null, "ok", wf, "signals");                                       // + its signals row (the NULL slot)
    await expect(ins("Q2", "partial")).rejects.toThrow(/research_runs_workflow_success/);
    await expect(ins(null, "ok", wf, "signals")).rejects.toThrow(/research_runs_workflow_success/);
    await ins("Q2", "failed"); await ins("Q2", "running");                     // failed / running attempts never collide
    await ins(null, "ok", null); await ins(null, "ok", null);                   // no workflow run (CLI rows): unconstrained
    await ins("Q1", "ok", null); await ins("Q1", "ok", null);
    await expect(ins("Q7")).rejects.toThrow(/research_runs_query_id_check/);
    await pg.close();
  });
});
