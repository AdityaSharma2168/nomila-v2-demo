/**
 * planMemory.migration.test.ts — the revert check for migrations/0066_studio_plan_memory.sql (Studio
 * PR 13), on 0061's harness (plans.migration.test.ts) and 0058's ADD COLUMN shape
 * (mediaDuration.migration.test.ts).
 *
 * ─── WHAT 0066 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 *   1. IT IS THE SCHEMA. After the file, studio_plans and generation_jobs equal a schema.ts push —
 *      columns WITH their types (the drift gate compares names only), indexes and constraints. Change
 *      a type on either side and "migration and schema disagree" reds by name.
 *   2. ADDITIVE, AND ONLY THAT. Five nullable columns with no default: no index, no constraint, no
 *      DROP, no UPDATE. The file's shape is asserted from its text.
 *   3. A PRE-0066 ROW IS UNTOUCHED. A plan written the old way — never naming the new columns — reads
 *      back with every one of them null, and no other value moved.
 *   4. RE-RUNS ARE NO-OPS. db-migrate.sh applies every listed file on every deploy; a second pass
 *      changes no column and rewrites no table.
 *   5. IT IS ON THE LIST, once, right after 0065.
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
  join(ROOT, "migrations", "0066_studio_plan_memory.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const PLANS = "studio_plans";
const JOBS = "generation_jobs";
const NEW = {
  [PLANS]: ["prompt", "aesthetic", "objective", "confirm"],
  [JOBS]: ["cost_usd"],
} as const;

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

/**
 * Dev and prod today: both tables present, the five columns absent. The DROP COLUMN is on a
 * THROWAWAY IN-MEMORY instance and reaches no database anything else can see.
 */
async function pre0066(): Promise<PGlite> {
  const pg = await pushed();
  for (const [table, cols] of Object.entries(NEW))
    for (const c of cols)
      await pg.exec(`ALTER TABLE ${table} DROP COLUMN ${c};`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0066();
  const err = await applyLikePsql(pg, MIGRATION);
  if (err) throw err;
  return pg;
}

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

/** The table's storage identity: a rewrite (ALTER TYPE, a defaulted NOT NULL add) changes it. */
const relfilenodeOf = async (pg: PGlite, table: string) =>
  (
    await pg.query<{ relfilenode: number }>(
      `SELECT relfilenode::int AS relfilenode FROM pg_class WHERE oid = '${table}'::regclass`,
    )
  ).rows[0].relfilenode;

const ATHLETE = "11111111-1111-4111-8111-111111111111";

/** A studio_plans row written the way the PRE-0066 code writes one: it never names the new columns. */
async function seedPre0066Plan(pg: PGlite): Promise<string> {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [ATHLETE],
  );
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO ${PLANS} (athlete_id, version, brief, plan)
       VALUES ($1, 1, '{"brand":{"name":"Acme"}}'::jsonb, '{"items":[],"castCount":0,"picksWithoutHer":[],"gaps":[],"look":null,"music":null}'::jsonb)
       RETURNING id`,
    [ATHLETE],
  );
  return rows[0].id;
}

describe("0066: the file's shape — additive, nullable, no default, nothing else", () => {
  const statements = splitStatements(MIGRATION).map((s) =>
    s
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  it("is exactly five ADD COLUMN IF NOT EXISTS statements, one per column, no default, no NOT NULL", () => {
    expect(statements).toHaveLength(5);
    for (const s of statements) {
      expect(s).toMatch(
        /^ALTER TABLE (studio_plans|generation_jobs) ADD COLUMN IF NOT EXISTS \w+ (text|jsonb|numeric)$/,
      );
    }
    const named = statements.map(
      (s) => /ADD COLUMN IF NOT EXISTS (\w+)/.exec(s)![1],
    );
    expect(named.sort()).toEqual([...NEW[PLANS], ...NEW[JOBS]].sort());
  });

  it("never drops, updates, indexes, constrains or rewrites — the rollback story is 'do nothing'", () => {
    const text = MIGRATION.replace(/--[^\n]*/g, "");
    for (const word of [
      "DROP",
      "UPDATE",
      "DELETE",
      "CREATE",
      "CONSTRAINT",
      "DEFAULT",
      "NOT NULL",
      "ALTER COLUMN",
    ])
      expect(text.toUpperCase()).not.toContain(word);
  });
});

describe("0066: what a deploy does to the rows already there", () => {
  it("a pre-0066 plan row reads back with every new column null, and nothing else moved", async () => {
    const pg = await pre0066();
    const id = await seedPre0066Plan(pg);
    const before = (
      await pg.query(`SELECT * FROM ${PLANS} WHERE id = $1`, [id])
    ).rows[0] as Record<string, unknown>;

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const after = (await pg.query(`SELECT * FROM ${PLANS} WHERE id = $1`, [id]))
      .rows[0] as Record<string, unknown>;
    for (const c of NEW[PLANS]) expect(after[c]).toBeNull();
    for (const [k, v] of Object.entries(before)) expect(after[k]).toEqual(v);
    await pg.close();
  });

  it("re-runs are no-ops: a second pass changes no column and rewrites neither table", async () => {
    const pg = await migrated();
    const snapshot = async () => ({
      plans: await columnsOf(pg, PLANS),
      jobs: await columnsOf(pg, JOBS),
      plansNode: await relfilenodeOf(pg, PLANS),
      jobsNode: await relfilenodeOf(pg, JOBS),
    });
    const first = await snapshot();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await snapshot()).toEqual(first);
    await pg.close();
  });

  it("the ADD is catalog-only: the table's relfilenode does not move on the first pass either", async () => {
    const pg = await pre0066();
    const plansNode = await relfilenodeOf(pg, PLANS);
    const jobsNode = await relfilenodeOf(pg, JOBS);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await relfilenodeOf(pg, PLANS)).toBe(plansNode);
    expect(await relfilenodeOf(pg, JOBS)).toBe(jobsNode);
    await pg.close();
  });
});

describe("0066: the file matches shared/schema.ts, and is on the list", () => {
  /** ⚠️ MUTATION: change any of the five types in the .sql OR in schema.ts — "migration and schema disagree" reds by name. */
  it("migration and schema disagree: never — both tables equal a schema.ts push, columns WITH types, indexes AND constraints", async () => {
    const fromFile = await migrated();
    const fromSchema = await pushed();
    for (const table of [PLANS, JOBS]) {
      expect(await columnsOf(fromFile, table)).toEqual(
        await columnsOf(fromSchema, table),
      );
      expect(await indexesOf(fromFile, table)).toEqual(
        await indexesOf(fromSchema, table),
      );
      expect(await constraintsOf(fromFile, table)).toEqual(
        await constraintsOf(fromSchema, table),
      );
    }
    // And the harness itself is honest: the pre-0066 instance really lacks the columns.
    const pre = await pre0066();
    for (const [table, cols] of Object.entries(NEW)) {
      const names = (await columnsOf(pre, table)).map((c) => c.column_name);
      for (const c of cols) expect(names).not.toContain(c);
    }
    await fromFile.close();
    await fromSchema.close();
    await pre.close();
  });

  it("is listed in db-migrate.sh step 3, once, right after 0065", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0066_studio_plan_memory")).toHaveLength(1);
    // Ordered placement, not "last": a later migration would otherwise red this test without touching 0066.
    expect(list.indexOf("0066_studio_plan_memory")).toBe(
      list.indexOf("0065_objective_run_events") + 1,
    );
  });
});
