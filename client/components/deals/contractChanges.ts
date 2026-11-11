/**
 * What attaching a contract will change about a deal she already has.
 *
 * WHY THIS EXISTS. Putting a contract on an existing deal overwrites its figures. The write
 * is careful — deal_periods rows are superseded rather than deleted, so a payment
 * reconciled against an old period still resolves — but the screen said nothing at all.
 * She has been looking at what her emails suggested for weeks, and the first time a
 * contract disagrees, the number would change under her with no account of why.
 *
 * UNCHANGED ROWS ARE SHOWN TOO. A contract confirming the $7,500 her emails suggested is
 * the reassuring half of the answer. Listing only the differences would leave her checking
 * the rest herself to find out what else moved quietly — which is the work this screen is
 * supposed to do for her.
 *
 * CENTS ON ONE SIDE, DOLLARS ON THE OTHER. The deal's figures come from the resolver in
 * integer cents; the form holds dollars, as text, because a half-typed number is not a
 * number yet. Comparing them in the wrong unit reports every unchanged figure as changed,
 * which would make the whole block noise. Conversion happens once, here.
 */

/** What the deal holds before this contract lands on it. Null when it holds nothing. */
export interface CurrentTerms {
  cashCents:        number | null;
  productCents:     number | null;
  termStart:        string | null;
  termEnd:          string | null;
  periodCount:      number;
  installmentCount: number;
}

/** The schedule as she has it in the form — dollars, held as text. */
export interface FormTerms {
  /** The current period's figures, in dollars. Null when she has not given one. */
  cash:        number | null;
  product:     number | null;
  termStart:   string;
  termEnd:     string;
  periodCount: number;
}

export interface ChangeRow {
  key:     string;
  /** The old value, already formatted. Null means there wasn't one — the row is an addition. */
  was:     string | null;
  /** The new value, formatted. "—" when she has left it blank. */
  now:     string;
  changed: boolean;
}

const DASH = "—";

/** Dollars as she'd write them. Not usdShort: $7,500 must not become $7.5K mid-edit. */
function dollars(n: number | null): string {
  return n == null ? DASH : `$${n.toLocaleString("en-US")}`;
}

function fromCents(c: number | null): string | null {
  return c == null ? null : dollars(Math.round(c / 100));
}

/**
 * Every row worth showing, in the order she reads them.
 *
 * Returns [] when there is nothing to replace — a first contract on a fresh deal changes
 * nothing, and a diff against an absence is just the form again.
 */
export function contractChanges(current: CurrentTerms | null, form: FormTerms): ChangeRow[] {
  if (!current) return [];

  const rows: ChangeRow[] = [];

  const moneyRow = (key: string, wasCents: number | null, nowDollars: number | null) => {
    // Both absent is not a change and not worth a row — it is a figure nobody has ever had.
    if (wasCents == null && nowDollars == null) return;
    rows.push({
      key,
      was:     fromCents(wasCents),
      now:     dollars(nowDollars),
      changed: wasCents !== (nowDollars == null ? null : Math.round(nowDollars * 100)),
    });
  };

  moneyRow("This year's cash", current.cashCents, form.cash);
  moneyRow("Product", current.productCents, form.product);

  const nowTerm = [form.termStart.trim(), form.termEnd.trim()].filter(Boolean).join(" – ");
  const wasTerm = [current.termStart, current.termEnd].filter(Boolean).join(" – ");
  if (nowTerm || wasTerm) {
    rows.push({
      key:     "Term",
      was:     wasTerm || null,
      now:     nowTerm || DASH,
      changed: nowTerm !== wasTerm,
    });
  }

  // The schedule's SHAPE, not its figures. Going from one lump sum to four dated periods is
  // the change she would most want flagged and the one least visible in the numbers.
  if (form.periodCount > 0 && form.periodCount !== current.periodCount) {
    rows.push({
      key:     form.periodCount === 1 ? "Schedule" : "Periods",
      was:     current.periodCount ? String(current.periodCount) : null,
      now:     String(form.periodCount),
      changed: true,
    });
  }

  return rows;
}
