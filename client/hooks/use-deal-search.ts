// All deals and All bookings (deals design §5c "All deals", §7b (b)): the search behind the header's search icon.
//
//   GET /api/v1/me/deals/search?q=&tab=active|done|closed&type=&limit=     → useDealSearch()
//   GET /api/v1/me/bookings/search?q=&tab=active|done|closed&format=&limit= → useBookingSearch()
//
// Both answer 404 while the server's DEALS_SEARCH is off (and bookings while BOOKINGS is off for her): read as `null`,
// so the screen says search isn't on yet instead of an error. Rows carry derived fields only — never email text, never
// a buyer's contact details.
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { DealType } from "../../shared/deals";

export type SearchTab = "active" | "done" | "closed";

export interface DealSearchRow {
  opportunity_id: string;
  brand: { id: number | null; name: string; logo_url: string | null; safe_logo_url: string | null; logo_none?: boolean; domain?: string | null; is_person: boolean; research_confirmed: boolean };
  via: string | null;
  dealType: DealType | null;
  type_label: string | null;
  money: string;
  ask: string | null;
  status_label: string;
  tab: SearchTab;
  closed_group: "not_a_deal" | "declined" | "expired" | null;
  last_activity_at: string | null;
  closed_at: string | null;
}

export interface DealSearchResult {
  q: string;
  tab: SearchTab;
  type: DealType | null;
  tabs: Record<SearchTab, number>;
  types: Array<{ type: DealType | "other"; label: string; count: number }>;
  not_a_deal: number;
  total: number;
  rows: DealSearchRow[];
}

export interface BookingSearchRow {
  id: string;
  title: string;
  format: string;
  format_label: string;
  buyer: string;
  starts_at: string | null;
  duration_minutes: number;
  price_cents: number;
  currency: string;
  status: string;
  status_label: string;
  tab: SearchTab;
  updated_at: string;
}

export interface BookingSearchResult {
  q: string;
  tab: SearchTab;
  tabs: Record<SearchTab, number>;
  formats: Array<{ format: string; label: string; count: number }>;
  total: number;
  rows: BookingSearchRow[];
}

export const DEAL_SEARCH_KEY = "/api/v1/me/deals/search";
export const BOOKING_SEARCH_KEY = "/api/v1/me/bookings/search";
export const SEARCH_LIMIT = 50;

/** The query string, in a fixed order so the cache key is stable. Pure. */
export function searchPath(base: string, p: { q: string; tab: SearchTab; filter?: string | null; filterKey: "type" | "format"; limit?: number }): string {
  const parts = [`q=${encodeURIComponent(p.q.trim())}`, `tab=${p.tab}`];
  if (p.filter) parts.push(`${p.filterKey}=${encodeURIComponent(p.filter)}`);
  parts.push(`limit=${p.limit ?? SEARCH_LIMIT}`);
  return `${base}?${parts.join("&")}`;
}

async function readOrNull<T>(path: string): Promise<T | null> {
  try {
    return (await (await apiRequest("GET", path)).json()) as T;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("404")) return null;
    throw e;
  }
}

export function useDealSearch(q: string, tab: SearchTab, type: string | null, enabled = true) {
  const path = searchPath(DEAL_SEARCH_KEY, { q, tab, filter: type, filterKey: "type" });
  return useQuery<DealSearchResult | null>({
    // The URL string first, so the shared deal-query list (lib/dealQueryKeys) refreshes it after any deal action.
    queryKey: [path],
    queryFn: () => readOrNull<DealSearchResult>(path),
    enabled,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

export function useBookingSearch(q: string, tab: SearchTab, format: string | null, enabled = true) {
  const path = searchPath(BOOKING_SEARCH_KEY, { q, tab, filter: format, filterKey: "format" });
  return useQuery<BookingSearchResult | null>({
    queryKey: [path],
    queryFn: () => readOrNull<BookingSearchResult>(path),
    enabled,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}
