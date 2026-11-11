/**
 * memoryBriefsDisplay.migration.test.ts — 0114 adds memory_briefs.display (jsonb, nullable): applied to a database
 * without it, it leaves exactly what a shared/schema.ts push creates; it re-runs as a no-op with rows present (existing
 * briefs keep NULL, nothing is backfilled); it has no transaction control; and it is on db-migrate.sh's list exactly
 * once, after 0106. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0114_memory_briefs_display.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'memory_briefs' order by 1`),
  constraints: await q(pg, `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'memory_briefs' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'memory_briefs' order by 1`),
});
/** Back to the state before 0114. */
const UNDO = `ALTER TABLE memory_briefs DROP COLUMN display;`;

describe("0114: memory_briefs.display", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing briefs stay NULL; a display round-trips", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const old = (await q(pg, `INSERT INTO memory_briefs (athlete_id, version, summary) VALUES ($1, 1, 'Before 0114') RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT display FROM memory_briefs WHERE id = $1`, [old])).toEqual([{ display: null }]);
    const display = { stage: { label: "L", band: "early", confidence: 0.5, why: "w", factIds: [] }, positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] } };
    await q(pg, `UPDATE memory_briefs SET status = 'superseded' WHERE id = $1`, [old]);
    const row = (await q(pg, `INSERT INTO memory_briefs (athlete_id, version, summary, display) VALUES ($1, 2, 'After', $2) RETURNING display`, [a, JSON.stringify(display)]))[0];
    expect(row.display).toEqual(display);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0106", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0114_memory_briefs_display \\")).toHaveLength(1);
    expect(lines.indexOf("0114_memory_briefs_display \\")).toBeGreaterThan(lines.indexOf("0106_agent_onboarding \\"));
  });
});
