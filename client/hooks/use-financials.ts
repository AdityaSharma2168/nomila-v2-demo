// Her money and her bookings at a glance (app layout B), read-only:
//
//   GET /api/v1/me/financials         → useFinancials()        the Opportunities money strip + the Financials screen
//   GET /api/v1/me/bookings/summary   → useBookingsSummary()   whether the Bookings section shows, her requests
//   POST /api/v1/me/connect/onboard   → startPayoutSetup()     her tap on "Set up payouts": a hosted Stripe link
//
// The shapes are shared with the server (shared/meSummaries.ts). A server without these routes answers 404, read as
// "nothing yet" (no money, no bookings) so Opportunities stays exactly as it was.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { BookingsSummary, FinancialSummary } from "../../shared/meSummaries";

export const FINANCIALS_KEY = ["me", "financials"] as const;
export const BOOKINGS_SUMMARY_KEY = ["me", "bookings", "summary"] as const;

const notMounted = (e: unknown) => e instanceof Error && e.message.startsWith("404");

export const NO_MONEY: FinancialSummary = {
  version: "financials/0.1", hasMoney: false, currency: "usd", comingCents: 0, paidMonthCents: 0, paidYearCents: 0,
  payouts: { upcoming: [], paid: [] }, holds: [], refunds: { countYear: 0, cents: 0, items: [] },
  account: { state: "none", payoutsEnabled: false, detailsSubmitted: false, requirementsDue: 0 },
};
export const NO_BOOKINGS: BookingsSummary = { version: "bookings-summary/0.1", published: false, publishedOffers: 0, requests: [], upcoming: [] };

async function read<T>(route: string, empty: T): Promise<T> {
  try {
    return (await (await apiRequest("GET", route)).json()) as T;
  } catch (e) {
    if (notMounted(e)) return empty;
    throw e;
  }
}

export function useFinancials(enabled = true) {
  return useQuery<FinancialSummary>({ queryKey: FINANCIALS_KEY, queryFn: () => read("/api/v1/me/financials", NO_MONEY), enabled, staleTime: 15_000 });
}

export function useBookingsSummary(enabled = true) {
  return useQuery<BookingsSummary>({ queryKey: BOOKINGS_SUMMARY_KEY, queryFn: () => read("/api/v1/me/bookings/summary", NO_BOOKINGS), enabled, staleTime: 15_000 });
}

/** Her tap: get-or-create her payout account and return Stripe's hosted onboarding link (moves no money). */
export async function startPayoutSetup(): Promise<string> {
  const body = (await (await apiRequest("POST", "/api/v1/me/connect/onboard")).json()) as { url?: string };
  if (!body.url) throw new Error("no onboarding link");
  return body.url;
}
