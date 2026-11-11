/**
 * bookingsFlow.migration.test.ts — 0102 is the schema. From the post-0099 shape (no proposed_times / athlete_proposed_times
 * / minor_first_name on bookings, no adult_attested_at / venue_confirmed_at on offers, the narrow slot index), the file
 * produces exactly what a shared/schema.ts push produces for bookings and offers: columns, constraints (by definition)
 * and indexes. It re-runs as a no-op with rows present, the new checks hold (1–3 proposed times, a child's name only
 * with a minor attendee), the WIDENED slot index protects a slot while a request is unverified or requested, and the
 * file is on db-migrate.sh's list exactly once, after 0101. The file is applied ON ITS OWN, never chained.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const NAME = "0102_bookings_flow";
const FILE = readFileSync(join(ROOT, "migrations", `${NAME}.sql`), "utf8");
// 0153 (group sessions) later rebuilt uq_bookings_live_slot (open groups excluded): the shape test replays it after.
const FILE_0153 = readFileSync(join(ROOT, "migrations", "0153_group_sessions.sql"), "utf8");
const TABLES = ["bookings", "offers"];
const inList = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

/** The post-0099, pre-0102 shape (what dev looks like before this PR deploys). */
async function pre0102(): Promise<PGlite> {
  const pg = await pushed();
  await pg.exec(`
    ALTER TABLE bookings DROP CONSTRAINT bookings_proposed_times_check;
    ALTER TABLE bookings DROP CONSTRAINT bookings_athlete_proposed_times_check;
    ALTER TABLE bookings DROP CONSTRAINT bookings_minor_name_check;
    ALTER TABLE bookings DROP COLUMN proposed_times;
    ALTER TABLE bookings DROP COLUMN athlete_proposed_times;
    ALTER TABLE bookings DROP COLUMN minor_first_name;
    ALTER TABLE offers DROP COLUMN adult_attested_at;
    ALTER TABLE offers DROP COLUMN venue_confirmed_at;
    DROP INDEX idx_bookings_status_respond;
    DROP INDEX uq_bookings_live_slot;
    CREATE UNIQUE INDEX uq_bookings_live_slot ON bookings USING btree (slot_id)
      WHERE slot_id IS NOT NULL AND status IN ('accepted','confirmed','in_review','issue_reported','disputed');
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
async function seed(pg: PGlite): Promise<{ athleteId: string; offerId: string; slotId: string }> {
  const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Flow Athlete') RETURNING id`);
  const [o] = await q(pg, `INSERT INTO offers (athlete_id, public_id, format, title, price_cents, duration_minutes, location_mode)
    VALUES ('${a.id}', 'pub_${++seq}', 'video_call', 'Call', 15000, 30, 'virtual') RETURNING id`);
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

describe("0102: the file is the schema", () => {
  it("turns the post-0099 shape into exactly what a schema.ts push creates (bookings + offers)", async () => {
    const want = await pushed();
    const got = await pre0102();
    expect(await indexes(got)).not.toEqual(await indexes(want));
    await got.exec(FILE);
    await got.exec(FILE_0153);
    expect(await columns(got)).toEqual(await columns(want));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect(await indexes(got)).toEqual(await indexes(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present", async () => {
    const pg = await pre0102();
    const ids = await seed(pg);
    await booking(pg, ids, `slot_id = '${ids.slotId}', status = 'confirmed'`);
    await pg.exec(FILE);
    await booking(pg, ids, `proposed_times = '[{"start":"2026-12-01T16:00:00.000Z","tz":"America/New_York"}]'::jsonb`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT count(*)::int AS n FROM bookings`)).toEqual([{ n: 2 }]);
    await pg.close();
  }, 120_000);

  it("1–3 proposed times, a child's first name only with a minor attendee", async () => {
    const pg = await pushed();
    const ids = await seed(pg);
    const id = await booking(pg, ids);
    const bad = async (sql: string) => { await expect(pg.query(sql)).rejects.toThrow(); };
    const t = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ start: `2026-12-0${i + 1}T16:00:00.000Z`, tz: null })));
    await bad(`UPDATE bookings SET proposed_times = '[]'::jsonb WHERE id = '${id}'`);
    await bad(`UPDATE bookings SET proposed_times = '${t(4)}'::jsonb WHERE id = '${id}'`);
    await bad(`UPDATE bookings SET proposed_times = '{"start":"x"}'::jsonb WHERE id = '${id}'`);
    await pg.query(`UPDATE bookings SET proposed_times = '${t(3)}'::jsonb WHERE id = '${id}'`);
    await bad(`UPDATE bookings SET athlete_proposed_times = '${t(4)}'::jsonb WHERE id = '${id}'`);
    await pg.query(`UPDATE bookings SET athlete_proposed_times = '${t(1)}'::jsonb WHERE id = '${id}'`);
    await bad(`UPDATE bookings SET minor_first_name = 'Kid' WHERE id = '${id}'`);
    await pg.query(`UPDATE bookings SET minor_attendee = true, parent_present_attested = true, minor_first_name = 'Kid' WHERE id = '${id}'`);
    expect(await q(pg, `SELECT adult_attested_at, venue_confirmed_at FROM offers`)).toEqual([{ adult_attested_at: null, venue_confirmed_at: null }]);
    await pg.close();
  }, 120_000);

  it("the widened index holds a slot while a request is unverified or requested; finished ones free it", async () => {
    const pg = await pushed();
    const ids = await seed(pg);
    const b1 = await booking(pg, ids, `slot_id = '${ids.slotId}'`);                       // unverified: holds
    await expect(booking(pg, ids, `slot_id = '${ids.slotId}'`)).rejects.toThrow();        // a second unverified
    await pg.query(`UPDATE bookings SET status = 'requested' WHERE id = '${b1}'`);
    await expect(booking(pg, ids, `slot_id = '${ids.slotId}', status = 'requested'`)).rejects.toThrow();
    await pg.query(`UPDATE bookings SET status = 'expired' WHERE id = '${b1}'`);           // lapsed → the slot reopens
    const b2 = await booking(pg, ids, `slot_id = '${ids.slotId}'`);
    expect(b2).toBeTruthy();
    await pg.close();
  }, 120_000);

  it(`is on db-migrate.sh's list exactly once, after 0101 (number order)`, () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === `${NAME} \\`)).toHaveLength(1);
    expect(list.indexOf(`${NAME} \\`)).toBeGreaterThan(list.indexOf("0101_public_card \\"));
    expect(list.indexOf("0101_public_card \\")).toBeGreaterThan(list.indexOf("0100_shop_shopify_catalog \\"));
  });
});
