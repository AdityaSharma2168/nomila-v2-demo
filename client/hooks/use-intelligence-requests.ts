// use-intelligence-requests — what is waiting on her (server/routes/intelligenceRequests.ts), for Home's
// "Mila can help with…" chips.
//
//   GET /api/v1/me/intelligence-requests → useIntelligenceRequests()   { items, waiting }, each item its presentation
//
// The route is retired (INTELLIGENCE_REQUESTS_V1 deleted): a 404 reads as "nothing waiting", never as an error. The shape mirrors
// server/services/intelligence/brain/requestPresentation.ts.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

export type RequestCtaKind = "add_contract" | "add_document";
export interface IntelligenceRequestItem {
  requestId: string;
  status: "open" | "acquiring" | "acquired" | "evidenced" | "obsolete" | string;
  sheAsked: string | null;
  nomilaSays: string;
  cta: { kind: RequestCtaKind; label: string } | null;
}
export interface IntelligenceRequestsResponse { items: IntelligenceRequestItem[]; waiting: number }

export const INTELLIGENCE_REQUESTS_KEY = ["me", "intelligence-requests"] as const;
const EMPTY: IntelligenceRequestsResponse = { items: [], waiting: 0 };

export async function fetchIntelligenceRequests(): Promise<IntelligenceRequestsResponse> {
  try {
    return (await (await apiRequest("GET", "/api/v1/me/intelligence-requests")).json()) as IntelligenceRequestsResponse;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("404")) return EMPTY;
    throw e;
  }
}

export function useIntelligenceRequests(enabled = true) {
  return useQuery<IntelligenceRequestsResponse>({ queryKey: INTELLIGENCE_REQUESTS_KEY, queryFn: fetchIntelligenceRequests, enabled, staleTime: 30_000 });
}
