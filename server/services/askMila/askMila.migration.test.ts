/**
 * askMila.migration.test.ts — 0104 adds public Mila mode's five tables (design-public-card-v3 §4, PR 5): applied to a
 * database without them it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op with rows
 * present, the guards hold (intent / status / role vocabularies, ended ⇔ ended_at, one row per turn number, text
 * length, the counter keys), deleting the athlete takes her chats and her counter, and it is on db-migrate.sh's list
 * exactly once, after 0103. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0104_ask_mila.sql"), "utf8");
const TABLES = ["ask_mila_sessions", "ask_mila_turns", "ask_mila_visitor_days", "ask_mila_athlete_days", "ask_mila_spend_days"];
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
const rewind = (pg: PGlite) => pg.exec(`DROP TABLE ask_mila_turns; DROP TABLE ask_mila_sessions; DROP TABLE ask_mila_visitor_days; DROP TABLE ask_mila_athlete_days; DROP TABLE ask_mila_spend_days;`);

describe("0104: the file is the schema", () => {
  it("on a database without the tables, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await rewind(got);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present, and the guards hold", async () => {
    const pg = await pushed();
    await rewind(pg);
    await pg.exec(FILE);
    const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Migration Diver') RETURNING id`);
    const [s] = await q(pg, `INSERT INTO ask_mila_sessions (athlete_id, snapshot_version, token_sha256) VALUES ($1, 1, 'h') RETURNING id`, [a.id]);
    await q(pg, `INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text) VALUES ($1, $2, 1, 'visitor', 'Hello')`, [s.id, a.id]);
    await q(pg, `INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text, gate) VALUES ($1, $2, 2, 'mila', 'Hi.', 'passed')`, [s.id, a.id]);
    await q(pg, `INSERT INTO ask_mila_visitor_days (day, visitor_hash, turns) VALUES ('2026-10-08', 'v1', 1)`);
    await q(pg, `INSERT INTO ask_mila_athlete_days (athlete_id, day, turns) VALUES ($1, '2026-10-08', 1)`, [a.id]);
    await q(pg, `INSERT INTO ask_mila_spend_days (day, turns, micro_usd) VALUES ('2026-10-08', 1, 1200)`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT intent, status, turn_count, ended_reason FROM ask_mila_sessions`)).toEqual([{ intent: "ask", status: "open", turn_count: 0, ended_reason: null }]);
    expect(await q(pg, `SELECT count(*)::int n FROM ask_mila_turns`)).toEqual([{ n: 2 }]);

    const bad = async (sql: string, params: unknown[] = []) => { await expect(pg.query(sql, params)).rejects.toThrow(); };
    // vocabularies
    await bad(`INSERT INTO ask_mila_sessions (athlete_id, snapshot_version, token_sha256, intent) VALUES ($1, 1, 'h', 'create')`, [a.id]);
    await bad(`UPDATE ask_mila_sessions SET status = 'paused' WHERE id = $1`, [s.id]);
    await bad(`INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text) VALUES ($1, $2, 3, 'athlete', 'x')`, [s.id, a.id]);
    // ended ⇔ ended_at; a known reason only
    await bad(`UPDATE ask_mila_sessions SET status = 'ended' WHERE id = $1`, [s.id]);
    await bad(`UPDATE ask_mila_sessions SET ended_at = now() WHERE id = $1`, [s.id]);
    await bad(`UPDATE ask_mila_sessions SET status = 'ended', ended_at = now(), ended_reason = 'bored' WHERE id = $1`, [s.id]);
    await q(pg, `UPDATE ask_mila_sessions SET status = 'ended', ended_at = now(), ended_reason = 'idle' WHERE id = $1`, [s.id]);
    await bad(`UPDATE ask_mila_sessions SET turn_count = -1 WHERE id = $1`, [s.id]);
    // one row per turn number in a session; text is 1–2000 characters
    await bad(`INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text) VALUES ($1, $2, 2, 'visitor', 'again')`, [s.id, a.id]);
    await bad(`INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text) VALUES ($1, $2, 9, 'visitor', '')`, [s.id, a.id]);
    await bad(`INSERT INTO ask_mila_turns (session_id, athlete_id, seq, role, text) VALUES ($1, $2, 9, 'visitor', $3)`, [s.id, a.id, "x".repeat(2001)]);
    // one counter row per key
    await bad(`INSERT INTO ask_mila_visitor_days (day, visitor_hash) VALUES ('2026-10-08', 'v1')`);
    await bad(`INSERT INTO ask_mila_athlete_days (athlete_id, day) VALUES ($1, '2026-10-08')`, [a.id]);
    await bad(`INSERT INTO ask_mila_spend_days (day) VALUES ('2026-10-08')`);
    // deleting the athlete takes her chats and her counter; the shared counters stay
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a.id]);
    expect(await q(pg, `SELECT (SELECT count(*) FROM ask_mila_sessions)::int s, (SELECT count(*) FROM ask_mila_turns)::int t, (SELECT count(*) FROM ask_mila_athlete_days)::int ad, (SELECT count(*) FROM ask_mila_visitor_days)::int vd, (SELECT count(*) FROM ask_mila_spend_days)::int sd`))
      .toEqual([{ s: 0, t: 0, ad: 0, vd: 1, sd: 1 }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("stores no IP, user agent or visitor identity column", async () => {
    const pg = await pushed();
    const cols = (await q(pg, `select column_name from information_schema.columns where table_name in (${list})`)).map((r) => r.column_name as string);
    for (const c of cols) expect({ c, bad: /(^|_)(ip|ip_address|user_agent|ua|email|phone|fingerprint)($|_)/.test(c) }).toEqual({ c, bad: false });
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0103", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0104_ask_mila \\")).toHaveLength(1);
    expect(lines.indexOf("0104_ask_mila \\")).toBeGreaterThan(lines.indexOf("0103_partner_intake \\"));
    expect(lines.indexOf("0103_partner_intake \\")).toBeGreaterThan(-1);
  });
});
