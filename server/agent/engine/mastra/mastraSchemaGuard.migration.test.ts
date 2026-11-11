/**
 * mastraSchemaGuard.migration.test.ts — every table in Mastra's schema is classified, the way athleteDataManifest's
 * guard classifies every table of ours (PGlite, no providers).
 *
 * lifecycle.ts finds an athlete's Mastra rows by resource / thread COLUMN NAME, so a table with neither column is
 * invisible to account deletion AND to the data export. Comparing the export with the sweep cannot catch that (both
 * come from the same discovery), so this guard checks the schema itself:
 *
 *   classified   every table in schema "mastra" (information_schema after applying 0147, and every `"mastra"."x"`
 *                any migration file creates) is EITHER keyed (a resource / thread column, or mastra_threads /
 *                mastra_resources by id) OR on MASTRA_NOT_ATHLETE_TABLES with a reason. A new table fails here until
 *                it is classified.
 *   list honest  every listed table exists, has no resource / thread column (else it belongs to the sweep, not the
 *                list) and has a non-empty reason.
 *   invariant    the sweep's OR-match relies on "Mastra never holds a row whose resource and thread belong to
 *                different athletes"; our side of it is guards.ts assertThreadOwned (a thread naming another resource
 *                is refused), pinned here.
 */
jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { client, initTestDb, closeTestDb } from "../../../testUtils/pgliteDb";
import { MASTRA_MIGRATION_FILE } from "./ddl";
import { MASTRA_NOT_ATHLETE_TABLES, RESOURCE_COLS, THREAD_COLS } from "./lifecycle";
import { assertThreadOwned, TenantGuardError } from "./guards";

const ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = join(ROOT, "migrations");
const q = async (s: string, params: unknown[] = []) => (await client.query<any>(s, params)).rows;
const BY_ID = new Set(["mastra_threads", "mastra_resources"]);

let tables: string[] = [];
let keyed = new Set<string>();

beforeAll(async () => {
  await initTestDb();
  await client.exec(readFileSync(join(MIGRATIONS, MASTRA_MIGRATION_FILE), "utf8"));
  tables = (await q(`select table_name from information_schema.tables where table_schema = 'mastra' order by 1`)).map((r) => r.table_name);
  keyed = new Set((await q(
    `select distinct table_name from information_schema.columns where table_schema = 'mastra' and column_name = any($1)`,
    [[...RESOURCE_COLS, ...THREAD_COLS]],
  )).map((r) => r.table_name));
}, 120_000);
afterAll(async () => { await closeTestDb(); });

describe("Mastra schema guard", () => {
  it("every table in the mastra schema is keyed to an athlete or classified as not athlete data", () => {
    expect(tables.length).toBeGreaterThan(0);
    const unclassified = tables.filter((t) => !keyed.has(t) && !BY_ID.has(t) && !(t in MASTRA_NOT_ATHLETE_TABLES));
    expect(unclassified).toEqual([]); // a new Mastra table: key it to her, or add it to MASTRA_NOT_ATHLETE_TABLES with a reason
  });

  it("every mastra table any migration creates is classified too (not only those 0147 applies here)", () => {
    const created = new Set<string>();
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
      const text = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?mastra"?\."?(\w+)"?/gi)) created.add(m[1]);
    }
    expect(created.size).toBeGreaterThan(0);
    const known = new Set(tables);
    expect([...created].filter((t) => !known.has(t) && !(t in MASTRA_NOT_ATHLETE_TABLES))).toEqual([]);
  });

  it("the not-athlete-data list is honest: each table exists, has no resource / thread column, and a reason", () => {
    for (const [t, reason] of Object.entries(MASTRA_NOT_ATHLETE_TABLES)) {
      expect({ t, exists: tables.includes(t) }).toEqual({ t, exists: true });
      expect({ t, keyed: keyed.has(t) || BY_ID.has(t) }).toEqual({ t, keyed: false });
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it("invariant: a Mastra thread naming another resource is refused before Mastra uses it (guards.ts)", async () => {
    const memory = { getThreadById: async () => ({ resourceId: "athlete-b" }) };
    await expect(assertThreadOwned(memory, "athlete-a", "thread-1", { ownsThread: async () => true }))
      .rejects.toMatchObject({ code: "thread_resource_mismatch" });
    await expect(assertThreadOwned(memory, "athlete-a", "thread-1", { ownsThread: async () => true }))
      .rejects.toBeInstanceOf(TenantGuardError);
    const own = { getThreadById: async () => ({ resourceId: "athlete-a" }) };
    await expect(assertThreadOwned(own, "athlete-a", "thread-1", { ownsThread: async () => true })).resolves.toEqual({ exists: true });
  });
});
