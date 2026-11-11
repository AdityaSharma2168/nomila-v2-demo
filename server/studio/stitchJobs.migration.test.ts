/**
 * stitchJobs.migration.test.ts — the revert check for migrations/0057_studio_stitch_jobs.sql.
 *
 * ─── WHAT 0057 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 * 0056 needed DO-block guards because widening a CHECK is a DROP + ADD pair and the gap between the
 * two autocommits — the gap that cost this repo two outages. 0057's claim is stronger and simpler:
 * IT WRITES NO SUCH PAIR AT ALL. Every constraint is inline in one CREATE TABLE, so there is no
 * intermediate state in which the table exists half-guarded, and nothing for a concurrent run or a
 * mid-DDL death to catch.
 *
 * A claim about a file's SHAPE has to be checked against the file's shape, so the first describe
 * below reads the SQL and asserts the absence directly. The rest check the behaviour that shape is
 * supposed to buy: OID-stable re-runs, fresh and existing databases converging, and a rollback that
 * is genuinely a no-op for everything else.
 *
 * ─── WHY THE FILE IS EXECUTED STATEMENT-AT-A-TIME ───────────────────────────────────────────────
 *
 * The same fidelity videoJobs.migration.test.ts rests on, and for the same reason. `pg.exec(WHOLE_FILE)`
 * sends a multi-statement simple Query, which Postgres wraps in ONE implicit transaction — under
 * which a broken file can roll back cleanly and prove nothing. db-migrate.sh runs `psql -f` with NO
 * --single-transaction, so each statement autocommits alone. `applyLikePsql` reproduces that.
 *
 * `splitStatements` is duplicated from videoJobs.migration.test.ts rather than imported: importing
 * that module would register ITS describes inside this suite and run 0056's tests twice.
 *
 * ─── WHAT IS NOT COVERED ────────────────────────────────────────────────────────────────────────
 *
 *   * THE CONCURRENT INTERLEAVE. PGlite is one in-process connection whose query()/transaction()
 *     share a mutex, so two runners cannot be made to interleave here. Argued, not measured: two
 *     concurrent `CREATE TABLE IF NOT EXISTS` take ACCESS EXCLUSIVE, and the loser finds the table
 *     present and skips. Both deploy workflows also declare `concurrency: cancel-in-progress: false`.
 *   * REAL POSTGRES. PGlite is Postgres, but only the deploy-dev migration step proves the file
 *     applies to Cloud SQL. That is watched on CI.
 *   * SPEND AND CLAIM ISOLATION — those drive the REAL spentTodayUsd and claimVideoJobs queries and
 *     need server/db mocked, so they live in stitchIsolation.test.ts next door.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0057_studio_stitch_jobs.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const TABLE = "studio_stitch_jobs";
const INDEXES = [
  "idx_studio_stitch_jobs_athlete",
  "idx_studio_stitch_jobs_claim",
  "idx_studio_stitch_jobs_lease",
];
const STATUSES = ["queued", "running", "succeeded", "failed", "canceled"];

/**
 * Split SQL the way psql does: on top-level semicolons, respecting $$…$$ dollar quoting so a DO
 * block would arrive as one statement, and skipping `--` comments so a semicolon in prose is not a
 * split. (0057 contains no DO block; the splitter still has to be dollar-quote aware to be a
 * faithful stand-in for psql, and to stay correct if one is ever added.)
 */
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
 * A database in its PRE-0057 state: schema.ts pushed, then the new table rewound away. That is
 * exactly what dev and prod look like today — every other table present, this one absent.
 */
async function pre0057(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${TABLE};`); // takes its indexes and constraints with it
  return pg;
}

const tableOid = async (pg: PGlite) =>
  (
    await pg.query<{ oid: number }>(
      `SELECT '${TABLE}'::regclass::oid::int AS oid`,
    )
  ).rows[0].oid;

const columnsOf = async (pg: PGlite) =>
  (
    await pg.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='${TABLE}' ORDER BY column_name`,
    )
  ).rows;

const indexesOf = async (pg: PGlite) =>
  (
    await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='${TABLE}' ORDER BY indexname`,
    )
  ).rows;

/**
 * Every constraint by NAME and DEFINITION — not just the CHECK. A hand-written foreign key with a
 * different name from the one drizzle emits passes a columns-and-indexes comparison while leaving
 * real drift behind, so the parity test has to look at all of them.
 */
const constraintsOf = async (pg: PGlite) =>
  (
    await pg.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '${TABLE}'::regclass ORDER BY conname`,
    )
  ).rows;

async function seedAthlete(
  pg: PGlite,
  id = "11111111-1111-4111-8111-111111111111",
) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

/** A stitch job, as the route will write one: asset ids in the spec, never paths. */
async function seedStitch(pg: PGlite, athleteId: string, status = "queued") {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO ${TABLE} (athlete_id, spec, status)
     VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [
      athleteId,
      JSON.stringify({
        clips: [{ assetId: "22222222-2222-4222-8222-222222222222" }],
        target: { width: 1080, height: 1920, fps: 30 },
      }),
      status,
    ],
  );
  return res.rows[0].id;
}

/** A generation_jobs row, written exactly the way the PRE-0057 code writes one. */
async function seedGenerationJob(
  pg: PGlite,
  athleteId: string,
  status = "pending",
) {
  await pg.query(
    `INSERT INTO generation_jobs (athlete_id, origin, mode, objective, deliverable, brief, status)
     VALUES ($1, 'system', 'generate', 'grow-following', 'post', '{}'::jsonb, $2)`,
    [athleteId, status],
  );
}

jest.setTimeout(180_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("0057: THE SHAPE — there is no DROP+ADD pair, so 0056's race cannot happen", () => {
  /**
   * THE STRUCTURAL REVERT CHECK. 0056's mid-DDL-death test cannot be written against this file
   * because the window it tests does not exist. What CAN be checked is that the window is never
   * introduced — the day someone widens this table's CHECK with a bare DROP + ADD, this reds and
   * points them at 0056's DO-block guard.
   */
  it("writes no DROP CONSTRAINT, no DROP INDEX and no bare ADD CONSTRAINT", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    expect(sql.match(/DROP\s+CONSTRAINT/gi) ?? []).toEqual([]);
    expect(sql.match(/DROP\s+INDEX/gi) ?? []).toEqual([]);
    // Inline `CONSTRAINT x FOREIGN KEY …` inside CREATE TABLE is fine; `ALTER TABLE … ADD CONSTRAINT`
    // is the unguardable half of the pair and is what must not appear.
    expect(
      sql.match(/ALTER\s+TABLE[\s\S]{0,200}?ADD\s+CONSTRAINT/gi) ?? [],
    ).toEqual([]);
    // No data movement either — the "ADDITIVE" banner at the top of the file has to be true.
    expect(
      sql.match(/\b(UPDATE|DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/gi) ?? [],
    ).toEqual([]);
  });

  it("carries no transaction control of its own — migrationsGuard.test.ts owns this rule repo-wide", () => {
    const stripped = MIGRATION.replace(/--[^\n]*/g, "");
    expect(
      stripped.match(
        /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/gim,
      ) ?? [],
    ).toEqual([]);
  });

  it("creates exactly one table, and it is a new one", () => {
    const creates =
      MIGRATION.replace(/--[^\n]*/g, "").match(/CREATE\s+TABLE[^(]*/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/IF\s+NOT\s+EXISTS\s+studio_stitch_jobs/i);
  });
});

describe("0057: FRESH AND EXISTING DATABASES both converge", () => {
  it("applies to a database that has never seen the table (the deploy case)", async () => {
    const pg = await pre0057();
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='${TABLE}'`,
        )
      ).rows[0].n,
    ).toBe(0);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const names = (await indexesOf(pg)).map((i) => i.indexname);
    for (const i of INDEXES) expect(names).toContain(i);
    expect((await columnsOf(pg)).map((c) => c.column_name)).toEqual([
      "athlete_id",
      "attempts",
      "completed_at",
      "created_at",
      "id",
      "last_error",
      "lease_holder",
      "lease_until",
      "output_asset_id",
      "spec",
      "started_at",
      "status",
      "updated_at",
    ]);
    await pg.close();
  });

  /**
   * THE REVERT CHECK for re-runnability. db-migrate.sh re-runs every file on every deploy, so the
   * second and third runs must change nothing — and "nothing" has to mean the table was never
   * dropped and re-created, not merely that the end state matches. An OID that moved would mean the
   * table was rebuilt under a live system, taking its rows with it.
   *
   * MUTATION: delete `IF NOT EXISTS` from the CREATE TABLE. Run 2 then fails with
   * "relation already exists", so this reds on the `toBeNull()` before it ever reaches the OID.
   */
  it("re-runs are a no-op and OID-stable — the table is never dropped and re-created", async () => {
    const pg = await pre0057();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const oid = await tableOid(pg);
    const cols = await columnsOf(pg);
    const idx = await indexesOf(pg);
    const cons = await constraintsOf(pg);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect(await tableOid(pg)).toBe(oid);
    expect(await columnsOf(pg)).toEqual(cols);
    expect(await indexesOf(pg)).toEqual(idx);
    expect(await constraintsOf(pg)).toEqual(cons);
    await pg.close();
  });

  it("preserves the rows that were already there", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    const id = await seedStitch(pg, athlete);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const rows = (
      await pg.query<{ id: string; status: string; attempts: number }>(
        `SELECT id, status, attempts FROM ${TABLE}`,
      )
    ).rows;
    expect(rows).toEqual([{ id, status: "queued", attempts: 0 }]);
    await pg.close();
  });
});

describe("0057: the status vocabulary the runner depends on", () => {
  it("accepts every status the runner writes, and refuses anything else", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);

    for (const s of STATUSES)
      await expect(seedStitch(pg, athlete, s)).resolves.toBeTruthy();
    await expect(seedStitch(pg, athlete, "archived")).rejects.toThrow();
    await pg.close();
  });

  /**
   * 'pending' is generation_jobs' vocabulary, not this table's: an image generates INLINE and is
   * pending while the request runs, whereas a stitch has no inline path and is owed the moment it
   * is asked for. Pinned so a copy-paste from 0056 cannot quietly widen it back.
   */
  it("refuses 'pending' — a stitch is born queued", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await expect(seedStitch(pg, athlete, "pending")).rejects.toThrow();
    await pg.close();
  });

  it("defaults a row with no status to queued", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await pg.query(
      `INSERT INTO ${TABLE} (athlete_id, spec) VALUES ($1, '{}'::jsonb)`,
      [athlete],
    );
    expect(
      (await pg.query<{ status: string }>(`SELECT status FROM ${TABLE}`))
        .rows[0].status,
    ).toBe("queued");
    await pg.close();
  });
});

describe("0057: the foreign keys bite", () => {
  it("cascades from the athlete — her jobs go when she does", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await seedStitch(pg, athlete);

    await pg.query(`DELETE FROM athletes WHERE id = $1`, [athlete]);
    expect(
      (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`))
        .rows[0].n,
    ).toBe(0);
    await pg.close();
  });

  /**
   * SET NULL, never cascade. A swept output asset must not delete the record that the stitch ran —
   * "this job produced a file that has since been removed" is a different fact from "this job never
   * existed", and only the first one is true.
   */
  it("nulls output_asset_id when the asset is swept, and keeps the run", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    const asset = (
      await pg.query<{ id: string }>(
        `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status, gcs_path)
       VALUES ($1, 'studio', 'generated', 'VIDEO', 'stored', 'x/y.mp4') RETURNING id`,
        [athlete],
      )
    ).rows[0].id;
    const job = await seedStitch(pg, athlete);
    await pg.query(`UPDATE ${TABLE} SET output_asset_id = $1 WHERE id = $2`, [
      asset,
      job,
    ]);

    await pg.query(`DELETE FROM media_assets WHERE id = $1`, [asset]);

    const rows = (
      await pg.query<{ id: string; output_asset_id: string | null }>(
        `SELECT id, output_asset_id FROM ${TABLE}`,
      )
    ).rows;
    expect(rows).toEqual([{ id: job, output_asset_id: null }]);
    await pg.close();
  });

  it("refuses a spec pointing at an output asset that does not exist", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await expect(
      pg.query(
        `INSERT INTO ${TABLE} (athlete_id, spec, output_asset_id)
         VALUES ($1, '{}'::jsonb, '33333333-3333-4333-8333-333333333333')`,
        [athlete],
      ),
    ).rejects.toThrow();
    await pg.close();
  });
});

describe("0057: ROLLBACK — the previous image keeps running against the new schema", () => {
  /**
   * The pre-0057 image has never heard of this table, so rolling BACK to it is a no-op: it writes
   * generation_jobs exactly as it did, and the new table simply sits there unread. This is the
   * whole rollback story, and it is worth asserting rather than asserting in prose.
   */
  it("every generation_jobs write the pre-0057 code makes still works after 0057 applies", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);

    for (const s of [
      "pending",
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ]) {
      await expect(seedGenerationJob(pg, athlete, s)).resolves.not.toThrow();
    }
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM generation_jobs`,
        )
      ).rows[0].n,
    ).toBe(6);
    await pg.close();
  });

  it("dropping the table back out leaves everything else standing — the manual revert path", async () => {
    const pg = await pre0057();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await seedStitch(pg, athlete);
    await seedGenerationJob(pg, athlete);

    await pg.exec(`DROP TABLE ${TABLE};`);

    // No dependent object anywhere else: nothing references this table, so nothing else moves.
    await expect(seedGenerationJob(pg, athlete)).resolves.not.toThrow();
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM generation_jobs`,
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='${TABLE}'`,
        )
      ).rows[0].n,
    ).toBe(0);
    await pg.close();
  });
});

describe("0057: the file matches shared/schema.ts, and is on the list", () => {
  /**
   * The HARD drift gate (db-migrate.sh step 5) compares tables and columns, so this is the check
   * that catches what it cannot: a constraint or an index the hand-written file and the schema
   * declaration disagree about. Constraints are compared by NAME as well as definition, because
   * drizzle generates `studio_stitch_jobs_athlete_id_athletes_id_fk` and a hand-written FK under
   * any other name is invisible drift.
   */
  it("produces the same table as a schema.ts push — columns, indexes AND constraints", async () => {
    const fromFile = await pre0057();
    await applyLikePsql(fromFile, MIGRATION);
    const fromSchema = await pushed();

    expect(await columnsOf(fromFile)).toEqual(await columnsOf(fromSchema));
    expect(await indexesOf(fromFile)).toEqual(await indexesOf(fromSchema));
    expect(await constraintsOf(fromFile)).toEqual(
      await constraintsOf(fromSchema),
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0056", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0057_studio_stitch_jobs")).toHaveLength(1);
    expect(list.indexOf("0057_studio_stitch_jobs")).toBe(
      list.indexOf("0056_studio_video_jobs") + 1,
    );
  });
});
