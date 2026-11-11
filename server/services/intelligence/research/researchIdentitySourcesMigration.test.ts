/**
 * researchIdentitySourcesMigration.test.ts — migrations/0082_research_identity_sources.sql (research v3 identity sources).
 *
 *   - static: the three CHECK lists = the TypeScript vocabularies = the shared/schema.ts mirrors; the old sets are untouched
 *     prefixes; no transaction control / data change; listed in db-migrate.sh step 3 once, right after 0081
 *   - CHECK OWNERSHIP (0063): 0082 owns the three CHECKs; 0053 and 0081 are the guarded "add only if absent, NOT VALID" form,
 *     so re-running them (every deploy) after 0082 never re-narrows a CHECK over rows written under 0082's sets
 *   - applied (dry-run against PGlite, never a real database) to a pre-0082 database: twice, ends equal to schema.ts, validated
 *
 * Statements run one at a time (each autocommits under psql -f), as researchRunsQueryIdMigration.test.ts does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../../shared/schema";
import { EVIDENCE_KINDS_V2, LINEAGE_STATUSES } from "./registries";
import { QUERY_IDS } from "./spec/researchSpecV1";
import { READ_QUERY_ID } from "./spec/sourceReadV1";

const ROOT = join(__dirname, "..", "..", "..", "..");
const file = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8");
const M0053 = file("0053_research_evidence_v2.sql");
const M0081 = file("0081_research_runs_query_id.sql");
const M0082 = file("0082_research_identity_sources.sql");
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
const OLD_KINDS = EVIDENCE_KINDS_V2.filter((k) => k !== "athlete_statement");
const OLD_LINEAGE = LINEAGE_STATUSES.filter((l) => l !== "source_read");
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
/** Pre-0082: schema.ts pushed, then the three CHECKs rewound to their 0053 / 0081 sets (as dev and prod are today). */
async function pre0082(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE research_evidence DROP CONSTRAINT research_evidence_kind_check;
    ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_kind_check CHECK (kind IN (${inList(OLD_KINDS)}));
    ALTER TABLE research_evidence DROP CONSTRAINT research_evidence_lineage_check;
    ALTER TABLE research_evidence ADD CONSTRAINT research_evidence_lineage_check CHECK (lineage_status IN (${inList(OLD_LINEAGE)}));
    ALTER TABLE research_runs DROP CONSTRAINT research_runs_query_id_check;
    ALTER TABLE research_runs ADD CONSTRAINT research_runs_query_id_check CHECK (query_id IS NULL OR query_id IN (${inList(QUERY_IDS)}));`);
  return pg;
}
const constraintsOf = async (pg: PGlite, table: string) => (await pg.query<{ conname: string; def: string }>(
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'c' ORDER BY conname`)).rows;
const values = (src: string, name: string) => {
  const m = new RegExp(`${name}[\\s\\S]*?IN \\(([^)]*)\\)`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
};
async function seedRows(pg: PGlite) {
  const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Identity Sources') RETURNING id`)).rows[0].id;
  const run = (await pg.query<{ id: string }>(`INSERT INTO research_runs (athlete_id, domain, trigger, status, workflow_run_id, query_id) VALUES ($1, 'refresh', 'manual', 'ok', gen_random_uuid(), 'READ') RETURNING id`, [a])).rows[0].id;
  const ev = (kind: string, lineage: string) => pg.query(`INSERT INTO research_evidence (athlete_id, run_id, kind, claim, lineage_status, retrieved_at, dedupe_key) VALUES ($1, $2, $3, '{}', $4, now(), md5(random()::text))`, [a, run, kind, lineage]);
  return { a, run, ev };
}

describe("0082 — static", () => {
  test("the three CHECK lists = the TypeScript vocabularies = the schema.ts mirrors; the old sets are untouched prefixes", () => {
    expect(values(M0082, "ADD CONSTRAINT research_evidence_kind_check")).toEqual([...EVIDENCE_KINDS_V2]);
    expect(values(SCHEMA_TS, `check\\("research_evidence_kind_check"`)).toEqual([...EVIDENCE_KINDS_V2]);
    expect(values(M0082, "ADD CONSTRAINT research_evidence_lineage_check")).toEqual([...LINEAGE_STATUSES]);
    expect(values(SCHEMA_TS, `check\\("research_evidence_lineage_check"`)).toEqual([...LINEAGE_STATUSES]);
    expect(values(M0082, "ADD CONSTRAINT research_runs_query_id_check")).toEqual([...QUERY_IDS, READ_QUERY_ID]);
    expect(values(SCHEMA_TS, `check\\("research_runs_query_id_check"`)).toEqual([...QUERY_IDS, READ_QUERY_ID]);
    expect(values(M0053, "ADD CONSTRAINT research_evidence_kind_check")).toEqual(OLD_KINDS);
    expect(values(M0053, "ADD CONSTRAINT research_evidence_lineage_check")).toEqual(OLD_LINEAGE);
    expect(values(M0081, "ADD CONSTRAINT research_runs_query_id_check")).toEqual([...QUERY_IDS]);
    expect(EVIDENCE_KINDS_V2.at(-1)).toBe("athlete_statement"); expect(LINEAGE_STATUSES.at(-1)).toBe("source_read");
  });
  test("0082 owns (DROP + ADD, validated); 0053 and 0081 are the guarded, NOT VALID form; no transaction control or data change", () => {
    const code = M0082.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|DEFAULT|NOT VALID|COMMIT|ROLLBACK|START TRANSACTION|BEGIN)\b/i);
    for (const c of ["research_evidence_kind_check", "research_evidence_lineage_check", "research_runs_query_id_check"]) expect(code).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${c};`));
    for (const [m, names] of [[M0053, ["research_evidence_kind_check", "research_evidence_lineage_check"]], [M0081, ["research_runs_query_id_check"]]] as const) {
      const c = m.replace(/--[^\n]*/g, "");
      for (const n of names) { expect(c).not.toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${n}`)); expect(c).toMatch(new RegExp(`conname = '${n}'`)); }
      expect(c).toMatch(/NOT VALID;/);
    }
  });
  test("listed in db-migrate.sh step 3 once, right after 0081", () => {
    const list = DB_MIGRATE.split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0082_research_identity_sources \\")).toHaveLength(1);
    expect(list.indexOf("0082_research_identity_sources \\")).toBe(list.indexOf("0081_research_runs_query_id \\") + 1);
  });
});

describe("0082 — applied (PGlite dry-run)", () => {
  test("a pre-0082 database refuses the new values; after 0082 (twice) they are accepted, bogus values still refused, and the CHECKs equal schema.ts", async () => {
    const want = await pushed();
    const got = await pre0082();
    const athlete = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Pre 0082') RETURNING id`)).rows[0].id;
    await expect(got.query(`INSERT INTO research_runs (athlete_id, domain, trigger, status, query_id) VALUES ($1, 'refresh', 'manual', 'ok', 'READ')`, [athlete])).rejects.toThrow(/research_runs_query_id_check/);

    expect(await applyLikePsql(got, M0082)).toBeNull();
    expect(await applyLikePsql(got, M0082)).toBeNull();   // every deploy re-runs it
    const { a, ev } = await seedRows(got);
    await ev("athlete_statement", "source_read");
    await ev("press_mention", "native_supported");                     // existing combinations unaffected
    await expect(ev("bogus_kind", "source_read")).rejects.toThrow(/research_evidence_kind_check/);
    await expect(ev("athlete_statement", "bogus")).rejects.toThrow(/research_evidence_lineage_check/);
    await expect(got.query(`INSERT INTO research_runs (athlete_id, domain, trigger, status, query_id) VALUES ($1, 'refresh', 'manual', 'ok', 'Q7')`, [a])).rejects.toThrow(/research_runs_query_id_check/);
    for (const t of ["research_evidence", "research_runs"]) expect(await constraintsOf(got, t)).toEqual(await constraintsOf(want, t));
    await want.close(); await got.close();
  });

  test("CHECK ownership: re-running 0053 and 0081 (every deploy) after 0082, over rows written under 0082's sets, succeeds and never re-narrows", async () => {
    const pg = await pre0082();
    expect(await applyLikePsql(pg, M0082)).toBeNull();
    const { ev } = await seedRows(pg);
    await ev("athlete_statement", "source_read");
    expect(await applyLikePsql(pg, M0053)).toBeNull();
    expect(await applyLikePsql(pg, M0081)).toBeNull();
    expect(await applyLikePsql(pg, M0082)).toBeNull();
    const defs = [...(await constraintsOf(pg, "research_evidence")), ...(await constraintsOf(pg, "research_runs"))].filter((c) => /kind_check|lineage_check|query_id_check/.test(c.conname));
    expect(defs).toHaveLength(3);
    for (const c of defs) expect(c.def).not.toContain("NOT VALID");
    expect(defs.map((c) => c.def).join(" ")).toMatch(/athlete_statement[\s\S]*source_read[\s\S]*READ|READ[\s\S]*athlete_statement/);
    await pg.close();
  });

  test("a database with none of the three CHECKs: 0053 → 0081 → 0082 ends with 0082's validated definitions", async () => {
    const want = await pushed();
    const pg = await pushed();
    await pg.exec(`ALTER TABLE research_evidence DROP CONSTRAINT research_evidence_kind_check; ALTER TABLE research_evidence DROP CONSTRAINT research_evidence_lineage_check; ALTER TABLE research_runs DROP CONSTRAINT research_runs_query_id_check;`);
    expect(await applyLikePsql(pg, M0053)).toBeNull();
    expect(await applyLikePsql(pg, M0081)).toBeNull();
    expect((await constraintsOf(pg, "research_runs")).find((c) => c.conname === "research_runs_query_id_check")!.def).toContain("NOT VALID");
    expect(await applyLikePsql(pg, M0082)).toBeNull();
    for (const t of ["research_evidence", "research_runs"]) expect(await constraintsOf(pg, t)).toEqual(await constraintsOf(want, t));
    await want.close(); await pg.close();
  });
});
