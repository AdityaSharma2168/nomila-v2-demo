// All deals / All bookings — the search screen's words (deals design §7b (b)). React-free, unit-tested.
import type { BookingSearchRow, DealSearchResult, DealSearchRow, SearchTab } from "../../hooks/use-deal-search";

export const SEARCH_TABS: ReadonlyArray<{ key: SearchTab; label: string }> = [
  { key: "active", label: "Active" },
  { key: "done",   label: "Done" },
  { key: "closed", label: "Closed" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 30" (UTC calendar day), or null. Pure. */
export function shortDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The row's status line: "Needs terms · Sep 30" — where it stands and the last activity (or when it closed). Pure. */
export function dealRowStatus(r: Pick<DealSearchRow, "status_label" | "last_activity_at" | "closed_at" | "tab">): string {
  const day = shortDay(r.tab === "active" ? r.last_activity_at : r.closed_at ?? r.last_activity_at);
  return day ? `${r.status_label} · ${day}` : r.status_label;
}

/** The row's logo source: the brand's logo once research is confirmed, else its own-domain logo; never a guess. Pure. */
export function dealRowLogo(r: Pick<DealSearchRow, "brand">): { logoUrl: string | null; domain: string | null } {
  if (r.brand.logo_none) return { logoUrl: null, domain: null };
  const logoUrl = (r.brand.research_confirmed ? r.brand.logo_url ?? r.brand.safe_logo_url : r.brand.safe_logo_url) ?? null;
  return { logoUrl, domain: r.brand.domain ?? null };
}

/** Under the Active list: "Plus 7 under Closed, 5 of them filed as “Not a deal”." — so nothing ever looks lost. Pure. */
export function closedHint(res: Pick<DealSearchResult, "tab" | "tabs">, notADeal: number | null): string | null {
  if (res.tab !== "active" || !res.tabs.closed) return null;
  const base = `Plus ${res.tabs.closed} under Closed`;
  return notADeal ? `${base}, ${notADeal} of them filed as “Not a deal”.` : `${base}.`;
}

/** "Showing 50 of 212" when the server capped the rows. Pure. */
export function cappedLine(total: number, shown: number): string | null {
  return total > shown ? `Showing the newest ${shown} of ${total}. Search to narrow them.` : null;
}

/** Filed mail only (Closed → "Not a deal"). Pure. */
export function onlyNotADeal(rows: readonly DealSearchRow[]): DealSearchRow[] {
  return rows.filter((r) => r.closed_group === "not_a_deal");
}

const money = (cents: number, currency: string) => {
  const sym = currency.toLowerCase() === "usd" ? "$" : "";
  const n = cents / 100;
  return `${sym}${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2)}${sym ? "" : ` ${currency.toUpperCase()}`}`;
};

/** A booking row's line: "Video call · 30 min · Sat Oct 18 · $60". Pure. */
export function bookingRowLine(r: Pick<BookingSearchRow, "format_label" | "duration_minutes" | "starts_at" | "price_cents" | "currency">): string {
  const parts = [r.format_label];
  if (r.duration_minutes) parts.push(`${r.duration_minutes} min`);
  const day = shortDay(r.starts_at);
  if (day) parts.push(day);
  parts.push(money(r.price_cents, r.currency));
  return parts.join(" · ");
}
