/**
 * chatAgentCards.migration.test.ts — 0123 adds chat_messages.agent_cards (jsonb) and agent_run_id (uuid), both nullable,
 * for Mila's chat skill: applied to a database without them, it leaves exactly what a shared/schema.ts push creates; it
 * re-runs as a no-op with rows present (existing rows read NULL — nothing is backfilled); it has no transaction control;
 * and it is on db-migrate.sh's list exactly once, after 0119. PGlite only: no real database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0123_chat_messages_agent_cards.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'chat_messages' order by 1`),
  constraints: await q(pg, `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'chat_messages' order by 1`),
  indexes: await q(pg, `select indexname, indexdef from pg_indexes where tablename = 'chat_messages' order by 1`),
});
const UNDO = `ALTER TABLE chat_messages DROP COLUMN agent_cards; ALTER TABLE chat_messages DROP COLUMN agent_run_id;`;

describe("0123: chat_messages.agent_cards and agent_run_id", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(UNDO);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows read NULL; new rows keep their cards", async () => {
    const pg = await pushed();
    await pg.exec(UNDO);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const old = (await q(pg, `INSERT INTO chat_messages (athlete_id, role, content) VALUES ($1,'assistant','hi') RETURNING id`, [a]))[0].id;
    await pg.exec(FILE); await pg.exec(FILE);
    expect(await q(pg, `SELECT agent_cards, agent_run_id FROM chat_messages WHERE id = $1`, [old])).toEqual([{ agent_cards: null, agent_run_id: null }]);
    const run = "00000000-0000-4000-8000-000000000123";
    const row = (await q(pg, `INSERT INTO chat_messages (athlete_id, role, content, agent_cards, agent_run_id) VALUES ($1,'assistant','x',$2,$3) RETURNING agent_cards, agent_run_id`,
      [a, JSON.stringify([{ id: "c", kind: "quick-question", title: "Quick question", payload: {}, links: [], runId: run }]), run]))[0];
    expect(row).toEqual({ agent_cards: [{ id: "c", kind: "quick-question", title: "Quick question", payload: {}, links: [], runId: run }], agent_run_id: run });
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0119", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0123_chat_messages_agent_cards \\")).toHaveLength(1);
    expect(lines.indexOf("0123_chat_messages_agent_cards \\")).toBeGreaterThan(lines.indexOf("0119_memory_display_gaps \\"));
  });
});
