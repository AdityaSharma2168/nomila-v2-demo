import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { proposeAndApproveReply, usePendingActions, type PendingAction } from "../../hooks/use-pending-actions";
import { bodySha256 } from "../../../shared/bodyHash";
import type { ReplyActionWidgetData } from "../../hooks/use-mila-chat";
import { invalidateDealQueries } from "../../lib/dealQueryKeys";

/**
 * useReplyAction — the ONE send path for a Mila reply_action card.
 *
 * On a deliberate Send tap it runs the co-pilot spine PROPOSE-AT-TAP: create a
 * send_reply pending action with the CURRENT (possibly edited) body, then approve it.
 * The server enforces the real guarantees — tenancy, Outlook rejection, and at-most-once
 * (a second approve of the same proposal 409s). This hook adds client single-flight so a
 * double-tap can't create two proposals, and a terminal "sent" state so an old card in
 * scrollback can't re-send.
 *
 * TENANCY / BINDING: every id comes from THIS widget's own data (dealId, threadId) —
 * never "the current deal" — so a card bound to thread A can only ever act on thread A.
 * The model never sends: chat text can't trigger this, only the on-screen tap does.
 */

export type SendStatus = "idle" | "sending" | "sent" | "error";

/**
 * Was THIS card's draft already sent? Read from the server's pending actions, not the card's memory, so a reopened chat
 * shows "Sent" and can't send it twice. A send from this card carries `draft_sha256` (the draft it showed, even if she
 * edited it before Send); older sends match on the body (or its hash, once zero retention dropped the text). Pure.
 */
export function sentAlready(rows: readonly Pick<PendingAction, "status" | "payload" | "result">[] | undefined, draft: string | null): boolean {
  if (!rows || !draft?.trim()) return false;
  const h = bodySha256(draft.trim());
  return rows.some((r) => r.status === "approved" && (r.result as { sent?: unknown } | null)?.sent === true
    && (r.payload?.draft_sha256 === h || r.payload?.body === draft.trim() || r.payload?.body_sha256 === h));
}

const GENERIC_ERROR = "Couldn't send your reply. Please try again.";
const REAUTH_ERROR =
  "Your inbox connection expired — reconnect it in Settings, then try again.";

export function useReplyAction(data: ReplyActionWidgetData) {
  const qc = useQueryClient();
  const rows = usePendingActions({ dealId: data.dealId });
  const [status, setStatus] = useState<SendStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Synchronous single-flight guard — a ref, not state, so two taps in the same tick
  // can't both pass the check before a re-render.
  const inFlight = useRef(false);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      // Single-flight + terminal guard: never send twice from one card (this session, or one the server says went out).
      if (inFlight.current || status === "sent" || sentAlready(rows.data, data.draft)) return false;
      const trimmed = body.trim();
      if (!data.threadId || !trimmed) {
        setError(GENERIC_ERROR);
        setStatus("error");
        return false;
      }

      inFlight.current = true;
      setStatus("sending");
      setError(null);
      try {
        // PROPOSE — a send_reply pending action carrying the current body, bound to this
        // widget's own deal + thread. Creating it sends NOTHING.
        // APPROVE — the only path that sends, attesting (body_sha256) to the same body.
        // The server's conditional pending→approved claim is the at-most-once guard; the
        // body is sent VERBATIM (no re-draft/re-derive).
        await proposeAndApproveReply({
          dealId:   data.dealId,
          threadId: data.threadId,
          body:     trimmed,
          payload:  { reply_intent: data.params.replyIntent, ...(data.draft?.trim() ? { draft_sha256: bodySha256(data.draft.trim()) } : {}) },
        });

        // staleTime is Infinity, so nothing refetches without explicit invalidation.
        invalidateDealQueries(qc);
        qc.invalidateQueries({ queryKey: ["/api/v1/me/inbox/threads"] });
        qc.invalidateQueries({
          queryKey: [`/api/v1/me/inbox/threads/${data.threadId}`],
        });

        setStatus("sent");
        return true;
      } catch (err: any) {
        const msg = String(err?.message ?? "");
        setError(
          /reauth|reconnect|expired/i.test(msg) ? REAUTH_ERROR : GENERIC_ERROR,
        );
        setStatus("error");
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [data.dealId, data.threadId, data.params.replyIntent, data.draft, status, qc, rows.data],
  );

  // The server's word wins: a card whose draft already went out reads "sent" after any reload.
  const effective: SendStatus = status !== "sent" && sentAlready(rows.data, data.draft) ? "sent" : status;
  return { status: effective, error, send };
}
