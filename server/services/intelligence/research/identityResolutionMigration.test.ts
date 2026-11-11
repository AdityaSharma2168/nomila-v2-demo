/**
 * identityResolutionMigration.test.ts — migrations/0080_identity_resolution.sql (PR E1; design record §4.2, §8).
 *
 *   - the SQL CHECK value list equals IDENTITY_RESOLUTIONS (the single TypeScript source) and the schema.ts mirror
 *   - listed in db-migrate.sh step 3 exactly once, right after 0079
 *   - applied to a pre-0080 database: additive, every existing row stays NULL (no default, no backfill, no UPDATE),
 *     the legacy identity_confidence / identity_resolved_at are untouched
 *   - re-runs without error (every file re-runs on every deploy) and ends equal to what shared/schema.ts declares
 *   - no transaction control in the file (migrationsGuard covers it too)
 *
 * Statements run one at a time (each autocommits under psql -f), never as one implicit transaction. splitStatements is
 * duplicated from objective/migrations.test.ts rather than imported, for the reason that file gives.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../../shared/schema";
import { IDENTITY_RESOLUTIONS } from "./registries";

const ROOT = join(__dirname, "..", "..", "..", "..");
const M0080 = readFileSync(join(ROOT, "migrations", "0080_identity_resolution.sql"), "utf8");
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
/** Pre-0080: schema.ts pushed, then the two constraints and two columns rewound away. */
async function pre0080(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE athlete_research_state DROP CONSTRAINT athlete_research_state_identity_detail_check;
    ALTER TABLE athlete_research_state DROP CONSTRAINT athlete_research_state_identity_resolution_check;
    ALTER TABLE athlete_research_state DROP COLUMN identity_resolution_detail;
    ALTER TABLE athlete_research_state DROP COLUMN identity_resolution;`);
  return pg;
}
const columnsOf = async (pg: PGlite) => (await pg.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'athlete_research_state' ORDER BY column_name`)).rows;
const constraintsOf = async (pg: PGlite) => (await pg.query<{ conname: string; def: string; convalidated: boolean }>(
  `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conrelid = 'athlete_research_state'::regclass ORDER BY conname`)).rows;

describe("0080 — static", () => {
  const values = (src: string, name: string) => {
    const m = new RegExp(`${name}[\\s\\S]*?IN \\(([^)]*)\\)`).exec(src);
    if (!m) throw new Error(`${name} not found`);
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  };
  test("the SQL CHECK list = IDENTITY_RESOLUTIONS = the schema.ts mirror", () => {
    expect(values(M0080, "ADD CONSTRAINT athlete_research_state_identity_resolution_check")).toEqual([...IDENTITY_RESOLUTIONS]);
    expect(values(SCHEMA_TS, `check\\("athlete_research_state_identity_resolution_check"`)).toEqual([...IDENTITY_RESOLUTIONS]);
  });
  test("additive and idempotent by construction: no UPDATE / INSERT / DEFAULT / NOT NULL / transaction control", () => {
    const code = M0080.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE|DEFAULT|NOT NULL|BEGIN|COMMIT|ROLLBACK)\b/i);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS identity_resolution text/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS identity_resolution_detail jsonb/);
    expect(code).not.toMatch(/identity_confidence|identity_resolved_at/);   // the legacy account signals are untouched
  });
  test("listed in db-migrate.sh step 3 once, right after 0079", () => {
    const list = DB_MIGRATE.split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0080_identity_resolution \\")).toHaveLength(1);
    expect(list.indexOf("0080_identity_resolution \\")).toBe(list.indexOf("0079_objective_change_assessed \\") + 1);
  });
});

describe("0080 — applied to a pre-0080 database", () => {
  test("existing rows stay NULL, legacy columns untouched; re-runs; ends equal to schema.ts", async () => {
    const want = await pushed();
    const got = await pre0080();
    const a = (await got.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Pre 0080') RETURNING id`)).rows[0].id;
    await got.query(`INSERT INTO athlete_research_state (athlete_id, identity_confidence, identity_resolved_at, research_status) VALUES ($1, 1.00, now(), 'identity_resolved')`, [a]);
    const legacyBefore = (await got.query(`SELECT identity_confidence, identity_resolved_at, research_status FROM athlete_research_state`)).rows;

    expect(await applyLikePsql(got, M0080)).toBeNull();
    expect(await applyLikePsql(got, M0080)).toBeNull();   // every deploy re-runs it

    expect((await got.query(`SELECT identity_resolution, identity_resolution_detail FROM athlete_research_state`)).rows).toEqual([{ identity_resolution: null, identity_resolution_detail: null }]);
    expect((await got.query(`SELECT identity_confidence, identity_resolved_at, research_status FROM athlete_research_state`)).rows).toEqual(legacyBefore);
    expect(await columnsOf(got)).toEqual(await columnsOf(want));
    expect(await constraintsOf(got)).toEqual(await constraintsOf(want));
    const cons = (await constraintsOf(got)).filter((c) => /identity_(resolution|detail)_check$/.test(c.conname)).map((c) => c.conname);
    expect(cons).toEqual(["athlete_research_state_identity_detail_check", "athlete_research_state_identity_resolution_check"]);

    // the CHECKs bite in the migrated database itself
    await expect(got.query(`UPDATE athlete_research_state SET identity_resolution = 'unresolved', identity_resolution_detail = '{}'`)).rejects.toThrow(/identity_resolution_check/);
    await expect(got.query(`UPDATE athlete_research_state SET identity_resolution = 'pending'`)).rejects.toThrow(/identity_detail_check/);
    await want.close(); await got.close();
  });
});
