/**
 * dealValue — every money question about a deal, answered from its schedule.
 *
 * WHY NOTHING HERE IS STORED. A deal used to be one number, and one number is wrong for
 * most of the questions asked of it the moment a contract runs longer than a campaign.
 * $105,000 is the wrong answer to "what does she earn this year"; $30,000 is the wrong
 * answer to "how big is this deal"; both are wrong for "what should escrow hold".
 *
 * This codebase has already paid for the alternative. `deals.amount` is a denormalized
 * snapshot written once at detection, and it went stale badly enough that dealVoice now
 * opens with "NEVER speak deals.amount — we saw $200 on a deal whose live offer was $950",
 * and offerMoney exists so the voice resolver structurally cannot see the column. A
 * schedule makes that failure worse, not better: any single stored figure is wrong on the
 * day it is written rather than eventually. So the schedule is the source of truth and
 * every metric is derived here, once.
 *
 * CENTS THROUGHOUT. deal_periods and payments are integer cents; deals.amount is legacy
 * numeric dollars and payments/money.ts already owns that boundary. Nothing in this module
 * emits dollars.
 *
 * PURE. No database, no clock of its own, no model. The caller supplies rows and a date,
 * which is what makes every branch here testable against a real contract.
 */

/** A period row, reduced to what the arithmetic needs. Mirrors `deal_periods`. */
export interface PeriodRow {
  seq:                     number;
  label:                   string | null;
  starts_on:               string | null;   // YYYY-MM-DD
  ends_on:                 string | null;
  cash_cents:              number | null;
  product_cents:           number | null;
  /** Value she directs but never receives. NEVER counted as compensation. */
  product_directed_cents:  number | null;
  guaranteed:              boolean;
  condition:               string | null;
  superseded_at:           Date | string | null;
}

/** An installment row, reduced. Mirrors `deal_installments`. */
export interface InstallmentRow {
  period_seq:   number;
  seq:          number;
  amount_cents: number | null;
  due_on:       string | null;
  kind:         string;
}

export interface DealValue {
  /** Whether there is a schedule at all. A single-figure deal is not a lesser schedule. */
  basis:            "schedule" | "none";
  currency:         string;
  /** Total guaranteed value across the whole term: cash + compensable product. */
  tcvCents:         number | null;
  /** This contract year, guaranteed. Null when the current period is conditional or unknown. */
  acvCents:         number | null;
  /** tcv ÷ guaranteed periods — the figure that makes a long deal comparable to a short one. */
  aavCents:         number | null;
  /** Guaranteed value from today forward. What walking away would cost her. */
  remainingCents:   number | null;
  /**
   * Value whose installments were DUE on or before today.
   *
   * Deliberately not called "earned". `payments` has no settled-at timestamp — only a
   * status — so nothing in the schema knows what was actually paid. This is "should have
   * been paid by now", and labelling it otherwise would ship a lie.
   */
  scheduledToDateCents: number | null;
  /** Charitable / directed value. Shown, never summed into anything above. */
  directedCents:    number | null;
  /** Money that exists only if a condition is met — retainers, incentive years. */
  conditionalCents: number | null;
  currentPeriod:    PeriodRow | null;
  /**
   * Periods whose cash we could not establish — the reconciler nulled it because two
   * reads disagreed, or the model never produced one.
   *
   * NULL IS NOT ZERO, and treating it as zero is how a year we could not read came to
   * display as a confident figure beside real ones. Any surface showing a per-year
   * number must check this first and say it does not know.
   */
  unknownCashPeriods: number[];
  /** True when the CURRENT period's cash is unknown, so no honest ACV exists. */
  acvUnknown:       boolean;
  periodCount:      number;
  guaranteedCount:  number;
  /**
   * Whether installments add up to their periods' cash. False means the two disagree and a
   * surface should say so rather than silently preferring one.
   */
  reconciled:       boolean;
}

const sum = (ns: Array<number | null | undefined>): number =>
  ns.reduce<number>((a, b) => a + (b ?? 0), 0);

/** Live rows only — an amendment supersedes rather than overwrites. */
export function livePeriods(periods: PeriodRow[]): PeriodRow[] {
  return periods.filter((p) => p.superseded_at == null).sort((a, b) => a.seq - b.seq);
}

/** Compensation in a period: cash plus product she keeps. Directed value is not hers. */
export function periodCompensationCents(p: PeriodRow): number {
  return (p.cash_cents ?? 0) + (p.product_cents ?? 0);
}

function toDay(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * The period today falls inside. Date containment, never array position — filtering rows
 * and then indexing by elapsed years is how a conditional year two returned year three's
 * money, with no error and a right-looking number.
 */
export function currentPeriod(periods: PeriodRow[], today = new Date()): PeriodRow | null {
  const now = today.getTime();
  const live = livePeriods(periods);
  for (const p of live) {
    const a = toDay(p.starts_on);
    const b = toDay(p.ends_on);
    if (a == null || b == null) continue;
    // ends_on is inclusive: a term ending 31 Dec runs through that day.
    if (now >= a && now < b + 86_400_000) return p;
  }
  // A single undated period is unambiguous. Several are not, and guessing which one we are
  // in is exactly the error this function exists to prevent.
  return live.length === 1 ? live[0] : null;
}

export function resolveDealValue(
  periods: PeriodRow[],
  installments: InstallmentRow[] = [],
  today = new Date(),
): DealValue {
  const live = livePeriods(periods);
  if (!live.length) {
    return {
      basis: "none", currency: "usd",
      tcvCents: null, acvCents: null, aavCents: null, remainingCents: null,
      scheduledToDateCents: null, directedCents: null, conditionalCents: null,
      currentPeriod: null, unknownCashPeriods: [], acvUnknown: false,
      periodCount: 0, guaranteedCount: 0, reconciled: true,
    };
  }

  // A guaranteed period with no cash figure is a hole in the total, not a zero in it.
  const unknownCashPeriods = live
    .filter((p) => p.guaranteed && p.cash_cents == null)
    .map((p) => p.seq);

  const guaranteed  = live.filter((p) => p.guaranteed);
  const conditional = live.filter((p) => !p.guaranteed);
  // TCV is null, not a partial sum, when any guaranteed period's cash is missing. A
  // partial total is indistinguishable from a complete one on screen, and the athlete
  // would have no way to know it was short.
  const tcv = unknownCashPeriods.length ? null : sum(guaranteed.map(periodCompensationCents));

  const cur = currentPeriod(live, today);
  // A conditional current period yields null, not its figure: money contingent on a
  // condition that may not hold is not money she has this year.
  // No ACV when the current period's cash is unknown. Returning cash+product with the
  // cash silently zeroed would print the product credit alone as though it were the
  // year's pay.
  const curUnknown = !!cur && cur.guaranteed && cur.cash_cents == null;
  const acv = cur && cur.guaranteed && !curUnknown ? periodCompensationCents(cur) : null;

  const now = today.getTime();
  const remaining = sum(
    guaranteed
      .filter((p) => { const e = toDay(p.ends_on); return e == null || e + 86_400_000 > now; })
      .map(periodCompensationCents),
  );

  const bySeq = new Map(live.map((p) => [p.seq, p]));
  const dueInstallments = installments.filter((i) => {
    if (i.kind !== "scheduled") return false;          // bonuses are not scheduled money
    const p = bySeq.get(i.period_seq);
    if (!p || !p.guaranteed) return false;
    const d = toDay(i.due_on);
    return d != null && d <= now;
  });
  const scheduledToDate = installments.length ? sum(dueInstallments.map((i) => i.amount_cents)) : null;

  // Installments must add up to the cash of the periods they belong to. No CHECK enforces
  // it — the writer is a model reading a PDF — so the disagreement is REPORTED instead of
  // one side being silently preferred.
  const scheduledByPeriod = new Map<number, number>();
  for (const i of installments) {
    if (i.kind !== "scheduled") continue;
    scheduledByPeriod.set(i.period_seq, (scheduledByPeriod.get(i.period_seq) ?? 0) + (i.amount_cents ?? 0));
  }
  const reconciled = [...scheduledByPeriod.entries()].every(([seq, cents]) => {
    const p = bySeq.get(seq);
    if (!p || p.cash_cents == null) return true;        // nothing to reconcile against
    return Math.abs(p.cash_cents - cents) <= 100;       // a dollar of rounding
  });

  return {
    basis:    "schedule",
    currency: live[0] && (live[0] as any).currency ? (live[0] as any).currency : "usd",
    tcvCents: tcv,
    acvCents: acv,
    // Averaged over GUARANTEED periods only — including a conditional retainer year would
    // dilute the average with money that may never arrive.
    aavCents: tcv != null && guaranteed.length ? Math.round(tcv / guaranteed.length) : null,
    remainingCents: remaining,
    scheduledToDateCents: scheduledToDate,
    directedCents:    sum(live.map((p) => p.product_directed_cents)),
    conditionalCents: sum(conditional.map(periodCompensationCents)),
    currentPeriod:    cur,
    unknownCashPeriods,
    acvUnknown:       curUnknown,
    periodCount:      live.length,
    guaranteedCount:  guaranteed.length,
    reconciled,
  };
}

/** Months spanned by the live schedule — what the score grid needs to annualise. */
export function termMonths(periods: PeriodRow[]): number | null {
  const live = livePeriods(periods);
  const starts = live.map((p) => toDay(p.starts_on)).filter((n): n is number => n != null);
  const ends   = live.map((p) => toDay(p.ends_on)).filter((n): n is number => n != null);
  if (!starts.length || !ends.length) return null;
  const months = Math.round((Math.max(...ends) - Math.min(...starts)) / (30.44 * 86_400_000));
  return months > 0 ? months : null;
}
