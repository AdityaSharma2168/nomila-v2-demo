/**
 * publicCard.migration.test.ts — 0101 adds the public card's three tables (design-public-card-v3 §11): applied to a
 * 0100 database it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op with rows present, the
 * guards hold (handle shape, one row per version, publish state ⇔ published version, snapshot kinds), and it is on
 * db-migrate.sh's list exactly once, after 0100. PGlite only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0101_public_card.sql"), "utf8");
const TABLES = ["public_cards", "public_card_snapshots", "public_card_handle_redirects"];
const list = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_name in (${list}) order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});
const rewind = (pg: PGlite) => pg.exec(`DROP TABLE public_card_handle_redirects; DROP TABLE public_card_snapshots; DROP TABLE public_cards;`);

describe("0101: the file is the schema", () => {
  it("on a 0100 database, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await rewind(got);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present, and the guards hold", async () => {
    const pg = await pushed();
    await rewind(pg);
    await pg.exec(FILE);
    const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Migration Rower') RETURNING id`);
    await q(pg, `INSERT INTO public_cards (athlete_id, handle) VALUES ($1, 'migration-rower')`, [a.id]);
    await q(pg, `INSERT INTO public_card_snapshots (athlete_id, version, content, sources, content_sha256) VALUES ($1, 1, '{}', '{}', 'h')`, [a.id]);
    await q(pg, `UPDATE public_cards SET status = 'published', published_version = 1, last_version = 1 WHERE athlete_id = $1`, [a.id]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT handle, status, published_version, show_mia, indexable, door_partner, door_book, door_shop, door_create, door_ask_mila FROM public_cards`))
      .toEqual([{ handle: "migration-rower", status: "published", published_version: 1, show_mia: false, indexable: false,
        door_partner: true, door_book: false, door_shop: false, door_create: true, door_ask_mila: true }]);

    const bad = async (sql: string, params: unknown[] = []) => { await expect(pg.query(sql, params)).rejects.toThrow(); };
    // one row per version per athlete; versions are positive; kinds are the three
    await bad(`INSERT INTO public_card_snapshots (athlete_id, version, content, sources, content_sha256) VALUES ($1, 1, '{}', '{}', 'h')`, [a.id]);
    await bad(`INSERT INTO public_card_snapshots (athlete_id, version, content, sources, content_sha256) VALUES ($1, 0, '{}', '{}', 'h')`, [a.id]);
    await bad(`INSERT INTO public_card_snapshots (athlete_id, version, kind, content, sources, content_sha256) VALUES ($1, 2, 'draft', '{}', '{}', 'h')`, [a.id]);
    // published ⇔ a published version
    await bad(`UPDATE public_cards SET published_version = NULL WHERE athlete_id = $1`, [a.id]);
    await bad(`UPDATE public_cards SET status = 'unpublished' WHERE athlete_id = $1`, [a.id]);
    // the handle shape: lower-case, 3–30, single inner hyphens
    for (const h of ["ab", "Upper", "-lead", "trail-", "two--hyphens", "has space", "a".repeat(31)]) {
      await bad(`UPDATE public_cards SET handle = $2 WHERE athlete_id = $1`, [a.id, h]);
    }
    // a handle belongs to one athlete
    const [b] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Migration Fencer') RETURNING id`);
    await bad(`INSERT INTO public_cards (athlete_id, handle) VALUES ($1, 'migration-rower')`, [b.id]);
    // deleting the athlete takes her card, versions and redirects with it
    await q(pg, `INSERT INTO public_card_handle_redirects (handle, athlete_id, expires_at) VALUES ('old-rower', $1, now() + interval '90 days')`, [a.id]);
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a.id]);
    expect(await q(pg, `SELECT (SELECT count(*) FROM public_cards)::int c, (SELECT count(*) FROM public_card_snapshots)::int s, (SELECT count(*) FROM public_card_handle_redirects)::int r`))
      .toEqual([{ c: 0, s: 0, r: 0 }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0100", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0101_public_card \\")).toHaveLength(1);
    expect(lines.indexOf("0101_public_card \\")).toBeGreaterThan(lines.indexOf("0100_shop_shopify_catalog \\"));
    expect(lines.indexOf("0100_shop_shopify_catalog \\")).toBeGreaterThan(-1);
  });
});
