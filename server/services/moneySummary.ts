/**
 * moneySummary.ts — her money, read-only (app layout B: the Opportunities money strip, Financials, and the money
 * lines in Home's "What matters next").
 *
 * Built ONLY from the existing payments ledger (payments + connect_accounts, joined to her own deals / bookings for a
 * label). Nothing here calls Stripe, moves money or writes a row. Every query filters her athlete id, and every join
 * repeats it, so another athlete's payment can never lend a label or a cent.
 *
 *   upcoming   a deal or booking payment whose money is on the platform, owed to her: funded (waiting on delivery or
 *              the brand's confirmation) or disputed (in review). Her amount is deal_value_cents (her price, all of it).
 *   paid       settled: transferred to her payout account. The paid date is the row's last update (settle's write).
 *   holds      a seriousness deposit the brand put down (authorized / reauthorized): refundable, never captured.
 *   refunds    anything refunded or charged back (refunded_cents, else the whole amount on a refunded row).
 *   account    her Stripe Connect payout account as last synced (none · pending · active) — no Stripe call.
 *
 *   direct     a brand's own payment notice paying her (a remittance / payment advice, skills/paperwork
 *              `payment_received` with a stated amount): money paid to her outside the platform, listed with paid.
 *
 * "Money exists" (hasMoney) = at least one of the four lists has a row. Before that the strip and Financials stay
 * hidden and Home shows no money line.
 */
import { and, desc, eq, inArray, or, gt, sql } from "drizzle-orm";
import { db } from "../db";
import { bookings, connectAccounts, deals, inboxBrands, inboxThreads, payments } from "../../shared/schema";
import { readPaperwork } from "../skills/paperwork";
import type { FinancialSummary, MoneyLine, MoneySource, PayoutAccountState, UpcomingStage } from "../../shared/meSummaries";
import type { AgentWinPayment } from "../../shared/plan";

export const UPCOMING_STATUSES = ["funded", "disputed"] as const;
export const PAID_STATUS = "settled";
export const HOLD_STATUSES = ["authorized", "reauthorized"] as const;
export const REFUND_STATUSES = ["refunded", "charged_back"] as const;
const EARNING_KINDS = ["deal_payment", "booking_payment"] as const;
/** How many rows each list carries (the totals are summed over every row, not just these). */
const LIST_CAP = 25;

export type { FinancialSummary, MoneyLine, MoneySource, PayoutAccountState, UpcomingStage } from "../../shared/meSummaries";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const cents = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

type Row = {
  id: string; kind: string; status: string; deal_id: string | null; booking_id: string | null;
  deal_value_cents: number | null; brand_total_cents: number | null; refunded_cents: number | null; currency: string;
  athlete_confirmed_at: Date | null; delivery_window_ends_at: Date | null; refunded_at: Date | null;
  created_at: Date | null; updated_at: Date | null;
};

/** Her payments that carry money (or a hold or a refund), newest first. Pending / failed / canceled rows never count. */
async function herMoneyRows(athleteId: string, dbx: any): Promise<Row[]> {
  return dbx.select({
    id: payments.id, kind: payments.kind, status: payments.status, deal_id: payments.deal_id, booking_id: payments.booking_id,
    deal_value_cents: payments.deal_value_cents, brand_total_cents: payments.brand_total_cents, refunded_cents: payments.refunded_cents,
    currency: payments.currency, athlete_confirmed_at: payments.athlete_confirmed_at, delivery_window_ends_at: payments.delivery_window_ends_at,
    refunded_at: payments.refunded_at, created_at: payments.created_at, updated_at: payments.updated_at,
  }).from(payments).where(and(
    eq(payments.athlete_id, athleteId),
    or(
      inArray(payments.status, [...UPCOMING_STATUSES, PAID_STATUS, ...HOLD_STATUSES, ...REFUND_STATUSES]),
      gt(payments.refunded_cents, 0),
    ),
  )).orderBy(desc(payments.updated_at));
}

/** Payments brands made to her directly, from their payment notices (paperwork markers with an amount), newest first. */
async function directPayments(athleteId: string, dbx: any): Promise<Array<{ threadId: string; dealId: string | null; label: string; cents: number; currency: string; at: Date | null }>> {
  const rows = await dbx.select({ id: inboxThreads.id, classification: inboxThreads.classification, brand: inboxBrands.name })
    .from(inboxThreads)
    .leftJoin(inboxBrands, eq(inboxBrands.id, inboxThreads.brand_id))
    .where(and(
      eq(inboxThreads.athlete_id, athleteId),
      sql`${inboxThreads.classification} -> 'paperwork' ->> 'event' = 'payment_received'`,
    ));
  const out = [];
  for (const r of rows) {
    const pw = readPaperwork(r.classification) as (ReturnType<typeof readPaperwork> & { amount_cents?: number; currency?: string; paid_at?: string }) | null;
    if (!pw || pw.amount_cents == null || pw.amount_cents <= 0) continue;
    out.push({ threadId: r.id, dealId: pw.deal_id ?? null, label: r.brand ?? "", cents: pw.amount_cents, currency: pw.currency ?? "usd", at: pw.paid_at ? new Date(pw.paid_at) : null });
  }
  return out.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}

/**
 * Brands' direct payments to her paid on or after `since` (Home v3's Wins: "{Brand} paid you $X"), newest first. Read
 * from the same payment notices as Financials' "Paid by them directly" — one source for both.
 */
export async function recentDirectPayments(athleteId: string, since: Date, dbx: any = db): Promise<AgentWinPayment[]> {
  return (await directPayments(athleteId, dbx))
    .filter((p) => p.at && p.at.getTime() >= since.getTime())
    .map((p) => ({ id: p.threadId, at: p.at!.toISOString(), brand: p.label, cents: p.cents, currency: p.currency, dealId: p.dealId }));
}

/** Labels for the rows: her deals' brand names and her bookings' titles, each read within her own rows. */
async function labelsFor(athleteId: string, rows: Row[], dbx: any): Promise<{ deal: Map<string, string>; booking: Map<string, string> }> {
  const dealIds = [...new Set(rows.map((r) => r.deal_id).filter((x): x is string => !!x))];
  const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((x): x is string => !!x))];
  const deal = new Map<string, string>();
  const booking = new Map<string, string>();
  if (dealIds.length) {
    const ds = await dbx.select({ id: deals.id, name: deals.brand_name }).from(deals).where(and(eq(deals.athlete_id, athleteId), inArray(deals.id, dealIds)));
    for (const d of ds) deal.set(d.id, d.name);
  }
  if (bookingIds.length) {
    const bs = await dbx.select({ id: bookings.id, title: bookings.title }).from(bookings).where(and(eq(bookings.athlete_id, athleteId), inArray(bookings.id, bookingIds)));
    for (const b of bs) booking.set(b.id, b.title);
  }
  return { deal, booking };
}

function stageOf(r: Row): UpcomingStage {
  if (r.status === "disputed") return "in_review";
  if (r.kind === "booking_payment") return "after_booking";
  return r.athlete_confirmed_at ? "awaiting_confirmation" : "awaiting_delivery";
}

/** Her money, summed and listed. `now` sets the month and year the paid totals cover (UTC). */
export async function readFinancialSummary(athleteId: string, now: Date = new Date(), dbx: any = db): Promise<FinancialSummary> {
  const [rows, accountRows, direct] = await Promise.all([
    herMoneyRows(athleteId, dbx),
    dbx.select({ payouts_enabled: connectAccounts.payouts_enabled, transfers_active: connectAccounts.transfers_active, details_submitted: connectAccounts.details_submitted, requirements_due: connectAccounts.requirements_due })
      .from(connectAccounts).where(eq(connectAccounts.athlete_id, athleteId)).limit(1),
    directPayments(athleteId, dbx),
  ]);
  const labels = await labelsFor(athleteId, rows, dbx);
  const line = (r: Row, amountCents: number, at: Date | null, stage?: UpcomingStage): MoneyLine => {
    const source: MoneySource = r.booking_id ? "booking" : "deal";
    const label = (source === "booking" ? labels.booking.get(r.booking_id!) : labels.deal.get(r.deal_id ?? "")) ?? "";
    return { id: r.id, source, label, dealId: r.deal_id, bookingId: r.booking_id, amountCents, currency: r.currency, at: iso(at), ...(stage ? { stage } : {}) };
  };

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const upcoming: MoneyLine[] = [];
  const paid: MoneyLine[] = [];
  const holds: MoneyLine[] = [];
  const refunds: MoneyLine[] = [];
  let comingCents = 0, paidMonthCents = 0, paidYearCents = 0, refundCents = 0, refundCountYear = 0;

  for (const r of rows) {
    const earning = (EARNING_KINDS as readonly string[]).includes(r.kind);
    if (earning && (UPCOMING_STATUSES as readonly string[]).includes(r.status)) {
      const amt = cents(r.deal_value_cents);
      comingCents += amt;
      upcoming.push(line(r, amt, r.delivery_window_ends_at, stageOf(r)));
    } else if (earning && r.status === PAID_STATUS) {
      const amt = cents(r.deal_value_cents);
      const at = r.updated_at ?? r.created_at;
      if (at && at >= monthStart) paidMonthCents += amt;
      if (at && at >= yearStart) paidYearCents += amt;
      paid.push(line(r, amt, at));
    } else if (r.kind === "deposit" && (HOLD_STATUSES as readonly string[]).includes(r.status)) {
      holds.push(line(r, cents(r.brand_total_cents), r.created_at));
    }
    const refunded = cents(r.refunded_cents) || ((REFUND_STATUSES as readonly string[]).includes(r.status) ? cents(r.brand_total_cents) : 0);
    if (refunded > 0) {
      const at = r.refunded_at ?? r.updated_at;
      refundCents += refunded;
      if (at && at >= yearStart) refundCountYear += 1;
      refunds.push(line(r, refunded, at));
    }
  }

  // Paid directly by the brand: counted in the summary's currency only (a figure in another currency is not added up).
  const currency = rows[0]?.currency ?? "usd";
  for (const d of direct) {
    if (d.currency !== currency) continue;
    if (d.at && d.at >= monthStart) paidMonthCents += d.cents;
    if (d.at && d.at >= yearStart) paidYearCents += d.cents;
    paid.push({ id: d.threadId, source: "deal", label: d.label, dealId: d.dealId, bookingId: null, amountCents: d.cents, currency, at: iso(d.at), direct: true });
  }
  paid.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));

  const acct = accountRows[0] as { payouts_enabled: boolean; transfers_active: boolean; details_submitted: boolean; requirements_due: unknown } | undefined;
  const due = Array.isArray(acct?.requirements_due) ? (acct!.requirements_due as unknown[]).length : 0;
  const state: PayoutAccountState = !acct ? "none" : acct.payouts_enabled && acct.transfers_active ? "active" : "pending";

  return {
    version: "financials/0.1",
    hasMoney: upcoming.length + paid.length + holds.length + refunds.length > 0,
    currency,
    comingCents, paidMonthCents, paidYearCents,
    payouts: { upcoming: upcoming.slice(0, LIST_CAP), paid: paid.slice(0, LIST_CAP) },
    holds: holds.slice(0, LIST_CAP),
    refunds: { countYear: refundCountYear, cents: refundCents, items: refunds.slice(0, LIST_CAP) },
    account: { state, payoutsEnabled: !!acct?.payouts_enabled, detailsSubmitted: !!acct?.details_submitted, requirementsDue: due },
  };
}
