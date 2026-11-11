/**
 * memoryFactsCareKind.migration.test.ts — 0113 adds memory_facts.care_kind (personal | conduct, nullable): applied to a
 * database without it, it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op with rows present
 * (existing rows keep NULL, nothing is backfilled); its check holds; it has no transaction control; and it is on
 * db-migrate.sh's list exactly once, after 0106. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { CARE_KINDS } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0113_memory_facts_care_kind.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'memory_facts' order by 1`),
  constraints: await q(pg, `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'memory_facts' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'memory_facts' order by 1`),
});
/** Back to the state before 0113. */
const UNDO = `ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_care_kind_check; ALTER TABLE memory_facts DROP COLUMN care_kind;`;

describe("0113: memory_facts.care_kind", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows stay NULL; the check holds", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const old = (await q(pg, `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence, sensitive) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,true) RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT care_kind FROM memory_facts WHERE id = $1`, [old])).toEqual([{ care_kind: null }]);
    for (const k of CARE_KINDS) {
      await pg.query(`INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence, sensitive, care_kind) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,true,$2)`, [a, k]);
    }
    await expect(pg.query(`INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence, sensitive, care_kind) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,true,'other')`, [a])).rejects.toThrow(/memory_facts_care_kind_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    for (const k of CARE_KINDS) expect(FILE).toContain(`'${k}'`);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0106", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0113_memory_facts_care_kind \\")).toHaveLength(1);
    expect(lines.indexOf("0113_memory_facts_care_kind \\")).toBeGreaterThan(lines.indexOf("0106_agent_onboarding \\"));
  });
});
