// Your rates — the screen's rules (deals design §5c "Your rates"; D9). React-free, unit-tested.
//
//   groupsOf(rows)        Deals · content, Deals · time, Bookings · public prices (bookings only while they're on for her)
//   barOf(row, minimum)   the suggested range as a bar (grey) on a scale that also fits her minimum (the black tick)
//   suggestedLine(row)    "Suggested $350–550 · medium confidence"; a low-confidence range says it is rough
//   writeOf(edits, rows)  her edits → the PUT body: minimums in dollars (null clears), booking prices in cents
import type { RateRow, RatesWrite } from "../../hooks/use-rates";
import type { RateType } from "../../../shared/deals";

export const RATE_GROUPS: ReadonlyArray<{ key: RateRow["group"]; title: string; sub: string }> = [
  { key: "content", title: "Deals · content", sub: "Private. Never shown to a brand." },
  { key: "time",    title: "Deals · time",    sub: "Private. Never shown to a brand." },
  { key: "booking", title: "Bookings · public prices", sub: "What a buyer pays you. Shown on your page." },
];

export function groupsOf(rows: readonly RateRow[], bookingsEnabled: boolean) {
  return RATE_GROUPS
    .filter((g) => g.key !== "booking" || bookingsEnabled)
    .map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key) }))
    .filter((g) => g.rows.length > 0);
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function suggestedLine(row: Pick<RateRow, "suggested" | "minimum">): string {
  const s = row.suggested;
  if (!s) return row.minimum?.source === "earlier" ? "From your earlier settings" : "";
  const conf = s.confidence === "low" ? "low confidence, a rough first pass" : `${s.confidence} confidence`;
  return `Suggested ${usd(s.low)}–${usd(s.high).replace("$", "")} · ${conf}`;
}

/** The note at the top: the server's when Mila has suggested anything, else a plain line that she hasn't yet. Pure. */
export function ratesNote(rows: readonly Pick<RateRow, "suggested">[], note: string): string {
  return rows.some((r) => r.suggested)
    ? note
    : "Mila hasn't suggested rates for you yet. Set your minimums here: they stay private, never shown to a brand.";
}

/** "$1,000" for a whole-dollar input value, as typed text. Pure. */
export function withCommas(text: string): string {
  const raw = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return text;
  const [whole, cents] = raw.split(".");
  return Number(whole).toLocaleString("en-US") + (cents !== undefined ? `.${cents}` : "");
}

/** The bar: where the range sits (0–1) and where her minimum's tick sits, on one scale. Null with no range. Pure. */
export function barOf(row: Pick<RateRow, "suggested">, minimum: number | null): { from: number; to: number; tick: number | null } | null {
  const s = row.suggested;
  if (!s || !(s.high > 0)) return null;
  const top = Math.max(s.high, minimum ?? 0) * 1.2;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { from: clamp(s.low / top), to: clamp(s.high / top), tick: minimum != null && minimum > 0 ? clamp(minimum / top) : null };
}

/** "$1,200" / "1200" / "1,200.50" → 1200.5; "" → null (clear); anything else → NaN (invalid). Pure. */
export function parseDollars(text: string): number | null {
  const s = text.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  return /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0 ? Number(s) : NaN;
}

/** The value a row's input shows before she edits it. Pure. */
export function initialText(row: RateRow): string {
  if (row.group === "booking") return row.price ? withCommas(String(Math.round(row.price.cents) / 100)) : "";
  return row.minimum ? withCommas(String(row.minimum.value)) : "";
}

/** Her edits (rate type → text) as the PUT body, only for rows she changed. Invalid text is a problem, not a write. Pure. */
export function writeOf(edits: Partial<Record<RateType, string>>, rows: readonly RateRow[]): { body: RatesWrite; invalid: RateType[] } {
  const body: RatesWrite = {};
  const invalid: RateType[] = [];
  for (const row of rows) {
    const text = edits[row.rate_type];
    if (text === undefined || text === initialText(row)) continue;
    const v = parseDollars(text);
    if (Number.isNaN(v as number)) { invalid.push(row.rate_type); continue; }
    if (row.group === "booking") {
      if (v == null) continue;                       // a public price is never cleared from here (the offer stays)
      (body.prices ??= {})[row.rate_type] = Math.round((v as number) * 100);
    } else {
      (body.minimums ??= {})[row.rate_type] = v == null ? null : Math.round(v as number);
    }
  }
  return { body, invalid };
}
