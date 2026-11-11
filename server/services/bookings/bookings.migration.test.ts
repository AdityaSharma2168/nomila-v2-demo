/**
 * bookings.migration.test.ts — 0099 is the schema. Starting from the pre-0099 shape (no booking tables; payments with
 * deal_id NOT NULL, no booking_id, kind deposit|deal_payment), the file produces exactly what a shared/schema.ts push
 * produces: columns, constraints (by definition) and indexes of the seven new tables and of payments. It re-runs as a
 * no-op with rows present, existing deal payments still validate, the one-subject rule and one-payment-per-booking hold,
 * the v2.1 seams hold (her per-offer cancellation window, no-show marking, paused_reason), and it is on db-migrate.sh's
 * list exactly once, after 0097. 0102 (the flow PR) adds columns and widens the slot index on these tables, so the
 * "file is the schema" comparison applies 0099 THEN 0102 — each file is still validated on its own, in its own test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0099_bookings.sql"), "utf8");
const FILE_0102 = readFileSync(join(ROOT, "migrations", "0102_bookings_flow.sql"), "utf8");
// 0103 (the Partner door) later widened payments (partner_request_id, credit_*, the subject check). The push is the
// schema AFTER both files, so the shape test rewinds 0103 too and replays 0099 then 0103.
const LATER = readFileSync(join(ROOT, "migrations", "0103_partner_intake.sql"), "utf8");
// 0137 (Bookings PR3) added offers.time_zone: replayed after the others so the shape matches the push.
const FILE_0137 = readFileSync(join(ROOT, "migrations", "0137_offers_time_zone.sql"), "utf8");
// 0153 (group sessions) added offers/bookings columns + checks, booking_guests, and rebuilt the slot index.
const FILE_0153 = readFileSync(join(ROOT, "migrations", "0153_group_sessions.sql"), "utf8");
// 0154 (sessions safety) added offers/bookings approve_each_spot and fan_blocks.
const FILE_0154 = readFileSync(join(ROOT, "migrations", "0154_sessions_safety.sql"), "utf8");
// 0155 (flexible hours) added offers.availability + its check.
const FILE_0155 = readFileSync(join(ROOT, "migrations", "0155_offer_availability.sql"), "utf8");
const NEW_TABLES = ["offers", "offer_slots", "bookings", "booking_events", "booking_messages", "booking_reports", "safety_blocks", "athlete_payout_adjustments"];
const TABLES = [...NEW_TABLES, "payments"];
const inList = TABLES.map((t) => `'${t}'`).join(",");

async function pushed(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  for (const s of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await pg.exec(s);
  return pg;
}

/** Put a pushed database back into the pre-0099 shape (what dev and prod look like today). */
async function rewind(pg: PGlite): Promise<void> {
  await pg.exec(`
    DROP INDEX uq_payments_partner_request;
    ALTER TABLE payments DROP CONSTRAINT payments_credit_check;
    ALTER TABLE payments DROP COLUMN credit_payment_id; ALTER TABLE payments DROP COLUMN credit_cents; ALTER TABLE payments DROP COLUMN partner_request_id;
    ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_moderation_check; ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_held_body_check;
    ALTER TABLE inbox_messages DROP COLUMN moderation; ALTER TABLE inbox_messages DROP COLUMN moderation_reason; ALTER TABLE inbox_messages DROP COLUMN held_body;
    DROP TABLE partner_visitor_codes, public_rate_counters, partner_fit_previews, brand_site_previews, partner_settings, partner_requests;
    DROP INDEX uq_payments_booking;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_subject_check;  -- already gone with partner_request_id (0103)
    ALTER TABLE payments DROP CONSTRAINT payments_booking_id_bookings_id_fk;
    ALTER TABLE payments DROP COLUMN booking_id;
    ALTER TABLE payments DROP CONSTRAINT payments_kind_check;
    ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('deposit','deal_payment'));
    ALTER TABLE payments ALTER COLUMN deal_id SET NOT NULL;
    DROP TABLE booking_guests;
    DROP TABLE fan_blocks;
    DROP TABLE athlete_payout_adjustments, safety_blocks, booking_reports, booking_messages, booking_events, bookings, offer_slots, offers;
  `);
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

async function seedDealPayment(pg: PGlite): Promise<{ athleteId: string; dealId: string }> {
  const [a] = await q(pg, `INSERT INTO athletes (full_name) VALUES ('Test Athlete') RETURNING id`);
  const [d] = await q(pg, `INSERT INTO deals (athlete_id, brand_name) VALUES ('${a.id}', 'Test Brand') RETURNING id`);
  await pg.query(`INSERT INTO payments (deal_id, athlete_id, kind, status) VALUES ('${d.id}', '${a.id}', 'deal_payment', 'funded')`);
  return { athleteId: a.id, dealId: d.id };
}

async function seedBooking(pg: PGlite, athleteId: string): Promise<string> {
  const [o] = await q(pg, `INSERT INTO offers (athlete_id, public_id, format, title, price_cents, duration_minutes, location_mode)
    VALUES ('${athleteId}', 'pub_${Math.random().toString(36).slice(2)}', 'video_call', 'Call', 15000, 30, 'virtual') RETURNING id`);
  const [b] = await q(pg, `INSERT INTO bookings (athlete_id, offer_id, format, title, duration_minutes, location_mode, policy_key, free_cancel_hours,
      price_cents, service_fee_cents, buyer_total_cents, buyer_name, buyer_email, buyer_email_hash, buyer_token_hash)
    VALUES ('${athleteId}', '${o.id}', 'video_call', 'Call', 30, 'virtual', 'athlete_window_v1', 24, 15000, 2796, 17796,
      'Buyer', 'buyer@example.com', 'h1', 'tok_${Math.random().toString(36).slice(2)}') RETURNING id`);
  return b.id;
}

describe("0099: the file is the schema", () => {
  it("turns the pre-0099 shape into exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await rewind(got);
    await got.exec(FILE);
    await got.exec(FILE_0102);
    await got.exec(LATER);
    await got.exec(FILE_0137);
    await got.exec(FILE_0153);
    await got.exec(FILE_0154);
    await got.exec(FILE_0155);
    expect(await columns(got)).toEqual(await columns(want));
    expect(await constraints(got)).toEqual(await constraints(want));
    expect(await indexes(got)).toEqual(await indexes(want));
    await want.close(); await got.close();
  }, 120_000);

  it("re-runs as a no-op with rows present; existing deal payments still validate", async () => {
    const pg = await pushed();
    await rewind(pg);
    const { athleteId } = await seedDealPayment(pg);   // a live deal payment from before 0099
    await pg.exec(FILE);
    const bookingId = await seedBooking(pg, athleteId);
    await pg.query(`INSERT INTO payments (booking_id, athlete_id, kind, status) VALUES ('${bookingId}', '${athleteId}', 'booking_payment', 'pending')`);
    await pg.exec(FILE);
    expect(await q(pg, `SELECT kind FROM payments ORDER BY kind`)).toEqual([{ kind: "booking_payment" }, { kind: "deal_payment" }]);
    await pg.close();
  }, 120_000);

  it("one subject per payment, one payment per booking, and the booking guards hold", async () => {
    const pg = await pushed();
    const { athleteId, dealId } = await seedDealPayment(pg);
    const bookingId = await seedBooking(pg, athleteId);
    const bad = async (sql: string) => { await expect(pg.query(sql)).rejects.toThrow(); };
    // a booking payment may not name a deal; a deal payment may not name a booking; neither may be subject-less
    await bad(`INSERT INTO payments (deal_id, booking_id, athlete_id, kind) VALUES ('${dealId}', '${bookingId}', '${athleteId}', 'booking_payment')`);
    await bad(`INSERT INTO payments (booking_id, athlete_id, kind) VALUES ('${bookingId}', '${athleteId}', 'deal_payment')`);
    await bad(`INSERT INTO payments (athlete_id, kind) VALUES ('${athleteId}', 'booking_payment')`);
    await pg.query(`INSERT INTO payments (booking_id, athlete_id, kind) VALUES ('${bookingId}', '${athleteId}', 'booking_payment')`);
    await bad(`INSERT INTO payments (booking_id, athlete_id, kind) VALUES ('${bookingId}', '${athleteId}', 'booking_payment')`);
    // the all-in total is her price + the fee, exactly
    await bad(`UPDATE bookings SET buyer_total_cents = 17797 WHERE id = '${bookingId}'`);
    // in person always requires ID; a minor attendee requires a parent present
    await bad(`UPDATE bookings SET location_mode = 'in_person' WHERE id = '${bookingId}'`);
    await bad(`UPDATE bookings SET minor_attendee = true WHERE id = '${bookingId}'`);
    await bad(`UPDATE offers SET location_mode = 'in_person'`);
    // a platform ban has no athlete; her own block has one
    await bad(`INSERT INTO safety_blocks (scope, athlete_id, kind, value_hash, created_by) VALUES ('platform', '${athleteId}', 'email', 'h', 'admin')`);
    await bad(`INSERT INTO safety_blocks (scope, kind, value_hash, created_by) VALUES ('athlete', 'email', 'h', 'athlete')`);
    await pg.query(`INSERT INTO safety_blocks (scope, kind, value_hash, created_by) VALUES ('platform', 'card_fingerprint', 'fp', 'admin')`);
    // her first athlete-caused cancellation is waived; only ONE waiver per athlete, ever
    const b2 = await seedBooking(pg, athleteId);
    await pg.query(`INSERT INTO athlete_payout_adjustments (athlete_id, booking_id, amount_cents, status) VALUES ('${athleteId}', '${bookingId}', 530, 'waived')`);
    await bad(`INSERT INTO athlete_payout_adjustments (athlete_id, booking_id, amount_cents, status) VALUES ('${athleteId}', '${b2}', 530, 'waived')`);
    await pg.query(`INSERT INTO athlete_payout_adjustments (athlete_id, booking_id, amount_cents, status) VALUES ('${athleteId}', '${b2}', 530, 'owed')`);
    // v2.1: her offer defaults to a 24h window under the versioned policy; the window is a positive number of hours
    expect(await q(pg, `SELECT free_cancel_hours, policy_key FROM offers LIMIT 1`)).toEqual([{ free_cancel_hours: 24, policy_key: "athlete_window_v1" }]);
    await bad(`UPDATE offers SET free_cancel_hours = 0`);
    await bad(`UPDATE bookings SET free_cancel_hours = NULL WHERE id = '${bookingId}'`);
    await pg.query(`UPDATE offers SET free_cancel_hours = 168`);
    // a paused_reason only while paused, from the known set
    await bad(`UPDATE offers SET paused_reason = 'no_show_review'`);
    await bad(`UPDATE offers SET status = 'paused', paused_reason = 'whatever'`);
    await pg.query(`UPDATE offers SET status = 'paused', paused_reason = 'no_show_review'`);
    // a no-show names who, and when it was marked, together
    await bad(`UPDATE bookings SET no_show_by = 'athlete' WHERE id = '${bookingId}'`);
    await bad(`UPDATE bookings SET no_show_by = 'nobody', no_show_marked_at = now() WHERE id = '${bookingId}'`);
    await pg.query(`UPDATE bookings SET no_show_by = 'buyer', no_show_marked_at = now() WHERE id = '${bookingId}'`);
    await pg.query(`INSERT INTO booking_events (booking_id, kind, actor) VALUES ('${bookingId}', 'no_show', 'athlete')`);
    // a report is resolved exactly when it has a resolution
    await bad(`INSERT INTO booking_reports (booking_id, athlete_id, reported_by, category, status) VALUES ('${bookingId}', '${athleteId}', 'buyer', 'no_show', 'resolved')`);
    await pg.close();
  }, 120_000);

  it("a slot can be held by one live booking only", async () => {
    const pg = await pushed();
    const { athleteId } = await seedDealPayment(pg);
    const b1 = await seedBooking(pg, athleteId);
    const b2 = await seedBooking(pg, athleteId);
    const [o] = await q(pg, `SELECT offer_id FROM bookings WHERE id = '${b1}'`);
    const [slot] = await q(pg, `INSERT INTO offer_slots (offer_id, athlete_id, starts_at, ends_at)
      VALUES ('${o.offer_id}', '${athleteId}', now() + interval '1 day', now() + interval '1 day 30 minutes') RETURNING id`);
    // two finished requests on one slot: fine (since 0102 a LIVE request — unverified or requested — holds it too; see
    // bookingsFlow.migration.test.ts)
    await pg.query(`UPDATE bookings SET slot_id = '${slot.id}', status = 'declined' WHERE id IN ('${b1}', '${b2}')`);
    await pg.query(`UPDATE bookings SET status = 'accepted' WHERE id = '${b1}'`);
    await expect(pg.query(`UPDATE bookings SET status = 'accepted' WHERE id = '${b2}'`)).rejects.toThrow();
    await pg.close();
  }, 120_000);

  it("is on db-migrate.sh's list exactly once, after 0097", () => {
    const list = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(list.filter((l) => l === "0099_bookings \\")).toHaveLength(1);
    expect(list.indexOf("0099_bookings \\")).toBeGreaterThan(list.indexOf("0097_payments_brand_confirm_token \\"));
    expect(list.indexOf("0097_payments_brand_confirm_token \\")).toBeGreaterThan(-1);
  });
});
