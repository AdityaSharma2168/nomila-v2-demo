/**
 * exportMastraData.test.ts — the athlete's Mastra engine footprint in the data export, on PGlite. Mirrors
 * agent/engine/mastra/mastraStore.migration.test.ts's seeding (the account-deletion test for the same schema), so
 * export and delete are proven against the same fixture shape.
 *
 *   contains      her Mastra thread, messages and working-memory resource row, by resource/thread id — none of
 *                 another athlete's, even a message in her own thread that names no resource
 *   missing schema  a database before 0147 (prod today) is skipped cleanly: present: false, a plain note, no query
 *   lists every table  every table the delete sweep would touch (athleteFootprintByTable) appears as an export key,
 *                 (tables with neither key are covered by mastraSchemaGuard.migration.test.ts, not here)
 *   exclusive     a row in her thread that Mastra attributes to another athlete, and a thread keyed by her session
 *                 row id whose resource is another athlete (with its thread-only rows), are NOT exported to her —
 *                 while the delete sweep still counts them (deletion behaviour unchanged)
 *   identifiers   a discovered table name that is not a plain identifier is refused, never spliced into SQL
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { MASTRA_MIGRATION_FILE } from "../../agent/engine/mastra/ddl";
import { athleteFootprintByTable, countMastraFootprint, safeIdent } from "../../agent/engine/mastra/lifecycle";
import { buildMastraExport } from "./exportMastraData";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", MASTRA_MIGRATION_FILE), "utf8");
const q = async (s: string, params: unknown[] = []) => (await client.query<any>(s, params)).rows;

beforeAll(async () => {
  await initTestDb();
  await client.exec(FILE);
}, 120_000);
afterAll(async () => { await closeTestDb(); });

async function seedThread(athleteId: string, threadId: string, words: string) {
  await q(`insert into mila_tf_sessions (id, athlete_id, conversation_id, tf_session_id) values ($1, $2, null, $3)`, [threadId, athleteId, `mastra:${threadId}`]);
  await q(`insert into mastra.mastra_threads (id, "resourceId", title, "createdAt", "updatedAt") values ($1, $2, '', now(), now())`, [threadId, athleteId]);
  for (const role of ["user", "assistant"]) {
    await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") values ($1, $2, $3, $4, 'v2', now(), $5)`,
      [randomUUID(), threadId, JSON.stringify({ parts: [{ type: "text", text: words }] }), role, athleteId]);
  }
}

describe("buildMastraExport", () => {
  it("contains her own threads, messages and working-memory resource row, and none of another athlete's", async () => {
    const A = await seedAthlete("Mastra Export A");
    const B = await seedAthlete("Mastra Export B");
    const [a1, b1] = [randomUUID(), randomUUID()];
    await seedThread(A, a1, "a-words-canary-471");
    await seedThread(B, b1, "b-words-canary-902");
    // A message in A's own thread that names no resource: still hers, by thread (as account deletion treats it).
    await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt") values ($1, $2, '{}', 'user', 'v2', now())`, [randomUUID(), a1]);
    await q(`insert into mastra.mastra_resources (id, "workingMemory", "createdAt", "updatedAt") values ($1, $2, now(), now()), ($3, $4, now(), now())`,
      [A, "A likes short replies", B, "B likes long replies"]);

    const out = await buildMastraExport(A);
    expect(out.present).toBe(true);
    expect(out.schema).toBe("mastra");

    expect(out.tables.mastra_threads.count).toBe(1);
    expect(out.tables.mastra_threads.rows[0].id).toBe(a1);

    expect(out.tables.mastra_messages.count).toBe(3); // 2 + the resource-less one
    const text = JSON.stringify(out.tables.mastra_messages.rows);
    expect(text).toContain("a-words-canary-471");
    expect(text).not.toContain("b-words-canary-902");
    expect(out.tables.mastra_messages.rows.every((r) => r.thread_id === a1)).toBe(true);

    expect(out.tables.mastra_resources.count).toBe(1);
    expect(out.tables.mastra_resources.rows[0]).toMatchObject({ id: A, workingMemory: "A likes short replies" });

    // Nothing of B's anywhere in the document.
    const whole = JSON.stringify(out);
    expect(whole).not.toContain(B);
    expect(whole).not.toContain("b-words-canary-902");
    expect(whole).not.toContain("B likes long replies");
  });

  it("skips a database without the schema cleanly, with a note, and runs no query", async () => {
    const out = await buildMastraExport(randomUUID(), "no_such_schema");
    expect(out).toEqual({ schema: "no_such_schema", present: false, note: expect.stringContaining("no_such_schema"), tables: {} });
  });

  it("lists every table the delete sweep would touch (resource / thread keyed tables)", async () => {
    const A = await seedAthlete("Mastra Export Manifest A");
    const threadId = randomUUID();
    await seedThread(A, threadId, "manifest-check");

    const out = await buildMastraExport(A);
    const swept = [...(await athleteFootprintByTable("mastra", A)).keys()].sort();
    expect(Object.keys(out.tables).sort()).toEqual(swept);
    expect(swept).toEqual(expect.arrayContaining(["mastra_threads", "mastra_messages", "mastra_resources"]));
  });

  it("is exclusive: rows Mastra attributes to another athlete never reach her, even in her thread (delete still sweeps them)", async () => {
    const A = await seedAthlete("Mastra Export Exclusive A");
    const B = await seedAthlete("Mastra Export Exclusive B");
    const own = randomUUID();
    await seedThread(A, own, "a-own-thread");
    // A message in A's thread that Mastra attributes to B.
    await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") values ($1, $2, $3, 'user', 'v2', now(), $4)`,
      [randomUUID(), own, JSON.stringify({ parts: [{ type: "text", text: "b-in-a-thread-canary-313" }] }), B]);
    // A session row of A's whose Mastra thread names B, with a resource-less message and thread-only state.
    const crossed = randomUUID();
    await q(`insert into mila_tf_sessions (id, athlete_id, conversation_id, tf_session_id) values ($1, $2, null, $3)`, [crossed, A, `mastra:${crossed}`]);
    await q(`insert into mastra.mastra_threads (id, "resourceId", title, "createdAt", "updatedAt") values ($1, $2, 'crossed-title-canary-554', now(), now())`, [crossed, B]);
    await q(`insert into mastra.mastra_messages (id, thread_id, content, role, type, "createdAt") values ($1, $2, $3, 'user', 'v2', now())`,
      [randomUUID(), crossed, JSON.stringify({ parts: [{ type: "text", text: "crossed-msg-canary-555" }] })]);
    await q(`insert into mastra.mastra_thread_state ("threadId", type, value, "createdAt", "updatedAt") values ($1, 'x', '{"s":"crossed-state-canary-556"}', now(), now())`, [crossed]);

    const out = await buildMastraExport(A);
    const whole = JSON.stringify(out);
    for (const canary of ["b-in-a-thread-canary-313", "crossed-title-canary-554", "crossed-msg-canary-555", "crossed-state-canary-556", B, crossed]) {
      expect(whole).not.toContain(canary);
    }
    expect(out.tables.mastra_threads.rows.map((r) => r.id)).toEqual([own]);
    expect(out.tables.mastra_messages.count).toBe(2);

    // Deletion's sweep is unchanged: it still reaches everything keyed by her session rows.
    const counted = await countMastraFootprint(A);
    expect(counted.mastra_threads).toBe(2);
    expect(counted.mastra_messages).toBe(4);
    expect(counted.mastra_thread_state).toBe(1);
  });

  it("refuses a discovered table name that is not a plain identifier", async () => {
    expect(() => safeIdent('x" ; DROP TABLE athletes; --')).toThrow(/non-plain identifier/);
    await q(`create schema evil_mastra`);
    await q(`create table evil_mastra.mastra_threads (id text primary key, "resourceId" text not null)`);
    await q(`create table evil_mastra."t"" OR true OR ""x" ("resourceId" text)`);
    await expect(buildMastraExport(randomUUID(), "evil_mastra")).rejects.toThrow(/non-plain identifier/);
  });

  it("invariant: while no row crosses athletes, the export holds exactly the rows the delete sweep counts", async () => {
    // The sweep's OR-match is only right because Mastra never holds a row whose resource and thread belong to
    // different athletes (lifecycle.ts header; guards.ts keeps it). On data that keeps it, exclusive == sweep.
    const A = await seedAthlete("Mastra Export Invariant A");
    const B = await seedAthlete("Mastra Export Invariant B");
    await seedThread(A, randomUUID(), "inv-a1");
    await seedThread(A, randomUUID(), "inv-a2");
    await seedThread(B, randomUUID(), "inv-b1");
    const out = await buildMastraExport(A);
    const exported = Object.fromEntries(Object.entries(out.tables).filter(([, t]) => t.count > 0).map(([k, t]) => [k, t.count]));
    expect(exported).toEqual(await countMastraFootprint(A));
  });
});
