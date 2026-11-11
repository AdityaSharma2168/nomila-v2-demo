/**
 * rightsAttestations.migration.test.ts — 0151 (the athlete's rights words): on a database without the table it leaves
 * exactly what a shared/schema.ts push creates, it re-runs as a no-op, it is additive only with no transaction control
 * and writes no rows; one live word per (athlete, asset) and per (athlete, deal), a revoked one makes room for a new one;
 * the scope check holds; deleting the asset or the athlete takes the words; it is on db-migrate.sh once, after 0150.
 * PGlite in memory only: no real database is touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0151_media_rights_attestations.sql"), "utf8");
const TABLES = "('media_rights_attestations')";

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<any>(sql, params)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
    where table_name in ${TABLES} order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in ${TABLES} order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in ${TABLES} order by 1, 2`),
});

describe("0151: the file is the schema", () => {
  it("on a database without it, leaves exactly what a schema.ts push creates; re-runs as a no-op", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec("DROP TABLE media_rights_attestations;");
    await got.exec(FILE);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    expect(await q(got, `select count(*)::int as n from media_rights_attestations`)).toEqual([{ n: 0 }]);
    await want.close(); await got.close();
  }, 120_000);

  it("one live word per asset and per deal; revoked makes room; the scope check; a deleted asset keeps the word", async () => {
    const pg = await pushed();
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const b = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Other') RETURNING id`))[0].id;
    const asset = (await q(pg, `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status) VALUES ($1, 'studio', 'upload', 'IMAGE', 'stored') RETURNING id`, [a]))[0].id;
    const own = (athlete: string, assetId: string | null, revoked = false) => q(pg,
      `INSERT INTO media_rights_attestations (athlete_id, scope, asset_id, asset_ref, asset_kind, words, words_version, revoked_at) VALUES ($1, 'own_posts', $2, $3, 'photo', 'w', 'rights/1', $4) RETURNING id`, [athlete, assetId, assetId ? `studio:${assetId}` : null, revoked ? new Date() : null]);
    const deal = (athlete: string, key: string | null) => q(pg,
      `INSERT INTO media_rights_attestations (athlete_id, scope, deal_key, brand, words, words_version) VALUES ($1, 'sponsored', $2, 'B', 'w', 'rights/1') RETURNING id`, [athlete, key]);
    const [first] = await own(a, asset);
    await expect(own(a, asset)).rejects.toThrow();                                  // one live word per asset
    await own(a, asset, true);                                                       // a revoked one alongside is fine
    await q(pg, `UPDATE media_rights_attestations SET revoked_at = now() WHERE id = $1`, [first.id]);
    await own(a, asset);                                                             // revoked → a new word
    await deal(a, "brand:b");
    await expect(deal(a, "brand:b")).rejects.toThrow();                              // one live word per deal
    await deal(b, "brand:b");                                                        // another athlete
    await expect(own(a, null)).rejects.toThrow();                                    // own_posts needs which asset (asset_ref)
    await expect(deal(a, null)).rejects.toThrow();                                   // sponsored needs a deal
    await expect(q(pg, `INSERT INTO media_rights_attestations (athlete_id, scope, asset_id, deal_key, words, words_version) VALUES ($1, 'own_posts', $2, 'brand:x', 'w', 'v')`, [a, asset])).rejects.toThrow();
    await expect(q(pg, `INSERT INTO media_rights_attestations (athlete_id, scope, words, words_version) VALUES ($1, 'other', 'w', 'v')`, [a])).rejects.toThrow();
    await expect(q(pg, `INSERT INTO media_rights_attestations (athlete_id, scope, deal_key, asset_ref, words, words_version) VALUES ($1, 'sponsored', 'brand:z', 'x:1', 'w', 'v')`, [a])).rejects.toThrow(); // sponsored names no asset
    // The photo is deleted: every word about it is KEPT, asset_id cleared, asset_ref still naming it (owner, 10 Nov 2026).
    await q(pg, `DELETE FROM media_assets WHERE id = $1`, [asset]);
    expect(await q(pg, `select scope, count(*)::int as n, count(asset_id)::int as linked, count(asset_ref)::int as named from media_rights_attestations where athlete_id = $1 group by 1 order by 1`, [a]))
      .toEqual([{ scope: "own_posts", n: 3, linked: 0, named: 3 }, { scope: "sponsored", n: 1, linked: 0, named: 0 }]);
    // A kept word with no asset never blocks (or counts for) a new one: live NULL-asset rows and a new asset's word coexist.
    await q(pg, `INSERT INTO media_rights_attestations (athlete_id, scope, asset_id, asset_ref, words, words_version) VALUES ($1, 'own_posts', NULL, 'studio:gone-2', 'w', 'v')`, [a]);
    const asset2 = (await q(pg, `INSERT INTO media_assets (athlete_id, platform, origin, media_type, status) VALUES ($1, 'studio', 'upload', 'IMAGE', 'stored') RETURNING id`, [a]))[0].id;
    await own(a, asset2);
    await expect(own(a, asset2)).rejects.toThrow();                                 // still one live word per (new) asset
    expect(await q(pg, `select count(*)::int as n from media_rights_attestations where athlete_id = $1 and asset_id = $2`, [a, asset2])).toEqual([{ n: 1 }]);
    await q(pg, `DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `select count(*)::int as n from media_rights_attestations`)).toEqual([{ n: 1 }]);
    await pg.close();
  }, 120_000);

  it("is additive only, writes no rows and carries no transaction control", () => {
    const body = FILE.replace(/--[^\n]*/g, "").replace(/ON DELETE (?:CASCADE|SET NULL)/g, "");
    expect(body).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|INSERT|BEGIN|COMMIT|ROLLBACK|ALTER|DO)\b/i);
  });

  it("is on db-migrate.sh exactly once, after 0150", () => {
    const sh = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8");
    expect(sh.match(/0151_media_rights_attestations/g)).toHaveLength(1);
    expect(sh.indexOf("0151_media_rights_attestations")).toBeGreaterThan(sh.indexOf("0150_platform_spend_indexes"));
  });
});
