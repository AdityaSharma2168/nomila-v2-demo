// WS4 · use-ask-terms — the client half of the "Ask for terms" batch co-pilot.
//
// TWO steps, and the split is the whole safety story:
//   1. useAskTermsBatch() PROPOSES — POST /deals/ask-terms-batch creates N
//      `pending_action`s (kind send_reply, reply_intent request_terms) in status
//      `pending`. This is INERT: nothing sends. It returns the created proposals + a
//      `skipped` list (deals that weren't valid candidates, with a reason).
//   2. Sending is the EXISTING approve path (useApprovePendingAction from
//      use-pending-actions) run in a PACED loop by the screen over the rows the athlete
//      opened and approved one by one (each approve carries body_sha256 + reviewed: true;
//      the server refuses a batch row without it). There is no new send path — an approved request_terms reply
//      goes out through the identical hardened reply service as any other reply.
//
// We have NO scheduler: the paced loop sends NOW, a short delay apart (SEND_SPACING_MS),
// so the batch isn't one indistinguishable burst. That is honest pacing, not a drip.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { PendingAction } from "./use-pending-actions";

export interface AskTermsSkip {
  deal_id: string;
  reason:
    | "not_found" | "not_open" | "already_priced" | "no_thread" | "filed"
    | "gifting_only" | "commission_only" | "declined" | "not_needs_terms"
    | "mailbox_unavailable" | "unverifiable_sender";
}

export interface AskTermsBatchResult {
  created: PendingAction[];
  skipped: AskTermsSkip[];
  cap:     number;
}

const PENDING_ACTIONS_KEY = "/api/v1/me/pending-actions";

/**
 * Propose a request-terms reply for each selected deal. Resolves to the created
 * `pending` proposals + any `skipped` deals. Creating them has NO outbound side
 * effect — the screen approves each (paced) to actually send.
 */
export function useAskTermsBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dealIds: string[]) =>
      apiRequest("POST", "/api/v1/me/deals/ask-terms-batch", { dealIds }).then(
        (r) => r.json() as Promise<AskTermsBatchResult>,
      ),
    onSuccess: () => {
      // New proposals landed in the co-pilot queue.
      qc.invalidateQueries({ queryKey: [PENDING_ACTIONS_KEY] });
    },
  });
}

/**
 * Edit the EXACT email body of a proposed (still `pending`) ask-terms row before it
 * sends. Inert — editing sends nothing; the edited body is what a later approve reads
 * verbatim. Resolves to the updated proposal.
 */
export function useEditAskTermsDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: string }) =>
      apiRequest("PATCH", `/api/v1/me/deals/ask-terms/${vars.id}`, { body: vars.body }).then(
        (r) => r.json() as Promise<PendingAction>,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [PENDING_ACTIONS_KEY] });
    },
  });
}
