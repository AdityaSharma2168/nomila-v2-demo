/**
 * partner/decisions.ts — her two decisions on a request from her public card, each only by her own tap.
 *
 *   declined → the deal is 'rejected' (status only, as "not interested" does today: nothing was misclassified), the
 *              visitor's page says "[First] has passed on this one. Thank you for thinking of [First]", and they get
 *              ONE email saying so — the only way a visitor ever hears a no.
 *   agreed   → the deal is 'accepted' and the visitor's page says so.
 * Decided once: a second tap is refused. No money moves here (payments are tap-only and live in services/payments; the
 * route that calls this also settles the Serious-offer hold).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { deals, partnerRequests, type PartnerRequest } from "../../../shared/schema";
import { createLogger } from "../../logger";
import { PARTNER_TEMPLATES, usd } from "../notify/templates/partner";
import { sendPartnerEmail, statusUrlFor } from "./links";
import { notifyPlanEvent } from "../../agent/plan/triggers";

const logger = createLogger("services/partner/decisions");

export type Outcome = "agreed" | "declined";

export async function decidePartnerRequest(
  row: PartnerRequest,
  outcome: Outcome,
  money: { releasedCents?: number | null; creditedCents?: number | null } = {},
  now: Date = new Date(),
): Promise<{ ok: true; outcome: Outcome } | { ok: false; error: string }> {
  if (row.status !== "confirmed" || !row.deal_id) return { ok: false, error: "this request isn't on your board" };
  const updated = await db.update(partnerRequests).set({ outcome, decided_at: now, updated_at: now })
    .where(and(eq(partnerRequests.id, row.id), isNull(partnerRequests.outcome))).returning({ id: partnerRequests.id });
  if (!updated.length) return { ok: false, error: "you already decided this request" };
  await db.update(deals).set({ status: outcome === "declined" ? "rejected" : "accepted" })
    .where(and(eq(deals.id, row.deal_id), eq(deals.athlete_id, row.athlete_id)));
  // The plan step: a deal moved to a new stage (a no-op unless AGENT_PLAN; never throws).
  notifyPlanEvent(row.athlete_id, outcome === "declined" ? "a deal was declined" : "a deal was agreed", null, outcome === "declined" ? undefined : "deal_signed");
  if (row.contact_email) {
    const statusUrl = statusUrlFor(row);
    const vars = { first: row.display_name, ref: row.public_ref, link: statusUrl };
    const [template, extra] = outcome === "declined"
      ? (money.releasedCents ? [PARTNER_TEMPLATES.declinedReleased, { amount: usd(money.releasedCents) }] : [PARTNER_TEMPLATES.declined, {}])
      : (money.creditedCents ? [PARTNER_TEMPLATES.agreed, { amount: usd(money.creditedCents) }] : [PARTNER_TEMPLATES.statusUpdate, {}]);
    try { await sendPartnerEmail(row.contact_email, template, { ...vars, ...extra }); }
    catch (err: any) { logger.warn({ requestId: row.id, error: err?.message }, "decision notice failed"); }
  }
  logger.info({ requestId: row.id, athleteId: row.athlete_id, outcome }, "partner request decided");
  return { ok: true, outcome };
}
