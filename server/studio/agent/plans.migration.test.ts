/**
 * plans.migration.test.ts — the revert check for migrations/0061_studio_plans.sql (Studio PR 6, 6a3),
 * on 0060's harness (server/studio/reference/brandProfiles.migration.test.ts).
 *
 * ─── WHAT 0061 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 *   1. A PLAN CANNOT DESCEND FROM ANOTHER ATHLETE'S PLAN. The parent FK is composite,
 *      (parent_plan_id, athlete_id) → (id, athlete_id). Make it a plain FK on parent_plan_id and
 *      "refuses a child filed under ANOTHER athlete's plan" goes red.
 *   2. HER PLANS GO WITH HER. athlete_id CASCADEs — lineage and all, in one statement, even with the
 *      parent FK's NO ACTION. "deleting the athlete takes every plan, parents and children" reds if
 *      it does not.
 *   3. HER PLAN OUTLIVES THE DEAL ROW. deal_deliverable_id is SET NULL. Make it CASCADE and "nulls the
 *      deliverable and keeps the plan" goes red.
 *   4. ADDITIVE ONLY — THE REVERT LEAVES NO ORPHAN. Dropping the table returns the catalog to its
 *      exact pre-0061 state.
 *   5. IT IS THE SCHEMA. Columns, indexes and constraints equal a schema.ts push, and the file is on
 *      db-migrate.sh's list once, after 0060.
 *
 * Statement-at-a-time, as `psql -f` without --single-transaction applies it (see 0060's header).
 * NOT covered: real Postgres (deploy-dev's migration step), and the code-level tenancy checks
 * (plans.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0061_studio_plans.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const PLANS = "studio_plans";

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

/** Dev and prod today: every other table present, this one absent. */
async function pre0061(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${PLANS};`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0061();
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

/**
 * The whole public catalog, by name: relations (tables, indexes, sequences, views), constraints
 * and types. Claim 5 compares two of these, so anything 0060 creates outside its two tables — or
 * anything a DROP TABLE fails to take with it — is a difference.
 */
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

// Synthetic ids and names throughout — no real person, deal or path.
const ATHLETE = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE = "99999999-9999-4999-8999-999999999999";

async function seedAthlete(pg: PGlite, id = ATHLETE) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

async function seedDeliverable(pg: PGlite, athleteId: string) {
  const deal = (
    await pg.query<{ id: string }>(
      `INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'Synthetic Brand') RETURNING id`,
      [athleteId],
    )
  ).rows[0].id;
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO deal_deliverables (deal_id, seq, format) VALUES ($1, 1, '1 reel') RETURNING id`,
      [deal],
    )
  ).rows[0].id;
}

async function seedPlan(
  pg: PGlite,
  athleteId: string,
  over: {
    parent?: string | null;
    version?: number;
    deliverable?: string | null;
  } = {},
) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO ${PLANS} (athlete_id, parent_plan_id, version, plan, deal_deliverable_id)
       VALUES ($1, $2, $3, '{"items":[]}'::jsonb, $4) RETURNING id`,
      [
        athleteId,
        over.parent ?? null,
        over.version ?? 1,
        over.deliverable ?? null,
      ],
    )
  ).rows[0].id;
}

describe("0061: applies additively, and re-runs as a no-op", () => {
  it("creates the one table, and a second run changes nothing (same OID)", async () => {
    const pg = await migrated();
    const oid = await tableOid(pg, PLANS);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await tableOid(pg, PLANS)).toBe(oid);
    await pg.close();
  });

  it("dropping the table leaves zero orphan objects — the catalog is exactly pre-0061", async () => {
    const pg = await pre0061();
    const before = await catalogOf(pg);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    await seedAthlete(pg);
    await seedPlan(pg, ATHLETE);
    await pg.exec(`DROP TABLE ${PLANS};`);
    expect(await catalogOf(pg)).toEqual(before);
    expect(await countRows(pg, "athletes")).toBe(1);
    await pg.close();
  });
});

describe("0061: tenancy and lineage are the database's, not only the code's", () => {
  /** ⚠️ MUTATION: make studio_plans_parent_fk a plain FK on parent_plan_id — this reds by name. */
  it("refuses a child filed under ANOTHER athlete's plan", async () => {
    const pg = await migrated();
    await seedAthlete(pg, ATHLETE);
    await seedAthlete(pg, OTHER_ATHLETE);
    const hers = await seedPlan(pg, ATHLETE);
    await expect(
      seedPlan(pg, OTHER_ATHLETE, { parent: hers, version: 2 }),
    ).rejects.toThrow(/studio_plans_parent_fk/);
    // Her own child is fine.
    await expect(
      seedPlan(pg, ATHLETE, { parent: hers, version: 2 }),
    ).resolves.toEqual(expect.any(String));
    await pg.close();
  });

  it("deleting the athlete takes every plan, parents and children, in one statement", async () => {
    const pg = await migrated();
    await seedAthlete(pg, ATHLETE);
    await seedAthlete(pg, OTHER_ATHLETE);
    const v1 = await seedPlan(pg, ATHLETE);
    const v2 = await seedPlan(pg, ATHLETE, { parent: v1, version: 2 });
    await seedPlan(pg, ATHLETE, { parent: v2, version: 3 });
    await seedPlan(pg, OTHER_ATHLETE);
    await pg.query(`DELETE FROM athletes WHERE id = $1`, [ATHLETE]);
    expect(await countRows(pg, PLANS)).toBe(1);
    await pg.close();
  });

  it("a parent with a child cannot be deleted alone (NO ACTION — the documented fallback)", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const v1 = await seedPlan(pg, ATHLETE);
    await seedPlan(pg, ATHLETE, { parent: v1, version: 2 });
    await expect(
      pg.query(`DELETE FROM ${PLANS} WHERE id = $1`, [v1]),
    ).rejects.toThrow(/studio_plans_parent_fk/);
    await pg.close();
  });

  /** ⚠️ MUTATION: make the deliverable FK CASCADE — this reds by name. */
  it("nulls the deliverable and keeps the plan when the deal row goes", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const d = await seedDeliverable(pg, ATHLETE);
    const plan = await seedPlan(pg, ATHLETE, { deliverable: d });
    await pg.query(`DELETE FROM deal_deliverables WHERE id = $1`, [d]);
    const row = (
      await pg.query<{ deal_deliverable_id: string | null }>(
        `SELECT deal_deliverable_id FROM ${PLANS} WHERE id = $1`,
        [plan],
      )
    ).rows;
    expect(row).toEqual([{ deal_deliverable_id: null }]);
    await pg.close();
  });
});

describe("0061: the file matches shared/schema.ts, and is on the list", () => {
  it("produces the same table as a schema.ts push — columns, indexes AND constraints", async () => {
    // With 0066 on top (PR 13): schema.ts now carries its four columns, and the deploy applies both
    // files in order. 0066's own parity is planMemory.migration.test.ts; this keeps holding 0061's.
    const fromFile = await migrated();
    // Every later file that alters studio_plans rides on top, in deploy order, so this compares 0061-and-what-followed
    // with head. 0072 (creative intents) adds studio_plans.creative_intent_id; its own parity is its migration test.
    for (const file of ["0066_studio_plan_memory.sql", "0072_creative_intents.sql"]) {
      const later = await applyLikePsql(fromFile, readFileSync(join(ROOT, "migrations", file), "utf8"));
      if (later) throw later;
    }
    const fromSchema = await pushed();
    expect(await columnsOf(fromFile, PLANS)).toEqual(
      await columnsOf(fromSchema, PLANS),
    );
    expect(await indexesOf(fromFile, PLANS)).toEqual(
      await indexesOf(fromSchema, PLANS),
    );
    expect(await constraintsOf(fromFile, PLANS)).toEqual(
      await constraintsOf(fromSchema, PLANS),
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("no constraint or index name is long enough for Postgres to truncate", async () => {
    const pg = await migrated();
    const names = [
      ...(await constraintsOf(pg, PLANS)).map((c) => c.conname),
      ...(await indexesOf(pg, PLANS)).map((i) => i.indexname),
    ];
    for (const n of names) expect(n.length).toBeLessThan(63);
    await pg.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0060", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0061_studio_plans")).toHaveLength(1);
    expect(list.indexOf("0061_studio_plans")).toBe(
      list.indexOf("0060_studio_brand_profiles") + 1,
    );
  });
});
