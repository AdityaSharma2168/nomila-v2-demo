/**
 * partner/holdNotices.ts — tell a brand their Serious-offer hold was released by its WINDOW (the request never
 * confirmed, no reply in 6 days, or no deal in the deposit window). Her Decline sends its own notice (decisions.ts).
 * Amount and reason only; never a message. Moves no money: the payments sweep released the hold before calling this.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { partnerRequests, payments } from "../../../shared/schema";
import { PARTNER_TEMPLATES, usd } from "../notify/templates/partner";
import { sendPartnerEmail, statusUrlFor } from "./links";

export async function notifyHoldReleased(requestId: string, paymentId: string): Promise<void> {
  const [r] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, requestId)).limit(1);
  const [p] = await db.select({ cents: payments.brand_total_cents }).from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!r?.contact_email || !p?.cents || r.outcome === "declined") return;
  const vars = { first: r.display_name, ref: r.public_ref, amount: usd(p.cents) };
  if (r.status !== "confirmed") { await sendPartnerEmail(r.contact_email, PARTNER_TEMPLATES.holdReleasedUnconfirmed, vars); return; }
  await sendPartnerEmail(r.contact_email, r.first_reply_at ? PARTNER_TEMPLATES.holdReleasedNoDeal : PARTNER_TEMPLATES.holdReleasedNoReply,
    { ...vars, link: statusUrlFor(r) });
}
