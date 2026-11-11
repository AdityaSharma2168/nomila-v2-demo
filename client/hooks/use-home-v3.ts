// Home v3's reads (EXPO_PUBLIC_HOME_V3), gathered once for Home and Me: the same caches the rest of the app reads —
// GET /me/agent/goals (This week, Moments), the opportunity board (Offers, deal wins, a contract to confirm), booking
// requests, GET /me/what-matters-next (Mila's suggestion, payouts owed), GET /me/agent/wins (the learning loop's
// exceptional posts), the connections, and the phone's notification permission. No new store: the model is computed
// on read (lib/homeV3Logic), and "seen" lives on the phone (useSeenStories below).
//
// Each read is optional: a dark route (404), a failure or a pilot-only feature reads as "nothing there", so Home never
// blanks because of one source.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiRequest } from "../lib/query-client";
import { useAgentGoalsPlan } from "../lib/agent/hooks";
import { useOpportunityBoard } from "./use-opportunity-board";
import { useBookingList } from "./use-bookings";
import { useWhatMattersNext } from "./use-what-matters-next";
import { useConnections } from "./use-connections";
import { phonePermission } from "../lib/push";
import { BOOKINGS } from "../lib/flags";
import { capSeen, homeV3Model, localDay, markSeen, parseLater, parseSeen, type HomeV3Model } from "../lib/homeV3Logic";
import type { AgentWinsResponse } from "../../shared/plan";

export const AGENT_WINS_KEY = ["agent", "wins"] as const;
export const PUSH_PERMISSION_KEY = ["me", "push-permission"] as const;

/** GET /me/agent/wins; null while the route is dark (404) or failing — no Wins from the learning loop then. */
export async function fetchAgentWins(): Promise<AgentWinsResponse | null> {
  try {
    const res = await apiRequest("GET", "/api/v1/me/agent/wins");
    return (await res.json()) as AgentWinsResponse;
  } catch {
    return null;
  }
}

export function useHomeV3(enabled = true): HomeV3Model & { loading: boolean; refetch: () => Promise<unknown> } {
  const goals = useAgentGoalsPlan(enabled);
  const board = useOpportunityBoard(enabled);
  const bookings = useBookingList("requests", enabled && BOOKINGS);
  const next = useWhatMattersNext(enabled);
  const wins = useQuery({ queryKey: AGENT_WINS_KEY, queryFn: fetchAgentWins, enabled, staleTime: 60_000, retry: false });
  const conn = useConnections();
  const push = useQuery({ queryKey: PUSH_PERMISSION_KEY, queryFn: () => phonePermission(), enabled, staleTime: 30_000, retry: false });

  const model = useMemo(() => homeV3Model({
    now: new Date(),
    goals: goals.data,
    board: board.isError ? null : board.data,
    bookingRequests: bookings.isError ? null : bookings.data,
    next: next.data?.items,
    winPosts: wins.data?.posts,
    winPayments: wins.data?.payments,
    connections: conn.connections,
    push: push.data ?? null,
  }), [goals.data, board.data, board.isError, bookings.data, bookings.isError, next.data, wins.data, conn.connections, push.data]);

  const refetch = useCallback(() => Promise.all([
    goals.refetch(), board.refetch(), BOOKINGS ? bookings.refetch() : undefined, next.refetch(), wins.refetch(), conn.refetch(), push.refetch(),
  ]), [goals, board, bookings, next, wins, conn, push]);

  return { ...model, loading: goals.isLoading && board.isLoading, refetch };
}

/** Where "seen" is kept: per athlete, on this phone only (no server schema). */
export const seenKey = (athleteId: string | null | undefined) => `nomila.home.v3.seen.${athleteId ?? "-"}`;

/**
 * The story items she has seen, kept in AsyncStorage by item id. `see(ids)` marks them seen and keeps the newest
 * SEEN_MAX ids, so the list never grows without end. It is never pruned to what is on screen right now: a read still
 * loading must not make something she already saw look new again. Every read and write is wrapped: a broken store reads
 * as nothing seen (every ring coloured) and never throws.
 */
export function useSeenStories(athleteId: string | null | undefined) {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const key = seenKey(athleteId);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(key);
        // Merged, so a story seen while the store was still being read stays seen.
        if (alive) setSeen((cur) => new Set([...parseSeen(raw), ...cur]));
      } catch { /* nothing seen */ }
    })();
    return () => { alive = false; };
  }, [key]);
  const see = useCallback((ids: string[]) => {
    setSeen((cur) => {
      if (ids.every((id) => cur.has(id))) return cur;
      const next = capSeen(markSeen(cur, ids));
      AsyncStorage.setItem(key, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, [key]);
  return { seen, see };
}

/** Where "Later" is kept: per athlete, on this phone, today only. */
export const laterKey = (athleteId: string | null | undefined) => `nomila.home.v3.later.${athleteId ?? "-"}`;

/**
 * What she put off "Later" in Mila's briefing today (hidden until tomorrow). Kept in AsyncStorage as { day, ids }; a
 * list from another day reads as empty. Wrapped like useSeenStories: a broken store hides nothing and never throws.
 */
export function useLaterToday(athleteId: string | null | undefined) {
  const [later, setLater] = useState<Set<string>>(() => new Set());
  const key = laterKey(athleteId);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (alive) setLater((cur) => new Set([...parseLater(raw, localDay(new Date())), ...cur]));
      } catch { /* nothing put off */ }
    })();
    return () => { alive = false; };
  }, [key]);
  const putOff = useCallback((id: string) => {
    setLater((cur) => {
      if (cur.has(id)) return cur;
      const next = new Set(cur).add(id);
      AsyncStorage.setItem(key, JSON.stringify({ day: localDay(new Date()), ids: [...next] })).catch(() => {});
      return next;
    });
  }, [key]);
  return { later, putOff };
}
