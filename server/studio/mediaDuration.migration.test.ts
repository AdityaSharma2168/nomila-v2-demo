/**
 * mediaDuration.migration.test.ts — the revert check for
 * migrations/0058_media_assets_duration_precise.sql.
 *
 * ─── WHAT 0058 CLAIMS, AND WHAT THESE TESTS MAKE FAIL-ABLE ──────────────────────────────────────
 *
 * 0058 adds ONE nullable column to media_assets so a video's real, fractional length has somewhere
 * to live. The claim that matters is not "the column exists" — it is that the column was added
 * ADDITIVELY rather than by widening duration_seconds in place, and that the difference is real:
 *
 *   * a fraction survives the round trip (12.5 comes back as 12.5), which is the entire point and
 *     is the thing the INTEGER column cannot do;
 *   * duration_seconds is UNCHANGED — still an integer, still rounding, still meaning what it meant
 *     to the picker and to the library grid's fmtDur;
 *   * the table is never REWRITTEN, which is what an `ALTER COLUMN ... TYPE` would do to the
 *     hottest table in the app, under ACCESS EXCLUSIVE, inside a deploy;
 *   * re-runs are no-ops, because db-migrate.sh applies every file on every deploy.
 *
 * A claim about a file's SHAPE has to be checked against the file's shape, so the first describe
 * reads the SQL and asserts the absences directly. The rest check the behaviour that shape buys.
 *
 * ─── WHY THE FILE IS EXECUTED STATEMENT-AT-A-TIME ───────────────────────────────────────────────
 *
 * The same fidelity videoJobs.migration.test.ts and stitchJobs.migration.test.ts rest on.
 * `pg.exec(WHOLE_FILE)` sends a multi-statement simple Query, which Postgres wraps in ONE implicit
 * transaction — under which a broken file can roll back cleanly and prove nothing. db-migrate.sh
 * runs `psql -f` with NO --single-transaction, so each statement autocommits alone. `applyLikePsql`
 * reproduces that.
 *
 * `splitStatements` is duplicated from stitchJobs.migration.test.ts rather than imported: importing
 * that module would register ITS describes inside this suite and run 0057's tests a second time.
 *
 * ─── WHAT IS NOT COVERED ────────────────────────────────────────────────────────────────────────
 *
 *   * REAL POSTGRES. PGlite is Postgres, but only the deploy-dev migration step proves the file
 *     applies to Cloud SQL. That is watched on CI.
 *   * THE CONCURRENT INTERLEAVE. PGlite is one in-process connection whose query()/transaction()
 *     share a mutex, so two runners cannot be made to interleave here. Argued, not measured: this
 *     file is a SINGLE self-guarded statement, so there is no gap between two statements for a
 *     second runner to land in — which is the property 0056 lacked and paid for twice. Both deploy
 *     workflows also declare `concurrency: cancel-in-progress: false`.
 *   * WHO WRITES THE COLUMN. The upload probe and the two riders are behaviour, not schema, and are
 *     tested next to the code that does the writing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(
  join(ROOT, "migrations", "0058_media_assets_duration_precise.sql"),
  "utf8",
);
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const TABLE = "media_assets";
const NEW_COLUMN = "duration_seconds_precise";
const OLD_COLUMN = "duration_seconds";

/**
 * Split SQL the way psql does: on top-level semicolons, respecting $$…$$ dollar quoting so a DO
 * block would arrive as one statement, and skipping `--` comments so a semicolon in prose is not a
 * split. (0058 contains no DO block — deliberately, see its header — but the splitter still has to
 * be dollar-quote aware to be a faithful stand-in for psql.)
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
 * A database in its PRE-0058 state: schema.ts pushed, then the new column rewound away. That is
 * exactly what dev and prod look like today — media_assets with every other column present and
 * this one absent.
 *
 * The DROP COLUMN here is on a THROWAWAY IN-MEMORY PGlite instance and reaches no database that
 * anything else can see. It is the same device stitchJobs.migration.test.ts uses to rewind 0057.
 */
async function pre0058(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${NEW_COLUMN};`);
  return pg;
}

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

/**
 * The column's IDENTITY in the catalog, not merely its presence.
 *
 * `attnum` moving would mean the column was dropped and re-added rather than left alone — a
 * re-run that silently destroyed the values in it. `atttypid` pins the type, which is what the
 * db-migrate.sh drift gate cannot see: checkSchemaDrift.ts compares NAMES only, so a column of the
 * wrong type passes it clean and then rounds every fraction written to it.
 */
const columnIdentity = async (pg: PGlite, column: string) =>
  (
    await pg.query<{ attnum: number; typname: string; attnotnull: boolean }>(
      `SELECT a.attnum, t.typname, a.attnotnull
         FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = '${TABLE}'::regclass AND a.attname = $1 AND a.attisdropped = false`,
      [column],
    )
  ).rows[0];

/**
 * relfilenode is the table's ON-DISK file. It is UNCHANGED by adding a nullable column with no
 * default (a catalog-only change in PG 11+) and is CHANGED by `ALTER COLUMN ... TYPE`, which
 * rewrites every row under ACCESS EXCLUSIVE. Asserting it is stable across a migration applied to
 * a table that HAS ROWS is the direct, mechanical proof that 0058 does not rewrite media_assets —
 * and it is what reds the day someone rewrites this file as an in-place widen.
 */
const relfilenodeOf = async (pg: PGlite) =>
  (
    await pg.query<{ relfilenode: number }>(
      `SELECT relfilenode::int AS relfilenode FROM pg_class WHERE oid = '${TABLE}'::regclass`,
    )
  ).rows[0].relfilenode;

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

/** A media_assets row written the way the PRE-0058 code writes one: it never names the new column. */
async function seedPre0058Video(
  pg: PGlite,
  athleteId: string,
  durationSeconds: number | null = null,
): Promise<string> {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO ${TABLE} (athlete_id, platform, origin, media_type, status, gcs_path, content_type, ${OLD_COLUMN})
     VALUES ($1, 'upload', 'upload', 'VIDEO', 'stored', 'athletes/a/uploads/x.mp4', 'video/mp4', $2)
     RETURNING id`,
    [athleteId, durationSeconds],
  );
  return res.rows[0].id;
}

jest.setTimeout(180_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("0058: THE SHAPE — additive, so there is no rewrite and no DROP+ADD pair", () => {
  /**
   * THE STRUCTURAL REVERT CHECK. The day someone "simplifies" this file into
   * `ALTER TABLE media_assets ALTER COLUMN duration_seconds TYPE double precision`, this reds and
   * points them at the header: a name-only drift gate cannot see a wrong type, and int4 -> float8
   * rewrites the whole table under ACCESS EXCLUSIVE during a deploy.
   */
  it("writes no ALTER ... TYPE, no DROP and no data movement", () => {
    const sql = MIGRATION.replace(/--[^\n]*/g, "");
    expect(sql.match(/ALTER\s+COLUMN[\s\S]{0,40}?TYPE/gi) ?? []).toEqual([]);
    expect(
      sql.match(/\bDROP\s+(COLUMN|TABLE|CONSTRAINT|INDEX)\b/gi) ?? [],
    ).toEqual([]);
    expect(sql.match(/\bUSING\b/gi) ?? []).toEqual([]);
    // The "ADDITIVE" claim in the header has to be true: nothing here moves a row.
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

  /**
   * ONE statement, self-guarded. That is what makes 0056's interleave impossible here: the race
   * needs a gap BETWEEN two statements, and there is no second statement.
   */
  it("is a single self-guarded ADD COLUMN, and adds exactly one column", () => {
    expect(splitStatements(MIGRATION)).toHaveLength(1);
    const adds =
      MIGRATION.replace(/--[^\n]*/g, "").match(/ADD\s+COLUMN[^;]*/gi) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(
      /IF\s+NOT\s+EXISTS\s+duration_seconds_precise\s+double\s+precision/i,
    );
  });
});

describe("0058: THE POINT — the new column holds a fraction the old one cannot", () => {
  /**
   * ⚠️  THE REVERT CHECK FOR THE WHOLE MIGRATION.
   *
   * 12.5 seconds is what ffprobe actually returns, and it is the value publishStitchOutput has been
   * throwing away since V7 (`Math.round`, "a float here is a write error"). Both columns are
   * written from the SAME number in one insert, so the assertion is not "float8 stores floats" —
   * it is that these are two different columns with two different answers, which is the only reason
   * to add one rather than widen the other.
   *
   * ⚠️  12.5 LANDS AS 12, NOT 13, AND THAT IS NOT A TYPO. Postgres's float8 -> int4 assignment cast
   * rounds HALF TO EVEN, so 12.5 -> 12 and 13.5 -> 14. JavaScript's Math.round rounds HALF UP, so
   * it makes 13 of the same number. The two writers of this column therefore disagree at exactly a
   * .5 tie: publishStitchOutput rounds in JS and stores 13, while recordGeneratedAsset (studio/
   * jobs.ts) hands the raw float to the driver and stores 12. Nobody chose that; it is what a
   * too-narrow column buys, and it is a second reason the measured value needs its own home.
   *
   * MUTATION: delete the ADD COLUMN line from the .sql (or the declaration from schema.ts). The
   * insert then fails on `column "duration_seconds_precise" of relation "media_assets" does not
   * exist` and this reds before it reaches the assertion.
   */
  it("stores 12.5 as 12.5, where the integer column keeps only 12", async () => {
    const pg = await pre0058();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    const athlete = await seedAthlete(pg);

    // ONE parameter, cast once, written to both columns — the shape the code actually has, where a
    // single JS number reaches both. int4's assignment cast is what rounds it; nothing in the app
    // asked for that.
    await pg.query(
      `INSERT INTO ${TABLE} (athlete_id, platform, origin, media_type, status, ${OLD_COLUMN}, ${NEW_COLUMN})
       VALUES ($1, 'studio', 'generated', 'VIDEO', 'stored', $2::double precision, $2::double precision)`,
      [athlete, 12.5],
    );

    const [row] = (
      await pg.query<{ rounded: number; precise: number }>(
        `SELECT ${OLD_COLUMN} AS rounded, ${NEW_COLUMN} AS precise FROM ${TABLE}`,
      )
    ).rows;
    expect(row.precise).toBe(12.5);
    expect(row.rounded).toBe(12); // half-to-even, see above — Math.round would have said 13
    await pg.close();
  });

  /**
   * The sub-second case, because it is the one the integer column gets WRONG rather than merely
   * coarse: a 0.4s clip rounds to 0, and 0 is indistinguishable from "no video" to every caller
   * that treats a falsy duration as missing.
   */
  it("keeps a sub-second duration that the integer column rounds to zero", async () => {
    const pg = await pre0058();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);

    await pg.query(
      `INSERT INTO ${TABLE} (athlete_id, platform, origin, media_type, status, ${OLD_COLUMN}, ${NEW_COLUMN})
       VALUES ($1, 'upload', 'upload', 'VIDEO', 'stored', $2::double precision, $2::double precision)`,
      [athlete, 0.4],
    );

    const [row] = (
      await pg.query<{ rounded: number; precise: number }>(
        `SELECT ${OLD_COLUMN} AS rounded, ${NEW_COLUMN} AS precise FROM ${TABLE}`,
      )
    ).rows;
    expect(row.rounded).toBe(0);
    expect(row.precise).toBeCloseTo(0.4, 6);
    await pg.close();
  });

  /**
   * duration_seconds MUST NOT MOVE. Its readers — the upload picker's round trip, fmtDur in the
   * library grid, the client contract — were not asked to change, and the whole argument for a
   * second column is that they don't have to.
   */
  it("leaves duration_seconds an integer, untouched", async () => {
    const pg = await pre0058();
    const before = await columnIdentity(pg, OLD_COLUMN);
    expect(before.typname).toBe("int4");

    await applyLikePsql(pg, MIGRATION);

    expect(await columnIdentity(pg, OLD_COLUMN)).toEqual(before);
    expect((await columnIdentity(pg, NEW_COLUMN)).typname).toBe("float8");
    await pg.close();
  });
});

describe("0058: FRESH AND EXISTING DATABASES both converge", () => {
  it("applies to a database that has never seen the column (the deploy case)", async () => {
    const pg = await pre0058();
    expect((await columnsOf(pg)).map((c) => c.column_name)).not.toContain(
      NEW_COLUMN,
    );

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const col = (await columnsOf(pg)).find((c) => c.column_name === NEW_COLUMN);
    expect(col).toEqual({
      column_name: NEW_COLUMN,
      data_type: "double precision",
      is_nullable: "YES",
      column_default: null,
    });
    await pg.close();
  });

  /**
   * THE REVERT CHECK for re-runnability. db-migrate.sh re-runs every file on every deploy, so runs
   * 2 and 3 must change nothing — and "nothing" has to mean the column was never dropped and
   * re-added (attnum stable, so the values in it survived) and the TABLE WAS NEVER REWRITTEN
   * (relfilenode stable). The table has rows while this happens, which is the only way the
   * rewrite question is meaningful.
   *
   * MUTATION: delete `IF NOT EXISTS`. Run 2 then fails with "column already exists", so this reds
   * on the `toBeNull()` before it reaches either catalog check.
   */
  it("re-runs are a no-op — attnum stable, and media_assets is never rewritten", async () => {
    const pg = await pre0058();
    const athlete = await seedAthlete(pg);
    await seedPre0058Video(pg, athlete, 9);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const identity = await columnIdentity(pg, NEW_COLUMN);
    // Pinned so the comparison below cannot be satisfied by `undefined === undefined`: with the
    // ADD COLUMN removed there is no column to be stable ABOUT, and this test must red with the
    // rest rather than report a no-op it never observed.
    expect(identity).toMatchObject({ typname: "float8", attnotnull: false });

    const cols = await columnsOf(pg);
    const relfilenode = await relfilenodeOf(pg);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    expect(await columnIdentity(pg, NEW_COLUMN)).toEqual(identity);
    expect(await columnsOf(pg)).toEqual(cols);
    expect(await relfilenodeOf(pg)).toBe(relfilenode);
    await pg.close();
  });

  /**
   * Existing rows keep their existing duration and gain a NULL, not a zero. The distinction is the
   * column's whole contract: NULL is "not measured", and 208 Instagram rows will stay NULL forever
   * because they hold a poster JPEG and there are no video bytes on our side to probe.
   */
  it("preserves the rows that were already there, and gives them NULL rather than 0", async () => {
    const pg = await pre0058();
    const athlete = await seedAthlete(pg);
    const id = await seedPre0058Video(pg, athlete, 9);

    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();

    const rows = (
      await pg.query<{
        id: string;
        duration_seconds: number | null;
        duration_seconds_precise: number | null;
      }>(`SELECT id, ${OLD_COLUMN}, ${NEW_COLUMN} FROM ${TABLE}`)
    ).rows;
    expect(rows).toEqual([
      { id, duration_seconds: 9, duration_seconds_precise: null },
    ]);
    await pg.close();
  });
});

describe("0058: ROLLBACK — the previous image keeps running against the new schema", () => {
  /**
   * The pre-0058 image never names this column, so rolling BACK to it is a no-op: it writes
   * media_assets exactly as it did and the new column simply sits there NULL. This is the whole
   * rollback story, and it is worth asserting rather than asserting in prose.
   */
  it("every media_assets write the pre-0058 code makes still works after 0058 applies", async () => {
    const pg = await pre0058();
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    const athlete = await seedAthlete(pg);

    for (const d of [null, 0, 8]) {
      await expect(seedPre0058Video(pg, athlete, d)).resolves.toBeTruthy();
    }
    expect(
      (
        await pg.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${TABLE} WHERE ${NEW_COLUMN} IS NULL`,
        )
      ).rows[0].n,
    ).toBe(3);
    await pg.close();
  });

  it("dropping the column back out leaves everything else standing — the manual revert path", async () => {
    const pg = await pre0058();
    await applyLikePsql(pg, MIGRATION);
    const athlete = await seedAthlete(pg);
    await seedPre0058Video(pg, athlete, 9);

    await pg.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${NEW_COLUMN};`);

    // Nothing else references the column — no index, no constraint, no view — so nothing moves.
    await expect(seedPre0058Video(pg, athlete, 4)).resolves.toBeTruthy();
    expect(
      (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`))
        .rows[0].n,
    ).toBe(2);
    expect((await columnsOf(pg)).map((c) => c.column_name)).not.toContain(
      NEW_COLUMN,
    );
    await pg.close();
  });
});

describe("0058: the file matches shared/schema.ts, and is on the list", () => {
  /**
   * The HARD drift gate (db-migrate.sh step 5) compares NAMES ONLY — it reads
   * information_schema.columns and never looks at a type. So this is the check that catches what it
   * cannot: the hand-written file and the schema declaration disagreeing about what
   * duration_seconds_precise IS. A `real` in one and a `double precision` in the other passes the
   * deploy gate and diverges silently.
   */
  it("produces the same media_assets as a schema.ts push — every column, with its type", async () => {
    const fromFile = await pre0058();
    await applyLikePsql(fromFile, MIGRATION);
    const fromSchema = await pushed();

    expect(await columnsOf(fromFile)).toEqual(await columnsOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });

  /**
   * MUTATION: remove the list line from db-migrate.sh. The file then exists, the schema declares
   * the column, every other test here still passes — and no deploy ever applies it, which is the
   * half-merged state the drift gate is there to catch at the cost of a red deploy. This catches it
   * at the cost of a red test instead.
   */
  it("is listed in db-migrate.sh step 3, once, after 0057", () => {
    const list = (DB_MIGRATE.match(/for f in \\\n([\s\S]*?)\n; do/)?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/\\$/, "").trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(20);
    expect(
      list.filter((f) => f === "0058_media_assets_duration_precise"),
    ).toHaveLength(1);
    expect(list.indexOf("0058_media_assets_duration_precise")).toBe(
      list.indexOf("0057_studio_stitch_jobs") + 1,
    );
  });
});
