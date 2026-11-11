/**
 * connectionIdentity.migration.test.ts — migrations/0071_connection_identity.sql on a PGlite fixture that reproduces
 * the dev shape the plan found (docs/plans/connection-identity-fix.md §2 F3/F9, §5, §7 "Migration").
 *
 * The fixture, per athlete:
 *   MIA   gmail sub-1 (mia@gmail.com)       4 rows: 2 revoked old, 1 revoked WITH compose, 1 active WITH compose
 *         gmail sub-2 (riley@rileyathlete.test)    2 rows: 1 revoked, 1 active WITHOUT compose
 *         gmail, NULL sub, username MIA@gmail.com (case differs) — filled from sub-1, then merged
 *         gmail pending, 3 days old         — stale, deleted
 *         gmail pending, just now           — kept (an OAuth in flight)
 *         instagram ig-1                    2 rows: revoked (carries snapshot/identity/sync run/publish job), active
 *   DEV   gmail sub-dev                     TWO ACTIVE rows nine minutes apart (F3)
 *   Threads, messages, dead letters (with collisions), snapshots, sync runs, identities and publish jobs spread across
 *   the duplicates, plus a legacy thread with no connection.
 *
 * Applied the way `psql -f` applies it: statement at a time (the plans.migration.test.ts harness). NOT covered: a real
 * Postgres (the deploy's migration step and the §6 dev dry run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

jest.setTimeout(120_000);

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "0071_connection_identity.sql"), "utf8");
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

/** Split SQL the way psql does: top-level semicolons, dollar-quote aware, `--` comments skipped. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "", i = 0, tag: string | null = null;
  while (i < sql.length) {
    if (tag === null) {
      if (sql[i] === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        const end = nl === -1 ? sql.length : nl;
        buf += sql.slice(i, end); i = end; continue;
      }
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) { tag = m[0]; buf += tag; i += tag.length; continue; }
      if (sql[i] === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i++; continue; }
      buf += sql[i++]; continue;
    }
    if (sql.startsWith(tag, i)) { buf += tag; i += tag.length; tag = null; continue; }
    buf += sql[i++];
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** One statement at a time, each its own transaction — psql -v ON_ERROR_STOP=1 without --single-transaction. */
async function applyLikePsql(pg: PGlite, sql: string): Promise<Error | null> {
  for (const statement of splitStatements(sql)) {
    try { await pg.exec(statement); } catch (err) { return err as Error; }
  }
  return null;
}

const INDEX = "connected_accounts_account_uq";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

/** Dev and prod today: no index, no column, no log table. */
async function pre0071(pg: PGlite): Promise<void> {
  await pg.exec(`DROP INDEX ${INDEX}; ALTER TABLE connected_accounts DROP COLUMN connected_at; DROP TABLE connection_merge_log;`);
}

// ─── Fixture ids ────────────────────────────────────────────────────────────────────────────────
const MIA = "10000000-0000-0000-0000-000000000001";
const DEV = "10000000-0000-0000-0000-000000000002";
const id = (n: number) => `c0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const G1 = id(1), G2 = id(2), G3 = id(3), G4 = id(4);          // gmail sub-1
const H1 = id(5), H2 = id(6);                                  // gmail sub-2
const N1 = id(7);                                              // null sub, username matches sub-1
const P1 = id(8), P2 = id(9);                                  // stale pending, fresh pending
const I1 = id(10), I2 = id(11);                                // instagram ig-1
const D1 = id(12), D2 = id(13);                                // DEV: two ACTIVE rows, one sub
const thread = (n: number) => `70000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const RO = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
const RC = `${RO} https://www.googleapis.com/auth/gmail.compose`;

async function seedFixture(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO athletes (id, full_name) VALUES ('${MIA}', 'Mia'), ('${DEV}', 'Dev Account');

    INSERT INTO connected_accounts (id, athlete_id, platform, status, platform_user_id, platform_username, scopes, access_token, created_at) VALUES
      ('${G1}', '${MIA}', 'gmail', 'revoked', 'sub-1', 'mia@gmail.com',     '${RO}', NULL,   now() - interval '40 days'),
      ('${G2}', '${MIA}', 'gmail', 'revoked', 'sub-1', 'mia@gmail.com',     '${RO}', NULL,   now() - interval '30 days'),
      ('${G3}', '${MIA}', 'gmail', 'revoked', 'sub-1', 'mia@gmail.com',     '${RC}', NULL,   now() - interval '20 days'),
      ('${G4}', '${MIA}', 'gmail', 'active',  'sub-1', 'mia@gmail.com',     '${RC}', 'tok4', now() - interval '10 days'),
      ('${H1}', '${MIA}', 'gmail', 'revoked', 'sub-2', 'riley@rileyathlete.test',  '${RC}', NULL,   now() - interval '50 days'),
      ('${H2}', '${MIA}', 'gmail', 'active',  'sub-2', 'riley@rileyathlete.test',  '${RO}', 'tokh', now() - interval '5 days'),
      ('${N1}', '${MIA}', 'gmail', 'revoked', NULL,    'MIA@gmail.com',     '${RO}', NULL,   now() - interval '60 days'),
      ('${P1}', '${MIA}', 'outlook', 'pending', NULL,  NULL,                NULL,    NULL,   now() - interval '3 days'),
      ('${P2}', '${MIA}', 'gmail', 'pending', NULL,    NULL,                NULL,    NULL,   now()),
      ('${I1}', '${MIA}', 'instagram', 'revoked', 'ig-1', 'rileyathlete',       'x',     NULL,   now() - interval '20 days'),
      ('${I2}', '${MIA}', 'instagram', 'active',  'ig-1', 'rileyathlete',       'x',     'toki', now() - interval '2 days'),
      ('${D1}', '${DEV}', 'gmail', 'active',  'sub-dev', 'dev@example.com', '${RC}', 'tokd1', now() - interval '9 minutes' - interval '1 day'),
      ('${D2}', '${DEV}', 'gmail', 'active',  'sub-dev', 'dev@example.com', '${RC}', 'tokd2', now() - interval '1 day');

    INSERT INTO inbox_threads (id, athlete_id, connected_account_id) VALUES
      ('${thread(1)}', '${MIA}', '${G1}'), ('${thread(2)}', '${MIA}', '${G2}'), ('${thread(3)}', '${MIA}', '${G3}'),
      ('${thread(4)}', '${MIA}', '${G4}'), ('${thread(5)}', '${MIA}', '${H1}'), ('${thread(6)}', '${MIA}', '${N1}'),
      ('${thread(7)}', '${MIA}', NULL),    ('${thread(8)}', '${DEV}', '${D1}'), ('${thread(9)}', '${MIA}', '${H2}');

    INSERT INTO inbox_messages (thread_id, athlete_id, external_message_id, connected_account_id) VALUES
      ('${thread(1)}', '${MIA}', 'm1', '${G1}'), ('${thread(2)}', '${MIA}', 'm2', '${G2}'),
      ('${thread(3)}', '${MIA}', 'm3', '${G3}'), ('${thread(4)}', '${MIA}', 'm4', '${G4}'),
      ('${thread(4)}', '${MIA}', 'm4b', '${G2}'),                                          -- message on a different row than its thread (F4)
      ('${thread(5)}', '${MIA}', 'm5', '${H1}'), ('${thread(6)}', '${MIA}', 'm6', '${N1}'),
      ('${thread(7)}', '${MIA}', 'm7', NULL),    ('${thread(8)}', '${DEV}', 'm8', '${D1}');

    INSERT INTO gmail_dead_letters (id, connected_account_id, athlete_id, gmail_message_id, created_at) VALUES
      ('d0000000-0000-0000-0000-000000000001', '${G1}', '${MIA}', 'X', now() - interval '5 days'),   -- collides with dl2 (already on the survivor) → dropped
      ('d0000000-0000-0000-0000-000000000002', '${G4}', '${MIA}', 'X', now() - interval '9 days'),
      ('d0000000-0000-0000-0000-000000000003', '${G2}', '${MIA}', 'Y', now() - interval '4 days'),   -- two old rows, same message → newest kept
      ('d0000000-0000-0000-0000-000000000004', '${G3}', '${MIA}', 'Y', now() - interval '2 days'),
      ('d0000000-0000-0000-0000-000000000005', '${H1}', '${MIA}', 'Z', now());

    INSERT INTO social_analytics_snapshots (athlete_id, platform, snapshot_day, connected_account_id) VALUES
      ('${MIA}', 'instagram', '2026-09-01', '${I1}'), ('${MIA}', 'instagram', '2026-09-02', '${I2}');

    INSERT INTO social_sync_runs (athlete_id, platform, provider, endpoint_family, source_class, trigger, connected_account_id) VALUES
      ('${MIA}', 'instagram', 'meta', 'profile', 'connected_verified', 'connect', '${I1}'),
      ('${MIA}', 'instagram', 'meta', 'profile', 'connected_verified', 'nightly', '${I2}'),
      ('${MIA}', 'gmail',     'google', 'profile', 'connected_verified', 'connect', '${G1}');

    INSERT INTO social_identities (athlete_id, platform, account_id, source_class, source_method, connected_account_id) VALUES
      ('${MIA}', 'instagram', 'ig-1', 'connected_verified', 'oauth', '${I1}');

    INSERT INTO studio_publish_jobs (athlete_id, platform, mode, connected_account_id) VALUES
      ('${MIA}', 'instagram', 'dry', '${I1}');
  `);
}

const REFERENCING = ["inbox_threads", "inbox_messages", "gmail_dead_letters", "social_identities", "social_sync_runs", "social_analytics_snapshots", "studio_publish_jobs"];

async function countsPerAthlete(pg: PGlite): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of REFERENCING.filter((t) => t !== "gmail_dead_letters")) {
    out[t] = (await pg.query(`SELECT athlete_id, count(*)::int AS total, count(connected_account_id)::int AS linked FROM ${t} GROUP BY athlete_id ORDER BY athlete_id`)).rows;
  }
  return out;
}
const pointer = async (pg: PGlite, table: string, where: string) =>
  (await pg.query<{ c: string | null }>(`SELECT connected_account_id AS c FROM ${table} WHERE ${where}`)).rows.map((r) => r.c);
const ids = async (pg: PGlite, athlete: string) =>
  (await pg.query<{ id: string }>(`SELECT id FROM connected_accounts WHERE athlete_id = '${athlete}' ORDER BY id`)).rows.map((r) => r.id);

describe("0071 on the dev-shaped fixture", () => {
  let pg: PGlite;
  let before: Record<string, unknown>;
  let schemaIndexDef: string;

  beforeAll(async () => {
    pg = await pushed();
    schemaIndexDef = (await pg.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}'`)).rows[0].indexdef;
    await pre0071(pg);
    await seedFixture(pg);
    before = await countsPerAthlete(pg);
    const err = await applyLikePsql(pg, MIGRATION);
    if (err) throw err;
  });
  afterAll(async () => { await pg.close(); });

  it("keeps one survivor per account: newest ACTIVE, else newest; the recent pending row stays; the stale one goes", async () => {
    expect(await ids(pg, MIA)).toEqual([G4, H2, P2, I2].sort());
    expect(await ids(pg, DEV)).toEqual([D2]);   // two ACTIVE rows → the newer one
  });

  it("fills the null-sub row from the same athlete's matching username (case-insensitively) and merges it", async () => {
    const log = (await pg.query<{ survivor_id: string; reason: string }>(`SELECT survivor_id, reason FROM connection_merge_log WHERE old_id = '${N1}' ORDER BY reason`)).rows;
    expect(log).toEqual([
      { survivor_id: G4, reason: "duplicate_account" },
      { survivor_id: G4, reason: "filled_platform_user_id" },
    ]);
  });

  it("re-points all seven referencing tables onto the survivors", async () => {
    expect(await pointer(pg, "inbox_threads", `id IN ('${thread(1)}','${thread(2)}','${thread(3)}','${thread(4)}','${thread(6)}')`)).toEqual([G4, G4, G4, G4, G4]);
    expect(await pointer(pg, "inbox_threads", `id = '${thread(5)}'`)).toEqual([H2]);
    expect(await pointer(pg, "inbox_threads", `id = '${thread(7)}'`)).toEqual([null]);   // legacy thread stays unlinked
    expect(await pointer(pg, "inbox_threads", `id = '${thread(8)}'`)).toEqual([D2]);
    expect(await pointer(pg, "inbox_messages", `external_message_id IN ('m1','m2','m3','m4','m4b','m6')`)).toEqual([G4, G4, G4, G4, G4, G4]);
    expect(await pointer(pg, "inbox_messages", `external_message_id = 'm5'`)).toEqual([H2]);
    expect(await pointer(pg, "inbox_messages", `external_message_id = 'm8'`)).toEqual([D2]);
    expect(await pointer(pg, "social_analytics_snapshots", "true")).toEqual([I2, I2]);
    expect((await pointer(pg, "social_sync_runs", "platform = 'instagram'")).sort()).toEqual([I2, I2]);
    expect(await pointer(pg, "social_sync_runs", "platform = 'gmail'")).toEqual([G4]);
    expect(await pointer(pg, "social_identities", "true")).toEqual([I2]);
    expect(await pointer(pg, "studio_publish_jobs", "true")).toEqual([I2]);
  });

  it("deduplicates dead letters on (survivor, gmail_message_id) and moves the rest", async () => {
    const rows = (await pg.query<{ id: string; c: string; m: string }>(`SELECT id, connected_account_id AS c, gmail_message_id AS m FROM gmail_dead_letters ORDER BY gmail_message_id`)).rows;
    expect(rows).toEqual([
      { id: "d0000000-0000-0000-0000-000000000002", c: G4, m: "X" },   // the one already on the survivor won
      { id: "d0000000-0000-0000-0000-000000000004", c: G4, m: "Y" },   // newest of the two moved rows won
      { id: "d0000000-0000-0000-0000-000000000005", c: H2, m: "Z" },
    ]);
  });

  it("leaves every per-athlete count (total AND linked) unchanged", async () => {
    expect(await countsPerAthlete(pg)).toEqual(before);
  });

  it("logs every move with the old row minus its tokens and what it carried", async () => {
    const dup = (await pg.query<{ old_id: string; survivor_id: string }>(`SELECT old_id, survivor_id FROM connection_merge_log WHERE reason = 'duplicate_account' ORDER BY old_id`)).rows;
    expect(dup).toEqual([
      { old_id: G1, survivor_id: G4 }, { old_id: G2, survivor_id: G4 }, { old_id: G3, survivor_id: G4 },
      { old_id: H1, survivor_id: H2 }, { old_id: N1, survivor_id: G4 }, { old_id: I1, survivor_id: I2 },
      { old_id: D1, survivor_id: D2 },
    ]);
    const stale = (await pg.query<{ old_id: string; survivor_id: string | null }>(`SELECT old_id, survivor_id FROM connection_merge_log WHERE reason = 'stale_pending'`)).rows;
    expect(stale).toEqual([{ old_id: P1, survivor_id: null }]);

    const [g1] = (await pg.query<{ repointed: any; old_row: any }>(`SELECT repointed, old_row FROM connection_merge_log WHERE old_id = '${G1}'`)).rows;
    expect(g1.repointed).toMatchObject({ inbox_threads: 1, inbox_messages: 1, social_sync_runs: 1, gmail_dead_letters: 0 });   // its dead letter was the dropped duplicate
    expect(g1.old_row).toMatchObject({ id: G1, status: "revoked", platform_user_id: "sub-1" });
    const [d1] = (await pg.query<{ old_row: any }>(`SELECT old_row FROM connection_merge_log WHERE old_id = '${D1}'`)).rows;
    expect(d1.old_row).not.toHaveProperty("access_token");
    expect(d1.old_row).not.toHaveProperty("refresh_token");
  });

  it("backfills connected_at from created_at for every row that ever connected; a pending row has none", async () => {
    const rows = (await pg.query<{ id: string; same: boolean | null }>(`SELECT id, connected_at = created_at AS same FROM connected_accounts ORDER BY id`)).rows;
    expect(rows).toEqual([G4, H2, P2, I2, D2].sort().map((i) => ({ id: i, same: i === P2 ? null : true })));
  });

  it("builds the unique index exactly as schema.ts declares it, and the database now refuses a second row", async () => {
    const def = (await pg.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}'`)).rows[0]?.indexdef;
    expect(def).toBe(schemaIndexDef);
    await expect(pg.exec(`INSERT INTO connected_accounts (athlete_id, platform, status, platform_user_id) VALUES ('${MIA}', 'gmail', 'revoked', 'sub-1')`)).rejects.toThrow(/connected_accounts_account_uq/);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const snapshot = async () => ({
      accounts: (await pg.query(`SELECT * FROM connected_accounts ORDER BY id`)).rows,
      log:      (await pg.query(`SELECT count(*)::int AS n FROM connection_merge_log`)).rows,
      counts:   await countsPerAthlete(pg),
      dl:       (await pg.query(`SELECT * FROM gmail_dead_letters ORDER BY id`)).rows,
    });
    const first = await snapshot();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await snapshot()).toEqual(first);
  });
});

describe("0071 aborts as a unit", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await pushed();
    await pre0071(pg);
    await seedFixture(pg);
  });
  afterAll(async () => { await pg.close(); });

  it("an orphaned reference (a table whose FK is missing on the live database) makes it RAISE, and every step rolls back", async () => {
    // A legacy database can lack a foreign key the schema declares; then a thread can point at nothing.
    await pg.exec(`ALTER TABLE inbox_threads DROP CONSTRAINT IF EXISTS inbox_threads_connected_account_id_connected_accounts_id_fk;
                   INSERT INTO inbox_threads (athlete_id, connected_account_id) VALUES ('${MIA}', 'eeeeeeee-0000-0000-0000-000000000000');`);
    const accountsBefore = (await pg.query(`SELECT to_jsonb(c) - 'connected_at' AS r FROM connected_accounts c ORDER BY id`)).rows;

    const err = await applyLikePsql(pg, MIGRATION);
    expect(err?.message).toMatch(/0071: 1 referencing rows point at a connection that does not exist/);

    // Nothing moved, nothing deleted, nothing logged — the DO block is one statement.
    expect((await pg.query(`SELECT to_jsonb(c) - 'connected_at' AS r FROM connected_accounts c ORDER BY id`)).rows).toEqual(accountsBefore);   // the ADD COLUMN IF NOT EXISTS before the DO block is harmless and stays
    expect(await pointer(pg, "inbox_threads", `id = '${thread(1)}'`)).toEqual([G1]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM connection_merge_log`)).rows).toEqual([{ n: 0 }]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${INDEX}'`)).rows).toEqual([{ n: 0 }]);
  });
});

describe("0071 is wired into the deploy's migration path", () => {
  it("is on db-migrate.sh's step-3 list exactly once, right after 0070", () => {
    const list = DB_MIGRATE.split("\n").map((l) => l.trim());
    expect(list.filter((l) => l === "0071_connection_identity \\")).toHaveLength(1);
    expect(list.indexOf("0071_connection_identity \\")).toBe(list.indexOf("0070_objective_deferral \\") + 1);
  });

  it("carries no transaction control of its own (the 11 Sep 2026 rule)", () => {
    const stripped = MIGRATION.replace(/--[^\n]*/g, "");
    expect(stripped.match(/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/gim)).toBeNull();
  });
});
