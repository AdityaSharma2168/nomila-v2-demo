/**
 * milaProactive.migration.test.ts — 0143 (Mila starts the conversation): on a database without its table, columns and
 * index it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no
 * transaction control, the dedupe key is unique per athlete, deleting the athlete takes the events, and it is on
 * db-migrate.sh once, after 0141.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0143_mila_proactive.sql"), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
    where table_name = 'athlete_events' or (table_name = 'chat_messages' and column_name in ('mila_started','seen_at')) order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'athlete_events' order by 1, 2, 3`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename = 'athlete_events' or indexname = 'idx_chat_mila_unread' order by 1, 2`),
});

describe("0143: the file is the schema", () => {
  it("on a database without them, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE athlete_events; DROP INDEX idx_chat_mila_unread; ALTER TABLE chat_messages DROP COLUMN mila_started; ALTER TABLE chat_messages DROP COLUMN seen_at;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("one event per (athlete, dedupe key); deleting the athlete takes the events; existing chat rows read as not Mila-started", async () => {
    const pg = await pushed();
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const b = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Other') RETURNING id`))[0].id;
    await q(pg, `INSERT INTO athlete_events (athlete_id, kind, dedupe_key) VALUES ($1, 'brand_reply', 'k1')`, [a]);
    await expect(q(pg, `INSERT INTO athlete_events (athlete_id, kind, dedupe_key) VALUES ($1, 'brand_reply', 'k1')`, [a])).rejects.toThrow();
    await q(pg, `INSERT INTO athlete_events (athlete_id, kind, dedupe_key) VALUES ($1, 'brand_reply', 'k1')`, [b]);
    await q(pg, `INSERT INTO chat_messages (athlete_id, role, content) VALUES ($1, 'assistant', 'hi')`, [a]);
    expect(await q(pg, `SELECT mila_started, seen_at FROM chat_messages`)).toEqual([{ mila_started: false, seen_at: null }]);
    await q(pg, `DELETE FROM chat_messages`);
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM athlete_events`)).toEqual([{ n: 1 }]);
    await pg.close();
  }, 120_000);

  it("is additive only and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ON DELETE CASCADE/g, "").replace(/ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|ALTER)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0141", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0143_mila_proactive/g)).toHaveLength(1);
    expect(sh.indexOf("0143_mila_proactive")).toBeGreaterThan(sh.indexOf("0141_mila_tf_chat"));
  });
});
