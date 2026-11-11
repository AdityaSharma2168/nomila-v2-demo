/**
 * offerAvailability.migration.test.ts — 0155 is the schema. From the pre-0155 shape (no offers.availability, no
 * offers_availability_check), the file produces exactly what a shared/schema.ts push produces for offers: columns,
 * constraints (by definition) and indexes. It re-runs as a no-op with rows present (existing offers read NULL, a saved
 * value survives), the check holds (NULL or a JSON object), and the file is on db-migrate.sh's list exactly once, after
 * 0153. The file is applied ON ITS OWN, never chained.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0155_offer_availability";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

/** The pre-0155 shape (what dev and prod look like before this PR deploys). */
async function pre0155(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`
    ALTER TABLE offers DROP CONSTRAINT offers_availability_check;
    ALTER TABLE offers DROP COLUMN availability;
  `);
  return pg;
}

const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite) => q(pg,
  `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'offers' order by column_name`);
const constraints = (pg: PGlite) => q(pg,
  `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text = 'offers' order by 1`);
const indexes = (pg: PGlite) => q(pg, `select indexname, indexdef from pg_indexes where tablename = 'offers' order by 1`);

let seq = 0;
async function seedOffer(pg: PGlite): Promise<string> {
  const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Hours Athlete') RETURNING id`);
  const [o] = await q(pg, `INSERT INTO offers (athlete_id, public_id, format, title, price_cents, duration_minutes, location_mode, scheduling_mode)
    VALUES ('${a.id}', 'pub_${++seq}', 'video_call', 'Call', 15000, 30, 'virtual', 'slots') RETURNING id`);
  return o.id;
}

describe("0155: the file is the schema", () => {
  it("turns the pre-0155 shape into exactly what a schema.ts push creates (offers)", async () => {
    const want = await pushed();
    const got = await pre0155();
    expect(await columns(got)).not.toEqual(await columns(want));
    await got.exec(FILE);
    expect(await columns(got)).toEqual(await columns(want));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect(await indexes(got)).toEqual(await indexes(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present: existing offers read NULL, a saved value survives", async () => {
    const pg = await pre0155();
    const before = await seedOffer(pg);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT availability FROM offers WHERE id = '${before}'`)).toEqual([{ availability: null }]);
    const hours = { version: 1, preset: null, blocks: [{ day: 2, start: 420, end: 495 }] };
    await pg.query(`UPDATE offers SET availability = $1::jsonb WHERE id = '${before}'`, [JSON.stringify(hours)]);
    await pg.exec(FILE);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT availability FROM offers WHERE id = '${before}'`)).toEqual([{ availability: hours }]);
    expect(await q(pg, `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'offers_availability_check'`)).toEqual([{ n: 1 }]);
    await pg.close();
  }, 120_000);

  it("the check: NULL or a JSON object, never a list or a scalar", async () => {
    const pg = await pre0155();
    await pg.exec(FILE);
    const id = await seedOffer(pg);
    for (const bad of [`'[]'`, `'"Mon 6-9"'`, `'42'`]) {
      await expect(pg.query(`UPDATE offers SET availability = ${bad}::jsonb WHERE id = '${id}'`)).rejects.toThrow();
    }
    await pg.query(`UPDATE offers SET availability = '{"version":1,"preset":null,"blocks":[]}'::jsonb WHERE id = '${id}'`);
    await pg.query(`UPDATE offers SET availability = NULL WHERE id = '${id}'`);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0153 (number order)", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === `${NAME} \\`)).toHaveLength(1);
    expect(list.indexOf(`${NAME} \\`)).toBeGreaterThan(list.indexOf("0153_group_sessions \\"));
  });
});
