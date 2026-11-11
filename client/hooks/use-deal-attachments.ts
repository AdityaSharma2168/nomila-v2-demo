import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

/** One PDF that arrived on this deal's thread, as the Attachments section renders it. */
export interface DealAttachment {
  /** Together with `index`, the opaque handle used to mint a download link. */
  messageId:   string;
  index:       number;
  filename:    string;
  contentType: string;
  bytes:       number;
  /** False = we stored the file but never read it (over the parse cap), so its terms did NOT feed the deal. */
  parsed:      boolean;
  receivedAt:  string | null;
}

/** One entry in a deal's activity timeline (server-composed from real per-deal sources). */
export interface DealActivityItem {
  ts:         string | null;
  type:       "detected" | "message" | "agent" | "payment";
  title:      string;
  detail?:    string | null;
  direction?: string | null;
}

export interface DealPaymentState {
  payment_status: string;
  deposit_status: string;
}

interface DealDetailResponse {
  attachments?: DealAttachment[];
  activity?:    DealActivityItem[];
  payment?:     DealPaymentState;
}

/**
 * Attachments for one deal. Backed by GET /deals/:id, which the deals LIST does not
 * carry — the list is the whole Opportunities screen and attachments are only ever
 * needed on the detail screen.
 */
export function useDealAttachments(dealId: string | null | undefined) {
  const query = useQuery<DealDetailResponse>({
    queryKey: [`/api/v1/me/deals/${dealId}`],
    enabled:  !!dealId,
  });

  return {
    attachments: query.data?.attachments ?? [],
    isLoading:   query.isLoading,
    error:       query.error as Error | null,
  };
}

/**
 * Activity timeline + payment state for one deal. Backed by the SAME GET /deals/:id as
 * useDealAttachments, so React Query serves both from one cached request (shared key).
 */
export function useDealTimeline(dealId: string | null | undefined) {
  const query = useQuery<DealDetailResponse>({
    queryKey: [`/api/v1/me/deals/${dealId}`],
    enabled:  !!dealId,
  });

  return {
    activity:  query.data?.activity ?? [],
    payment:   query.data?.payment ?? null,
    isLoading: query.isLoading,
  };
}

/**
 * Fetch a short-lived signed URL for one attachment.
 *
 * Two hops on purpose: the app opens files with RN Linking, which cannot send an
 * auth header, so the API hands back a pre-signed URL instead of redirecting.
 */
export async function fetchAttachmentUrl(
  dealId: string,
  a: Pick<DealAttachment, "messageId" | "index">,
): Promise<string> {
  const res = await apiRequest(
    "GET",
    `/api/v1/me/deals/${dealId}/attachments/${a.messageId}/${a.index}/url`,
  );
  const json = await res.json() as { url?: string };
  if (!json.url) throw new Error("No link returned for this attachment");
  return json.url;
}
