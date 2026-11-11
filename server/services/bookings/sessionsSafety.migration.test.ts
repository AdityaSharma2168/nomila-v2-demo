/**
 * sessionsSafety.migration.test.ts — 0154 is the schema. From the pre-0154 shape (no approve_each_spot on offers or
 * bookings, no fan_blocks), the file produces exactly what a shared/schema.ts push produces for offers, bookings and
 * fan_blocks: columns, constraints (by definition) and indexes. It re-runs as a no-op with rows present (existing offers
 * and bookings read as "approve each spot" off), the checks hold (one live block per fan per athlete, a known source),
 * the booking FK never blocks a purge, and the file is on db-migrate.sh's list exactly once, after 0153.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0154_sessions_safety";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const TABLES = ["bookings", "offers", "fan_blocks"];
const inList = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

async function pre0154(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`
    DROP TABLE fan_blocks;
    ALTER TABLE bookings DROP COLUMN approve_each_spot;
    ALTER TABLE offers DROP COLUMN approve_each_spot;
  `);
  return pg;
}

const q = async (pg: PGlite, sql: string) => (await pg.query<any>(sql)).rows;
const columns = (pg: PGlite) => q(pg,
  `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_name in (${inList}) order by table_name, column_name`);
const constraints = (pg: PGlite) => q(pg,
  `select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid::regclass::text in (${inList}) order by 1, 2`);
const indexes = (pg: PGlite) => q(pg,
  `select tablename, indexname, indexdef from pg_indexes where tablename in (${inList}) order by 1, 2`);

let seq = 0;
async function seed(pg: PGlite): Promise<{ athleteId: string; offerId: string; bookingId: string }> {
  const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Safety Athlete') RETURNING id`);
  const [o] = await q(pg, `INSERT INTO offers (athlete_id, public_id, format, title, price_cents, duration_minutes, location_mode, scheduling_mode)
    VALUES ('${a.id}', 'pub_${++seq}', 'video_call', 'Call', 15000, 30, 'virtual', 'slots') RETURNING id`);
  const [b] = await q(pg, `INSERT INTO bookings (athlete_id, offer_id, format, title, duration_minutes, location_mode, policy_key, free_cancel_hours,
      price_cents, service_fee_cents, buyer_total_cents, buyer_name, buyer_email, buyer_email_hash, buyer_token_hash)
    VALUES ('${a.id}', '${o.id}', 'video_call', 'Call', 30, 'virtual', 'athlete_window_v1', 24, 15000, 2796, 17796,
      'Buyer', 'buyer@example.com', 'h', 'tok_${++seq}') RETURNING id`);
  return { athleteId: a.id, offerId: o.id, bookingId: b.id };
}

describe("0154: the file is the schema", () => {
  it("turns the pre-0154 shape into exactly what a schema.ts push creates (offers + bookings + fan_blocks)", async () => {
    const want = await pushed();
    const got = await pre0154();
    expect(await columns(got)).not.toEqual(await columns(want));
    await got.exec(FILE);
    expect(await columns(got)).toEqual(await columns(want));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect(await indexes(got)).toEqual(await indexes(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing offers and bookings read as approve-each-spot off", async () => {
    const pg = await pre0154();
    const ids = await seed(pg);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT approve_each_spot FROM offers`)).toEqual([{ approve_each_spot: false }]);
    expect(await q(pg, `SELECT approve_each_spot FROM bookings`)).toEqual([{ approve_each_spot: false }]);
    await pg.query(`INSERT INTO fan_blocks (athlete_id, email_hash, booking_id) VALUES ('${ids.athleteId}', 'eh', '${ids.bookingId}')`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT count(*)::int AS n FROM fan_blocks`)).toEqual([{ n: 1 }]);
    await pg.close();
  }, 120_000);

  it("the checks: one live block per fan per athlete, a known source; a purged booking leaves the block standing", async () => {
    const pg = await pushed();
    const ids = await seed(pg);
    const bad = async (sql: string) => { await expect(pg.query(sql)).rejects.toThrow(); };
    await pg.query(`INSERT INTO fan_blocks (athlete_id, email_hash, booking_id) VALUES ('${ids.athleteId}', 'eh', '${ids.bookingId}')`);
    await bad(`INSERT INTO fan_blocks (athlete_id, email_hash) VALUES ('${ids.athleteId}', 'eh')`);
    await bad(`INSERT INTO fan_blocks (athlete_id, email_hash, source) VALUES ('${ids.athleteId}', 'other', 'everyone')`);
    await pg.query(`UPDATE fan_blocks SET removed_at = now()`);
    await pg.query(`INSERT INTO fan_blocks (athlete_id, email_hash, source) VALUES ('${ids.athleteId}', 'eh', 'live')`);   // blocked again after an unblock
    await pg.query(`DELETE FROM bookings WHERE id = '${ids.bookingId}'`);
    expect(await q(pg, `SELECT count(*)::int AS n, count(booking_id)::int AS linked FROM fan_blocks`)).toEqual([{ n: 2, linked: 0 }]);
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0153 (number order)", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === `${NAME} \\`)).toHaveLength(1);
    expect(list.indexOf(`${NAME} \\`)).toBeGreaterThan(list.indexOf("0153_group_sessions \\"));
  });
});
