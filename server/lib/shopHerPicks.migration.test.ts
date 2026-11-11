/**
 * shopHerPicks.migration.test.ts — 0096 adds the three shop_* tables (docs/design/shop-her-picks.md): applied to a
 * database without them it leaves exactly what a shared/schema.ts push creates (columns, constraints, indexes), it
 * re-runs as a no-op, it carries no transaction control, and it is on db-migrate.sh's list once, after 0090.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0096_shop_her_picks.sql"), "utf8");
const TABLES = ["shop_click_days", "shop_items", "shop_settings"];
// Every later file that alters these tables rides on top, in deploy order (as plans.migration.test.ts does for 0061), so
// the parity check compares 0096-and-what-followed with head. 0100 adds shop_items.catalog_product_id (+ its FK to
// shop_catalog_products); its own parity is shopShopifyCatalog.migration.test.ts.
const LATER = ["0100_shop_shopify_catalog.sql"].map((f) => readFileSync(join(ROOT, "migrations", f), "utf8"));

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name in (${TABLES.map((t) => `'${t}'`).join(",")}) order by table_name, column_name`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid::regclass::text in (${TABLES.map((t) => `'${t}'`).join(",")}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${TABLES.map((t) => `'${t}'`).join(",")}) order by 1, 2`),
});

describe("0096: the file is the schema", () => {
  it("on a database without the shop tables, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    // The pre-0096 shape: no shop tables, and none of 0100's either (0100 runs next and creates them).
    await got.exec(`DROP TABLE shop_click_days; DROP TABLE shop_items; DROP TABLE shop_settings;`);
    await got.exec(`DROP TABLE shop_brand_approvals; DROP TABLE shop_catalog_products; DROP TABLE shopify_shops;`);
    await got.exec(FILE);
    for (const later of LATER) await got.exec(later);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op and keeps the rows; no transaction control; the status lifecycle is checked", async () => {
    const pg = await pushed();
    await pg.exec(FILE);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO shop_items (athlete_id, code, url, url_host, source, title) VALUES ($1, 'c0de', 'https://x.test/p', 'x.test', 'link', 'Kept')`, [a]);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT title, status, position FROM shop_items`)).toEqual([{ title: "Kept", status: "draft", position: 0 }]);
    await expect(pg.query(`UPDATE shop_items SET status = 'published'`)).rejects.toThrow(/shop_items_status_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 60_000);

  it("deleting a pick takes its click days with it; deleting the athlete takes everything", async () => {
    const pg = await pushed();
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    const i = (await pg.query<{ id: string }>(`INSERT INTO shop_items (athlete_id, code, url, url_host, source, title) VALUES ($1, 'c1', 'https://x.test/a', 'x.test', 'link', 'A') RETURNING id`, [a])).rows[0].id;
    await pg.query(`INSERT INTO shop_click_days (item_id, day, clicks) VALUES ($1, '2026-10-07', 3)`, [i]);
    await pg.query(`INSERT INTO shop_settings (athlete_id) VALUES ($1)`, [a]);
    await pg.query(`DELETE FROM shop_items WHERE id = $1`, [i]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM shop_click_days`)).toEqual([{ n: 0 }]);
    await pg.query(`DELETE FROM athletes WHERE id = $1`, [a]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM shop_settings`)).toEqual([{ n: 0 }]);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0090", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0096_shop_her_picks \\")).toHaveLength(1);
    expect(list.indexOf("0096_shop_her_picks \\")).toBeGreaterThan(list.indexOf("0090_drop_onboarding_sessions_brand_api_keys \\"));
  });
});
