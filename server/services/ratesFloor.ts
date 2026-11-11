/**
 * services/ratesFloor.ts — her minimum for one kind of work: THE one floor key (deals design §5c, D9). No I/O and no
 * imports beyond shared/deals, so the qualification check, the draft, the deal read and Your rates all call the same
 * function without pulling the bookings or database layers in.
 *
 * The key is the rate type (shared/deals floorKeyOf decides which); the number is read by shared/deals readFloor: the
 * rate type's own key in deal_preferences.minimum_rates first, then its LEGACY_FLOOR_KEY (the older per-kind key she
 * set on the earlier Rates screen). `source` says which, so Your rates can label an inherited minimum. Never a
 * computed or suggested number; a booking rate type is a public price, never a minimum.
 */
import { readFloor, type RateType } from "../../shared/deals";

export interface Minimum { value: number; source: "set" | "earlier" }

export function minimumFor(minimumRates: Record<string, unknown> | null | undefined, rateType: RateType | null): Minimum | null {
  if (!rateType) return null;
  const value = readFloor(minimumRates, rateType);
  if (value == null) return null;
  const own = readFloor({ [rateType]: minimumRates?.[rateType] }, rateType);
  return { value, source: own != null ? "set" : "earlier" };
}
