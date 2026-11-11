/**
 * referenceOrigin.migration.test.ts — the revert check for migrations/0062_media_assets_origin_reference.sql
 * (Studio PR 7, Lane C): the origin CHECK gains 'reference', the way db-migrate.sh will apply it.
 *
 * Same harness as plans.migration.test.ts: schema.ts pushed into a throwaway PGlite, the constraint
 * NARROWED back to what dev and prod hold today, then the file applied statement by statement, each
 * in its own transaction, as `psql -f` without --single-transaction does. What it holds:
 *
 *   - today refuses origin 'reference'; after 0062 it is accepted, and an off-list value still is not;
 *   - a second run is a no-op — the guard, not luck — and the constraint's text does not change;
 *   - the vocabulary the file writes is the vocabulary schema.ts declares (the drift gate is name-only
 *     and would not see a CHECK that disagreed);
 *   - db-migrate.sh names the file in its step-3 list, or nothing here ever runs on a deploy.
 *
 * ⚠️ MUTATION: drop 'reference' from the file's CHECK — "accepted after" and "same vocabulary" red;
 * drop the guard — "a second run is a no-op" reds on the DROP + ADD pair's second pass only if the
 * pair itself fails, so the guard is ALSO held by the constraint's text staying byte-identical.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = "0062_media_assets_origin_reference";
const MIGRATION = readFileSync(join(ROOT, "migrations", `${FILE}.sql`), "utf8");
const DB_MIGRATE = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");

const HER = "33333333-1111-4444-8555-999999999999";

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
  await pg.exec(
    `INSERT INTO athletes (id, full_name) VALUES ('${HER}', 'Reference Athlete');`,
  );
  return pg;
}

/** Dev and prod today: the list without 'reference'. */
async function pre0062(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`ALTER TABLE media_assets DROP CONSTRAINT media_assets_origin_check;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check
      CHECK (origin IN ('connected','discovery','upload','generated'));`);
  return pg;
}

async function migrated(): Promise<PGlite> {
  const pg = await pre0062();
  const err = await applyLikePsql(pg, MIGRATION);
  if (err) throw err;
  return pg;
}

async function constraintText(pg: PGlite): Promise<string> {
  const r = await pg.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'media_assets'::regclass AND conname = 'media_assets_origin_check'`,
  );
  return r.rows[0]?.def ?? "";
}

/** One row with the given origin — the columns a fetched reference writes. */
async function insertWithOrigin(
  pg: PGlite,
  origin: string,
): Promise<Error | null> {
  try {
    await pg.exec(
      `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status, gcs_path, content_type, ingested_at, metadata)
       VALUES ('${HER}', 'web', '${origin}', 'IMAGE', 'stored', 'athletes/${HER}/references/x.jpg', 'image/jpeg', now(), '{}'::jsonb);`,
    );
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe("0062 — media_assets_origin_check gains 'reference'", () => {
  it("today refuses origin 'reference'; after the file it is accepted, and an off-list value still is not", async () => {
    const before = await pre0062();
    expect(await insertWithOrigin(before, "reference")).not.toBeNull();
    await before.close();

    const after = await migrated();
    expect(await insertWithOrigin(after, "reference")).toBeNull();
    expect(await insertWithOrigin(after, "upload")).toBeNull();
    expect(await insertWithOrigin(after, "bogus")).not.toBeNull();
    await after.close();
  });

  it("a second run is a no-op — the guard — and the constraint's text does not change", async () => {
    const pg = await migrated();
    const once = await constraintText(pg);
    expect(once).toContain("'reference'");
    expect(await applyLikePsql(pg, MIGRATION)).toBeNull();
    expect(await constraintText(pg)).toBe(once);
    await pg.close();
  });

  it("writes the vocabulary schema.ts declares — the drift gate is name-only and would not notice", async () => {
    const fromSchema = await pushed();
    const fromFile = await migrated();
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(await constraintText(fromFile))).toBe(
      norm(await constraintText(fromSchema)),
    );
    await fromSchema.close();
    await fromFile.close();
  });

  it("db-migrate.sh names the file in its step-3 list, after 0061", () => {
    const lines = DB_MIGRATE.split("\n").map((l) => l.trim());
    const i61 = lines.indexOf("0061_studio_plans \\");
    const i62 = lines.indexOf(`${FILE} \\`);
    expect(i61).toBeGreaterThan(-1);
    expect(i62).toBe(i61 + 1);
  });

  /**
   * THE LEGACY RE-ADD (deploy of 23 Sep 2026, failed): scripts/db-migrate.sh step 1 re-runs
   * migrations/legacy/08_studio_generation.sql on EVERY deploy, before the numbered files, and that file
   * DROPs and re-ADDs media_assets_origin_check — with the OLD four-value list, until this. The first
   * deploy after a 'reference' row existed died there ("check constraint … is violated by some row")
   * before 0062 ever ran. So the legacy line is pinned to the schema's vocabulary, and replayed here on
   * a database that already holds a 'reference' row. ⚠️ MUTATION: narrow the legacy list again — both
   * assertions red by name.
   */
  it("the legacy re-add lists the same vocabulary as schema.ts and 0062, and replays cleanly on a table that already holds a 'reference' row", async () => {
    const legacy = readFileSync(
      join(ROOT, "migrations", "legacy", "08_studio_generation.sql"),
      "utf8",
    );
    const legacyList =
      /ADD CONSTRAINT media_assets_origin_check CHECK \(origin IN \(([^)]*)\)\)/.exec(
        legacy,
      )?.[1];
    expect(legacyList).toBeDefined();
    const values = (list: string) =>
      [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    const pg = await migrated();
    // pg_get_constraintdef renders the list as ARRAY['a'::text, …], so the values are read, not the shape.
    expect(values(legacyList!)).toEqual(values(await constraintText(pg)));
    expect(values(legacyList!)).toContain("reference");
    // The deploy order, replayed: a 'reference' row exists, then step 1's DROP + ADD runs again.
    expect(await insertWithOrigin(pg, "reference")).toBeNull();
    const statements = legacy
      .split("\n")
      .filter(
        (l) => /media_assets_origin_check/.test(l) && !l.startsWith("--"),
      );
    expect(statements).toHaveLength(2);
    for (const st of statements) await pg.exec(st);
    expect(await constraintText(pg)).toContain("'reference'");
    await pg.close();
  });

  it("contains no bare DROP or ADD CONSTRAINT outside the guarded block", () => {
    const body = MIGRATION.replace(/--[^\n]*/g, "");
    const blocks = body.match(/DO \$\$[\s\S]*?\$\$;/g) ?? [];
    expect(blocks).toHaveLength(1);
    const outside = body.replace(/DO \$\$[\s\S]*?\$\$;/g, "");
    expect(outside).not.toMatch(/DROP CONSTRAINT|ADD CONSTRAINT/);
  });
});
