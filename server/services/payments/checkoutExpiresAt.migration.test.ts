/**
 * checkoutExpiresAt.migration.test.ts — 0095 is the schema: the column the file adds equals what a shared/schema.ts
 * push creates, it re-runs as a no-op, it is additive (one nullable column, nothing else), existing rows stay NULL,
 * and it is on db-migrate.sh's list exactly once, after 0090.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0095_payments_checkout_expires_at";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}
const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const column = (pg: PGlite) => q(pg,
  `select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name='payments' and column_name='checkout_expires_at'`);

describe("0095: the file is the schema", () => {
  it("adds exactly the column a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(`ALTER TABLE payments DROP COLUMN checkout_expires_at;`);
    expect(await column(got)).toEqual([]);
    await got.exec(FILE);
    expect(await column(got)).toEqual(await column(want));
    expect(await column(got)).toEqual([{ column_name: "checkout_expires_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; additive only; no transaction control; existing rows stay NULL", async () => {
    const pg = await pushed();
    await pg.exec(`ALTER TABLE payments DROP COLUMN checkout_expires_at;`);
    const a = (await pg.query<{ id: string }>(`INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`)).rows[0].id;
    const d = (await pg.query<{ id: string }>(`INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'Acme') RETURNING id`, [a])).rows[0].id;
    await pg.query(`INSERT INTO payments (deal_id, athlete_id, kind) VALUES ($1, $2, 'deal_payment')`, [d, a]);

    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT kind, checkout_expires_at FROM payments`)).toEqual([{ kind: "deal_payment", checkout_expires_at: null }]);

    const code = FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
    expect(code).toBe("ALTER TABLE payments ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz;");
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0090", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const line = `${NAME} \\`;
    expect(list.filter((l) => l === line)).toHaveLength(1);
    expect(list.indexOf(line)).toBeGreaterThan(list.indexOf("0090_drop_onboarding_sessions_brand_api_keys \\"));
  });
});
