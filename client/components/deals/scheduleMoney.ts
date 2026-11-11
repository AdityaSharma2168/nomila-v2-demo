/**
 * scheduleMoney — how a deal with a SCHEDULE is written on screen.
 *
 * Its own module rather than a helper inside DealCard because it is pure, it is read by
 * both the card and Deal Detail, and a string this consequential deserves tests — which a
 * .tsx file cannot easily give it here.
 *
 * LEADS WITH THE YEAR, not the total. Every other system in this app reasons annually or
 * per-unit: the score grid annualises against her projected annual value, the negotiate
 * composer works in per-deal rates, escrow charges one figure. A card leading with a
 * four-year total would put a number on screen that no other surface agrees with — and
 * this codebase already treats two surfaces disagreeing about one deal as a bug worth its
 * own test file (actionAgreement.test.ts). Here the disagreement would be fourfold.
 *
 * NEVER asserts a duration when the end is conditional. adidas runs to "the earlier of
 * December 31 of the second Professional Contract Year, or December 31 2028" — "4 yrs" is
 * simply false, while "through 2028" is the outer bound and is true.
 *
 * The total is carried but always labelled, because a bare "$105K" reads as this year's
 * money to anyone glancing at a list.
 */

export interface ScheduleMoneyInput {
  /** True when a figure exists but we could not establish it — see dealValue. */
  acvUnknown?: boolean;
  unknownCashPeriods?: number[];
  acvCents:   number | null;
  tcvCents:   number | null;
  termMonths: number | null;
  currentPeriod?: { ends_on: string | null } | null;
}

/** Cents to a short dollar string. Cents travel on the wire; formatting happens here. */
export function usdShort(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 1000
    ? "$" + Math.round(dollars / 1000) + "K"
    : "$" + Math.round(dollars).toLocaleString();
}

/**
 * @param compact  Drop the term total. A collapsed card in a list is read at a glance and
 *                 does not need every figure — the rate and the horizon are what let her
 *                 tell one deal from another. The total, and the named breakdown behind
 *                 it, live on the detail screen and in the review step, where there is
 *                 room to label them.
 */
export function formatScheduleMoney(
  m: ScheduleMoneyInput | null | undefined,
  opts: { compact?: boolean } = {},
): string | null {
  if (!m) return null;

  // A year we could not read is not a year worth nothing. Saying so plainly beats a
  // confident figure built on a hole — which is what printing the product credit alone
  // amounted to when the cash was unknown.
  if (m.acvUnknown) return "Amount unconfirmed — check the contract";

  const parts: string[] = [];

  // Null ACV is not zero — it means the period she is in is conditional, so there is no
  // figure we can stand behind for this year. Say nothing rather than something false.
  if (m.acvCents != null) parts.push(usdShort(m.acvCents) + "/yr");

  const endYear = m.currentPeriod?.ends_on?.slice(0, 4);
  if (endYear) parts.push("through " + endYear);

  if (!opts.compact && m.tcvCents != null && m.tcvCents !== m.acvCents) {
    parts.push(usdShort(m.tcvCents) + " total");
  }

  return parts.length ? parts.join(" · ") : null;
}

/**
 * The deal's money as the three figures the rest of the industry names.
 *
 * The card deliberately stays plain — "$30K/yr · through 2028 · $105K total" — because a
 * list is read at a glance. This is the detail view, where there is room to put the name
 * beside the number: a NIL athlete negotiating a second contract is better served knowing
 * that "ACV" is the figure an agent will quote at her than by never meeting the word.
 *
 * Acronym AND full name, always together. An acronym alone is jargon; the full name alone
 * does not connect to what she will hear in a negotiation.
 *
 * Returns null when there is no schedule, and omits any figure that is unknown rather than
 * printing a zero — the same rule the card follows.
 */
export interface ScheduleSummaryRow { abbr: string; name: string; value: string; note: string }

export function scheduleSummary(m: {
  acvCents: number | null; tcvCents: number | null; aavCents: number | null;
  remainingCents?: number | null; conditionalCents?: number | null;
  acvUnknown?: boolean; guaranteedCount?: number; periodCount?: number;
} | null | undefined): ScheduleSummaryRow[] {
  if (!m) return [];
  const rows: ScheduleSummaryRow[] = [];

  if (m.acvUnknown) {
    rows.push({ abbr: "ACV", name: "Annual Contract Value",
                value: "—", note: "we couldn't confirm this year's figure" });
  } else if (m.acvCents != null) {
    rows.push({ abbr: "ACV", name: "Annual Contract Value",
                value: usdShort(m.acvCents), note: "what this year is worth" });
  }

  if (m.tcvCents != null) {
    rows.push({ abbr: "TCV", name: "Total Contract Value",
                value: usdShort(m.tcvCents), note: "guaranteed across the whole term" });
  }

  // Only worth showing when it differs from ACV — on a single-year deal they are the same
  // number and printing both twice teaches nothing.
  if (m.aavCents != null && m.aavCents !== m.acvCents) {
    rows.push({ abbr: "AAV", name: "Average Annual Value",
                value: usdShort(m.aavCents), note: "how it compares to a one-year deal" });
  }

  if (m.remainingCents != null && m.remainingCents > 0 && m.remainingCents !== m.tcvCents) {
    rows.push({ abbr: "Left", name: "Remaining",
                value: usdShort(m.remainingCents), note: "still to come from today" });
  }

  // Named separately because it is NOT part of any figure above — money that only arrives
  // if a condition is met should never be added to a total she might rely on.
  if (m.conditionalCents != null && m.conditionalCents > 0) {
    rows.push({ abbr: "If", name: "Conditional",
                value: usdShort(m.conditionalCents), note: "only if the contract's conditions are met" });
  }

  return rows;
}
