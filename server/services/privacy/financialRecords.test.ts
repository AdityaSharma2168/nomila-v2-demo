/**
 * Account deletion keeps a de-identified financial record (#803) — on PGlite, no provider is reached (storage,
 * grant revocation and the Firebase user are injected fakes; Stripe is never called).
 *
 *   - a settled payment leaves exactly one financial_ledger_records row, with no personal column;
 *   - a canceled payment leaves none;
 *   - her payment_events payloads are cut to the whitelist; another athlete's are untouched;
 *   - the purge refuses while the retention period is unset, and deletes only expired rows when it is set.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));

import { sql } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { deleteAthleteAccount, type AccountDeletionDeps } from "./deleteAthleteAccount";
import { financialRecordRetentionDays, minimizePaymentEventPayload } from "../../lib/privacy/financialRecords";
import { purgeExpiredFinancialRecords, RetentionPeriodUnset } from "../../scripts/privacy/purgeExpiredFinancialRecordsCore";

const rows = (r: any) => (r.rows ?? r) as any[];
const deps: AccountDeletionDeps = {
  store: { list: async () => [], remove: async () => {} },
  revoke: async (g) => ({ connection_id: g.id, platform: g.platform, outcome: "revoked" }),
  deleteAuthUser: async () => {},
  retry: { attempts: 1, backoffMs: 0 },
};

beforeAll(async () => { await initTestDb(); }, 120_000);
afterAll(async () => { await closeTestDb(); });

interface Seeded { athleteId: string; dealId: string; paymentId: string; acct: string; email: string; pi: string; ch: string; tr: string }

let seq = 0;
async function athleteWithPayment(status: string, opts: { charged: boolean }): Promise<Seeded> {
  const n = ++seq;
  const athleteId = await seedAthlete(`Fin ${n}`);
  const acct = `acct_test${n}x`; const email = `brand${n}@example.test`;
  const pi = `pi_test${n}x`; const ch = `ch_test${n}x`; const tr = `tr_test${n}x`;
  const [deal] = rows(await db.execute(sql`INSERT INTO deals (athlete_id, brand_name) VALUES (${athleteId}::uuid, ${`Brand ${n}`}) RETURNING id::text`));
  await db.execute(sql`INSERT INTO connect_accounts (athlete_id, stripe_account_id) VALUES (${athleteId}::uuid, ${acct})`);
  const [p] = rows(await db.execute(sql`
    INSERT INTO payments (deal_id, athlete_id, kind, status, deal_value_cents, commission_cents, processing_fee_cents, brand_total_cents,
                          currency, stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, destination_account_id, brand_email,
                          failure_reason, metadata, created_at)
    VALUES (${deal.id}::uuid, ${athleteId}::uuid, 'deal_payment', ${status}, 100000, 10000, 3200, 113200,
            'usd', ${pi}, ${opts.charged ? ch : null}, ${opts.charged ? tr : null}, ${acct}, ${email},
            'none', ${JSON.stringify({ note: "private" })}::jsonb, '2026-09-01T00:00:00Z')
    RETURNING id::text`));
  return { athleteId, dealId: deal.id, paymentId: p.id, acct, email, pi, ch, tr };
}

/** A Stripe-shaped event naming the athlete's payment, Connect account, brand email and her ids in metadata. */
async function stripeEvent(id: string, s: Seeded, type = "payment_intent.succeeded", object?: Record<string, unknown>) {
  const payload = {
    id, type, object: "event", account: s.acct, created: 1790000000,
    data: { object: object ?? {
      id: s.pi, object: "payment_intent", amount: 113200, amount_received: 113200, currency: "usd", status: "succeeded", created: 1790000000,
      receipt_email: s.email, transfer_data: { destination: s.acct },
      charges: { data: [{ id: s.ch, billing_details: { email: s.email, name: "Brand Buyer", address: { line1: "1 Main St" } } }] },
      metadata: { kind: "deal_payment", payment_id: s.paymentId, deal_id: s.dealId, athlete_id: s.athleteId },
    } },
  };
  await db.execute(sql`INSERT INTO payment_events (id, type, payload) VALUES (${id}, ${type}, ${JSON.stringify(payload)}::jsonb)`);
}
const eventPayload = async (id: string) => rows(await db.execute(sql`SELECT payload FROM payment_events WHERE id = ${id}`))[0].payload;

describe("account deletion — de-identified financial record", () => {
  it("a settled payment leaves exactly one ledger row with no personal columns; her payment is deleted", async () => {
    const s = await athleteWithPayment("settled", { charged: true });
    const before = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n);

    const res = await deleteAthleteAccount(s.athleteId, deps);
    expect(res!.financial_records.ledger_rows).toBe(1);

    const ledger = rows(await db.execute(sql`SELECT * FROM financial_ledger_records WHERE stripe_payment_intent_id = ${s.pi}`));
    expect(ledger).toHaveLength(1);
    expect(Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n)).toBe(before + 1);
    const row = ledger[0];
    expect(row).toMatchObject({
      kind: "deal_payment", status: "settled", deal_value_cents: 100000, commission_cents: 10000, processing_fee_cents: 3200,
      brand_total_cents: 113200, currency: "usd", stripe_payment_intent_id: s.pi, stripe_charge_id: s.ch, stripe_transfer_id: s.tr,
      stripe_refund_id: null, retention_category: "financial_record",
    });
    expect(new Date(row.payment_created_at).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(row.deidentified_at).toBeTruthy();
    // Nothing in the row leads back to her.
    const text = JSON.stringify(row);
    for (const v of [s.athleteId, s.dealId, s.paymentId, s.acct, s.email, "private"]) expect(text).not.toContain(v);
    for (const col of ["athlete_id", "deal_id", "installment_id", "destination_account_id", "brand_email", "metadata", "failure_reason"]) expect(row).not.toHaveProperty(col);

    expect(rows(await db.execute(sql`SELECT id FROM payments WHERE id = ${s.paymentId}::uuid`))).toHaveLength(0);
  }, 120_000);

  it("a canceled payment with no charge leaves no ledger row", async () => {
    const s = await athleteWithPayment("canceled", { charged: false });
    const res = await deleteAthleteAccount(s.athleteId, deps);
    expect(res!.financial_records.ledger_rows).toBe(0);
    expect(rows(await db.execute(sql`SELECT id FROM financial_ledger_records WHERE stripe_payment_intent_id = ${s.pi}`))).toHaveLength(0);
    expect(rows(await db.execute(sql`SELECT id FROM payments WHERE id = ${s.paymentId}::uuid`))).toHaveLength(0);
  }, 120_000);

  it("the in-flight refusal still stands: a funded payment blocks deletion and writes no ledger row", async () => {
    const s = await athleteWithPayment("funded", { charged: true });
    await expect(deleteAthleteAccount(s.athleteId, deps)).rejects.toMatchObject({ code: "PAYMENTS_IN_FLIGHT" });
    expect(rows(await db.execute(sql`SELECT id FROM financial_ledger_records WHERE stripe_payment_intent_id = ${s.pi}`))).toHaveLength(0);
  }, 120_000);

  it("minimizes her payment_events payloads and leaves another athlete's untouched", async () => {
    const her = await athleteWithPayment("refunded", { charged: true });
    const him = await athleteWithPayment("settled", { charged: true });
    await stripeEvent("evt_her_pi", her);
    await stripeEvent("evt_her_acct", her, "account.updated", {
      id: her.acct, object: "account", email: her.email, business_profile: { name: "Her Name" }, created: 1790000001,
    });
    await stripeEvent("evt_his_pi", him);
    const hisBefore = await eventPayload("evt_his_pi");

    const res = await deleteAthleteAccount(her.athleteId, deps);
    expect(res!.financial_records).toEqual({ ledger_rows: 1, events_minimized: 2 });

    expect(await eventPayload("evt_her_pi")).toEqual({ data: { object: {
      id: her.pi, object: "payment_intent", amount: 113200, amount_received: 113200, currency: "usd", status: "succeeded", created: 1790000000,
    } } });
    // data.object IS her Connect account: its id goes too.
    expect(await eventPayload("evt_her_acct")).toEqual({ data: { object: { object: "account", created: 1790000001 } } });
    const [ev] = rows(await db.execute(sql`SELECT id, type FROM payment_events WHERE id = 'evt_her_pi'`));
    expect(ev).toEqual({ id: "evt_her_pi", type: "payment_intent.succeeded" });
    for (const id of ["evt_her_pi", "evt_her_acct"]) {
      const text = JSON.stringify(await eventPayload(id));
      for (const v of [her.athleteId, her.dealId, her.paymentId, her.acct, her.email, "Brand Buyer", "Her Name"]) expect(text).not.toContain(v);
    }

    expect(await eventPayload("evt_his_pi")).toEqual(hisBefore);
  }, 120_000);
});

describe("minimizePaymentEventPayload", () => {
  it("keeps only whitelisted primitives under data.object", () => {
    expect(minimizePaymentEventPayload({ data: { object: { id: "re_1", object: "refund", amount_refunded: 5, currency: "usd", metadata: { a: 1 }, status: "succeeded", email: "x@y" } } }))
      .toEqual({ data: { object: { id: "re_1", object: "refund", amount_refunded: 5, currency: "usd", status: "succeeded" } } });
    expect(minimizePaymentEventPayload(null)).toEqual({ data: { object: {} } });
  });
});

describe("financial_record retention period", () => {
  it("is null when unset (TBD), a whole number of days when set, and throws on anything else", () => {
    expect(financialRecordRetentionDays({})).toBeNull();
    expect(financialRecordRetentionDays({ FINANCIAL_RECORD_RETENTION_DAYS: "" })).toBeNull();
    expect(financialRecordRetentionDays({ FINANCIAL_RECORD_RETENTION_DAYS: "30" })).toBe(30);
    for (const bad of ["0", "-1", "7.5", "seven"]) expect(() => financialRecordRetentionDays({ FINANCIAL_RECORD_RETENTION_DAYS: bad })).toThrow();
  });

  it("the purge refuses while the period is unset and deletes nothing", async () => {
    await db.execute(sql`INSERT INTO financial_ledger_records (kind, status, currency, deidentified_at) VALUES ('deposit', 'released', 'usd', now() - interval '9999 days')`);
    const before = Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n);
    await expect(purgeExpiredFinancialRecords(db, { retentionDays: null, apply: true })).rejects.toBeInstanceOf(RetentionPeriodUnset);
    expect(Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n)).toBe(before);
  }, 60_000);

  it("when set, a dry run only counts, and --apply deletes only rows older than the period", async () => {
    await db.execute(sql`DELETE FROM financial_ledger_records`);
    await db.execute(sql`DELETE FROM payment_events`);
    await db.execute(sql`INSERT INTO financial_ledger_records (kind, status, currency, deidentified_at) VALUES
      ('deal_payment', 'settled', 'usd', now() - interval '40 days'), ('deal_payment', 'settled', 'usd', now() - interval '10 days')`);
    await db.execute(sql`INSERT INTO payment_events (id, type, payload, received_at) VALUES
      ('evt_old', 'charge.refunded', '{}'::jsonb, now() - interval '40 days'), ('evt_new', 'charge.refunded', '{}'::jsonb, now() - interval '10 days')`);

    const dry = await purgeExpiredFinancialRecords(db, { retentionDays: 30, apply: false });
    expect(dry).toMatchObject({ ledger_records: 1, payment_events: 1 });
    expect(Number(rows(await db.execute(sql`SELECT count(*)::int AS n FROM financial_ledger_records`))[0].n)).toBe(2);

    const applied = await purgeExpiredFinancialRecords(db, { retentionDays: 30, apply: true });
    expect(applied).toMatchObject({ ledger_records: 1, payment_events: 1 });
    expect(rows(await db.execute(sql`SELECT status FROM financial_ledger_records`))).toHaveLength(1);
    expect(rows(await db.execute(sql`SELECT id FROM payment_events`)).map((r) => r.id)).toEqual(["evt_new"]);
  }, 60_000);
});
