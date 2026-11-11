/**
 * financialRecords.ts — what account deletion keeps of her money, and for how long.
 *
 * Product decision (#803): deleting the account deletes her payments, but Nomila may have to keep a record of money
 * that moved for its own accounting / legal obligations. So, in one short transaction of the delete (phase 2's financial_records step, exactly once) and BEFORE payments go:
 *
 *   1. Each of her payments in which money moved or was held leaves ONE financial_ledger_records row: kind, status,
 *      amounts (incl. what was refunded), currency, the Stripe ids incl. refund / transfer reversal / chargeback (to reconcile against Stripe, the system of record) and when the payment was
 *      created. No athlete, deal, installment, Connect account, brand email, metadata or failure reason, no FK.
 *   2. Every payment_events row (the Stripe webhook ledger) whose payload names her — her athlete id, her deal or
 *      payment ids, the Stripe ids on her payments, her Connect account — keeps its id and type columns, and its
 *      payload is cut down to data.object { id, object, amount, amount_received, amount_refunded, currency, status,
 *      created }. That drops Connect account details, billing details, emails and metadata. When data.object IS her
 *      Connect account (account.updated), its id is dropped too.
 *
 * Both carry the retention category `financial_record`. The period is FINANCIAL_RECORD_RETENTION_DAYS — TBD pending
 * counsel/accountant confirmation, deliberately not hard-coded. Unset means "not decided": nothing is purged, and
 * server/scripts/privacy/purgeExpiredFinancialRecords.ts refuses to run.
 */

import { sql, type SQL } from "drizzle-orm";
import { rowsOf, type Executor } from "../../services/privacy/athleteScope";

/** The retention category shared by financial_ledger_records and payment_events. */
export const FINANCIAL_RECORD = "financial_record" as const;

/**
 * The financial_record retention period in days, from FINANCIAL_RECORD_RETENTION_DAYS. TBD pending
 * counsel/accountant confirmation: null when unset (no period decided — nothing may be purged). A value that is not
 * a positive whole number throws, so a typo can never purge early.
 */
export function financialRecordRetentionDays(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.FINANCIAL_RECORD_RETENTION_DAYS?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`FINANCIAL_RECORD_RETENTION_DAYS must be a positive whole number of days (got "${raw}")`);
  return Number(raw);
}

/**
 * Payment statuses that leave a ledger row: money was captured (funded, settled, refunded, disputed, charged_back) or a hold was
 * placed on the brand's card (authorized, reauthorized, released). authorized / reauthorized / funded / disputed
 * also BLOCK deletion (PAYMENT_STATES_IN_FLIGHT), so they are listed only for completeness. `released` is an
 * uncaptured deposit hold that was cancelled — kept conservatively, since a hold did hit the brand's card.
 * pending / requires_action / canceled / expired / failed leave none — unless a Stripe charge id is recorded on the
 * row, which means a charge existed whatever the status says (the conservative catch-all).
 */
export const LEDGER_STATUSES = ["authorized", "reauthorized", "funded", "settled", "released", "refunded", "disputed", "charged_back"] as const;

/** The only payload keys kept on a payment_events row that named her (all under data.object). */
export const PAYMENT_EVENT_PAYLOAD_KEYS = ["id", "object", "amount", "amount_received", "amount_refunded", "currency", "status", "created"] as const;

/** Cut a Stripe event payload down to the whitelist. `dropIds`: ids that may not survive as data.object.id. */
export function minimizePaymentEventPayload(payload: unknown, dropIds: ReadonlySet<string> = new Set()): { data: { object: Record<string, string | number | boolean> } } {
  const src = (payload as any)?.data?.object;
  const object: Record<string, string | number | boolean> = {};
  if (src && typeof src === "object") {
    for (const k of PAYMENT_EVENT_PAYLOAD_KEYS) {
      const v = src[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") object[k] = v;
    }
  }
  if (typeof object.id === "string" && dropIds.has(object.id)) delete object.id;
  return { data: { object } };
}

/** Everything in a payment_events payload that would name her. Read before her rows are deleted. */
export interface HerFinancialIdentifiers {
  /** Her athlete id, deal ids and payment ids, and every Stripe id on her payments. */
  tokens: string[];
  /** Her Stripe Connect account ids (connect_accounts + payments.destination_account_id). */
  connectAccountIds: string[];
  /** Brand emails captured on her payments. */
  brandEmails: string[];
}

export async function herFinancialIdentifiers(exec: Executor, athleteId: string): Promise<HerFinancialIdentifiers> {
  const pays = rowsOf<Record<string, string | null>>(await exec.execute(sql`
    SELECT id::text, deal_id::text, stripe_payment_intent_id, stripe_checkout_session_id, stripe_charge_id,
           stripe_transfer_id, stripe_refund_id, stripe_transfer_reversal_id, stripe_dispute_id, destination_account_id, brand_email
    FROM payments WHERE athlete_id = ${athleteId}::uuid
  `));
  const deals = rowsOf<{ id: string }>(await exec.execute(sql`SELECT id::text FROM deals WHERE athlete_id = ${athleteId}::uuid`));
  const accts = rowsOf<{ a: string }>(await exec.execute(sql`SELECT stripe_account_id AS a FROM connect_accounts WHERE athlete_id = ${athleteId}::uuid`));

  const clean = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim().length >= 6))];
  const connectAccountIds = clean([...accts.map((r) => r.a), ...pays.map((p) => p.destination_account_id)]);
  const brandEmails = clean(pays.map((p) => p.brand_email));
  const tokens = clean([
    athleteId, ...deals.map((d) => d.id),
    ...pays.flatMap((p) => [p.id, p.deal_id, p.stripe_payment_intent_id, p.stripe_checkout_session_id, p.stripe_charge_id, p.stripe_transfer_id, p.stripe_refund_id, p.stripe_transfer_reversal_id, p.stripe_dispute_id]),
  ]);
  return { tokens, connectAccountIds, brandEmails };
}

/** SQL: `col::text` contains any of `needles` (strpos, so `_` / `%` in Stripe ids are literal). */
export function textContainsAny(col: SQL, needles: string[]): SQL {
  if (!needles.length) return sql`false`;
  return sql`(${sql.join(needles.map((n) => sql`strpos(${col}::text, ${n}) > 0`), sql` OR `)})`;
}

export interface FinancialRecordResult { ledger_rows: number; events_minimized: number }

/**
 * Run inside one transaction (accountDeletionSteps.ts financialRecordsStep), before payments are deleted. Writes her ledger rows and minimizes the
 * payment_events payloads that name her. Returns counts only.
 */
export async function keepDeidentifiedFinancialRecords(tx: Executor, athleteId: string): Promise<FinancialRecordResult> {
  const ids = await herFinancialIdentifiers(tx, athleteId);

  const [ins] = rowsOf<{ n: number }>(await tx.execute(sql`
    WITH i AS (
      INSERT INTO financial_ledger_records
        (kind, status, deal_value_cents, commission_cents, processing_fee_cents, brand_total_cents, currency,
         stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, stripe_refund_id,
         refunded_cents, stripe_transfer_reversal_id, stripe_dispute_id, payment_created_at, retention_category)
      SELECT kind, status, deal_value_cents, commission_cents, processing_fee_cents, brand_total_cents, currency,
             stripe_payment_intent_id, stripe_charge_id, stripe_transfer_id, stripe_refund_id,
             refunded_cents, stripe_transfer_reversal_id, stripe_dispute_id, created_at, ${FINANCIAL_RECORD}
      FROM payments
      WHERE athlete_id = ${athleteId}::uuid
        AND (status IN (${sql.join(LEDGER_STATUSES.map((s) => sql`${s}`), sql`, `)}) OR stripe_charge_id IS NOT NULL)
      RETURNING 1
    ) SELECT count(*)::int AS n FROM i
  `));

  const needles = [...ids.tokens, ...ids.connectAccountIds, ...ids.brandEmails];
  const events = rowsOf<{ id: string; payload: unknown }>(await tx.execute(sql`
    SELECT id, payload FROM payment_events WHERE payload IS NOT NULL AND ${textContainsAny(sql`payload`, needles)}
  `));
  const dropIds = new Set(ids.connectAccountIds);
  for (const e of events) {
    const minimized = minimizePaymentEventPayload(typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload, dropIds);
    await tx.execute(sql`UPDATE payment_events SET payload = ${JSON.stringify(minimized)}::jsonb WHERE id = ${e.id}`);
  }
  return { ledger_rows: Number(ins?.n ?? 0), events_minimized: events.length };
}
