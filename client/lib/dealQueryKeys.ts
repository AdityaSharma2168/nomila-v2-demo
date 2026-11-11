// One list of the queries that show deals, so every action that changes a deal refreshes all of them.
//
// Why this exists: the app's queries are keyed by their full URL in ONE string (`/api/v1/me/deals?view=active`,
// `/api/v1/me/opportunities/abc`), and TanStack's prefix match compares whole array elements. So
// `invalidateQueries({ queryKey: ["/api/v1/me/deals"] })` matched nothing, and with `staleTime: Infinity` the board,
// Home and the deals list kept saying "Your move" after a reply until a pull-to-refresh (audit D §3.6).
// The fix is a predicate over the first key element instead of a prefix key.
import type { QueryClient, Query } from "@tanstack/react-query";

/** URL-string keys: any query whose first key element starts with one of these shows a deal. */
export const DEAL_URL_PREFIXES = [
  "/api/v1/me/deals",          // ?view=active|archived, ?id=, /counts, /:id, /search
  "/api/v1/me/opportunities",  // the board, a detail, a brand page
  "/api/v1/me/inbox/threads",  // a thread and its list
  "/api/v1/me/pending-actions",
] as const;

/** Tuple keys (`["me", <name>, ...]`) that also show deal state. */
export const DEAL_TUPLE_NAMES = ["what-matters-next", "financials"] as const;

export function isDealQueryKey(queryKey: readonly unknown[]): boolean {
  const head = queryKey[0];
  if (typeof head === "string" && DEAL_URL_PREFIXES.some((p) => head === p || head.startsWith(p + "/") || head.startsWith(p + "?"))) {
    return true;
  }
  return head === "me" && typeof queryKey[1] === "string" && (DEAL_TUPLE_NAMES as readonly string[]).includes(queryKey[1]);
}

/** Refresh every list and detail that shows a deal. Fire-and-forget safe; returns the promise for callers that wait. */
export function invalidateDealQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ predicate: (q: Query) => isDealQueryKey(q.queryKey) });
}
