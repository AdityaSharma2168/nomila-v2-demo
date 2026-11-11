/**
 * dealAgree.ts — D4: an "accept" reply she approved moves the deal to Agreed, with an Undo (DEALS_AGREE_ON_ACCEPT).
 *
 * What the athlete gets: after she sends "yes, let's do it", the deal reads Agreed on every surface straight away,
 * instead of sitting at "new" until she changes it by hand — and one tap on the receipt puts it back.
 *
 * Rules (a governed transition, never a model's read):
 *   · only after the send SUCCEEDED, from the approve path (her tap on that exact body);
 *   · only when the reply was an accept: the payload's reply_intent, or — when the screen didn't say — the intent of
 *     the saved draft whose body is exactly the body she approved (an edited body says nothing, so nothing moves);
 *   · only forward, from detected / pending / negotiating, with a conditional update (a concurrent change wins);
 *   · one reversible receipt marked as her act, holding the status it came from. It is stored with the existing
 *     agent_actions verb 'reopen' (a reversible deal-status change; no writer used it, and neither sender memory nor
 *     the Week's set-aside lists read it) and payload.kind = "deal_agreed" — so no CHECK change and no migration.
 *     Undo goes through the route's conditional deal-status restore (only while the deal is still 'accepted').
 * Accept intents: shared/deals ACCEPT_INTENTS, plus the legacy draft intent "accept".
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads } from "../../shared/schema";
import { ACCEPT_INTENTS } from "../../shared/deals";
import { writeAgentAction } from "../lib/agentActions";
import { createLogger } from "../logger";

const logger = createLogger("skills/dealAgree");

/** payload.kind of the D4 receipt (action 'reopen'). */
export const DEAL_AGREED_KIND = "deal_agreed";

/** The statuses an accept moves forward from. Accepted / completed / rejected are never touched. */
export const AGREEABLE_FROM = ["detected", "pending", "negotiating"] as const;

export function isAcceptIntent(intent: unknown): boolean {
  return intent === "accept" || (typeof intent === "string" && (ACCEPT_INTENTS as readonly string[]).includes(intent));
}

/**
 * What the reply she is about to send DOES: the payload's reply_intent, or — when the screen didn't say — the intent of
 * the saved draft whose body is exactly this body. Read BEFORE the send: a successful send clears the saved draft.
 * null when nothing says (an edited body says nothing).
 */
export async function sentReplyIntent(athleteId: string, threadId: string | null, payload: Record<string, unknown>): Promise<string | null> {
  if (typeof payload.reply_intent === "string") return payload.reply_intent;
  if (!threadId) return null;
  try {
    const [t] = await db
      .select({ latest_draft: inboxThreads.latest_draft })
      .from(inboxThreads)
      .where(and(eq(inboxThreads.id, threadId), eq(inboxThreads.athlete_id, athleteId)))
      .limit(1);
    const draft = (t?.latest_draft ?? null) as Record<string, unknown> | null;
    const sent = String(payload.body ?? "").trim();
    return draft && typeof draft.body === "string" && sent && draft.body.trim() === sent && typeof draft.reply_intent === "string"
      ? draft.reply_intent
      : null;
  } catch {
    return null;
  }
}

/**
 * After an approved send: move the deal to Agreed when the reply was an accept (`intent` from sentReplyIntent). Never throws (the send already
 * happened; a failure here only means the status stays where it was). Returns true when it moved the deal.
 */
export async function agreeOnAcceptSend(p: {
  athleteId: string;
  dealId: string | null;
  threadId: string | null;
  pendingActionId: string;
  intent: string | null;
}): Promise<boolean> {
  if (!p.dealId) return false;
  const intent = p.intent;
  try {
    if (!isAcceptIntent(intent)) return false;

    const [deal] = await db
      .select({ status: deals.status, brand_name: deals.brand_name })
      .from(deals)
      .where(and(eq(deals.id, p.dealId), eq(deals.athlete_id, p.athleteId)))
      .limit(1);
    if (!deal || !(AGREEABLE_FROM as readonly string[]).includes(String(deal.status))) return false;

    const moved = await db
      .update(deals)
      .set({ status: "accepted" })
      .where(and(
        eq(deals.id, p.dealId),
        eq(deals.athlete_id, p.athleteId),
        eq(deals.status, String(deal.status)),
        inArray(deals.status, [...AGREEABLE_FROM]),
      ))
      .returning({ id: deals.id });
    if (!moved.length) return false;

    await writeAgentAction({
      athleteId:  p.athleteId,
      action:     "reopen",
      dealId:     p.dealId,
      threadId:   p.threadId,
      reversible: true,
      reason:     "You sent your yes — marked as agreed",
      payload: {
        kind:              DEAL_AGREED_KIND,
        actor:             "athlete",
        source:            "athlete",
        deal_from_status:  deal.status,
        deal_to_status:    "accepted",
        reply_intent:      intent,
        pending_action_id: p.pendingActionId,
        brand_name:        deal.brand_name ?? null,
      },
    });
    logger.info({ athleteId: p.athleteId, dealId: p.dealId, from: deal.status }, "Accept sent — deal marked agreed");
    return true;
  } catch (err: any) {
    logger.warn({ athleteId: p.athleteId, dealId: p.dealId, err: err?.message }, "agreeOnAcceptSend failed — status unchanged");
    return false;
  }
}
