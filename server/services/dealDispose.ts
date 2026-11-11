/**
 * dealDispose.ts — the athlete says what a deal actually IS, in her words: not_a_deal · not_interested · expired.
 *
 * Moved out of POST /deals/:id/dispose (routes/deals.ts) unchanged, so the route (her tap on "Not for me") and Mila's
 * deals_close tool (D1: Mila may close a deal when she asks — internal, with an undo receipt marked as hers) run the
 * SAME code. One receipt, hers (actor: athlete), recording both statuses as they were, so Undo
 * (POST /agent-actions/:id/undo) puts back both.
 *
 * WHY THIS IS NOT JUST status='rejected': these look identical in the deals table and mean quite different things
 * about the CLASSIFIER.
 *   not_a_deal      → we should never have surfaced this. A precision failure.
 *   not_interested  → a real offer, correctly surfaced, and the answer is no.
 *   expired         → a real offer, correctly surfaced, whose moment has passed.
 * Each writes `payload.athlete_label`, the ground-truth label her sender memory (lib/senderMemory.ts) reads.
 *
 * None of them sends anything to the brand. A polite no is a separate reply that waits for her Send.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads } from "../../shared/schema";
import { writeAgentAction } from "../lib/agentActions";
import { createLogger } from "../logger";

const logger = createLogger("services/dealDispose");

export const DISPOSITIONS = ["not_a_deal", "not_interested", "expired"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Dispositions that CONFIRM the deal was real: never counted against the sender in her sender memory. */
const CONFIRMS_REAL: readonly string[] = ["not_interested", "expired"];

const REASONS: Record<Disposition, string> = {
  not_a_deal:     "Athlete says this is not a deal",
  not_interested: "Athlete is not interested — real offer, wrong fit",
  expired:        "Athlete says this has expired — real offer, no longer live",
};

export type DisposeResult = { ok: true; receiptId: string } | { ok: false; error: "not_found" };

/** Dispose of one of HER deals. `dealId` is ANDed with her id: another athlete's deal is not_found. */
export async function disposeDeal(athleteId: string, dealId: string, disposition: Disposition, note: string | null = null): Promise<DisposeResult> {
  const [deal] = await db
    .select({ id: deals.id, status: deals.status, brand_name: deals.brand_name })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) return { ok: false, error: "not_found" };

  const [thread] = await db
    .select({ id: inboxThreads.id, status: inboxThreads.status })
    .from(inboxThreads)
    .where(eq(inboxThreads.deal_id, dealId))
    .limit(1);

  if (disposition === "expired") {
    // Still a deal, just no longer live: archive the THREAD (the dormancy sweep's "filed away" shape) and leave
    // deals.status where it was — 'rejected' would claim she turned it down.
    if (thread) {
      await db.update(inboxThreads).set({ status: "archived" }).where(eq(inboxThreads.id, thread.id));
    }
  } else if (disposition === "not_a_deal") {
    if (thread) {
      // Thread archived, deal row KEPT — HER act: one receipt (below), labelled as hers.
      await db.update(inboxThreads).set({ status: "archived" })
        .where(and(eq(inboxThreads.id, thread.id), eq(inboxThreads.athlete_id, athleteId)));
    } else {
      await db.update(deals).set({ status: "rejected" }).where(eq(deals.id, dealId));
    }
  } else {
    // not_interested: a real deal she does not want. Status only — the thread stays where it is.
    await db.update(deals).set({ status: "rejected" }).where(eq(deals.id, dealId));
  }

  // ONE receipt, hers (actor: athlete), with BOTH statuses as they were so Undo restores both.
  const threadMoved = !!thread && disposition !== "not_interested";
  const dealMoved = disposition === "not_interested" || (disposition === "not_a_deal" && !thread);
  const receipt = await writeAgentAction({
    athleteId,
    action:     "reclassify",
    dealId,
    threadId:   thread?.id ?? null,
    reversible: true,
    reason:     note || REASONS[disposition] || "Athlete disposed of this deal",
    payload: {
      athlete_label: disposition,
      source:        "athlete",
      actor:         "athlete",
      ...(threadMoved ? { from_status: thread!.status ?? "read", thread_from_status: thread!.status ?? "read", to_status: "archived" } : {}),
      ...(dealMoved ? { deal_from_status: deal.status, deal_to_status: "rejected" } : {}),
      confirms_real: CONFIRMS_REAL.includes(disposition),
      brand_name:    deal.brand_name,
      ...(note ? { note } : {}),
    },
  });

  logger.info({ athleteId, dealId, disposition }, "Deal disposed by athlete");
  return { ok: true, receiptId: receipt.id };
}
