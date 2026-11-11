/**
 * videoJobs.migration.test.ts — the revert check for migrations/0056_studio_video_jobs.sql.
 *
 * 0056 widens a CHECK, and widening a CHECK is a DROP + ADD pair — the pair that broke two deploys
 * (deploy-dev.yml:16-24, and 9038d5d/#357). The rewrite's whole claim is that the pair is now ONE
 * statement, so it commits together or not at all. These tests exist to make that claim fail-able.
 *
 * ── WHAT EACH TEST COVERS, AND WHAT IT DOES NOT ─────────────────────────────────────────────────
 *
 *   1. THE MID-DDL DEATH (#357) — TESTED, and it is the load-bearing one. A live row holding a
 *      status outside the new list makes the ADD fail on validation. Under the ORIGINAL 0040 the
 *      DROP had already autocommitted, so the table was left with NO status constraint at all and
 *      every later deploy died at the same ADD. Under 0056 the failure rolls the DROP back and the
 *      old constraint is still standing. Both still throw — a failing deploy is correct — so the
 *      assertion is about the RESIDUE, not the throw.
 *
 *   2. IDEMPOTENCY AND FINAL STATE — TESTED, from both seed states (the old 5-value constraint
 *      present, and the #357 state where it is absent entirely). Re-running is asserted by the
 *      constraint's OID being UNCHANGED, not merely by the end state matching: an OID that moved
 *      would mean the guard never engaged and the file drop-and-re-added on a healthy database,
 *      which is the exact behaviour that opens the window in the first place.
 *
 *   3. THE CONCURRENT INTERLEAVE (PRs #140 + #141) — *** NOT TESTED. ARGUED ONLY. *** PGlite is a
 *      single in-process connection and its query()/transaction() share one mutex, so two runners
 *      cannot be made to interleave here (pglite-serializes-transactions). Nothing below should be
 *      read as covering it. The argument, for the record: the DO block is one statement and
 *      therefore one implicit transaction; ALTER TABLE takes ACCESS EXCLUSIVE on generation_jobs
 *      and Postgres holds it to end-of-transaction, so a second runner reaching the DROP blocks
 *      until the first commits and then re-reads a vocabulary that already admits 'queued' and
 *      returns early. The absent window is never observable. That is Postgres lock semantics, not
 *      something measured here. It is also the half that deploy-dev.yml and deploy-prod.yml
 *      independently guard with `concurrency: { cancel-in-progress: false }` — so it is
 *      belt-and-braces, not sole reliance. The mid-DDL death in (1) is the half serialization
 *      structurally CANNOT solve, which is why (1) is the one that had to be testable.
 *
 * ── WHY THE FILE IS EXECUTED STATEMENT-AT-A-TIME ────────────────────────────────────────────────
 *
 * This is the fidelity the whole suite rests on. `pg.exec(WHOLE_FILE)` sends a multi-statement
 * simple Query, which Postgres wraps in ONE implicit transaction — under which the original 0040
 * ALSO rolls back cleanly and test (1) passes against the broken file, proving nothing. db-migrate.sh
 * runs `psql -f` with NO --single-transaction, and psql sends each statement separately, so each
 * autocommits alone. `applyLikePsql` below reproduces that, and its dollar-quote-aware splitter is
 * why the DO blocks arrive whole rather than sliced at the semicolons inside them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0056_studio_video_jobs.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const NEW_COLUMNS = [
  "lease_until",
  "lease_holder",
  "attempts",
  "submit_attempted_at",
  "provider_operation_name",
  "poll_count",
  "last_polled_at",
];
const NEW_INDEXES = [
  "idx_generation_jobs_operation",
  "idx_generation_jobs_claim",
  "idx_generation_jobs_lease",
];
const WIDENED =
  "CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))";
const NARROW =
  "CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'canceled'::text])))";

/**
 * Split SQL the way psql does: on top-level semicolons, respecting $$…$$ dollar quoting so a DO
 * block arrives as one statement, and skipping `--` comments so a semicolon in prose is not a split.
 */
export function splitStatements(sql: string): string[] {
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
  // drop fragments that are only comments/whitespace
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

/** Push a set of schema.ts exports into a fresh PGlite — pgliteDb.ts's initTestDb, on our own instance. */
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

/**
 * A database in its PRE-0056 state: schema.ts pushed, then generation_jobs rewound to the shape the
 * live dev and prod databases have today — no lease columns, the narrow status index, and the
 * five-value CHECK that 0027 created and legacy/08 still writes on a fresh install.
 *
 * `withConstraint: false` is the #357 state instead: the DROP committed, the ADD failed, and the
 * table has been sitting in production with no status constraint at all.
 */
async function pre0056(
  opts: { withConstraint: boolean } = { withConstraint: true },
): Promise<PGlite> {
  const pg = await pushed(schema);
  // IF EXISTS because dropping a column drops the partial indexes that depend on it: losing
  // provider_operation_name takes idx_generation_jobs_operation with it, and lease_until takes
  // idx_generation_jobs_lease. The explicit drops are here so the rewind reads as the full inverse.
  for (const c of NEW_COLUMNS)
    await pg.exec(`ALTER TABLE generation_jobs DROP COLUMN ${c};`);
  for (const i of NEW_INDEXES) await pg.exec(`DROP INDEX IF EXISTS ${i};`);
  await pg.exec(`DROP INDEX idx_generation_jobs_status;`);
  await pg.exec(
    `CREATE INDEX idx_generation_jobs_status ON generation_jobs (status, created_at) WHERE status IN ('pending','running');`,
  );
  await pg.exec(
    `ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_status_check;`,
  );
  if (opts.withConstraint) {
    await pg.exec(
      `ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled'));`,
    );
  }
  return pg;
}

const statusCheck = async (pg: PGlite) =>
  (
    await pg.query<{ oid: number; def: string }>(
      `SELECT oid::int AS oid, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'generation_jobs'::regclass AND conname = 'generation_jobs_status_check'`,
    )
  ).rows;

const columnsOf = async (pg: PGlite) =>
  (
    await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='generation_jobs' ORDER BY column_name`,
    )
  ).rows.map((r) => r.column_name);

const indexesOf = async (pg: PGlite) =>
  (
    await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='generation_jobs' ORDER BY indexname`,
    )
  ).rows;

/** An athlete + a generation_jobs row, so the CHECK has real data to validate against. */
async function seedJob(pg: PGlite, status: string) {
  const athlete = "11111111-1111-4111-8111-111111111111";
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [athlete],
  );
  await pg.query(
    `INSERT INTO generation_jobs (athlete_id, origin, mode, objective, deliverable, brief, status)
     VALUES ($1, 'system', 'generate', 'o', 'd', '{}'::jsonb, $2)`,
    [athlete, status],
  );
}

jest.setTimeout(180_000);

describe("0056: THE MID-DDL DEATH — a failing ADD must not leave the table unguarded (#357)", () => {
  /**
   * THE REVERT CHECK. This is the test that goes RED against foundation's original 0040 and the
   * reason the rewrite exists. It is the #357 mechanism exactly: a row already holds a status the
   * new list omits, so ADD CONSTRAINT fails validation.
   */
  it("leaves the OLD constraint standing when the widening cannot validate", async () => {
    const pg = await pre0056();
    // A status outside BOTH vocabularies. It can only exist because the constraint was absent when
    // it was written — which is exactly the state #357 left agent_actions in.
    await pg.exec(
      `ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_status_check;`,
    );
    await seedJob(pg, "archived");
    await pg.exec(
      `ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled','archived'));`,
    );

    const before = await statusCheck(pg);
    expect(before).toHaveLength(1);

    const err = await applyLikePsql(pg, MIGRATION);

    // The deploy MUST fail — widening onto data that contradicts it is a real error.
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/violated by some row/i);

    // …and the table must still be guarded. THIS is what the original 0040 gets wrong: its DROP
    // autocommits, so this assertion finds zero rows and the constraint is gone from production.
    const after = await statusCheck(pg);
    expect(after).toHaveLength(1);
    expect(after[0].def).toBe(before[0].def);
    expect(after[0].oid).toBe(before[0].oid); // not dropped and re-added — never touched
    await pg.close();
  });

  it("still rejects a status outside the vocabulary after that failed run", async () => {
    const pg = await pre0056();
    await pg.exec(
      `ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_status_check;`,
    );
    await seedJob(pg, "archived");
    await pg.exec(
      `ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled','archived'));`,
    );
    await applyLikePsql(pg, MIGRATION);
    await expect(seedJob(pg, "not_a_status")).rejects.toThrow();
    await pg.close();
  });
});

describe("0056: FRESH AND EXISTING DATABASES both converge", () => {
  it("applies to a database carrying the old five-value constraint (the deploy case)", async () => {
    const pg = await pre0056();
    expect((await statusCheck(pg))[0].def).toBe(NARROW);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect((await statusCheck(pg))[0].def).toBe(WIDENED);
    for (const c of NEW_COLUMNS) expect(await columnsOf(pg)).toContain(c);
    const names = (await indexesOf(pg)).map((i) => i.indexname);
    for (const i of NEW_INDEXES) expect(names).toContain(i);
    await pg.close();
  });

  it("applies to a database whose constraint is ABSENT — the state #357 actually left behind", async () => {
    const pg = await pre0056({ withConstraint: false });
    expect(await statusCheck(pg)).toHaveLength(0);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect((await statusCheck(pg))[0].def).toBe(WIDENED);
    await pg.close();
  });

  it("accepts a queued row, and still refuses one outside the vocabulary", async () => {
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    await seedJob(pg, "queued"); // the whole point of the widening
    await expect(seedJob(pg, "nope")).rejects.toThrow();
    await pg.close();
  });

  it("preserves the rows that were already there", async () => {
    const pg = await pre0056();
    await seedJob(pg, "succeeded");
    await seedJob(pg, "running");
    await applyLikePsql(pg, MIGRATION);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM generation_jobs`,
    );
    expect(rows[0].n).toBe(2);
    await pg.close();
  });
});

describe("0056: RE-RUNNABLE — db-migrate.sh runs every file on every deploy", () => {
  it("is a no-op the second and third time, and never re-drops the constraint", async () => {
    const pg = await pre0056();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    const first = await statusCheck(pg);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    const third = await statusCheck(pg);

    expect(third[0].def).toBe(WIDENED);
    // The OID is the assertion that matters. A matching definition alone would also be produced by
    // dropping and re-adding the constraint on every deploy — which is the window this file closes.
    expect(third[0].oid).toBe(first[0].oid);
    await pg.close();
  });

  it("leaves a later widening alone rather than fighting it every deploy", async () => {
    // db-migrate.sh runs 0056 before any future 0060, on every deploy. If the guard demanded its own
    // exact definition it would re-narrow the vocabulary each time and the two files would oscillate.
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    await pg.exec(
      `ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_status_check;`,
    );
    await pg.exec(
      `ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','queued','running','succeeded','failed','canceled','stitching'));`,
    );
    const hypothetical = await statusCheck(pg);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect((await statusCheck(pg))[0].oid).toBe(hypothetical[0].oid);
    expect((await statusCheck(pg))[0].def).toMatch(/stitching/);
    await pg.close();
  });

  it("re-runs the status-index replacement exactly once", async () => {
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    const first = (await indexesOf(pg)).find(
      (i) => i.indexname === "idx_generation_jobs_status",
    )!;
    expect(first.indexdef).toMatch(/queued/);
    await applyLikePsql(pg, MIGRATION);
    expect(
      (await indexesOf(pg)).find(
        (i) => i.indexname === "idx_generation_jobs_status",
      )!.indexdef,
    ).toBe(first.indexdef);
    await pg.close();
  });
});

describe("0056: ROLLBACK — the previous image keeps running against the new schema", () => {
  /**
   * There is no down-migration here and there should not be: db-migrate.sh has no down path and
   * 0054 states the house rule ("Rollback is the switch; there is never a DROP"). What rollback
   * MEANS for a widening is that the old image, which writes only the five old statuses, is still
   * valid against the new constraint — deploy-prod.yml migrates the database BEFORE it replaces the
   * revision, so the old code runs against this schema in every deploy, not only in a rollback.
   */
  it("every status the pre-0056 code writes is still accepted", async () => {
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    for (const s of ["pending", "running", "succeeded", "failed", "canceled"]) {
      await expect(seedJob(pg, s)).resolves.not.toThrow();
    }
    await pg.close();
  });

  it("the new columns are all nullable or defaulted, so an old INSERT that names none of them works", async () => {
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    await seedJob(pg, "pending"); // the pre-0056 INSERT, verbatim — no new column named
    const { rows } = await pg.query<{
      attempts: number;
      poll_count: number;
      lease_until: unknown;
    }>(`SELECT attempts, poll_count, lease_until FROM generation_jobs LIMIT 1`);
    expect(rows[0]).toMatchObject({
      attempts: 0,
      poll_count: 0,
      lease_until: null,
    });
    await pg.close();
  });

  it("narrowing back is possible while no queued row exists — the manual revert path, stated not run", async () => {
    const pg = await pre0056();
    await applyLikePsql(pg, MIGRATION);
    await seedJob(pg, "succeeded");
    await pg.exec(
      `ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_status_check;`,
    );
    await pg.exec(
      `ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_status_check CHECK (status IN ('pending','running','succeeded','failed','canceled'));`,
    );
    expect((await statusCheck(pg))[0].def).toBe(NARROW);
    await pg.close();
  });
});

describe("0056: the file matches shared/schema.ts, and is on the list", () => {
  it("produces the same generation_jobs columns and indexes as a schema.ts push", async () => {
    const fromFile = await pre0056();
    await applyLikePsql(fromFile, MIGRATION);
    const fromSchema = await pushed(schema);

    expect(await columnsOf(fromFile)).toEqual(await columnsOf(fromSchema));
    expect(await indexesOf(fromFile)).toEqual(await indexesOf(fromSchema));
    expect((await statusCheck(fromFile))[0].def).toBe(
      (await statusCheck(fromSchema))[0].def,
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0055", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0056_studio_video_jobs")).toHaveLength(1);
    expect(list.indexOf("0056_studio_video_jobs")).toBe(
      list.indexOf("0055_mia_evaluator_service") + 1,
    );
  });

  it("carries no transaction control of its own — migrationsGuard.test.ts owns this rule", () => {
    const stripped = MIGRATION.replace(/--[^\n]*/g, "");
    expect(
      stripped.match(
        /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/gim,
      ) ?? [],
    ).toEqual([]);
    // …while still containing the DO blocks whose atomicity the tests above depend on.
    const bodies = splitStatements(MIGRATION).map((s) =>
      s.replace(/--[^\n]*/g, "").trim(),
    );
    expect(bodies.filter((s) => s.startsWith("DO $$"))).toHaveLength(2);
  });
});
