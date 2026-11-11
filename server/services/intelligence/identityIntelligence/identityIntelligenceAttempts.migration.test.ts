/**
 * identityIntelligenceAttempts.migration.test.ts — 0083 is the schema: the table the file creates equals the table a
 * shared/schema.ts push creates (columns, indexes, constraints), it re-runs as a no-op, it is additive, and it is on
 * db-migrate.sh's list once, right after 0082.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0083_identity_intelligence_attempts.sql"), "utf8");
const TABLE = "identity_intelligence_attempts";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const catalog = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name='${TABLE}' order by column_name`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename='${TABLE}' order by indexname`),
  constraints: await q(pg, `select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='${TABLE}'::regclass order by conname`),
});

describe("0083: the file is the schema", () => {
  it("creates exactly what a schema.ts push creates — columns, indexes and constraints", async () => {
    const fromSchema = await pushed();
    const fromFile = await pushed();
    await fromFile.exec(`DROP TABLE ${TABLE};`);
    await fromFile.exec(FILE);
    expect(await catalog(fromFile)).toEqual(await catalog(fromSchema));
  }, 60_000);

  it("re-runs as a no-op, and is additive (no existing table touched)", async () => {
    const pg = await pushed();
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect((await catalog(pg)).columns.length).toBe(14);
    const statements = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).not.toMatch(/\bALTER TABLE\b|\bDROP\b|\bBEGIN\b|\bCOMMIT\b/i);
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, right after 0082", () => {
    const script = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(script.match(/0083_identity_intelligence_attempts/g)).toHaveLength(1);
    expect(script.indexOf("0082_research_identity_sources")).toBeLessThan(script.indexOf("0083_identity_intelligence_attempts"));
  });
});
