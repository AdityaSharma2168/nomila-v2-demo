/**
 * use-agent-actions.ts — WS5 the receipt feed (The Week, 5B).
 *
 *   · useAgentActions   — the receipt feed (filterable by action / deal / since)
 *   · useUndoAgentAction — reverse a reversible filing (thread status flips back)
 *   · useMarkWrong       — `Wrong?` → eval-fixture sink (Phase-2 learning seed)
 *
 * React-query patterns mirror use-deals.ts / use-thread.ts exactly.
 */

import { useQuery, useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, getApiUrl, getAuthHeaders } from "../lib/query-client";
import { invalidateDealQueries } from "../lib/dealQueryKeys";

export type AgentActionKind = "file" | "auto_decline" | "reclassify" | "mute_sender" | "reopen" | "auto_archive" | "confirm_signed" | "split_deal";

/** One receipt row (server: agent_actions). Append-only; `undone_at` set on Undo. */
export interface AgentActionRow {
  id:          string;
  athlete_id:  string;
  action:      AgentActionKind;
  deal_id:     string | null;
  thread_id:   string | null;
  reason:      string | null;
  reversible:  boolean;
  held_until:  string | null;   // the 24h auto-decline hold (ISO)
  undone_at:   string | null;   // set once an Undo reversed it
  payload:     Record<string, any> | null;
  result:      Record<string, any> | null;
  created_at:  string | null;
}

export interface AgentActionsFilter {
  action?:  AgentActionKind;
  deal_id?: string;
  since?:   string; // ISO timestamp
}

// ─── useAgentActions — the receipt feed ────────────────────────────────────────

/** Server page size. Must match the route's `.limit(200)` — it is how we detect the last page. */
const RECEIPT_PAGE = 200;

type ReceiptCursor = { before: string; before_id: string } | undefined;

/**
 * The receipt feed, paged.
 *
 * Mila files a lot — 969 in thirty days for one athlete — and the feed used to stop at the
 * first 200 rows with nothing to say it had. Pages now continue on demand via a keyset cursor
 * on (created_at, id), matching the route's ordering exactly so no row is skipped or repeated.
 *
 * `data` stays a FLAT array so every existing caller (BriefView, TheWeekView, FilteredView,
 * YourWeekOutcome) keeps reading it exactly as before; only the extra paging fields are new.
 *
 * Paging is safe on this feed and not on the deal list: this is flat and chronological, while
 * deals collapse cross-thread groups whose members can sit a month apart, so a page boundary
 * through a group renders the same deal twice.
 */
export function useAgentActions(filter: AgentActionsFilter = {}) {
  const buildPath = (cursor: ReceiptCursor) => {
    const params = new URLSearchParams();
    if (filter.action)  params.set("action",  filter.action);
    if (filter.deal_id) params.set("deal_id", filter.deal_id);
    if (filter.since)   params.set("since",   filter.since);
    if (cursor)         { params.set("before", cursor.before); params.set("before_id", cursor.before_id); }
    const qs = params.toString();
    return `/api/v1/me/agent-actions${qs ? `?${qs}` : ""}`;
  };

  const query = useInfiniteQuery<AgentActionRow[]>({
    // Filters are part of the cache identity; explicit queryFn since the URL
    // carries a query string (the default key-join queryFn can't build one).
    queryKey: ["/api/v1/me/agent-actions", filter.action ?? "", filter.deal_id ?? "", filter.since ?? ""],
    initialPageParam: undefined as ReceiptCursor,
    queryFn: async ({ pageParam }) => {
      const url = new URL(buildPath(pageParam as ReceiptCursor), getApiUrl()).toString();
      const res = await fetch(url, { headers: await getAuthHeaders() });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    // A short page is the last page. Asking for one more row to find out would be a second
    // round trip for information the row count already carries.
    getNextPageParam: (last): ReceiptCursor => {
      if (!last || last.length < RECEIPT_PAGE) return undefined;
      const tail = last[last.length - 1];
      // created_at is the sort key AND the cursor, so a null one leaves nothing to page from.
      // Stopping is the honest outcome: continuing without it would re-request the same page
      // forever. It should not happen — the column is NOT NULL with a default — which is
      // exactly why it deserves a guard rather than a non-null assertion.
      if (!tail?.created_at || !tail.id) return undefined;
      return { before: tail.created_at, before_id: tail.id };
    },
  });

  return {
    ...query,
    data: query.data?.pages.flat() ?? [],
  };
}

/**
 * True totals for the receipt — what Mila actually did, not what fitted in a page.
 *
 * The counts used to be derived from the rows the client happened to hold, so the Last 30 Days
 * screen credited her with 190 filings against 969 real ones. Counting server-side is both
 * correct and cheaper: three integers rather than 200 rows.
 */
export function useAgentActionCounts(since?: string) {
  return useQuery<{ total: number; byAction: Record<string, number> }>({
    queryKey: ["/api/v1/me/agent-actions/counts", since ?? ""],
    queryFn: async () => {
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      const url = new URL(`/api/v1/me/agent-actions/counts${qs}`, getApiUrl()).toString();
      const res = await fetch(url, { headers: await getAuthHeaders() });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });
}

// ─── useUndoAgentAction — reverse a reversible filing ──────────────────────────

export function useUndoAgentAction() {
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest("POST", `/api/v1/me/agent-actions/${id}/undo`).then(
        (r) => r.json() as Promise<AgentActionRow>,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/v1/me/agent-actions"] });
      // Undo flips a thread status back — the Brief/Files/deals views must refresh.
      queryClient.invalidateQueries({ queryKey: ["/api/v1/me/inbox/threads"] });
      invalidateDealQueries(queryClient);
    },
  });
}

// ─── useMarkWrong — `Wrong?` → eval-fixture sink ───────────────────────────────

export function useMarkWrong() {
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      apiRequest("POST", `/api/v1/me/agent-actions/${id}/wrong`, note ? { note } : undefined).then(
        (r) => r.json() as Promise<{ ok: boolean }>,
      ),
  });
}
