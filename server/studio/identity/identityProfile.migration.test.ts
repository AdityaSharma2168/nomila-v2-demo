/**
 * identityProfile.migration.test.ts — the revert check for migrations/0067_identity_profile.sql
 * (Studio PR 17, R-1), on 0061's harness (server/studio/agent/plans.migration.test.ts).
 *
 * ─── WHAT 0067 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 *   1. IT IS THE SCHEMA. After the file, identity_profiles equals a schema.ts push — columns WITH
 *      their types (the drift gate compares names only), indexes and constraints. Change a type on
 *      either side and "migration and schema disagree" reds by name.
 *   2. ONE ROW PER ATHLETE, AND HER ROW GOES WITH HER. athlete_id is UNIQUE and CASCADEs.
 *   3. IDS AND NUMBERS ONLY. The file's text names no vector, template, crop or box column — the
 *      legal property (qa/identity.ts) is asserted on the DDL, not only in prose.
 *   4. ADDITIVE ONLY — THE REVERT LEAVES NO ORPHAN. Dropping the table returns the catalog to its
 *      exact pre-0067 state. No existing table is named by the file.
 *   5. RE-RUNS ARE NO-OPS. db-migrate.sh applies every listed file on every deploy; a second pass
 *      keeps the same OID.
 *   6. IT IS ON THE LIST, once, right after 0066.
 *
 * Statement-at-a-time, as `psql -f` without --single-transaction applies it (see 0060's header).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0067_identity_profile.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const TABLE = "identity_profiles";

/** Split SQL the way psql does: top-level semicolons, dollar-quote aware, `--` comments skipped. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "",
    i = 0,
    tag: string | null = null;
  while (i < sql.length) {
    if (tag === null) {
      if (sql[i] === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        const end = nl === -1 ? sql.length : nl;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        tag = m[0];
        buf += tag;
        i += tag.length;
        continue;
      }
      if (sql[i] === ";") {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
        i++;
        continue;
      }
      buf += sql[i++];
      continue;
    }
    if (sql.startsWith(tag, i)) {
      buf += tag;
      i += tag.length;
      tag = null;
      continue;
    }
    buf += sql[i++];
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Apply a migration the way `psql -f` does: one statement at a time, each in its own transaction. */
async function applyLikePsql(pg: PGlite, sql: string): Promise<Error | null> {
  for (const statement of splitStatements(sql)) {
    try {
      await pg.exec(statement);
    } catch (err) {
      return err as Error; // ON_ERROR_STOP=1 — db-migrate.sh stops here and the deploy fails
    }
  }
  return null;
}

/** Push schema.ts into a fresh PGlite — pgliteDb.ts's initTestDb, on our own throwaway instance. */
async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import(
    "drizzle-kit/api"
  );
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema),
  );
  for (const s of statements) await pg.exec(s);
  return pg;
}

/** Dev and prod today: every other table present, this one absent. The DROP is on a THROWAWAY instance. */
async function pre0067(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${TABLE};`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0067();
  const err = await applyLikePsql(pg, MIGRATION);
  if (err) throw err;
  return pg;
}

const tableOid = async (pg: PGlite, table: string) =>
  (
    await pg.query<{ oid: number }>(
      `SELECT '${table}'::regclass::oid::int AS oid`,
    )
  ).rows[0].oid;

const columnsOf = async (pg: PGlite, table: string) =>
  (
    await pg.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='${table}' ORDER BY column_name`,
    )
  ).rows;

const indexesOf = async (pg: PGlite, table: string) =>
  (
    await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='${table}' ORDER BY indexname`,
    )
  ).rows;

/** Every constraint by NAME and DEFINITION — a hand-written FK under another name is invisible drift. */
const constraintsOf = async (pg: PGlite, table: string) =>
  (
    await pg.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '${table}'::regclass ORDER BY conname`,
    )
  ).rows;

/** The whole public catalog, by name: relations, constraints and types. */
async function catalogOf(pg: PGlite): Promise<Record<string, string[]>> {
  const names = async (q: string) =>
    (await pg.query<{ n: string }>(q)).rows.map((r) => r.n);
  return {
    relations: await names(
      `SELECT c.relkind::text || ':' || c.relname AS n FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' ORDER BY 1`,
    ),
    constraints: await names(
      `SELECT con.conname AS n FROM pg_constraint con
         JOIN pg_namespace ns ON ns.oid = con.connamespace
        WHERE ns.nspname = 'public' ORDER BY 1`,
    ),
    types: await names(
      `SELECT t.typname AS n FROM pg_type t
         JOIN pg_namespace ns ON ns.oid = t.typnamespace
        WHERE ns.nspname = 'public' ORDER BY 1`,
    ),
  };
}

const countRows = async (pg: PGlite, table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
    .rows[0].n;

// Synthetic ids throughout — no real person.
const ATHLETE = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE = "99999999-9999-4999-8999-999999999999";

async function seedAthlete(pg: PGlite, id = ATHLETE) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

async function seedProfile(pg: PGlite, athleteId: string) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO ${TABLE} (athlete_id, pack) VALUES ($1, '[]'::jsonb) RETURNING id`,
      [athleteId],
    )
  ).rows[0].id;
}

describe("0067: applies additively, and re-runs as a no-op", () => {
  it("creates the one table, and a second run changes nothing (same OID)", async () => {
    const pg = await migrated();
    const oid = await tableOid(pg, TABLE);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await tableOid(pg, TABLE)).toBe(oid);
    await pg.close();
  });

  it("dropping the table leaves zero orphan objects — the catalog is exactly pre-0067", async () => {
    const pg = await pre0067();
    const before = await catalogOf(pg);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    await seedAthlete(pg);
    await seedProfile(pg, ATHLETE);
    await pg.exec(`DROP TABLE ${TABLE};`);
    expect(await catalogOf(pg)).toEqual(before);
    expect(await countRows(pg, "athletes")).toBe(1);
    await pg.close();
  });

  it("names no existing table: CREATE TABLE IF NOT EXISTS identity_profiles and nothing else", () => {
    const statements = splitStatements(MIGRATION).map((s) =>
      s.replace(/--[^\n]*/g, "").trim(),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^CREATE TABLE IF NOT EXISTS identity_profiles/i,
    );
    const body = MIGRATION.replace(/--[^\n]*/g, "");
    // `ON DELETE CASCADE` is the FK's referential action, not a DELETE statement.
    expect(body).not.toMatch(/(?<!ON\s)\b(ALTER|DROP|UPDATE|DELETE|INSERT)\b/);
  });

  /** ⚠️ Claim 3: the legal property, on the DDL. A column that could hold a face template reds here. */
  it("stores ids and numbers only — no embedding, template, crop or box column", () => {
    const body = MIGRATION.replace(/--[^\n]*/g, "");
    expect(body).not.toMatch(
      /embedding|template|vector|crop|box|bytea|real\[\]|float\[\]/i,
    );
    expect(body).toMatch(/\bpack\s+jsonb\b/);
  });
});

describe("0067: one row per athlete, and it goes with her", () => {
  /** ⚠️ MUTATION: drop the UNIQUE — "two profiles for one athlete" reds by name. */
  it("refuses a second profile for the same athlete", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    await seedProfile(pg, ATHLETE);
    await expect(seedProfile(pg, ATHLETE)).rejects.toThrow(
      /identity_profiles_athlete_unique/,
    );
    await pg.close();
  });

  /** ⚠️ MUTATION: drop ON DELETE CASCADE — this reds by name. */
  it("deleting the athlete takes her profile and nobody else's", async () => {
    const pg = await migrated();
    await seedAthlete(pg, ATHLETE);
    await seedAthlete(pg, OTHER_ATHLETE);
    await seedProfile(pg, ATHLETE);
    await seedProfile(pg, OTHER_ATHLETE);
    await pg.query(`DELETE FROM athletes WHERE id = $1`, [ATHLETE]);
    expect(await countRows(pg, TABLE)).toBe(1);
    await pg.close();
  });

  it("refuses a profile for an athlete that does not exist", async () => {
    const pg = await migrated();
    await expect(seedProfile(pg, OTHER_ATHLETE)).rejects.toThrow(
      /identity_profiles_athlete_id_athletes_id_fk/,
    );
    await pg.close();
  });

  it("a fresh row carries no measurement: band, control and embedder are null", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const id = await seedProfile(pg, ATHLETE);
    const row = (
      await pg.query<Record<string, unknown>>(
        `SELECT band_min, band_max, band_pairs, band_measured_at, control_passed, control_measured_at, embedder
           FROM ${TABLE} WHERE id = $1`,
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      band_min: null,
      band_max: null,
      band_pairs: null,
      band_measured_at: null,
      control_passed: null,
      control_measured_at: null,
      embedder: null,
    });
    await pg.close();
  });
});

describe("0067: the file matches shared/schema.ts, and is on the list", () => {
  /** ⚠️ MUTATION "migration and schema disagree": change one type on either side — reds by name. */
  it("produces the same table as a schema.ts push — columns, indexes AND constraints", async () => {
    const fromFile = await migrated();
    const fromSchema = await pushed();
    expect(await columnsOf(fromFile, TABLE)).toEqual(
      await columnsOf(fromSchema, TABLE),
    );
    expect(await indexesOf(fromFile, TABLE)).toEqual(
      await indexesOf(fromSchema, TABLE),
    );
    expect(await constraintsOf(fromFile, TABLE)).toEqual(
      await constraintsOf(fromSchema, TABLE),
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("no constraint or index name is long enough for Postgres to truncate", async () => {
    const pg = await migrated();
    const names = [
      ...(await constraintsOf(pg, TABLE)).map((c) => c.conname),
      ...(await indexesOf(pg, TABLE)).map((i) => i.indexname),
    ];
    for (const n of names) expect(n.length).toBeLessThan(63);
    await pg.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0066", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0067_identity_profile")).toHaveLength(1);
    expect(list.indexOf("0067_identity_profile")).toBe(
      list.indexOf("0066_studio_plan_memory") + 1,
    );
  });
});
