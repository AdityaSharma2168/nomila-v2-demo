/**
 * memoryDisplayGaps.migration.test.ts — 0119 (the memory display gaps) adds memory_goals.domain and memory_facts
 * date_precision / field / field_value: applied to a database without them, it leaves exactly what a shared/schema.ts
 * push creates; it re-runs as a no-op with rows present (existing rows read NULL — nothing is backfilled); its checks
 * hold (the closed lists, and field written only with its value); it has no transaction control; and it is on
 * db-migrate.sh's list exactly once, after 0118. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { DATE_PRECISIONS, GOAL_DOMAINS, IDENTITY_FIELDS } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0119_memory_display_gaps.sql"), "utf8");
const TABLES = ["memory_facts", "memory_goals"];
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
/** Back to the state before 0119. */
const UNDO = `
  DROP INDEX idx_memory_facts_athlete_field;
  ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_date_precision_check;
  ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_field_check;
  ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_field_value_check;
  ALTER TABLE memory_facts DROP COLUMN date_precision; ALTER TABLE memory_facts DROP COLUMN field; ALTER TABLE memory_facts DROP COLUMN field_value;
  ALTER TABLE memory_goals DROP CONSTRAINT memory_goals_domain_check; ALTER TABLE memory_goals DROP COLUMN domain;`;

const fact = (a: string, extra: string, values: unknown[] = []) =>
  `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence${extra ? `, ${extra}` : ""}) VALUES ('${a}','athlete','X','A claim.','found','https://example.org/a',0.9${values.map((_, i) => `,$${i + 1}`).join("")})`;

describe("0119: the memory display gaps' columns", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows read NULL; the checks hold", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const oldFact = (await q(pg, `${fact(a, "")} RETURNING id`))[0].id;
    const oldGoal = (await q(pg, `INSERT INTO memory_goals (athlete_id, text, source) VALUES ($1,'Grow','said') RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT date_precision, field, field_value FROM memory_facts WHERE id = $1`, [oldFact])).toEqual([{ date_precision: null, field: null, field_value: null }]);
    expect(await q(pg, `SELECT domain FROM memory_goals WHERE id = $1`, [oldGoal])).toEqual([{ domain: null }]);

    for (const d of GOAL_DOMAINS) await pg.query(`INSERT INTO memory_goals (athlete_id, text, source, domain) VALUES ($1,'g','said',$2)`, [a, d]);
    await expect(pg.query(`INSERT INTO memory_goals (athlete_id, text, source, domain) VALUES ($1,'g','said','performance')`, [a])).rejects.toThrow(/memory_goals_domain_check/);
    for (const p of DATE_PRECISIONS) await pg.query(fact(a, "observed_on, date_precision", [1, 2]), ["2026-12-01", p]);
    await expect(pg.query(fact(a, "date_precision", [1]), ["week"])).rejects.toThrow(/memory_facts_date_precision_check/);
    for (const f of IDENTITY_FIELDS) await pg.query(fact(a, "field, field_value", [1, 2]), [f, "A value"]);
    await expect(pg.query(fact(a, "field, field_value", [1, 2]), ["jersey", "9"])).rejects.toThrow(/memory_facts_field_check/);
    await expect(pg.query(fact(a, "field", [1]), ["team"])).rejects.toThrow(/memory_facts_field_value_check/);
    await expect(pg.query(fact(a, "field_value", [1]), ["Alone"])).rejects.toThrow(/memory_facts_field_value_check/);

    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    for (const d of GOAL_DOMAINS) expect(FILE).toContain(`'${d}'`);
    for (const f of IDENTITY_FIELDS) expect(FILE).toContain(`'${f}'`);
    for (const p of DATE_PRECISIONS) expect(FILE).toContain(`'${p}'`);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0118", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0119_memory_display_gaps \\")).toHaveLength(1);
    expect(lines.indexOf("0119_memory_display_gaps \\")).toBeGreaterThan(lines.indexOf("0118_plan_step \\"));
  });
});
