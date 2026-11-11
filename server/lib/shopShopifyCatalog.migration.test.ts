/**
 * shopShopifyCatalog.migration.test.ts — 0100 adds the catalog-only Shopify app's tables (docs/design/shop-her-picks.md
 * §12): applied to a 0096 database it leaves exactly what a shared/schema.ts push creates, it re-runs as a no-op, the
 * token column refuses anything that is not a kms1: envelope, and it is on db-migrate.sh's list once, after 0096.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../shared/schema";

const ROOT = join(__dirname, "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0100_shop_shopify_catalog.sql"), "utf8");
const TABLES = ["shopify_shops", "shop_catalog_products", "shop_brand_approvals", "shop_items"];
const list = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const shape = async (pg: PGlite) => ({
  columns: await q(pg, `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_name in (${list}) order by 1, 2`),
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});

describe("0100: the file is the schema", () => {
  it("on a 0096 database, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`ALTER TABLE shop_items DROP COLUMN catalog_product_id; DROP TABLE shop_brand_approvals; DROP TABLE shop_catalog_products; DROP TABLE shopify_shops;`);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; a plaintext token is refused; a deleted catalog row leaves her pick with its link", async () => {
    const pg = await pushed();
    await pg.exec(FILE); await pg.exec(FILE);
    await expect(pg.query(`INSERT INTO shopify_shops (shop_domain, access_token) VALUES ('a.myshopify.com', 'shpat_plain')`)).rejects.toThrow(/shopify_shops_token_sealed_check/);
    const shop = (await pg.query<{ id: string }>(`INSERT INTO shopify_shops (shop_domain, access_token) VALUES ('b.myshopify.com', 'kms1:x') RETURNING id`)).rows[0].id;
    const prod = (await pg.query<{ id: string }>(`INSERT INTO shop_catalog_products (shop_id, shopify_product_id, handle, title, product_url) VALUES ($1, '1', 'h', 'T', 'https://b.example/products/h') RETURNING id`, [shop])).rows[0].id;
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    await pg.query(`INSERT INTO shop_items (athlete_id, code, url, url_host, source, title, catalog_product_id) VALUES ($1, 'c', 'https://b.example/products/h', 'b.example', 'shopify', 'T', $2)`, [a, prod]);
    await pg.query(`DELETE FROM shopify_shops WHERE id = $1`, [shop]);
    expect(await q(pg, `SELECT url, catalog_product_id FROM shop_items`)).toEqual([{ url: "https://b.example/products/h", catalog_product_id: null }]);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0096", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0100_shop_shopify_catalog \\")).toHaveLength(1);
    expect(lines.indexOf("0100_shop_shopify_catalog \\")).toBeGreaterThan(lines.indexOf("0096_shop_her_picks \\"));
  });
});
