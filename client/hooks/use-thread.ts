import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "../lib/query-client";
import { proposeAndApproveReply, sendErrorMessage } from "./use-pending-actions";
import { invalidateDealQueries } from "../lib/dealQueryKeys";

export interface ThreadMessage {
  id:           string;
  direction:    "inbound" | "outbound";
  sender_name:  string | null;
  sender_email: string | null;
  body:         string | null;
  received_at:  string | null;
  platform:     string | null;
  /** The message's files, names and types only (absent from an older server). */
  attachments?: Array<{ filename: string; content_type: string }>;
  /** Its text is only a legal notice and the content is in an attached file. */
  footer_only?: boolean;
}

export interface ThreadDetail {
  thread: {
    id:              string;
    deal_id?:        string | null;
    subject:         string | null;
    summary:         string | null;
    status:          string | null;
    last_message_at: string | null;
    message_count:   number | null;
  };
  messages: ThreadMessage[];
  /**
   * Present when the server reads the conversation live from the mailbox
   * (MAILBOX_LIVE_READS). `available: false` = it couldn't be read; `message` says why
   * ("Conversation unavailable — reconnect Gmail" / "This email was deleted in Gmail").
   */
  conversation?: {
    available: boolean;
    reason?:   "disconnected" | "not_found" | "rate_limited" | "transient";
    message?:  string;
  };
  brand: {
    id:       number;
    name:     string;
    logo_url: string | null;
  } | null;
}

export function useThread(
  threadId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<ThreadDetail>({
    queryKey:  [`/api/v1/me/inbox/threads/${threadId}`],
    enabled:   (options?.enabled ?? true) && !!threadId,
  });
}

/** Message shown when a thread has no deal to propose through (the governed path is
 *  deal-scoped). Every Thread entry point today is reached from a deal. */
export const NO_DEAL_FOR_THREAD_ERROR =
  "This conversation isn't linked to a deal, so it can't be sent from here.";

/** The plain sentence for a failed Thread send. The no-deal refusal says itself; every other failure uses the
 *  governed-send wording (never a status code). */
export function threadSendErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message === NO_DEAL_FOR_THREAD_ERROR) return NO_DEAL_FOR_THREAD_ERROR;
  return sendErrorMessage(err);
}

/**
 * Send a reply on `threadId` through the ONE governed path: propose a send_reply
 * pending action on `dealId`, then approve it on the same visible body (the way
 * useReplyAction does). It no longer POSTs to the deprecated /inbox/threads/:id/reply.
 * `dealId` is the deal the thread belongs to; without one there is nothing to propose
 * on, so the send refuses rather than going around the approval record.
 */
export function useThreadReply(threadId: string, dealId: string | null | undefined) {
  return useMutation({
    mutationFn: async (body: string) => {
      if (!dealId) throw new Error(NO_DEAL_FOR_THREAD_ERROR);
      return proposeAndApproveReply({ dealId, threadId, body });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/v1/me/pending-actions"] });
      queryClient.invalidateQueries({ queryKey: [`/api/v1/me/inbox/threads/${threadId}`] });
      // The deal card's turn badge + LATEST COMMUNICATION read the deals list,
      // which never refetches on its own (staleTime: Infinity) — without this,
      // "Your turn" stays frozen after a reply until pull-to-refresh.
      invalidateDealQueries(queryClient);
    },
  });
}
