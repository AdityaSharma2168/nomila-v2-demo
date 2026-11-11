/**
 * memoryFactsTopicSourceType.migration.test.ts — 0115 adds memory_facts.topic and memory_facts.source_type (nullable):
 * applied to a database without them, it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op
 * with rows present (existing rows keep NULL, nothing is backfilled); its source_type check holds; it has no
 * transaction control; and it is on db-migrate.sh's list exactly once, after 0114. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";
import { FACT_SOURCE_TYPES } from "../../shared/agent";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0115_memory_facts_topic_source_type.sql"), "utf8");

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
/** Back to the state before 0115. */
const UNDO = `ALTER TABLE memory_facts DROP CONSTRAINT memory_facts_source_type_check; ALTER TABLE memory_facts DROP COLUMN source_type; ALTER TABLE memory_facts DROP COLUMN topic;`;
const INSERT = `INSERT INTO memory_facts (athlete_id, subject_kind, subject_name, claim, type, source_url, confidence`;

describe("0115: memory_facts.topic and memory_facts.source_type", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows stay NULL; the source_type check holds", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const old = (await q(pg, `${INSERT}) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5) RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT topic, source_type FROM memory_facts WHERE id = $1`, [old])).toEqual([{ topic: null, source_type: null }]);
    for (const t of FACT_SOURCE_TYPES) {
      await pg.query(`${INSERT}, topic, source_type) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,'sponsor',$2)`, [a, t]);
    }
    // topic is free text (the research topic list grows); source_type is one of the outlet types or NULL.
    await pg.query(`${INSERT}, topic) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,'a-new-topic')`, [a]);
    await expect(pg.query(`${INSERT}, source_type) VALUES ($1,'athlete','A','c','found','https://example.org/a',0.5,'blog')`, [a])).rejects.toThrow(/memory_facts_source_type_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    for (const t of FACT_SOURCE_TYPES) expect(FILE).toContain(`'${t}'`);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0114", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0115_memory_facts_topic_source_type \\")).toHaveLength(1);
    expect(lines.indexOf("0115_memory_facts_topic_source_type \\")).toBeGreaterThan(lines.indexOf("0114_memory_briefs_display \\"));
  });
});
