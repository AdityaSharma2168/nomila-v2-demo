/**
 * previews.migration.test.ts — the revert check for migrations/0064_studio_edit_previews.sql (Studio
 * PR 9, Lane 1), on 0061's harness (server/studio/agent/plans.migration.test.ts).
 *
 * ─── WHAT 0064 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 *   1. HER EDIT PREVIEWS GO WITH HER, AND WITH THE PHOTO. athlete_id and source_asset_id CASCADE.
 *      Make either SET NULL and its test reds by name.
 *   2. THE RESULT OUTLIVES ITS QUOTE, ITS JOB AND THE ROW ACCEPT WROTE. preview_id, job_id and
 *      accepted_asset_id are SET NULL. Make one CASCADE and "keeps the preview when …" reds.
 *   3. A SIXTH OP, OR A STATUS OFF THE LIST, IS REFUSED AT THE WRITE. The two CHECKs.
 *   4. ADDITIVE ONLY — THE REVERT LEAVES NO ORPHAN. Dropping the table returns the catalog to its
 *      exact pre-0064 state.
 *   5. IT IS THE SCHEMA. Columns, indexes and constraints equal a schema.ts push, and the file is on
 *      db-migrate.sh's list once, after 0061 (0062 is PR 7's and sits between them once it lands).
 *
 * Statement-at-a-time, as `psql -f` without --single-transaction applies it (see 0060's header).
 * NOT covered: real Postgres (deploy-dev's migration step), and the code-level tenancy checks
 * (previews.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0064_studio_edit_previews.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const T = "studio_edit_previews";

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
async function pre0064(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${T};`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0064();
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

// Synthetic ids and paths throughout — no real person or object.
const ATHLETE = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE = "99999999-9999-4999-8999-999999999999";

async function seedAthlete(pg: PGlite, id = ATHLETE) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

async function seedPhoto(pg: PGlite, athleteId: string) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status, gcs_path)
       VALUES ($1, 'upload', 'upload', 'IMAGE', 'stored', 'athletes/x/uploads/synthetic.jpg') RETURNING id`,
      [athleteId],
    )
  ).rows[0].id;
}

async function seedQuote(pg: PGlite, athleteId: string) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO studio_generation_previews (athlete_id, brief, status, expires_at)
       VALUES ($1, '{}'::jsonb, 'ready', now() + interval '30 minutes') RETURNING id`,
      [athleteId],
    )
  ).rows[0].id;
}

async function seedJob(pg: PGlite, athleteId: string, source: string) {
  // generation_jobs_edit_needs_source: an edit job names its frame, as the engine's job will.
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO generation_jobs (athlete_id, origin, mode, objective, deliverable, brief, source_asset_id)
       VALUES ($1, 'system', 'edit', 'showcase-product', 'post', '{}'::jsonb, $2) RETURNING id`,
      [athleteId, source],
    )
  ).rows[0].id;
}

async function seedPreview(
  pg: PGlite,
  athleteId: string,
  source: string,
  over: {
    op?: string;
    status?: string;
    quote?: string | null;
    job?: string | null;
    accepted?: string | null;
  } = {},
) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO ${T} (athlete_id, source_asset_id, op, status, preview_id, job_id, accepted_asset_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '1 hour') RETURNING id`,
      [
        athleteId,
        source,
        over.op ?? "recolour",
        over.status ?? "quoted",
        over.quote ?? null,
        over.job ?? null,
        over.accepted ?? null,
      ],
    )
  ).rows[0].id;
}

const readOne = async (pg: PGlite, id: string) =>
  (
    await pg.query<{
      preview_id: string | null;
      job_id: string | null;
      accepted_asset_id: string | null;
    }>(`SELECT preview_id, job_id, accepted_asset_id FROM ${T} WHERE id = $1`, [
      id,
    ])
  ).rows;

describe("0064: applies additively, and re-runs as a no-op", () => {
  it("creates the one table, and a second run changes nothing (same OID)", async () => {
    const pg = await migrated();
    const oid = await tableOid(pg, T);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await tableOid(pg, T)).toBe(oid);
    await pg.close();
  });

  it("dropping the table leaves zero orphan objects — the catalog is exactly pre-0064", async () => {
    const pg = await pre0064();
    const before = await catalogOf(pg);
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    await seedAthlete(pg);
    const photo = await seedPhoto(pg, ATHLETE);
    await seedPreview(pg, ATHLETE, photo);
    await pg.exec(`DROP TABLE ${T};`);
    expect(await catalogOf(pg)).toEqual(before);
    expect(await countRows(pg, "media_assets")).toBe(1);
    await pg.close();
  });
});

describe("0064: what goes with what is the database's, not only the code's", () => {
  /** ⚠️ MUTATION: make the athlete FK SET NULL — this reds by name (and the NOT NULL would refuse it anyway). */
  it("deleting the athlete takes every edit preview of hers, and none of another's", async () => {
    const pg = await migrated();
    await seedAthlete(pg, ATHLETE);
    await seedAthlete(pg, OTHER_ATHLETE);
    const hers = await seedPhoto(pg, ATHLETE);
    const theirs = await seedPhoto(pg, OTHER_ATHLETE);
    await seedPreview(pg, ATHLETE, hers);
    await seedPreview(pg, ATHLETE, hers, { status: "ready" });
    await seedPreview(pg, OTHER_ATHLETE, theirs);
    await pg.query(`DELETE FROM athletes WHERE id = $1`, [ATHLETE]);
    expect(await countRows(pg, T)).toBe(1);
    await pg.close();
  });

  /** ⚠️ MUTATION: make the source FK SET NULL — this reds by name. */
  it("deleting the source photo takes its previews — there is nothing left to accept onto", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const a = await seedPhoto(pg, ATHLETE);
    const b = await seedPhoto(pg, ATHLETE);
    await seedPreview(pg, ATHLETE, a);
    await seedPreview(pg, ATHLETE, b);
    await pg.query(`DELETE FROM media_assets WHERE id = $1`, [a]);
    expect(await countRows(pg, T)).toBe(1);
    await pg.close();
  });

  /** ⚠️ MUTATION: make the quote FK CASCADE — this reds by name. */
  it("keeps the preview when its quote row goes — preview_id nulls, the result stays", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const photo = await seedPhoto(pg, ATHLETE);
    const quote = await seedQuote(pg, ATHLETE);
    const id = await seedPreview(pg, ATHLETE, photo, { quote });
    await pg.query(`DELETE FROM studio_generation_previews WHERE id = $1`, [
      quote,
    ]);
    expect(await readOne(pg, id)).toEqual([
      { preview_id: null, job_id: null, accepted_asset_id: null },
    ]);
    await pg.close();
  });

  /** ⚠️ MUTATION: make the job FK CASCADE — this reds by name. */
  it("keeps the preview when its job row goes — job_id nulls", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const photo = await seedPhoto(pg, ATHLETE);
    const job = await seedJob(pg, ATHLETE, photo);
    const id = await seedPreview(pg, ATHLETE, photo, { job, status: "ready" });
    await pg.query(`DELETE FROM generation_jobs WHERE id = $1`, [job]);
    expect(await readOne(pg, id)).toEqual([
      { preview_id: null, job_id: null, accepted_asset_id: null },
    ]);
    await pg.close();
  });

  /** ⚠️ MUTATION: make the accepted-asset FK CASCADE — this reds by name. */
  it("keeps the record that she accepted when the accepted row goes — accepted_asset_id nulls", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const photo = await seedPhoto(pg, ATHLETE);
    const made = await seedPhoto(pg, ATHLETE);
    const id = await seedPreview(pg, ATHLETE, photo, {
      accepted: made,
      status: "accepted",
    });
    await pg.query(`DELETE FROM media_assets WHERE id = $1`, [made]);
    expect(await readOne(pg, id)).toEqual([
      { preview_id: null, job_id: null, accepted_asset_id: null },
    ]);
    expect(await countRows(pg, T)).toBe(1);
    await pg.close();
  });

  /** ⚠️ MUTATION: drop either CHECK — its half reds by name. */
  it("refuses a sixth op and a status off the list, at the write", async () => {
    const pg = await migrated();
    await seedAthlete(pg);
    const photo = await seedPhoto(pg, ATHLETE);
    await expect(
      seedPreview(pg, ATHLETE, photo, { op: "upscale" }),
    ).rejects.toThrow(/studio_edit_previews_op_check/);
    await expect(
      seedPreview(pg, ATHLETE, photo, { status: "stored" }),
    ).rejects.toThrow(/studio_edit_previews_status_check/);
    for (const op of [
      "recolour",
      "garment",
      "product",
      "background_clean",
      "ad",
    ]) {
      await expect(seedPreview(pg, ATHLETE, photo, { op })).resolves.toEqual(
        expect.any(String),
      );
    }
    await pg.close();
  });
});

describe("0064: the file matches shared/schema.ts, and is on the list", () => {
  it("produces the same table as a schema.ts push — columns, indexes AND constraints", async () => {
    const fromFile = await migrated();
    const fromSchema = await pushed();
    expect(await columnsOf(fromFile, T)).toEqual(
      await columnsOf(fromSchema, T),
    );
    expect(await indexesOf(fromFile, T)).toEqual(
      await indexesOf(fromSchema, T),
    );
    expect(await constraintsOf(fromFile, T)).toEqual(
      await constraintsOf(fromSchema, T),
    );
    await fromFile.close();
    await fromSchema.close();
  });

  it("no constraint or index name is long enough for Postgres to truncate", async () => {
    const pg = await migrated();
    const names = [
      ...(await constraintsOf(pg, T)).map((c) => c.conname),
      ...(await indexesOf(pg, T)).map((i) => i.indexname),
    ];
    for (const n of names) expect(n.length).toBeLessThan(63);
    await pg.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0061 (0062 between them once PR 7 lands)", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0064_studio_edit_previews")).toHaveLength(
      1,
    );
    expect(list.indexOf("0064_studio_edit_previews")).toBeGreaterThan(
      list.indexOf("0061_studio_plans"),
    );
    // Ordered placement, not "last": every later migration (0065_objective_run_events was the first) would
    // otherwise red this test without touching 0064 or its claims.
    expect(list.indexOf("0064_studio_edit_previews")).toBe(list.indexOf("0063_objectives") + 1);
  });
});
