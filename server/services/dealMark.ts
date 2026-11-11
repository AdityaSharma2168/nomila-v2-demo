/**
 * dealMark.ts — her "it's done" and "bring it back" on a deal, as governed transitions with an Undo. Run ONLY from her
 * tap: Mila's deals_mark is a propose tool, so the call is queued and this runs from POST /pending-actions/:id/approve.
 *
 *   completed  an Agreed deal (status accepted) → completed
 *   reopen     a deal she set aside (status rejected, or its thread archived) → back on her board (pending / read),
 *              while its opportunity is still open
 *
 * ("Signed" is skills/dealSigning confirmSigned, which already has its own receipt and Undo.)
 *
 * Each writes ONE reversible receipt marked as her act — the existing agent_actions verb 'reopen' with payload.kind
 * "deal_marked" (the same verb D4's "Marked agreed" uses, so no CHECK change and no migration) — holding both ends of
 * every status it moved. Undo goes through the route's conditional restores (only while the deal / thread is still
 * where this left it). Conditional updates: a concurrent change wins and nothing is written.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads, opportunities } from "../../shared/schema";
import { writeAgentAction } from "../lib/agentActions";
import { createLogger } from "../logger";

const logger = createLogger("services/dealMark");

export const DEAL_MARKED_KIND = "deal_marked";

export type MarkResult =
  | { ok: true; receiptId: string }
  | { ok: false; error: "not_found" | "wrong_state"; detail: string };

/** Mark one of HER deals completed, or reopen one she set aside. `opportunityId` is ANDed with her id. */
export async function markDeal(athleteId: string, opportunityId: string, what: "completed" | "reopen"): Promise<MarkResult> {
  const [opp] = await db.select({ id: opportunities.id, status: opportunities.status })
    .from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId))).limit(1);
  if (!opp) return { ok: false, error: "not_found", detail: "not one of her deals" };
  const [deal] = await db.select({ id: deals.id, status: deals.status, brand_name: deals.brand_name })
    .from(deals).where(and(eq(deals.opportunity_id, opportunityId), eq(deals.athlete_id, athleteId)))
    .orderBy(deals.detected_at).limit(1);
  if (!deal) return { ok: false, error: "not_found", detail: "this opportunity has no deal" };
  const [thread] = await db.select({ id: inboxThreads.id, status: inboxThreads.status })
    .from(inboxThreads).where(and(eq(inboxThreads.deal_id, deal.id), eq(inboxThreads.athlete_id, athleteId))).limit(1);

  let dealMove: { from: string; to: string } | null = null;
  let threadMove: { from: string; to: string } | null = null;

  if (what === "completed") {
    if (deal.status !== "accepted") return { ok: false, error: "wrong_state", detail: "only an agreed deal can be marked completed" };
    const moved = await db.update(deals).set({ status: "completed" })
      .where(and(eq(deals.id, deal.id), eq(deals.athlete_id, athleteId), eq(deals.status, "accepted"))).returning({ id: deals.id });
    if (!moved.length) return { ok: false, error: "wrong_state", detail: "the deal changed in the meantime" };
    dealMove = { from: "accepted", to: "completed" };
  } else {
    if (opp.status !== "open") return { ok: false, error: "wrong_state", detail: "this deal is closed; it can't be brought back from the chat" };
    if (deal.status === "rejected") {
      const moved = await db.update(deals).set({ status: "pending" })
        .where(and(eq(deals.id, deal.id), eq(deals.athlete_id, athleteId), eq(deals.status, "rejected"))).returning({ id: deals.id });
      if (moved.length) dealMove = { from: "rejected", to: "pending" };
    }
    if (thread?.status === "archived") {
      const moved = await db.update(inboxThreads).set({ status: "read" })
        .where(and(eq(inboxThreads.id, thread.id), eq(inboxThreads.athlete_id, athleteId), eq(inboxThreads.status, "archived"))).returning({ id: inboxThreads.id });
      if (moved.length) threadMove = { from: "archived", to: "read" };
    }
    if (!dealMove && !threadMove) return { ok: false, error: "wrong_state", detail: "the deal is already on her board" };
  }

  const receipt = await writeAgentAction({
    athleteId,
    action:     "reopen",
    dealId:     deal.id,
    threadId:   threadMove ? thread!.id : null,
    reversible: true,
    reason:     what === "completed" ? "Marked completed" : "Brought back",
    payload: {
      kind: DEAL_MARKED_KIND, mark: what, actor: "athlete", source: "athlete", brand_name: deal.brand_name,
      ...(dealMove ? { deal_from_status: dealMove.from, deal_to_status: dealMove.to } : {}),
      ...(threadMove ? { thread_from_status: threadMove.from, from_status: threadMove.from, to_status: threadMove.to } : {}),
    },
  });
  logger.info({ athleteId, opportunityId, what }, "Deal marked by athlete");
  return { ok: true, receiptId: receipt.id };
}
