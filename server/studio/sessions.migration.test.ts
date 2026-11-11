/**
 * sessions.migration.test.ts — migrations/0054_studio_sessions.sql is the thing that reaches nomila-v2-db and
 * nomila-prod-db; shared/schema.ts is the thing every PGlite suite (and Drizzle's every query) believes. This proves
 * they describe the same two tables, and that the file is safe to run again.
 *
 *   1. THE FILE, TWICE, ON A FRESH DATABASE. A PGlite that has every other table (schema.ts pushed WITHOUT the two
 *      session tables, so the FK targets exist) gets 0054 applied, then applied again — the second run must be a
 *      no-op, which is what db-migrate.sh relies on every deploy.
 *   2. THE SAME SHAPE AS schema.ts. A second fresh PGlite gets the whole of schema.ts pushed, exactly as
 *      server/testUtils/pgliteDb.ts does, and the two tables are compared column by column (type, nullability,
 *      default, identity), constraint by constraint (by definition — Postgres and Drizzle auto-name an inline FK
 *      differently, and nothing reads those names) and index by index (by name AND definition).
 *   3. THE FILE IS ON THE LIST. PGlite never runs db-migrate.sh, so a missing step-3 line is invisible to every other
 *      suite — and the HARD drift gate would red the deploy that merged it (studio-ddl-path).
 *
 * Constraint BEHAVIOUR (tenancy FK, one entry per preview, SET NULL, cascades) is exercised against the
 * migration-applied database here, and against the schema.ts one in sessions.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0054_studio_sessions.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
const TABLES = ["studio_sessions", "studio_session_entries"];
const IN_TABLES = `('studio_sessions', 'studio_session_entries')`;

/** Push a set of schema.ts exports into a fresh PGlite — pgliteDb.ts's initTestDb, on an instance of our own. */
async function pushed(exports: Record<string, unknown>): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import(
    "drizzle-kit/api"
  );
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(exports),
  );
  for (const s of statements) await pg.exec(s);
  return pg;
}

interface Shape {
  columns: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
}

async function shapeOf(pg: PGlite): Promise<Shape> {
  const columns = await pg.query<Record<string, unknown>>(
    `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default,
            is_identity, identity_generation, identity_start, identity_increment, identity_maximum,
            identity_minimum, identity_cycle
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ${IN_TABLES}
      ORDER BY table_name, ordinal_position`,
  );
  const constraints = await pg.query<Record<string, unknown>>(
    `SELECT conrelid::regclass::text AS table_name, contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = ANY(ARRAY['studio_sessions'::regclass, 'studio_session_entries'::regclass])
      ORDER BY 1, 2, 3`,
  );
  const indexes = await pg.query<Record<string, unknown>>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ${IN_TABLES}
      ORDER BY tablename, indexname`,
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

let fromFile: PGlite;
let fromSchema: PGlite;

beforeAll(async () => {
  const others = Object.fromEntries(
    Object.entries(schema).filter(
      ([name]) => name !== "studioSessions" && name !== "studioSessionEntries",
    ),
  );
  fromFile = await pushed(others);
  await fromFile.exec(MIGRATION);
  await fromFile.exec(MIGRATION); // db-migrate.sh runs every file on every deploy
  fromSchema = await pushed(schema);
}, 120_000);

afterAll(async () => {
  await fromFile?.close();
  await fromSchema?.close();
});

describe("0054_studio_sessions: the file matches shared/schema.ts", () => {
  it("creates both tables, and survives a second run (the shape tests below see no duplicate)", async () => {
    const shape = await shapeOf(fromFile);
    expect(new Set(shape.columns.map((c) => c.table_name))).toEqual(
      new Set(TABLES),
    );
  });

  it("has the same columns — type, nullability, default, identity, order", async () => {
    const [a, b] = [await shapeOf(fromFile), await shapeOf(fromSchema)];
    expect(a.columns).toEqual(b.columns);
    // Hand-written beside the comparison, so a change to BOTH sides still has to get past a reader.
    const cols = (t: string) =>
      a.columns.filter((c) => c.table_name === t).map((c) => c.column_name);
    expect(cols("studio_sessions")).toEqual([
      "id",
      "athlete_id",
      "title",
      "archived_at",
      "created_at",
      "updated_at",
    ]);
    expect(cols("studio_session_entries")).toEqual([
      "id",
      "seq",
      "session_id",
      "athlete_id",
      "kind",
      "text",
      "payload",
      "preview_id",
      "created_at",
    ]);
    const seq = a.columns.find((c) => c.column_name === "seq")!;
    expect(seq).toMatchObject({
      data_type: "bigint",
      is_identity: "YES",
      identity_generation: "ALWAYS",
      is_nullable: "NO",
    });
  });

  it("has the same constraints, by definition", async () => {
    const [a, b] = [await shapeOf(fromFile), await shapeOf(fromSchema)];
    expect(a.constraints).toEqual(b.constraints);
    const defs = a.constraints.map((c) => c.def);
    expect(defs).toEqual(
      expect.arrayContaining([
        "UNIQUE (id, athlete_id)",
        "FOREIGN KEY (session_id, athlete_id) REFERENCES studio_sessions(id, athlete_id) ON DELETE CASCADE",
        "FOREIGN KEY (preview_id) REFERENCES studio_generation_previews(id) ON DELETE SET NULL",
        "FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE",
      ]),
    );
  });

  it("names the two constraints it names, identically on both sides", async () => {
    for (const pg of [fromFile, fromSchema]) {
      const { rows } = await pg.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname IN ('studio_sessions_id_athlete_uniq', 'studio_session_entries_session_fk')`,
      );
      expect(rows.map((r) => r.conname).sort()).toEqual([
        "studio_session_entries_session_fk",
        "studio_sessions_id_athlete_uniq",
      ]);
    }
  });

  it("has the same indexes, by name and definition", async () => {
    const [a, b] = [await shapeOf(fromFile), await shapeOf(fromSchema)];
    expect(a.indexes).toEqual(b.indexes);
    expect(a.indexes.map((i) => String(i.indexname)).sort()).toEqual([
      "idx_studio_session_entries_session",
      "idx_studio_sessions_athlete_updated",
      "studio_session_entries_pkey",
      "studio_sessions_id_athlete_uniq",
      "studio_sessions_pkey",
      "uq_studio_session_entries_preview",
    ]);
  });
});

describe("0054_studio_sessions: the constraints the file creates bite", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const PREVIEW_A = "bbbbbbbb-0000-4000-8000-000000000001";

  beforeAll(async () => {
    await fromFile.query(
      `INSERT INTO athletes (id, full_name) VALUES ($1, 'A'), ($2, 'B')`,
      [A, B],
    );
    await fromFile.query(
      `INSERT INTO studio_sessions (id, athlete_id) VALUES ($1, $2)`,
      [SESSION_A, A],
    );
    await fromFile.query(
      `INSERT INTO studio_generation_previews (id, athlete_id, brief, status, expires_at) VALUES ($1, $2, '{}'::jsonb, 'ready', now())`,
      [PREVIEW_A, A],
    );
  });

  it("refuses an entry that names another athlete's session", async () => {
    await expect(
      fromFile.query(
        `INSERT INTO studio_session_entries (session_id, athlete_id, kind) VALUES ($1, $2, 'prompt')`,
        [SESSION_A, B],
      ),
    ).rejects.toThrow(/studio_session_entries_session_fk/);
  });

  it("allows one entry per preview, then sets it null when the preview goes — and keeps the entry", async () => {
    await fromFile.query(
      `INSERT INTO studio_session_entries (session_id, athlete_id, kind, preview_id) VALUES ($1, $2, 'plan', $3)`,
      [SESSION_A, A, PREVIEW_A],
    );
    await expect(
      fromFile.query(
        `INSERT INTO studio_session_entries (session_id, athlete_id, kind, preview_id) VALUES ($1, $2, 'plan', $3)`,
        [SESSION_A, A, PREVIEW_A],
      ),
    ).rejects.toThrow(/uq_studio_session_entries_preview/);
    await fromFile.query(
      `DELETE FROM studio_generation_previews WHERE id = $1`,
      [PREVIEW_A],
    );
    const { rows } = await fromFile.query<{ preview_id: string | null }>(
      `SELECT preview_id FROM studio_session_entries WHERE session_id = $1 AND kind = 'plan'`,
      [SESSION_A],
    );
    expect(rows).toEqual([{ preview_id: null }]);
  });

  it("numbers entries in insertion order, and refuses a hand-written seq", async () => {
    const { rows } = await fromFile.query<{ seq: number }>(
      `INSERT INTO studio_session_entries (session_id, athlete_id, kind) VALUES ($1, $2, 'prompt'), ($1, $2, 'ask') RETURNING seq`,
      [SESSION_A, A],
    );
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
    await expect(
      fromFile.query(
        `INSERT INTO studio_session_entries (seq, session_id, athlete_id, kind) VALUES (1, $1, $2, 'prompt')`,
        [SESSION_A, A],
      ),
    ).rejects.toThrow(/non-DEFAULT value into column "seq"/);
  });

  it("cascades a thread's entries with the thread, and both with the athlete", async () => {
    const count = async () =>
      Number(
        (
          await fromFile.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM studio_session_entries WHERE athlete_id = $1`,
            [A],
          )
        ).rows[0].n,
      );
    expect(await count()).toBeGreaterThan(0);
    await fromFile.query(`DELETE FROM studio_sessions WHERE id = $1`, [
      SESSION_A,
    ]);
    expect(await count()).toBe(0);

    await fromFile.query(
      `INSERT INTO studio_sessions (id, athlete_id) VALUES ($1, $2)`,
      [SESSION_A, A],
    );
    await fromFile.query(
      `INSERT INTO studio_session_entries (session_id, athlete_id, kind) VALUES ($1, $2, 'prompt')`,
      [SESSION_A, A],
    );
    await fromFile.query(`DELETE FROM athletes WHERE id = $1`, [A]);
    const left = await fromFile.query(
      `SELECT 1 FROM studio_sessions WHERE athlete_id = $1`,
      [A],
    );
    expect(left.rows).toEqual([]);
    expect(await count()).toBe(0);
  });
});

describe("0054_studio_sessions: db-migrate.sh runs it", () => {
  // The step-3 list, as the loop reads it: the `for f in \ … ; do` block.
  const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/\\$/, "").trim())
    .filter(Boolean);

  it("lists the file in step 3, once, after 0053", () => {
    expect(list.length).toBeGreaterThan(20); // the parse found the real list, not nothing
    expect(list.filter((f) => f === "0054_studio_sessions")).toHaveLength(1);
    expect(list.indexOf("0054_studio_sessions")).toBe(
      list.indexOf("0053_research_evidence_v2") + 1,
    );
  });
});
