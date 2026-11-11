/**
 * agent/engine/replyPush.ts — "Mila: your reply is ready". The phone's promise kept (chat v2's "This is taking longer
 * than usual. I'll let you know when it's ready."; owner option A, 3 Nov 2026).
 *
 * When: a Mila chat turn on the Mastra engine (the v1 route or chat v2) COMPLETED with a saved reply AFTER the client
 * stopped listening (its stream closed before the turn ended). The turn decides that itself, at its end, on the instance
 * that holds the request (the stream is that instance's own), so it works with any number of Cloud Run instances; the
 * send is claimed once per run in push_sends (dedupe key `mila_reply:<runId>`), so a second attempt anywhere sends
 * nothing.
 *
 * Never: while she was still connected (she saw it); for a stopped turn (her Stop, a newer turn in the conversation, a
 * cost cap, the step limit), a turn refused by the turn cap, a failed turn (the proactive path sends nothing for a turn
 * that failed either: the chat shows the error and Retry when she is back), after the account-deletion fence, or for a
 * turn that queued a card waiting on her tap (that card already sent its own "Waiting on your tap" push: one push a turn).
 *
 * How: exactly the proactive path's notification (agent/proactive/dispatcher.ts milaPushEvent): the "mila" target with
 * the conversation and the message, so a tap opens that chat on that message (client/lib/push.ts → MainTabNavigator);
 * one live notification per conversation (collapseId) grouped by it (threadId). The push service applies her
 * "all notifications" switch, quiet hours (it still arrives, silently), the overall daily cap and once-per-key. She asked
 * for this reply, so the proactive Mila pacing (5 a day) does not apply (owner rule). While the app is open nothing pops
 * (client/lib/push.ts setNotificationHandler). Fixed copy, never a model's words. Never throws.
 */
import { createHash } from "node:crypto";
import { isAthleteDeleting } from "../../lib/privacy/deletionFence";
import { createLogger } from "../../logger";
import { sendPush, type PushEvent, type SendResult } from "../../services/push/push";

const logger = createLogger("agent/engine/replyPush");

/** The words (Prompt Register / copy). */
export const REPLY_READY_COPY = { title: "Mila", body: "Your reply is ready." } as const;

export function replyReadyEvent(at: { runId: string; conversationId: string; messageId: string }): PushEvent {
  const collapse = `mila-reply-${createHash("sha256").update(at.conversationId).digest("hex").slice(0, 24)}`;
  return {
    kind: "mila_reply", dedupeKey: `mila_reply:${at.runId}`, title: REPLY_READY_COPY.title, body: REPLY_READY_COPY.body,
    target: { screen: "mila", id: at.conversationId, messageId: at.messageId },
    collapseId: collapse, threadId: at.conversationId,
  };
}

export interface ReplyPushFacts {
  athleteId: string;
  runId: string;
  conversationId: string | null;
  /** The saved assistant row (null: nothing was saved). */
  messageId: string | null;
  status: "completed" | "stopped" | "failed";
  /** The client's stream had closed before the turn ended. */
  clientLeft: boolean;
  /** A chat turn she is waiting on (trigger chat, not isolated). */
  interactive: boolean;
  turnCap: boolean;
  /** The turn queued a card that sent its own waiting push. */
  waitingPushed: boolean;
}

export type ReplyPushOutcome = SendResult["status"] | "not_needed" | "fenced";

export interface ReplyPushDeps {
  push?: (athleteId: string, e: PushEvent) => Promise<SendResult>;
  isDeleting?: (athleteId: string) => Promise<boolean>;
}

/**
 * Whether the turn's queued cards already sent their own "Waiting on your tap" push: the same rule as
 * services/push/events.ts waitingEvent (every verb but "Want me to save that?", which lives only in the chat). Kept here,
 * not imported, so the engine does not load the proactive layer; push.db.test.ts holds the two to the same answer.
 */
export function waitingCardPushed(approvals: readonly { verb: string }[]): boolean {
  return approvals.some((a) => a.verb !== "save_memory");
}

/** Whether this turn's end calls for the push, before anything is read. */
export function replyPushWanted(f: ReplyPushFacts): f is ReplyPushFacts & { conversationId: string; messageId: string } {
  return f.clientLeft && f.interactive && !f.turnCap && f.status === "completed" && !!f.conversationId && !!f.messageId && !f.waitingPushed;
}

export async function notifyReplyReady(f: ReplyPushFacts, deps: ReplyPushDeps = {}): Promise<ReplyPushOutcome> {
  if (!replyPushWanted(f)) return "not_needed";
  try {
    if (await (deps.isDeleting ?? isAthleteDeleting)(f.athleteId).catch(() => true)) return "fenced";
    const res = await (deps.push ?? sendPush)(f.athleteId, replyReadyEvent({ runId: f.runId, conversationId: f.conversationId, messageId: f.messageId }));
    logger.info({ athleteId: f.athleteId, runId: f.runId, status: res.status }, "reply-ready push");
    return res.status;
  } catch (err: any) {
    logger.warn({ athleteId: f.athleteId, runId: f.runId, err: err?.message }, "reply-ready push failed (the turn is unaffected)");
    return "failed";
  }
}
