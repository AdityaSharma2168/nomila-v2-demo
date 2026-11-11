// "Your rates" on Me (deals design §5c; D9): GET / PUT /api/v1/me/rates (server/services/rates.ts, RATES_V1).
//
// One row per rate type: Mila's suggested range (stored, with its confidence and what it is based on), her PRIVATE deal
// minimum, or — on a booking row — her PUBLIC price and the guard when that price sits under her deal minimum. A 404
// (RATES_V1 off) reads as `null`: the screen says the rates aren't ready yet. Minimums are hers: shown only to her,
// never sent to a brand.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { invalidateDealQueries } from "../lib/dealQueryKeys";
import type { RateType } from "../../shared/deals";

export type RateGroup = "content" | "time" | "booking";

export interface RateRow {
  rate_type: RateType;
  group: RateGroup;
  label: string;
  suggested: { low: number; high: number; currency: string; confidence: string; drivers: string[]; based_on: string; source: string; shown_at: string } | null;
  minimum: { value: number; source: "set" | "earlier" } | null;
  price: { cents: number; offer_id: string; duration_minutes: number; status: string } | null;
  guard: { below_minimum: true; minimum: number; against: RateType; compared: "per_hour" | "per_session"; line: string } | null;
}

export interface RatesView {
  rows: RateRow[];
  bookings_enabled: boolean;
  note: string;
}

export interface RatesWrite {
  minimums?: Partial<Record<RateType, number | null>>;
  prices?: Partial<Record<RateType, number>>;
}

export type RatesProblem = { rate_type: string; field: "minimum" | "price"; problem: string };

export const RATES_KEY = "/api/v1/me/rates";

export function useRates() {
  return useQuery<RatesView | null>({
    queryKey: [RATES_KEY],
    queryFn: async () => {
      try { return (await (await apiRequest("GET", RATES_KEY)).json()) as RatesView; }
      catch (e) { if (e instanceof Error && e.message.startsWith("404")) return null; throw e; }
    },
  });
}

/** The server's "400: {…problems}" as rows, so the screen can mark each one. Pure. */
export function ratesProblems(err: unknown): RatesProblem[] {
  const m = /^400: ([\s\S]*)$/.exec((err as Error)?.message ?? "");
  if (!m) return [];
  try { const body = JSON.parse(m[1]); return Array.isArray(body?.problems) ? body.problems : []; } catch { return []; }
}

export function useSaveRates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RatesWrite) => (await (await apiRequest("PUT", RATES_KEY, body)).json()) as RatesView,
    onSuccess: (view) => {
      qc.setQueryData([RATES_KEY], view);
      // Her minimum changes every Money line ("above / below your minimum"), and a price changes her booking offers.
      void invalidateDealQueries(qc);
      void qc.invalidateQueries({ queryKey: ["me", "bookings"] });
    },
  });
}
