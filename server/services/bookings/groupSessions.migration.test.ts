/**
 * groupSessions.migration.test.ts — 0153 is the schema. From the pre-0153 shape (no audience / max_people on offers, no
 * audience / party_size / unit_price_cents on bookings, no booking_guests, the slot index without the open-group
 * condition), the file produces exactly what a shared/schema.ts push produces for offers, bookings and booking_guests:
 * columns, constraints (by definition) and indexes. It re-runs as a no-op with rows present (existing rows read as 1:1,
 * party 1, and the slot index is NOT dropped on a re-run), the new checks hold, and the file is on db-migrate.sh's list
 * exactly once, after 0151. The file is applied ON ITS OWN, never chained.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0153_group_sessions";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");
const TABLES = ["bookings", "offers", "booking_guests"];
const inList = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

/** The pre-0153 shape (what dev and prod look like before this PR deploys). */
async function pre0153(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`
    DROP TABLE booking_guests;
    DROP INDEX idx_bookings_slot;
    DROP INDEX uq_bookings_live_slot;
    CREATE UNIQUE INDEX uq_bookings_live_slot ON bookings USING btree (slot_id)
      WHERE slot_id IS NOT NULL AND status IN ('unverified','requested','accepted','confirmed','in_review','issue_reported','disputed');
    ALTER TABLE bookings DROP CONSTRAINT bookings_audience_check;
    ALTER TABLE bookings DROP CONSTRAINT bookings_party_size_check;
    ALTER TABLE bookings DROP CONSTRAINT bookings_unit_price_check;
    ALTER TABLE bookings DROP COLUMN audience;
    ALTER TABLE bookings DROP COLUMN party_size;
    ALTER TABLE bookings DROP COLUMN unit_price_cents;
    ALTER TABLE offers DROP CONSTRAINT offers_audience_check;
    ALTER TABLE offers DROP CONSTRAINT offers_max_people_check;
    ALTER TABLE offers DROP CONSTRAINT offers_open_group_slots_check;
    ALTER TABLE offers DROP COLUMN audience;
    ALTER TABLE offers DROP COLUMN max_people;
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
async function seed(pg: PGlite, offerCols = "", offerVals = ""): Promise<{ athleteId: string; offerId: string; slotId: string }> {
  const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Group Athlete') RETURNING id`);
  const [o] = await q(pg, `INSERT INTO offers (athlete_id, public_id, format, title, price_cents, duration_minutes, location_mode, scheduling_mode${offerCols})
    VALUES ('${a.id}', 'pub_${++seq}', 'video_call', 'Call', 15000, 30, 'virtual', 'slots'${offerVals}) RETURNING id`);
  const [s] = await q(pg, `INSERT INTO offer_slots (offer_id, athlete_id, starts_at, ends_at)
    VALUES ('${o.id}', '${a.id}', now() + interval '2 days', now() + interval '2 days 30 minutes') RETURNING id`);
  return { athleteId: a.id, offerId: o.id, slotId: s.id };
}
async function booking(pg: PGlite, ids: { athleteId: string; offerId: string }, extra = ""): Promise<string> {
  const [b] = await q(pg, `INSERT INTO bookings (athlete_id, offer_id, format, title, duration_minutes, location_mode, policy_key, free_cancel_hours,
      price_cents, service_fee_cents, buyer_total_cents, buyer_name, buyer_email, buyer_email_hash, buyer_token_hash)
    VALUES ('${ids.athleteId}', '${ids.offerId}', 'video_call', 'Call', 30, 'virtual', 'athlete_window_v1', 24, 15000, 2796, 17796,
      'Buyer', 'buyer@example.com', 'h', 'tok_${++seq}') RETURNING id`);
  if (extra) await pg.query(`UPDATE bookings SET ${extra} WHERE id = '${b.id}'`);
  return b.id;
}

describe("0153: the file is the schema", () => {
  it("turns the pre-0153 shape into exactly what a schema.ts push creates (offers + bookings + booking_guests)", async () => {
    const want = await pushed();
    const got = await pre0153();
    expect(await indexes(got)).not.toEqual(await indexes(want));
    await got.exec(FILE);
    expect(await columns(got)).toEqual(await columns(want));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect(await indexes(got)).toEqual(await indexes(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing rows read as 1:1, one person; the slot index survives a re-run", async () => {
    const pg = await pre0153();
    const ids = await seed(pg);
    const b = await booking(pg, ids, `slot_id = '${ids.slotId}', status = 'confirmed'`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT audience, party_size, unit_price_cents FROM bookings`)).toEqual([{ audience: "one", party_size: 1, unit_price_cents: null }]);
    expect(await q(pg, `SELECT audience, max_people FROM offers`)).toEqual([{ audience: "one", max_people: 1 }]);
    const oid = await q(pg, `SELECT 'uq_bookings_live_slot'::regclass::oid AS oid`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT 'uq_bookings_live_slot'::regclass::oid AS oid`)).toEqual(oid);   // not dropped and rebuilt
    await pg.query(`INSERT INTO booking_guests (booking_id, email, email_hash) VALUES ('${b}', 'g@example.com', 'gh')`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT count(*)::int AS n FROM booking_guests`)).toEqual([{ n: 1 }]);
    await pg.close();
  }, 120_000);

  it("the checks: who it's for, how many, open groups use set times, the per-person price adds up, one live invite per email", async () => {
    const pg = await pushed();
    const ids = await seed(pg);
    const bad = async (sql: string) => { await expect(pg.query(sql)).rejects.toThrow(); };
    await bad(`UPDATE offers SET audience = 'crowd' WHERE id = '${ids.offerId}'`);
    await bad(`UPDATE offers SET max_people = 3 WHERE id = '${ids.offerId}'`);                     // 1:1 is one person
    await bad(`UPDATE offers SET audience = 'open_group' WHERE id = '${ids.offerId}'`);            // a group needs 2..20
    await bad(`UPDATE offers SET audience = 'open_group', max_people = 21 WHERE id = '${ids.offerId}'`);
    await bad(`UPDATE offers SET audience = 'open_group', max_people = 5, scheduling_mode = 'request' WHERE id = '${ids.offerId}'`);
    await pg.query(`UPDATE offers SET audience = 'private_group', max_people = 5, scheduling_mode = 'request' WHERE id = '${ids.offerId}'`);
    const b = await booking(pg, ids);
    await bad(`UPDATE bookings SET party_size = 3 WHERE id = '${b}'`);                               // only a private group brings a party
    await bad(`UPDATE bookings SET audience = 'open_group', party_size = 2 WHERE id = '${b}'`);
    await bad(`UPDATE bookings SET audience = 'private_group', party_size = 21 WHERE id = '${b}'`);
    await bad(`UPDATE bookings SET audience = 'private_group', party_size = 3, unit_price_cents = 15000 WHERE id = '${b}'`);   // 3 × 15000 ≠ 15000
    await pg.query(`UPDATE bookings SET audience = 'private_group', party_size = 3, unit_price_cents = 5000 WHERE id = '${b}'`);
    await pg.query(`INSERT INTO booking_guests (booking_id, email, email_hash) VALUES ('${b}', 'g@example.com', 'gh')`);
    await bad(`INSERT INTO booking_guests (booking_id, email, email_hash) VALUES ('${b}', 'g@example.com', 'gh')`);
    await pg.query(`UPDATE booking_guests SET revoked_at = now()`);
    await pg.query(`INSERT INTO booking_guests (booking_id, email, email_hash) VALUES ('${b}', 'g@example.com', 'gh')`);   // re-invited after removal
    await pg.close();
  }, 120_000);

  it("the rebuilt slot index: one live booking per slot, except an open group", async () => {
    const pg = await pre0153();
    await pg.exec(FILE);
    const one = await seed(pg);
    await booking(pg, one, `slot_id = '${one.slotId}'`);
    await expect(booking(pg, one, `slot_id = '${one.slotId}'`)).rejects.toThrow();
    const open = await seed(pg, ", audience, max_people", ", 'open_group', 5");
    await booking(pg, open, `slot_id = '${open.slotId}', audience = 'open_group'`);
    await booking(pg, open, `slot_id = '${open.slotId}', audience = 'open_group', status = 'confirmed'`);
    expect(await q(pg, `SELECT count(*)::int AS n FROM bookings WHERE slot_id = '${open.slotId}'`)).toEqual([{ n: 2 }]);
    await pg.close();
  }, 120_000);

  it(`is on db-migrate.sh's list exactly once, after 0151 (number order)`, () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === `${NAME} \\`)).toHaveLength(1);
    expect(list.indexOf(`${NAME} \\`)).toBeGreaterThan(list.indexOf("0151_media_rights_attestations \\"));
  });
});
