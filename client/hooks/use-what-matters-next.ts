// Home's "What matters next" candidates: GET /api/v1/me/what-matters-next (app layout B). The server gathers across
// every tab; client/lib/whatMattersNext.ts ranks and words them. A server without the route (an older deploy) answers
// 404, read here as `unavailable` so Home falls back to her recommendations alone — never an error on Home.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { NextCandidate } from "../lib/whatMattersNext";

export const WHAT_MATTERS_NEXT_KEY = ["me", "what-matters-next"] as const;

/** `waiting`: how many opportunities wait on her — the Opportunities tab's count (null from an older server). */
export interface WhatMattersNextData { items: NextCandidate[]; unavailable: boolean; waiting: number | null }

const notMounted = (e: unknown) => e instanceof Error && e.message.startsWith("404");

export async function fetchWhatMattersNext(): Promise<WhatMattersNextData> {
  try {
    const res = await apiRequest("GET", "/api/v1/me/what-matters-next");
    const body = (await res.json()) as { items?: NextCandidate[]; waiting?: number };
    return { items: Array.isArray(body.items) ? body.items : [], unavailable: false, waiting: typeof body.waiting === "number" ? body.waiting : null };
  } catch (e) {
    if (notMounted(e)) return { items: [], unavailable: true, waiting: null };
    throw e;
  }
}

export function useWhatMattersNext(enabled = true) {
  return useQuery<WhatMattersNextData>({ queryKey: WHAT_MATTERS_NEXT_KEY, queryFn: fetchWhatMattersNext, enabled, staleTime: 15_000 });
}
