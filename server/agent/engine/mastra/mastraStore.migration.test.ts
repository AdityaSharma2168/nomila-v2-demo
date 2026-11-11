/**
 * mastraStore.migration.test.ts — 0147 (the Mastra engine's own schema) and the account-deletion purge of it, on PGlite.
 *
 *   file      a FRESH install: Mastra's part equals what @mastra/pg 1.32.0 (the installed, pinned version) exports, then
 *             our own three nullable columns on mila_tf_sessions; every statement IF NOT EXISTS; no transaction control;
 *             listed once in db-migrate.sh, after 0145. The equality holds for a fresh install only: IF NOT EXISTS
 *             never alters a table that exists, so a @mastra/pg bump whose DDL differs needs a NEW migration with the
 *             ALTERs (this test fails on the bump until the pinned version is moved with that migration)
 *   apply     on a fresh database: 53 tables in schema "mastra", no new table in public (three columns on
 *             mila_tf_sessions); re-runs as a no-op; the POC's dev-only "mastra_poc" schema is dropped
 *   purge     deleteMastraFootprint removes exactly one athlete's threads, messages and resource row (by resource and by
 *             their session-row thread ids), never another athlete's; account deletion purge_rows does it before the
 *             session rows go and verify counts it (remainingRows)
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { client, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { mastraExportSql, mastraMigrationSql, MASTRA_MIGRATION_FILE, MASTRA_PG_VERSION_0147, OUR_COLUMNS_SQL } from "./ddl";
import { countMastraFootprint, deleteMastraFootprint } from "./lifecycle";
import { purgeRows, remainingRows } from "../../../services/privacy/accountDeletionSteps";

const ROOT = join(__dirname, "..", "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", MASTRA_MIGRATION_FILE), "utf8").replace(/\r\n/g, "\n");
const q = async (sql: string, params: unknown[] = []) => (await client.query<any>(sql, params)).rows;

beforeAll(async () => { await initTestDb(); }, 120_000);
afterAll(async () => { await closeTestDb(); });

describe("0147: the file", () => {
  it("a fresh install: what @mastra/pg 1.32.0 exports, under our header, then our columns", () => {
    // A bump of @mastra/pg lands here first. Do NOT regenerate 0147 (applied already; IF NOT EXISTS would not alter the
    // existing tables): write a new numbered migration with the ALTERs, then move MASTRA_PG_VERSION_0147's check.
    const installed = JSON.parse(readFileSync(join(require.resolve("@mastra/pg"), "..", "..", "package.json"), "utf8")).version;
    expect({ installed, rule: "a @mastra/pg bump needs a new ALTER migration, not an edit of 0147" }).toEqual({ installed: MASTRA_PG_VERSION_0147, rule: expect.any(String) });
    expect(FILE).toBe(mastraMigrationSql());
    expect(FILE).toContain(`${mastraExportSql()}\n\n${OUR_COLUMNS_SQL}\n`);
    expect(FILE.trimEnd().endsWith(OUR_COLUMNS_SQL)).toBe(true);
  });

  it("touches public only by adding nullable columns to mila_tf_sessions", () => {
    // Everything after Mastra's own part is ours: exactly these three statements (Mastra's part names only its schemas).
    const ours = FILE.slice(FILE.indexOf(mastraExportSql()) + mastraExportSql().length).split("\n").filter((l) => l.trim() && !l.startsWith("--"));
    expect(mastraExportSql()).not.toMatch(/mila_tf_sessions|"public"/);
    expect(ours.map((l) => l.replace(/;$/, ""))).toEqual([
      'ALTER TABLE "mila_tf_sessions" ADD COLUMN IF NOT EXISTS "running_run_id" uuid',
      'ALTER TABLE "mila_tf_sessions" ADD COLUMN IF NOT EXISTS "running_at" timestamp with time zone',
      'ALTER TABLE "mila_tf_sessions" ADD COLUMN IF NOT EXISTS "last_engine" text',
    ]);
  });

  it("has no transaction control and creates only IF NOT EXISTS", () => {
    // (plpgsql bodies have BEGIN … END; blocks: those are not transaction control)
    expect(FILE).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im);
    const creates = FILE.match(/CREATE (TABLE|INDEX|UNIQUE INDEX|SCHEMA)\b[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(50);
    for (const c of creates) expect([c.slice(0, 80), /IF NOT EXISTS/i.test(c)]).toEqual([c.slice(0, 80), true]);
  });

  it("is on db-migrate.sh once, after 0145", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/^\s*0147_mastra_engine \\$/gm)).toHaveLength(1);
    expect(sh.indexOf("0147_mastra_engine")).toBeGreaterThan(sh.indexOf("0145_account_deletion_two_phase"));
  });
});

describe("0147: applied", () => {
  it("creates the mastra schema (53 tables), no table in public, re-runs as a no-op, drops mastra_poc", async () => {
    await client.exec(`CREATE SCHEMA mastra_poc; CREATE TABLE mastra_poc.mastra_threads (id text primary key);`);
    const publicBefore = await q(`select count(*)::int n from information_schema.tables where table_schema = 'public'`);
    await client.exec(FILE);
    await client.exec(FILE);
    expect(await q(`select count(*)::int n from information_schema.tables where table_schema = 'mastra'`)).toEqual([{ n: 53 }]);
    expect(await q(`select count(*)::int n from information_schema.tables where table_schema = 'public'`)).toEqual(publicBefore);
    expect(await q(`select count(*)::int n from information_schema.schemata where schema_name = 'mastra_poc'`)).toEqual([{ n: 0 }]);
    const cols = await q(`select column_name, is_nullable from information_schema.columns where table_name = 'mila_tf_sessions' and column_name in ('running_run_id', 'running_at', 'last_engine') order by column_name`);
    expect(cols).toEqual([{ column_name: "last_engine", is_nullable: "YES" }, { column_name: "running_at", is_nullable: "YES" }, { column_name: "running_run_id", is_nullable: "YES" }]);
  }, 120_000);
});

describe("account deletion: the Mastra footprint", () => {
  async function seedThread(athleteId: string, threadId: string, words: string) {
    await q(`insert into mila_tf_sessions (id, athlete_id, conversation_id, tf_session_id) values ($1, $2, null, $3)`, [threadId, athleteId, `mastra:${threadId}`]);
    await q(`insert into mastra.mastra_threads (id, "resourceId", title, "createdAt", "updatedAt") values ($1, $2, '', now(), now())`, [threadId, athleteId]);
    for (const role of ["user", "assistant"]) {
      await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") values ($1, $2, $3, $4, 'v2', now(), $5)`,
        [randomUUID(), threadId, JSON.stringify({ parts: [{ type: "text", text: words }] }), role, athleteId]);
    }
  }

  it("deletes one athlete's threads, messages and resource row, and nothing of another's", async () => {
    const A = await seedAthlete("Mastra Purge A");
    const B = await seedAthlete("Mastra Purge B");
    const [a1, a2, b1] = [randomUUID(), randomUUID(), randomUUID()];
    await seedThread(A, a1, "a-words"); await seedThread(A, a2, "a-more"); await seedThread(B, b1, "b-words");
    // A message in one of A's threads that names no resource (Mastra allows it) is still A's, by thread.
    await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt") values ($1, $2, '{}', 'user', 'v2', now())`, [randomUUID(), a1]);
    await q(`insert into mastra.mastra_resources (id, "workingMemory", "createdAt", "updatedAt") values ($1, null, now(), now()), ($2, null, now(), now())`, [A, B]);

    expect(await countMastraFootprint(A)).toEqual({ mastra_messages: 5, mastra_resources: 1, mastra_threads: 2 });
    const bBefore = await countMastraFootprint(B);
    expect(await deleteMastraFootprint(A)).toEqual({ mastra_messages: 5, mastra_resources: 1, mastra_threads: 2 });
    expect(await countMastraFootprint(A)).toEqual({});
    expect(await deleteMastraFootprint(A)).toEqual({});   // idempotent
    expect(await countMastraFootprint(B)).toEqual(bBefore);
    expect(bBefore).toEqual({ mastra_messages: 2, mastra_resources: 1, mastra_threads: 1 });
  });

  it("purge_rows removes it before the session rows go; verify (remainingRows) sees it", async () => {
    const C = await seedAthlete("Mastra Purge C");
    const D = await seedAthlete("Mastra Purge D");
    const c1 = randomUUID();
    const d1 = randomUUID();
    await seedThread(C, c1, "c-words"); await seedThread(D, d1, "d-words");
    expect(await remainingRows({ athleteId: C, userIds: [] })).toMatchObject({ "mastra.mastra_messages": 2, "mastra.mastra_threads": 1 });
    const deleted = await purgeRows({ athleteId: C, userIds: [] });
    expect(deleted).toMatchObject({ "mastra.mastra_messages": 2, "mastra.mastra_threads": 1 });
    expect(Object.keys(await remainingRows({ athleteId: C, userIds: [] }))).toEqual([]);
    expect(await countMastraFootprint(D)).toEqual({ mastra_messages: 2, mastra_threads: 1 });
  });

  it("a database without the schema (before 0147) has no footprint and the purge is a no-op", async () => {
    expect(await countMastraFootprint(randomUUID(), "no_such_schema")).toEqual({});
    expect(await deleteMastraFootprint(randomUUID(), "no_such_schema")).toEqual({});
  });
});
