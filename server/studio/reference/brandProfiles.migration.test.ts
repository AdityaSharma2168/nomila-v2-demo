/**
 * brandProfiles.migration.test.ts — the revert check for migrations/0060_studio_brand_profiles.sql.
 *
 * ─── WHAT 0060 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 * Each claim has a test below that reds BY NAME when the claim is taken out of the file:
 *
 *   1. AN ANALYSIS CANNOT BE FILED UNDER ANOTHER ATHLETE'S PROFILE. The profile FK is composite,
 *      (brand_profile_id, athlete_id) → (id, athlete_id). Make it a plain FK on brand_profile_id and
 *      "refuses an analysis filed under ANOTHER athlete's profile" goes red.
 *   2. EXACTLY ONE SOURCE. Drop `studio_reference_analyses_one_source_check` and the "zero sources"
 *      and "two sources" tests go red.
 *   3. HER PROFILE OUTLIVES A CATALOG MERGE. brand_id is SET NULL. Make it CASCADE and "nulls
 *      brand_id when the catalog brand is deleted, and keeps the profile" goes red.
 *   4. ONE PROFILE PER CATALOG BRAND, PER ATHLETE. Drop `uq_studio_brand_profiles_brand` and
 *      "refuses a second profile for the same brand" goes red.
 *   5. ADDITIVE ONLY — THE REVERT LEAVES NO ORPHAN. Dropping the two tables returns the catalog to
 *      its exact pre-0060 state. Add anything outside the two tables (an index on media_assets, a
 *      sequence, a type) and "dropping both tables leaves zero orphan objects" goes red.
 *
 * Plus 0057's structural claim, inherited whole: no DROP + ADD pair, no ALTER, no data movement.
 *
 * ─── WHY THE FILE IS EXECUTED STATEMENT-AT-A-TIME ───────────────────────────────────────────────
 *
 * db-migrate.sh runs `psql -f` with NO --single-transaction, so each statement autocommits alone.
 * `applyLikePsql` reproduces that; `pg.exec(WHOLE_FILE)` would wrap the file in one implicit
 * transaction. `splitStatements` is duplicated from jobs.migration.test.ts rather than imported,
 * for that file's reason: importing it would register its describes inside this suite.
 *
 * ─── WHAT IS NOT COVERED ────────────────────────────────────────────────────────────────────────
 *
 *   * REAL POSTGRES. Only the deploy-dev migration step proves the file applies to Cloud SQL.
 *     (PGlite is a newer Postgres than Cloud SQL's 15; `num_nonnulls` exists since 9.6.)
 *   * The code-level tenancy checks — those live beside the store, in store.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0060_studio_brand_profiles.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const PROFILES = "studio_brand_profiles";
const ANALYSES = "studio_reference_analyses";
const TABLES = [PROFILES, ANALYSES];

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

/** Dev and prod today: every other table present, these two absent. Child first — it holds the FK. */
async function pre0060(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`DROP TABLE ${ANALYSES};`);
  await pg.exec(`DROP TABLE ${PROFILES};`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0060();
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

// Synthetic ids and names throughout — no real person, brand row or path.
const ATHLETE = "11111111-1111-4111-8111-111111111111";
const OTHER_ATHLETE = "99999999-9999-4999-8999-999999999999";

async function seedAthlete(pg: PGlite, id = ATHLETE) {
  await pg.query(
    `INSERT INTO athletes (id, full_name) VALUES ($1, 'A') ON CONFLICT DO NOTHING`,
    [id],
  );
  return id;
}

async function seedBrand(pg: PGlite, name = "Synthetic Brand") {
  return (
    await pg.query<{ id: number }>(
      `INSERT INTO inbox_brands (name, normalized_name) VALUES ($1, lower($1)) RETURNING id`,
      [name],
    )
  ).rows[0].id;
}

async function seedAsset(pg: PGlite, athleteId: string, path = "x/ref.jpg") {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status, gcs_path)
       VALUES ($1, 'upload', 'upload', 'IMAGE', 'stored', $2) RETURNING id`,
      [athleteId, path],
    )
  ).rows[0].id;
}

async function seedProfile(
  pg: PGlite,
  athleteId: string,
  brandId: number | null = null,
  name = "Synthetic Brand",
) {
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO ${PROFILES} (athlete_id, brand_id, name) VALUES ($1, $2, $3) RETURNING id`,
      [athleteId, brandId, name],
    )
  ).rows[0].id;
}

interface SeedAnalysis {
  athleteId: string;
  profileId?: string | null;
  assetId?: string | null;
  text?: string | null;
}

/** An analysis as the engine will write one. The default source is a pasted brief. */
async function seedAnalysis(pg: PGlite, a: SeedAnalysis) {
  const text = a.text === undefined && !a.assetId ? "a pasted brief" : a.text;
  return (
    await pg.query<{ id: string }>(
      `INSERT INTO ${ANALYSES}
         (athlete_id, brand_profile_id, source_kind, source_asset_id, source_text, role,
          decomposition, prompt_version, model)
       VALUES ($1, $2, $3, $4, $5, 'style_reference', '{}'::jsonb, 'reference/1', 'synthetic-model')
       RETURNING id`,
      [
        a.athleteId,
        a.profileId ?? null,
        a.assetId ? "image" : "brief",
        a.assetId ?? null,
        text ?? null,
      ],
    )
  ).rows[0].id;
}

jest.setTimeout(180_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("0060: THE SHAPE — two new tables and nothing else", () => {
  it("writes no DROP, no bare ADD CONSTRAINT, no ALTER and no data movement", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    expect(sql.match(/DROP\s+(CONSTRAINT|INDEX|TABLE)/gi) ?? []).toEqual([]);
    expect(sql.match(/ALTER\s+TABLE/gi) ?? []).toEqual([]);
    expect(
      sql.match(/\b(UPDATE|DELETE\s+FROM|TRUNCATE|INSERT\s+INTO)\b/gi) ?? [],
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

  it("creates exactly the two tables, both new", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    const creates = (sql.match(/CREATE\s+TABLE[^(]*/gi) ?? []).map((c) =>
      c.replace(/\s+/g, " ").trim(),
    );
    expect(creates).toEqual([
      `CREATE TABLE IF NOT EXISTS ${PROFILES}`,
      `CREATE TABLE IF NOT EXISTS ${ANALYSES}`,
    ]);
  });
});

describe("0060: FRESH AND EXISTING DATABASES both converge", () => {
  it("applies to a database that has never seen either table (the deploy case)", async () => {
    const pg = await pre0060();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect((await indexesOf(pg, PROFILES)).map((i) => i.indexname)).toEqual([
      "idx_studio_brand_profiles_athlete",
      "studio_brand_profiles_id_athlete_unique",
      "studio_brand_profiles_pkey",
      "uq_studio_brand_profiles_brand",
    ]);
    expect((await indexesOf(pg, ANALYSES)).map((i) => i.indexname)).toEqual([
      "idx_studio_reference_analyses_athlete",
      "idx_studio_reference_analyses_profile",
      "studio_reference_analyses_pkey",
    ]);
    expect((await columnsOf(pg, ANALYSES)).map((c) => c.column_name)).toEqual([
      "athlete_id",
      "brand_profile_id",
      "cost_basis",
      "cost_estimated_usd",
      "created_at",
      "decomposition",
      "id",
      "model",
      "prompt_version",
      "role",
      "source_asset_id",
      "source_kind",
      "source_text",
    ]);
    await pg.close();
  });

  /** MUTATION: delete either `IF NOT EXISTS`. Run 2 then fails "already exists" on `toBeNull()`. */
  it("re-runs are a no-op and OID-stable — neither table is dropped and re-created", async () => {
    const pg = await migrated();
    const before = [];
    for (const t of TABLES) {
      before.push({
        oid: await tableOid(pg, t),
        cols: await columnsOf(pg, t),
        idx: await indexesOf(pg, t),
        cons: await constraintsOf(pg, t),
      });
    }

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    for (const [i, t] of TABLES.entries()) {
      expect(await tableOid(pg, t)).toBe(before[i].oid);
      expect(await columnsOf(pg, t)).toEqual(before[i].cols);
      expect(await indexesOf(pg, t)).toEqual(before[i].idx);
      expect(await constraintsOf(pg, t)).toEqual(before[i].cons);
    }
    await pg.close();
  });

  it("preserves the rows that were already there", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const profile = await seedProfile(pg, athlete);
    const analysis = await seedAnalysis(pg, {
      athleteId: athlete,
      profileId: profile,
    });

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${PROFILES}`)).rows,
    ).toEqual([{ id: profile }]);
    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${ANALYSES}`)).rows,
    ).toEqual([{ id: analysis }]);
    await pg.close();
  });
});

describe("0060: TENANCY — the database refuses a cross-athlete filing", () => {
  /**
   * THE REVERT CHECK for claim 1. MUTATION: replace `studio_reference_analyses_profile_fk` with a
   * plain `FOREIGN KEY (brand_profile_id) REFERENCES studio_brand_profiles(id)`. The insert below
   * then succeeds — athlete B's reference filed under athlete A's brand — and this reds on `rejects`.
   */
  it("refuses an analysis filed under ANOTHER athlete's profile", async () => {
    const pg = await migrated();
    const mine = await seedAthlete(pg);
    const other = await seedAthlete(pg, OTHER_ATHLETE);
    const herProfile = await seedProfile(pg, mine);

    await expect(
      seedAnalysis(pg, { athleteId: other, profileId: herProfile }),
    ).rejects.toThrow(/studio_reference_analyses_profile_fk|foreign key/i);
    expect(await countRows(pg, ANALYSES)).toBe(0);
    await pg.close();
  });

  it("accepts an analysis under her own profile, and one filed under no profile", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const profile = await seedProfile(pg, athlete);
    await expect(
      seedAnalysis(pg, { athleteId: athlete, profileId: profile }),
    ).resolves.toBeTruthy();
    await expect(
      seedAnalysis(pg, { athleteId: athlete, profileId: null }),
    ).resolves.toBeTruthy();
    expect(await countRows(pg, ANALYSES)).toBe(2);
    await pg.close();
  });

  it("refuses a profile id that does not exist", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await expect(
      seedAnalysis(pg, {
        athleteId: athlete,
        profileId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow();
    await pg.close();
  });

  it("cascades from the athlete — her profiles and analyses go when she does, and nobody else's do", async () => {
    const pg = await migrated();
    const mine = await seedAthlete(pg);
    const other = await seedAthlete(pg, OTHER_ATHLETE);
    const herProfile = await seedProfile(pg, mine);
    await seedAnalysis(pg, { athleteId: mine, profileId: herProfile });
    const keptProfile = await seedProfile(pg, other);
    const keptAnalysis = await seedAnalysis(pg, {
      athleteId: other,
      profileId: keptProfile,
    });

    await pg.query(`DELETE FROM athletes WHERE id = $1`, [mine]);

    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${PROFILES}`)).rows,
    ).toEqual([{ id: keptProfile }]);
    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${ANALYSES}`)).rows,
    ).toEqual([{ id: keptAnalysis }]);
    await pg.close();
  });
});

describe("0060: EXACTLY ONE SOURCE per analysis", () => {
  it("accepts an image alone, and a brief alone", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    await expect(
      seedAnalysis(pg, { athleteId: athlete, assetId: asset, text: null }),
    ).resolves.toBeTruthy();
    await expect(
      seedAnalysis(pg, { athleteId: athlete, text: "a pasted brief" }),
    ).resolves.toBeTruthy();
    await pg.close();
  });

  /** THE REVERT CHECK for claim 2. MUTATION: delete `studio_reference_analyses_one_source_check`. */
  it("refuses an analysis with zero sources", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await expect(
      seedAnalysis(pg, { athleteId: athlete, assetId: null, text: null }),
    ).rejects.toThrow(/studio_reference_analyses_one_source_check|check/i);
    await pg.close();
  });

  /** Claim 2, other half. Same mutation. */
  it("refuses an analysis with two sources", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    await expect(
      seedAnalysis(pg, {
        athleteId: athlete,
        assetId: asset,
        text: "and a brief",
      }),
    ).rejects.toThrow(/studio_reference_analyses_one_source_check|check/i);
    await pg.close();
  });

  /**
   * Pinned so that adding a CHECK is a decision somebody reads about first: source_kind and role
   * are both vocabularies certain to grow, and widening a CHECK is 0056's DROP + ADD pair.
   */
  it("has NO check on source_kind or role, on purpose", async () => {
    const pg = await migrated();
    // contype = 'c' — CHECKs only (PGlite also lists NOT NULLs as contype 'n').
    const checks = (
      await pg.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid IN ('${PROFILES}'::regclass, '${ANALYSES}'::regclass) AND contype = 'c'
          ORDER BY conname`,
      )
    ).rows.map((r) => r.conname);
    expect(checks).toEqual(["studio_reference_analyses_one_source_check"]);
    await pg.close();
  });
});

describe("0060: DELETION — what goes with what", () => {
  it("cascades a profile's analyses when the profile is deleted", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const profile = await seedProfile(pg, athlete);
    await seedAnalysis(pg, { athleteId: athlete, profileId: profile });
    const loose = await seedAnalysis(pg, {
      athleteId: athlete,
      profileId: null,
    });

    await pg.query(`DELETE FROM ${PROFILES} WHERE id = $1`, [profile]);

    expect(
      (await pg.query<{ id: string }>(`SELECT id FROM ${ANALYSES}`)).rows,
    ).toEqual([{ id: loose }]);
    await pg.close();
  });

  /** THE REVERT CHECK for claim 3. MUTATION: `ON DELETE CASCADE` on the brand FK. */
  it("nulls brand_id when the catalog brand is deleted, and keeps the profile", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const brand = await seedBrand(pg);
    const profile = await seedProfile(pg, athlete, brand, "Synthetic Brand");

    await pg.query(`DELETE FROM inbox_brands WHERE id = $1`, [brand]);

    expect(
      (
        await pg.query<Record<string, unknown>>(
          `SELECT id, brand_id, name FROM ${PROFILES}`,
        )
      ).rows,
    ).toEqual([{ id: profile, brand_id: null, name: "Synthetic Brand" }]);
    await pg.close();
  });

  it("cascades an analysis when its source image is deleted — her photo gone, its reading goes", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const asset = await seedAsset(pg, athlete);
    await seedAnalysis(pg, { athleteId: athlete, assetId: asset, text: null });

    await pg.query(`DELETE FROM media_assets WHERE id = $1`, [asset]);

    expect(await countRows(pg, ANALYSES)).toBe(0);
    await pg.close();
  });
});

describe("0060: ONE PROFILE PER CATALOG BRAND, per athlete", () => {
  /** THE REVERT CHECK for claim 4. MUTATION: delete `uq_studio_brand_profiles_brand`. */
  it("refuses a second profile for the same brand", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    const brand = await seedBrand(pg);
    await seedProfile(pg, athlete, brand);
    await expect(seedProfile(pg, athlete, brand)).rejects.toThrow(
      /uq_studio_brand_profiles_brand|unique/i,
    );
    await pg.close();
  });

  it("is per athlete, and does not bind brand-less profiles", async () => {
    const pg = await migrated();
    const mine = await seedAthlete(pg);
    const other = await seedAthlete(pg, OTHER_ATHLETE);
    const brand = await seedBrand(pg);
    await seedProfile(pg, mine, brand);
    await expect(seedProfile(pg, other, brand)).resolves.toBeTruthy();
    await seedProfile(pg, mine, null, "Loose A");
    await expect(seedProfile(pg, mine, null, "Loose B")).resolves.toBeTruthy();
    expect(await countRows(pg, PROFILES)).toBe(4);
    await pg.close();
  });

  it("defaults attributes to an empty array", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await seedProfile(pg, athlete);
    expect(
      (
        await pg.query<{ attributes: unknown }>(
          `SELECT attributes FROM ${PROFILES}`,
        )
      ).rows,
    ).toEqual([{ attributes: [] }]);
    await pg.close();
  });
});

describe("0060: ROLLBACK — additive only, and the revert leaves no orphan", () => {
  it("every write the pre-0060 code makes still works after 0060 applies", async () => {
    const pg = await migrated();
    const athlete = await seedAthlete(pg);
    await expect(seedAsset(pg, athlete)).resolves.toBeTruthy();
    await expect(seedBrand(pg)).resolves.toBeTruthy();
    await expect(
      pg.query(
        `INSERT INTO studio_stitch_jobs (athlete_id, spec) VALUES ($1, '{}'::jsonb)`,
        [athlete],
      ),
    ).resolves.toBeTruthy();
    await pg.close();
  });

  /**
   * THE REVERT CHECK for claim 5 — "up/down round-trips with no orphan". The manual revert of an
   * additive migration is dropping what it added, child first. After it, the public catalog must
   * be EXACTLY the pre-0060 catalog: same relations, same constraints, same types. MUTATION: add
   * `CREATE INDEX IF NOT EXISTS idx_x ON media_assets (created_at);` to the file — the index
   * survives the drop and this reds.
   */
  it("dropping both tables leaves zero orphan objects — the catalog is exactly pre-0060", async () => {
    const pg = await pre0060();
    const before = await catalogOf(pg);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    const athlete = await seedAthlete(pg);
    const profile = await seedProfile(pg, athlete, await seedBrand(pg));
    await seedAnalysis(pg, { athleteId: athlete, profileId: profile });
    const withTables = await catalogOf(pg);
    expect(withTables.relations.length).toBeGreaterThan(
      before.relations.length,
    );

    await pg.exec(`DROP TABLE ${ANALYSES};`);
    await pg.exec(`DROP TABLE ${PROFILES};`);

    expect(await catalogOf(pg)).toEqual(before);
    // And nothing it pointed at moved.
    expect(await countRows(pg, "athletes")).toBe(1);
    expect(await countRows(pg, "inbox_brands")).toBe(1);
    await pg.close();
  });
});

describe("0060: the file matches shared/schema.ts, and is on the list", () => {
  /**
   * The HARD drift gate compares table and column NAMES only, so this is the check that catches a
   * type, default, constraint or index the hand-written file and the schema declaration disagree
   * about — including the hand-named composite FK on both sides.
   */
  it("produces the same two tables as a schema.ts push — columns, indexes AND constraints", async () => {
    const fromFile = await migrated();
    const fromSchema = await pushed();
    for (const t of TABLES) {
      expect(await columnsOf(fromFile, t)).toEqual(
        await columnsOf(fromSchema, t),
      );
      expect(await indexesOf(fromFile, t)).toEqual(
        await indexesOf(fromSchema, t),
      );
      expect(await constraintsOf(fromFile, t)).toEqual(
        await constraintsOf(fromSchema, t),
      );
    }
    await fromFile.close();
    await fromSchema.close();
  });

  it("no constraint or index name is long enough for Postgres to truncate", async () => {
    const pg = await migrated();
    for (const t of TABLES) {
      const names = [
        ...(await constraintsOf(pg, t)).map((c) => c.conname),
        ...(await indexesOf(pg, t)).map((i) => i.indexname),
      ];
      for (const n of names) expect(n.length).toBeLessThan(63);
    }
    await pg.close();
  });

  it("is listed in db-migrate.sh step 3, once, after 0059", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(list.filter((f) => f === "0060_studio_brand_profiles")).toHaveLength(
      1,
    );
    expect(list.indexOf("0060_studio_brand_profiles")).toBe(
      list.indexOf("0059_studio_publish_jobs") + 1,
    );
  });
});
