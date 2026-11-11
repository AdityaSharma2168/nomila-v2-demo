/**
 * partnerIntake.migration.test.ts — 0103 adds the Partner door's tables (partner requests, her settings, the site and
 * fit caches, rate counters, visitor codes), the relay moderation columns on inbox_messages and the Serious-offer
 * columns on payments (+ deals.deposit_status 'credited'): applied to a 0100 database it leaves exactly what a shared/schema.ts push creates, it re-runs as
 * a no-op, the widened payments subject check still refuses every shape it refused before (and accepts only a deposit
 * hold on a partner request as new), and it is on db-migrate.sh's list once, after 0100.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "../../../shared/schema";

const ROOT = join(__dirname, "..", "..", "..");
const FILE = readFileSync(join(ROOT, "migrations", "0103_partner_intake.sql"), "utf8");
const TABLES = ["deals", "partner_requests", "partner_settings", "brand_site_previews", "partner_fit_previews", "public_rate_counters",
  "partner_visitor_codes", "inbox_messages", "payments"];
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
  constraints: await q(pg, `select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid::regclass::text in (${list}) order by 1, 2`),
  indexes: await q(pg, `select tablename, indexname, indexdef from pg_indexes where tablename in (${list}) order by 1, 2`),
});

/** Back to the 0100 shape: what main had before this file. */
const TO_0100 = `
  ALTER TABLE deals DROP CONSTRAINT deals_deposit_status_check;
  ALTER TABLE deals ADD CONSTRAINT deals_deposit_status_check CHECK (deposit_status IN ('none','held','released','expired'));
  DROP INDEX uq_payments_partner_request;
  ALTER TABLE payments DROP CONSTRAINT payments_credit_check;
  ALTER TABLE payments DROP CONSTRAINT payments_subject_check;
  ALTER TABLE payments ADD CONSTRAINT payments_subject_check CHECK (
    (kind = 'booking_payment' AND booking_id IS NOT NULL AND deal_id IS NULL)
    OR (kind IN ('deposit','deal_payment') AND deal_id IS NOT NULL AND booking_id IS NULL));
  ALTER TABLE payments DROP COLUMN credit_payment_id; ALTER TABLE payments DROP COLUMN credit_cents; ALTER TABLE payments DROP COLUMN partner_request_id;
  ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_moderation_check; ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_held_body_check;
  ALTER TABLE inbox_messages DROP COLUMN moderation; ALTER TABLE inbox_messages DROP COLUMN moderation_reason; ALTER TABLE inbox_messages DROP COLUMN held_body;
  DROP TABLE partner_visitor_codes; DROP TABLE public_rate_counters; DROP TABLE partner_fit_previews;
  DROP TABLE brand_site_previews; DROP TABLE partner_settings; DROP TABLE partner_requests;`;

describe("0103: the file is the schema", () => {
  it("on a 0100 database, leaves exactly what a schema.ts push creates", async () => {
    const want = await pushed();
    const got = await pushed();
    await got.exec(TO_0100);
    await got.exec(FILE);
    expect(await shape(got)).toEqual(await shape(want));
    await want.close(); await got.close();
  }, 60_000);

  it("re-runs as a no-op; the payments checks refuse what they refused before and accept a hold on a request", async () => {
    const pg = await pushed();
    await pg.exec(FILE); await pg.exec(FILE);
    const a = (await q(pg, `INSERT INTO athletes (full_name) VALUES ('Mig') RETURNING id`))[0].id;
    const d = (await q(pg, `INSERT INTO deals (athlete_id, brand_name) VALUES ($1, 'B') RETURNING id`, [a]))[0].id;
    const r = (await q(pg, `INSERT INTO partner_requests (athlete_id, public_ref, kind, brand_name, display_name, brief, contact_email_hash, draft_token_hash, token_nonce, expires_at)
      VALUES ($1, 'REF1', 'content', 'B', 'F', '{}', 'h', 'dt', 'n', now()) RETURNING id`, [a]))[0].id;
    // new: a deposit hold on a request, no deal yet
    await pg.query(`INSERT INTO payments (athlete_id, kind, partner_request_id) VALUES ($1, 'deposit', $2)`, [a, r]);
    // one hold per request
    await expect(pg.query(`INSERT INTO payments (athlete_id, kind, partner_request_id) VALUES ($1, 'deposit', $2)`, [a, r])).rejects.toThrow(/uq_payments_partner_request/);
    // still refused: a deposit with no subject, a deal payment on a request, a booking payment on a request
    await expect(pg.query(`INSERT INTO payments (athlete_id, kind) VALUES ($1, 'deposit')`, [a])).rejects.toThrow(/payments_subject_check/);
    await expect(pg.query(`INSERT INTO payments (athlete_id, kind, deal_id, partner_request_id) VALUES ($1, 'deal_payment', $2, $3)`, [a, d, r])).rejects.toThrow(/payments_subject_check/);
    // a credit only on a deal payment, with its source
    const hold = (await q(pg, `INSERT INTO payments (athlete_id, kind, deal_id) VALUES ($1, 'deposit', $2) RETURNING id`, [a, d]))[0].id;
    await expect(pg.query(`INSERT INTO payments (athlete_id, kind, deal_id, credit_cents) VALUES ($1, 'deal_payment', $2, 5000)`, [a, d])).rejects.toThrow(/payments_credit_check/);
    await expect(pg.query(`INSERT INTO payments (athlete_id, kind, deal_id, credit_cents, credit_payment_id) VALUES ($1, 'deposit', $2, 5000, $3)`, [a, d, hold])).rejects.toThrow(/payments_credit_check/);
    await pg.query(`INSERT INTO payments (athlete_id, kind, deal_id, credit_cents, credit_payment_id) VALUES ($1, 'deal_payment', $2, 5000, $3)`, [a, d, hold]);
    // moderation only on relayed rows
    const t = (await q(pg, `INSERT INTO inbox_threads (athlete_id) VALUES ($1) RETURNING id`, [a]))[0].id;
    await expect(pg.query(`INSERT INTO inbox_messages (thread_id, athlete_id, platform, moderation) VALUES ($1, $2, 'gmail', 'clean')`, [t, a])).rejects.toThrow(/inbox_messages_moderation_check/);
    await pg.query(`INSERT INTO inbox_messages (thread_id, athlete_id, platform, moderation, held_body) VALUES ($1, $2, 'nomila', 'held', 'x')`, [t, a]);
    await expect(pg.query(`INSERT INTO inbox_messages (thread_id, athlete_id, platform, moderation, held_body) VALUES ($1, $2, 'nomila', 'clean', 'x')`, [t, a])).rejects.toThrow(/inbox_messages_held_body_check/);
    // a confirmed request always has its deal and its status token
    await expect(pg.query(`UPDATE partner_requests SET status = 'confirmed' WHERE id = $1`, [r])).rejects.toThrow(/partner_requests_confirmed_check/);
    expect(FILE.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await pg.close();
  }, 60_000);

  it("is on db-migrate.sh's list exactly once, after 0100", () => {
    const lines = readFileSync(join(ROOT, "scripts", "db-migrate.sh"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines.filter((l) => l === "0103_partner_intake \\")).toHaveLength(1);
    expect(lines.indexOf("0103_partner_intake \\")).toBeGreaterThan(lines.indexOf("0100_shop_shopify_catalog \\"));
  });
});
