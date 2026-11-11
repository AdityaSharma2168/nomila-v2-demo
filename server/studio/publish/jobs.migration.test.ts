/**
 * jobs.migration.test.ts — the revert check for migrations/0059_studio_publish_jobs.sql.
 *
 * ─── WHAT 0059 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 * Three claims, and each one has a test below that reds BY NAME when the claim is taken out:
 *
 *   1. TWO TAPS ARE ONE POST. `uq_studio_publish_jobs_live` allows one live job per video per
 *      platform. Drop that index from the file and "refuses a second LIVE job…" goes red. This is
 *      the only guard against a double-tap that a race between two requests cannot get past.
 *   2. A ROW CANNOT FORGET ITS MODE. `mode` has no default, so a writer that never decided between
 *      dry and live is refused by the database instead of inheriting one. Give it a default and
 *      "refuses a row with no mode…" goes red.
 *   3. THE RECORD OUTLIVES WHAT IT POINTS AT. Both optional foreign keys are SET NULL. Turn either
 *      into a CASCADE and the two "…and keeps the record" tests go red.
 *
 * Plus 0057's structural claim, inherited whole: NO DROP + ADD PAIR, so 0056's race has no window
 * to land in. A claim about a file's shape is checked against the file's shape.
 *
 * ─── WHY THE FILE IS EXECUTED STATEMENT-AT-A-TIME ───────────────────────────────────────────────
 *
 * `pg.exec(WHOLE_FILE)` sends a multi-statement simple Query, which Postgres wraps in ONE implicit
 * transaction — under which a broken file can roll back cleanly and prove nothing. db-migrate.sh
 * runs `psql -f` with NO --single-transaction, so each statement autocommits alone. `applyLikePsql`
 * reproduces that.
 *
 * `splitStatements` is duplicated from stitchJobs.migration.test.ts rather than imported: importing
 * that module would register ITS describes inside this suite and run 0057's tests twice.
 *
 * ─── WHAT IS NOT COVERED ────────────────────────────────────────────────────────────────────────
 *
 *   * THE CONCURRENT INTERLEAVE, for 0057's reason: PGlite's query()/transaction() share a mutex.
 *     The double-tap guard is therefore proven SEQUENTIALLY here — which is sufficient, because a
 *     unique index is not a check-then-write: the loser of a real race gets the same 23505 the
 *     second sequential insert gets.
 *   * REAL POSTGRES. Only the deploy-dev migration step proves the file applies to Cloud SQL.
 *   * THE SUBMIT-ONCE ORDERING ITSELF. This file proves the two columns exist to be ordered; that
 *     they ARE ordered is the runner's claim and lives beside the runner.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0059_studio_publish_jobs.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const TABLE = "studio_publish_jobs";
const INDEXES = [
  "idx_studio_publish_jobs_athlete",
  "idx_studio_publish_jobs_claim",
  "idx_studio_publish_jobs_lease",
  "uq_studio_publish_jobs_live",
];
const STATUSES = ["queued", "running", "succeeded", "failed", "canceled"];
const LIVE = ["queued", "running"];
const FINISHED = ["succeeded", "failed", "canceled"];

/**
 * Split SQL the way psql does: on top-level semicolons, respecting $$…$$ dollar quoting so a DO
 * block would arrive as one statement, and skipping `--` comments so a semicolon in prose is not a
 * split. (0059 contains no DO block; the splitter still has to be dollar-quote aware to be a
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
 * A database in its PRE-0059 state: schema.ts pushed, then the new table rewound away. That is
 * exactly what dev and prod look like today — every other table present, this one absent.
 */
async function pre0059(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${TABLE};`); // takes its indexes and constraints with it
  return pg;
}

/** The deploy case, which nearly every test below starts from. */
async function migrated(): Promise<PGlite> {
  const pg = await pre0059();
  const err = await applyLikePsql(pg, MIGRATION);
  if (err) throw err;
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

/** Every constraint by NAME and DEFINITION — a hand-written FK under another name is invisible drift. */
const constraintsOf = async (pg: PGlite) =>
  (
    await pg.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = '${TABLE}'::regclass ORDER BY conname`,
    )
  ).rows;

const countRows = async (pg: PGlite, table = TABLE) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
    .rows[0].n;

const ATHLETE = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE = "99999999-9999-4999-8999-999999999999";

async function seedAthlete(pg: PGlite, id = ATHLETE) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

/** A finished video on her shelf. Synthetic: no real path, no real person. */
async function seedAsset(pg: PGlite, athleteId: string, path = "x/y.mp4") {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status, gcs_path)
       VALUES ($1, 'studio', 'generated', 'VIDEO', 'stored', $2) RETURNING id`,
      [athleteId, path],
    )
  ).rows[0].id;
}

async function seedAccount(pg: PGlite, athleteId: string) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO connected_accounts (athlete_id, platform, status, platform_username)
       VALUES ($1, 'instagram', 'active', 'synthetic_handle') RETURNING id`,
      [athleteId],
    )
  ).rows[0].id;
}

interface SeedJob {
  athleteId: string;
  assetId: string | null;
  accountId?: string | null;
  platform?: string;
  status?: string;
  mode?: string;
}

/** A publish job, as the route will write one: an asset ID, a pinned account, a frozen mode. */
async function seedJob(pg: PGlite, j: SeedJob) {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO ${TABLE} (athlete_id, asset_id, connected_account_id, platform, caption, mode, status)
     VALUES ($1, $2, $3, $4, 'a caption', $5, $6) RETURNING id`,
    [
      j.athleteId,
      j.assetId,
      j.accountId ?? null,
      j.platform ?? "instagram",
      j.mode ?? "dry",
      j.status ?? "queued",
    ],
  );
  return res.rows[0].id;
}

/** A stitch job written exactly the way the PRE-0059 code writes one. */
async function seedStitch(pg: PGlite, athleteId: string) {
  await pg.query(
    `INSERT INTO studio_stitch_jobs (athlete_id, spec) VALUES ($1, '{}'::jsonb)`,
    [athleteId],
  );
}

jest.setTimeout(180_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("0059: THE SHAPE — there is no DROP+ADD pair, so 0056's race cannot happen", () => {
  it("writes no DROP CONSTRAINT, no DROP INDEX and no bare ADD CONSTRAINT", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    expect(sql.match(/DROP\s+CONSTRAINT/gi) ?? []).toEqual([]);
    expect(sql.match(/DROP\s+INDEX/gi) ?? []).toEqual([]);
    expect(
      sql.match(/ALTER\s+TABLE[\s\S]{0,200}?ADD\s+CONSTRAINT/gi) ?? [],
    ).toEqual([]);
    // No data movement either — "ONE new table and nothing else" has to be true.
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

  it("creates exactly one table, and it is a new one — content_posts is not touched", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    const creates = sql.match(/CREATE\s+TABLE[^(]*/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/IF\s+NOT\s+EXISTS\s+studio_publish_jobs/i);
    expect(sql).not.toMatch(/content_posts/i);
    expect(sql.match(/ALTER\s+TABLE/gi) ?? []).toEqual([]);
  });
});

describe("0059: FRESH AND EXISTING DATABASES both converge", () => {
  it("applies to a database that has never seen the table (the deploy case)", async () => {
    const pg = await pre0059();
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name='${TABLE}'`,
        )
      ).rows[0].n,
    ).toBe(0);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect((await indexesOf(pg)).map((i) => i.indexname)).toEqual(
      [...INDEXES, "studio_publish_jobs_pkey"].sort(),
    );
    expect((await columnsOf(pg)).map((c) => c.column_name)).toEqual([
      "asset_id",
      "athlete_id",
      "attempts",
      "caption",
      "completed_at",
      "connected_account_id",
      "container_created_at",
      "container_id",
      "created_at",
      "error_code",
      "id",
      "ig_media_id",
      "last_error",
      "lease_holder",
      "lease_until",
      "mode",
      "permalink",
      "platform",
      "poll_count",
      "publish_attempted_at",
      "started_at",
      "status",
      "updated_at",
    ]);
    await pg.close();
  });

  /**
   * MUTATION: delete `IF NOT EXISTS` from the CREATE TABLE. Run 2 then fails with "relation already
   * exists", so this reds on the `toBeNull()` before it ever reaches the OID.
   */
  it("re-runs are a no-op and OID-stable — the table is never dropped and re-created", async () => {
    const pg = await migrated();

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

  it("preserves the rows that were already there — including a handle already written", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    const id = await seedJob(pg, { athleteId: athlete, assetId: asset });
    await pg.query(
      `UPDATE ${TABLE} SET container_id = 'c-1', publish_attempted_at = now() WHERE id = $1`,
      [id],
    );

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const rows = (
      await pg.query<{
        id: string;
        container_id: string | null;
        attempted: boolean;
      }>(
        `SELECT id, container_id, publish_attempted_at IS NOT NULL AS attempted FROM ${TABLE}`,
      )
    ).rows;
    expect(rows).toEqual([{ id, container_id: "c-1", attempted: true }]);
    await pg.close();
  });
});

describe("0059: THE DOUBLE-TAP GUARD — two taps are one post", () => {
  /**
   * THE REVERT CHECK for claim 1. MUTATION: delete the `CREATE UNIQUE INDEX … uq_studio_publish_jobs_live`
   * statement from the migration. The second insert then succeeds and this reds on `rejects`.
   *
   * Both LIVE statuses hold the slot. `running` matters as much as `queued`: the second tap that
   * arrives while the first is mid-upload is the one that would otherwise post twice.
   */
  it("refuses a second LIVE job for the same video on the same platform", async () => {
    for (const first of LIVE) {
      const pg = await migrated();
      const athlete = await seedAthlete(pg);
      const asset = await seedAsset(pg, athlete);
      await seedJob(pg, { athleteId: athlete, assetId: asset, status: first });

      await expect(
        seedJob(pg, { athleteId: athlete, assetId: asset }),
      ).rejects.toThrow(/uq_studio_publish_jobs_live|unique/i);
      expect(await countRows(pg)).toBe(1);
      await pg.close();
    }
  });

  /**
   * The other half, and the reason the index is PARTIAL. Posting the same video again next month is
   * a thing she may decide to do (content_posts: "one asset → many posts"). A finished row must not
   * hold the slot — and a FAILED one above all, or a failed post could never be retried.
   */
  it("a FINISHED job does not hold the slot — her retry, and her repost, stay possible", async () => {
    for (const done of FINISHED) {
      const pg = await migrated();
      const athlete = await seedAthlete(pg);
      const asset = await seedAsset(pg, athlete);
      await seedJob(pg, { athleteId: athlete, assetId: asset, status: done });

      await expect(
        seedJob(pg, { athleteId: athlete, assetId: asset }),
      ).resolves.toBeTruthy();
      expect(await countRows(pg)).toBe(2);
      await pg.close();
    }
  });

  it("is per video and per platform — a different video, or another platform, is not a double tap", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const a = await seedAsset(pg, athlete, "x/a.mp4");
    const b = await seedAsset(pg, athlete, "x/b.mp4");
    await seedJob(pg, { athleteId: athlete, assetId: a });

    await expect(
      seedJob(pg, { athleteId: athlete, assetId: b }),
    ).resolves.toBeTruthy();
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: a, platform: "tiktok" }),
    ).resolves.toBeTruthy();
    await pg.close();
  });

  /**
   * The slot has to come back the moment a job ends, by the UPDATE the runner makes — not by a
   * sweep. Otherwise a failed post leaves her unable to try again until something else runs.
   */
  it("frees the slot when the live job is closed", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    const first = await seedJob(pg, { athleteId: athlete, assetId: asset });
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: asset }),
    ).rejects.toThrow();

    await pg.query(`UPDATE ${TABLE} SET status = 'failed' WHERE id = $1`, [
      first,
    ]);

    await expect(
      seedJob(pg, { athleteId: athlete, assetId: asset }),
    ).resolves.toBeTruthy();
    await pg.close();
  });
});

describe("0059: the vocabularies the runner depends on", () => {
  it("accepts every status the runner writes, and refuses anything else", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);

    for (const [i, s] of STATUSES.entries()) {
      const asset = await seedAsset(pg, athlete, `x/${i}.mp4`);
      await expect(
        seedJob(pg, { athleteId: athlete, assetId: asset, status: s }),
      ).resolves.toBeTruthy();
    }
    const asset = await seedAsset(pg, athlete, "x/z.mp4");
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: asset, status: "archived" }),
    ).rejects.toThrow();
    // 'pending' is generation_jobs' vocabulary: a publish has no inline path, so it is born queued.
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: asset, status: "pending" }),
    ).rejects.toThrow();
    await pg.close();
  });

  it("defaults a row with no status to queued, with nothing attempted and nothing polled", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await pg.query(
      `INSERT INTO ${TABLE} (athlete_id, platform, mode) VALUES ($1, 'instagram', 'dry')`,
      [athlete],
    );
    const [row] = (
      await pg.query<Record<string, unknown>>(
        `SELECT status, caption, attempts, poll_count, container_id, publish_attempted_at, ig_media_id
           FROM ${TABLE}`,
      )
    ).rows;
    expect(row).toEqual({
      status: "queued",
      caption: "",
      attempts: 0,
      poll_count: 0,
      container_id: null,
      publish_attempted_at: null,
      ig_media_id: null,
    });
    await pg.close();
  });

  /**
   * THE REVERT CHECK for claim 2. MUTATION: give `mode` a default (`DEFAULT 'live'` is the dangerous
   * one; `DEFAULT 'dry'` is the tempting one). Either way the first insert below succeeds and this
   * reds. A writer that never chose must be refused, not given an answer.
   */
  it("refuses a row with no mode — dry or live is decided at the tap, never inherited", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await expect(
      pg.query(
        `INSERT INTO ${TABLE} (athlete_id, platform) VALUES ($1, 'instagram')`,
        [athlete],
      ),
    ).rejects.toThrow(/mode/i);
    expect(await countRows(pg)).toBe(0);
    await pg.close();
  });

  it("accepts dry and live, and refuses every other mode — 'off' is not a way to queue a job", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    for (const [i, mode] of ["dry", "live"].entries()) {
      const asset = await seedAsset(pg, athlete, `x/${i}.mp4`);
      await expect(
        seedJob(pg, { athleteId: athlete, assetId: asset, mode }),
      ).resolves.toBeTruthy();
    }
    const asset = await seedAsset(pg, athlete, "x/z.mp4");
    for (const mode of ["off", "LIVE", "", "test"]) {
      await expect(
        seedJob(pg, { athleteId: athlete, assetId: asset, mode }),
      ).rejects.toThrow();
    }
    await pg.close();
  });

  /**
   * Pinned so that adding the CHECK is a decision somebody reads about first. `platform` is the one
   * vocabulary here certain to grow, and widening a CHECK is the DROP + ADD pair 0056 documents as
   * two outages. The closed list lives in the route; the runner refuses what it cannot publish.
   */
  it("has NO check on platform, on purpose", async () => {
    const pg = await migrated();
    // contype = 'c' — CHECKs only. PGlite is a newer Postgres than Cloud SQL's 15 and lists every
    // NOT NULL in pg_constraint too (contype 'n'); asking for all of them would pin this test to
    // the test database's version instead of to the claim.
    const checks = (
      await pg.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = '${TABLE}'::regclass AND contype = 'c' ORDER BY conname`,
      )
    ).rows.map((r) => r.conname);
    expect(checks).toEqual([
      "studio_publish_jobs_mode_check",
      "studio_publish_jobs_status_check",
    ]);
    // And the behaviour the absence buys: the DATABASE takes a platform the route does not know yet.
    const athlete = await seedAthlete(pg);
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: null, platform: "tiktok" }),
    ).resolves.toBeTruthy();
    await pg.close();
  });
});

describe("0059: the foreign keys bite, and the record outlives what it points at", () => {
  it("cascades from the athlete — her jobs go when she does, and nobody else's do", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const other = await seedAthlete(pg, OTHER_ATHLETE);
    await seedJob(pg, { athleteId: athlete, assetId: null });
    const kept = await seedJob(pg, { athleteId: other, assetId: null });

    await pg.query(`DELETE FROM athletes WHERE id = $1`, [athlete]);

    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${TABLE}`)).rows,
    ).toEqual([{ id: kept }]);
    await pg.close();
  });

  /**
   * THE REVERT CHECK for claim 3, first half. MUTATION: `ON DELETE CASCADE` on the asset FK. The row
   * then vanishes with the asset and this reds. "We posted this to her Instagram" is the only record
   * on our side that a public post came from here; sweeping the file must not erase it.
   */
  it("nulls asset_id when the video is swept, and keeps the record", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    const job = await seedJob(pg, {
      athleteId: athlete,
      assetId: asset,
      status: "succeeded",
    });
    await pg.query(
      `UPDATE ${TABLE} SET ig_media_id = 'm-1', permalink = 'https://example.test/p/1' WHERE id = $1`,
      [job],
    );

    await pg.query(`DELETE FROM media_assets WHERE id = $1`, [asset]);

    expect(
      (
        await pg.query<Record<string, unknown>>(
          `SELECT id, asset_id, ig_media_id, permalink FROM ${TABLE}`,
        )
      ).rows,
    ).toEqual([
      {
        id: job,
        asset_id: null,
        ig_media_id: "m-1",
        permalink: "https://example.test/p/1",
      },
    ]);
    await pg.close();
  });

  /** Claim 3, second half. MUTATION: `ON DELETE CASCADE` on the account FK. */
  it("nulls connected_account_id when the account is removed, and keeps the record", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    const account = await seedAccount(pg, athlete);
    const job = await seedJob(pg, {
      athleteId: athlete,
      assetId: asset,
      accountId: account,
      status: "succeeded",
    });

    await pg.query(`DELETE FROM connected_accounts WHERE id = $1`, [account]);

    expect(
      (
        await pg.query<Record<string, unknown>>(
          `SELECT id, connected_account_id FROM ${TABLE}`,
        )
      ).rows,
    ).toEqual([{ id: job, connected_account_id: null }]);
    await pg.close();
  });

  it("refuses an asset or an account that does not exist", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const ghost = "33333333-3333-4333-8333-333333333333";
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: ghost }),
    ).rejects.toThrow();
    await expect(
      seedJob(pg, { athleteId: athlete, assetId: null, accountId: ghost }),
    ).rejects.toThrow();
    await pg.close();
  });
});

describe("0059: ROLLBACK — the previous image keeps running against the new schema", () => {
  it("every write the pre-0059 code makes to its own queues still works after 0059 applies", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await expect(seedStitch(pg, athlete)).resolves.not.toThrow();
    const asset = await seedAsset(pg, athlete);
    await expect(
      pg.query(
        `INSERT INTO content_posts (asset_id, platform, permalink) VALUES ($1, 'instagram', 'https://example.test/p/1')`,
        [asset],
      ),
    ).resolves.toBeTruthy();
    await pg.close();
  });

  it("dropping the table back out leaves everything else standing — the manual revert path", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    const account = await seedAccount(pg, athlete);
    await seedJob(pg, {
      athleteId: athlete,
      assetId: asset,
      accountId: account,
    });

    await pg.exec(`DROP TABLE ${TABLE};`);

    // Nothing references this table, so nothing else moves: the asset and the account are untouched.
    expect(await countRows(pg, "media_assets")).toBe(1);
    expect(await countRows(pg, "connected_accounts")).toBe(1);
    await expect(seedStitch(pg, athlete)).resolves.not.toThrow();
    await pg.close();
  });
});

describe("0059: the file matches shared/schema.ts, and is on the list", () => {
  /**
   * The HARD drift gate compares table and column NAMES only, so this is the check that catches
   * what it cannot: a type, a default, a constraint or an index the hand-written file and the
   * schema declaration disagree about. Constraints are compared by NAME as well as definition —
   * which is what holds `studio_publish_jobs_connected_account_fk` to its hand-chosen name on both
   * sides (the generated one is 65 characters; Postgres would truncate it and say nothing).
   */
  it("produces the same table as a schema.ts push — columns, indexes AND constraints", async () => {
    const fromFile = await migrated();
    const fromSchema = await pushed();

    expect(await columnsOf(fromFile)).toEqual(await columnsOf(fromSchema));
    expect(await indexesOf(fromFile)).toEqual(await indexesOf(fromSchema));
    expect(await constraintsOf(fromFile)).toEqual(
      await constraintsOf(fromSchema),
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("no constraint or index name is long enough for Postgres to truncate", async () => {
    const pg = await migrated();
    const names = [
      ...(await constraintsOf(pg)).map((c) => c.conname),
      ...(await indexesOf(pg)).map((i) => i.indexname),
    ];
    // NAMEDATALEN - 1. At 63 exactly a name is already suspect: it may BE a truncation.
    for (const n of names) expect(n.length).toBeLessThan(63);
    await pg.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0058", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0059_studio_publish_jobs")).toHaveLength(
      1,
    );
    expect(list.indexOf("0059_studio_publish_jobs")).toBe(
      list.indexOf("0058_media_assets_duration_precise") + 1,
    );
  });
});
