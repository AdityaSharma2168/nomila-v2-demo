/**
 * partnerAthlete.ts — HER side of a request sent from her public card (requireAuth; athleteId from the token only).
 * Mounted under /api/v1/me while PUBLIC_CARD and PARTNER_INTAKE are both "true".
 *
 *   GET  /partner-requests/:id           the request (kind, markers, status) and its thread as she may see it: every
 *                                         delivered message and her own held ones, never the sender's held text
 *   POST /partner-requests/:id/decline   her Decline tap: the deal is rejected and the visitor is told "[First] has
 *                                         passed on this one" (the only way a visitor hears a no)
 *   POST /partner-requests/:id/agree     her "We agreed" tap: the deal is accepted and the visitor's page says so; a
 *                                         Serious-offer hold is CAPTURED and counts toward the brand's first payment
 *   (decline releases the hold at once)
 *   GET  /partner/settings               her Serious offer switch and amount (on by default, $50)
 *   PUT  /partner/settings               { serious_offer_enabled?, serious_offer_cents? } — $50 / $100 / $150 / $250
 * Her REPLY is not here: it is the governed send path every reply uses (a send_reply pending action she approves →
 * sendThreadReply), which hands a request thread to the relay (services/partner/threads.ts).
 * Another athlete's request is the same 404 as a missing one.
 */
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { partnerRequests, type PartnerRequest } from "../../shared/schema";
import { KIND_MAP, type PartnerRequestKind } from "../services/partner/kinds";
import { partnerCardsForDeals } from "../services/partner/prequal";
import { readPartnerThread } from "../services/partner/threads";
import { decidePartnerRequest } from "../services/partner/decisions";
import { captureSeriousOffer, releaseSeriousOffer } from "../services/payments/seriousOffer";
import { getPartnerSettings, savePartnerSettings } from "../services/partner/settings";

const logger = createLogger("routes/partnerAthlete");
export const partnerAthleteRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownRequest(req: Request, res: Response): Promise<PartnerRequest | null> {
  const id = String(req.params.id);
  const [row] = UUID.test(id)
    ? await db.select().from(partnerRequests).where(and(eq(partnerRequests.id, id), eq(partnerRequests.athlete_id, req.athleteId!), eq(partnerRequests.status, "confirmed"))).limit(1)
    : [];
  if (!row) { res.status(404).json({ error: "not found" }); return null; }
  return row;
}

partnerAthleteRouter.get("/partner-requests/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const row = await ownRequest(req, res); if (!row) return;
  const card = (await partnerCardsForDeals(row.athlete_id, [row.deal_id!])).get(row.deal_id!) ?? null;
  res.json({
    request: {
      id: row.id, ref: row.public_ref, kind: row.kind, kind_label: KIND_MAP[row.kind as PartnerRequestKind].label,
      brand_name: row.brand_name, sender_name: row.contact_name, deal_id: row.deal_id, thread_id: row.inbox_thread_id,
      outcome: row.outcome, received_at: row.confirmed_at, first_reply_at: row.first_reply_at, brief: row.brief, fit_preview: row.fit_preview,
      markers: card?.markers ?? null,
      serious_offer: card?.serious_offer ?? null,
    },
    messages: await readPartnerThread(row, "athlete"),
  });
});

for (const decision of ["decline", "agree"] as const) {
  partnerAthleteRouter.post(`/partner-requests/:id/${decision}`, requireAuth, async (req: Request, res: Response): Promise<void> => {
    const row = await ownRequest(req, res); if (!row) return;
    try {
      if (row.outcome) { res.status(409).json({ error: "you already decided this request" }); return; }
      // Her tap moves the hold: captured toward the first payment on agree, released on decline.
      const money = decision === "agree"
        ? { creditedCents: await captureSeriousOffer(row.id) }
        : { releasedCents: await releaseSeriousOffer(row.id) };
      const r = await decidePartnerRequest(row, decision === "decline" ? "declined" : "agreed", money);
      if (!r.ok) { res.status(409).json({ error: r.error }); return; }
      res.json({ ok: true, outcome: r.outcome, ...money });
    } catch (err: any) {
      logger.error({ requestId: row.id, error: err?.message }, "partner decision failed");
      res.status(500).json({ error: "failed" });
    }
  });
}

partnerAthleteRouter.get("/partner/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
  res.json(await getPartnerSettings(req.athleteId!));
});

partnerAthleteRouter.put("/partner/settings", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const r = await savePartnerSettings(req.athleteId!, req.body ?? {});
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  res.json(r.settings);
});
