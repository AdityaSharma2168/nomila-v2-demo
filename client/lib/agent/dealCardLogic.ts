/**
 * dealCardLogic — the pure half of Mila's deal and booking cards (AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS), so it
 * unit-tests without React.
 *
 *   replyStateOf   where a reply card stands, read from the SERVER's pending action (not component state), so a card in
 *                  a reopened chat still says "Sent … exactly as you approved it" and can never send twice
 *   inboxWord      "Gmail" · "Outlook" · "Instagram" · "Nomila"
 */
import type { ApprovalCardStatus, ReplyInbox } from "../../../shared/agent";

export type ReplyState =
  | { kind: "needs_ok" }
  | { kind: "sent"; at: string | null; edited: boolean }
  | { kind: "failed"; error: string | null }
  | { kind: "not_now" }
  | { kind: "expired" }
  | { kind: "unknown" };

/** The rows a card reads (GET /pending-actions?deal_id=…). */
export interface PendingRowLike {
  id: string;
  status: "pending" | "approved" | "dismissed" | "failed";
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  expires_at: string | null;
  executed_at?: string | null;
  approved_at?: string | null;
}

/** The state the server attached to a reopened chat's card (GET /me/conversations/:id), as a ReplyState; null when none
 *  (or still waiting: the live row decides that). Used only until the card's own pending-actions read has loaded. */
export function replyStateOfApproval(approval: ApprovalCardStatus | undefined): ReplyState | null {
  switch (approval?.state) {
    case "sent": return { kind: "sent", at: approval.at, edited: false };
    case "declined": return { kind: "not_now" };
    case "failed": return { kind: "failed", error: null };
    case "expired": return { kind: "expired" };
    default: return null;
  }
}

/**
 * A reply card's state. "Edit first" sends a NEW proposal carrying `payload.replaces = <the card's id>` and dismisses the
 * card's own one, so the edited send (when there is one) decides. `now` for expiry.
 */
export function replyStateOf(pendingActionId: string, rows: readonly PendingRowLike[] | undefined, now: Date = new Date()): ReplyState {
  if (!rows) return { kind: "unknown" };
  const edited = rows.filter((r) => r.payload?.replaces === pendingActionId);
  const editedSent = edited.find((r) => r.status === "approved" && r.result?.sent === true);
  if (editedSent) return { kind: "sent", at: editedSent.executed_at ?? editedSent.approved_at ?? null, edited: true };
  const editedFailed = edited.find((r) => r.status === "failed");
  const own = rows.find((r) => r.id === pendingActionId);
  if (!own) return editedFailed ? { kind: "failed", error: editedFailed.error } : { kind: "unknown" };
  if (own.status === "approved") return own.result?.sent === true ? { kind: "sent", at: own.executed_at ?? own.approved_at ?? null, edited: false } : { kind: "unknown" };
  if (own.status === "failed") return { kind: "failed", error: own.error };
  if (own.status === "dismissed") return editedFailed ? { kind: "failed", error: editedFailed.error } : { kind: "not_now" };
  if (own.expires_at && new Date(own.expires_at).getTime() < now.getTime()) return { kind: "expired" };
  return { kind: "needs_ok" };
}

export function inboxWord(inbox: ReplyInbox | null): string {
  switch (inbox) {
    case "gmail": return "Gmail";
    case "outlook": return "Outlook";
    case "instagram": return "Instagram";
    case "nomila": return "Nomila";
    default: return "your inbox";
  }
}

/** The approval question: "Send this email from your Gmail?" (a DM on Instagram, a message through Nomila). */
export function approvalQuestion(inbox: ReplyInbox | null): string {
  if (inbox === "instagram") return "Send this message from your Instagram?";
  if (inbox === "nomila") return "Send this message through Nomila?";
  return `Send this email from your ${inboxWord(inbox)}?`;
}

/** "9:41" — the receipt's time, in her local time. */
export function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
