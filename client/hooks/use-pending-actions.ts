// WS2/WS3 · use-pending-actions — the client half of the co-pilot spine.
//
// Mila PROPOSES an action (a pending_action row, no side effect); the athlete
// APPROVES it (the only path that actually sends); DISMISS backs it out. These
// hooks wrap `server/routes/pendingActions.ts` (mounted at /api/v1/me) and follow
// the exact react-query conventions in use-deals.ts — same `apiRequest` client,
// array query keys, invalidate-on-success. Nothing here sends on its own: creating
// a pending action is inert, and only approve executes (useApprovePendingAction, or
// proposeAndApproveReply for a one-tap send). Every approve carries `body_sha256`.
//
//   POST /deals/:dealId/pending-actions   → useCreatePendingAction(dealId)
//   POST /pending-actions/:id/approve     → useApprovePendingAction()   (SENDS)
//   POST /pending-actions/:id/dismiss     → useDismissPendingAction()
//   GET  /pending-actions?status=&deal_id= → usePendingActions({...})

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { bodySha256 } from "../../shared/bodyHash";
import { invalidateDealQueries } from "../lib/dealQueryKeys";

// ─── Wire shapes ──────────────────────────────────────────────────────────────
// Mirrors `pendingActions` in shared/schema.ts, but timestamps arrive as ISO
// strings over the wire (not Date), so we can't reuse the Drizzle `$inferSelect`.

export type PendingActionStatus = "pending" | "approved" | "dismissed" | "failed";
export type PendingActionKind   = "send_reply";

export interface PendingAction {
  id:           string;
  athlete_id:   string;
  deal_id:      string | null;
  thread_id:    string | null;
  kind:         string;
  status:       PendingActionStatus;
  payload:      Record<string, unknown>;
  result:       Record<string, unknown> | null;
  error:        string | null;
  created_at:   string | null;
  expires_at:   string | null;
  approved_at:  string | null;
  dismissed_at: string | null;
  executed_at:  string | null;
}

/** The `send_reply` payload the composer proposes. `body` is required by the
 *  route; the rest are drafted-from metadata the executor reads verbatim. */
export interface SendReplyPayload {
  body:          string;
  reply_intent?: string;
  style?:        string;
  voice?:        string;
  [k: string]:   unknown;
}

export interface CreatePendingActionInput {
  kind:        PendingActionKind;
  payload:     SendReplyPayload;
  thread_id?:  string;
  expires_at?: string;   // ISO timestamp; optional TTL on the proposal
}

// Shared prefix so every mutation can invalidate the co-pilot queue (list hooks
// tack on deal_id / status, and react-query matches by key prefix).
const PENDING_ACTIONS_KEY = "/api/v1/me/pending-actions";

// ─── useCreatePendingAction — propose (no send) ───────────────────────────────

/** Propose a pending action for `dealId`. Resolves to the created `pending` row;
 *  creating it has NO outbound side effect (approve is what executes). */
export function useCreatePendingAction(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePendingActionInput) =>
      apiRequest("POST", `/api/v1/me/deals/${dealId}/pending-actions`, input).then(
        (r) => r.json() as Promise<PendingAction>,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [PENDING_ACTIONS_KEY] });
    },
  });
}

// ─── Approve request — what the athlete SAW is what sends ──────────────────────

/** The approve request body: `body_sha256` of the body the athlete was shown. The
 *  server re-hashes the stored `payload.body` with the same shared helper and refuses
 *  (409 BODY_MISMATCH) when they differ, so a stale or edited-elsewhere body never
 *  goes out under an approval of different text. Pass the displayed string verbatim. */
/**
 * The sentence the athlete reads when a send is refused. Raw errors arrive as "409: {…}" from apiRequest; a 409 means
 * the message changed or was already sent since she saw it, so the honest answer is to reopen it — never a status code.
 */
export function sendErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/BODY_MISMATCH/.test(msg)) return "This message changed since you opened it. Reopen it, check it, and send again.";
  if (msg.startsWith("409")) return "This message was already sent or is being sent. Check the conversation before trying again.";
  // Outlook (OUTLOOK_SEND): name the inbox it is really about, never Gmail.
  const outlook = /Outlook/.test(msg);
  if (outlook && /SCOPE_MISSING/.test(msg)) return "Reconnect Outlook in Settings to allow sending. Nothing was sent; you can reply in Outlook meanwhile.";
  if (outlook) return "Check your Outlook connection and try again, or reply in Outlook.";
  return "Check your Gmail connection and try again.";
}

/** `reviewed: true` attests that the athlete opened this one message and approved it there.
 *  The server requires it on ask-terms batch rows (409 NOT_REVIEWED otherwise). */
export function approveRequestBody(
  displayedBody: string,
  opts?: { reviewed?: boolean },
): { body_sha256: string; reviewed?: true } {
  return opts?.reviewed ? { body_sha256: bodySha256(displayedBody), reviewed: true } : { body_sha256: bodySha256(displayedBody) };
}

/** Approve pending action `id`, attesting to `displayedBody`. Resolves to the row. */
export function approvePendingAction(id: string, displayedBody: string, opts?: { reviewed?: boolean }): Promise<PendingAction> {
  return apiRequest("POST", `/api/v1/me/pending-actions/${id}/approve`, approveRequestBody(displayedBody, opts)).then(
    (r) => r.json() as Promise<PendingAction>,
  );
}

/** The ONE governed send for a reply composed and sent in a single tap: PROPOSE a
 *  send_reply pending action carrying `body`, then APPROVE it on that same visible body.
 *  Every in-app send goes through here (or through an explicit propose → preview →
 *  approve), never straight to the deprecated /inbox/threads/:id/reply. Throws whatever
 *  `apiRequest` throws on a non-ok status; the caller keeps its draft on failure. */
export async function proposeAndApproveReply(input: {
  dealId:   string;
  threadId: string;
  body:     string;
  payload?: Omit<SendReplyPayload, "body">;
}): Promise<PendingAction> {
  const created = await apiRequest("POST", `/api/v1/me/deals/${input.dealId}/pending-actions`, {
    kind:      "send_reply",
    thread_id: input.threadId,
    payload:   { ...(input.payload ?? {}), body: input.body },
  }).then((r) => r.json() as Promise<PendingAction>);
  return approvePendingAction(created.id, input.body);
}

// ─── useApprovePendingAction — approve → EXECUTE (the only send path) ──────────

/** Approve a pending action → the server runs the underlying action once. On a
 *  `send_reply` this sends the reply, so on success we invalidate the deals list
 *  and (when known) the thread, exactly like useThreadReply does. Pass the
 *  thread/deal ids as variables so onSuccess can target the right caches, and
 *  `body` — the exact text the athlete is looking at — so the server can check it
 *  is what will send (see approveRequestBody).
 *
 *  A send that errors (REAUTH, threading, …) comes back as a non-ok HTTP status,
 *  which `apiRequest` throws — surface it via the mutation's error and
 *  `parseApproveError` below. */
export function useApprovePendingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: string; reviewed?: boolean; threadId?: string | null; dealId?: string | null }) =>
      approvePendingAction(vars.id, vars.body, { reviewed: vars.reviewed }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: [PENDING_ACTIONS_KEY] });
      invalidateDealQueries(qc);
      if (vars.threadId) {
        qc.invalidateQueries({ queryKey: [`/api/v1/me/inbox/threads/${vars.threadId}`] });
      }
    },
  });
}

// ─── useDismissPendingAction — cancel a proposal (no send) ─────────────────────

export function useDismissPendingAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      apiRequest("POST", `/api/v1/me/pending-actions/${vars.id}/dismiss`).then(
        (r) => r.json() as Promise<PendingAction>,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [PENDING_ACTIONS_KEY] });
    },
  });
}

// ─── usePendingActions — the co-pilot queue ───────────────────────────────────

/** List this athlete's pending actions, optionally filtered by deal / status.
 *  Explicit queryFn (like useDealPreferences) so the query string maps to the
 *  route's ?deal_id / ?status params. */
export function usePendingActions(params?: { dealId?: string; status?: PendingActionStatus }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.dealId) qs.set("deal_id", params.dealId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  return useQuery<PendingAction[]>({
    queryKey: [PENDING_ACTIONS_KEY, params?.dealId ?? null, params?.status ?? null],
    queryFn:  () => apiRequest("GET", `/api/v1/me/pending-actions${suffix}`).then((r) => r.json()),
  });
}
