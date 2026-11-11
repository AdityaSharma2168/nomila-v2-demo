/**
 * partner/milaPort.ts — public Mila's PartnerIntakePort (server/mila/public/ports.ts), implemented over the Partner door.
 * Wired in server/index.ts as createAskMilaPublicRouter({ partner: createPartnerIntakePort(), … }).
 *
 *   begin({ athleteId, handle, kind })  the visitor tapped a request kind (a "What kind of request?" chip, or a card
 *                                       Mila's start_partner_request prepared). It writes NOTHING: it checks that the
 *                                       Partner door is open on THIS athlete's published card and answers where the
 *                                       visitor continues — her card's Partner page with that kind chosen
 *                                       (/p/:handle/partner?kind=…). There the visitor fills the request, and the Partner
 *                                       door's own path takes over: a draft, the email confirm, then her board.
 *
 * The chat id is accepted and not stored: a partner request has no column for it, and the request stands on its own
 * (the visitor writes it in their words on the next page).
 *
 * Tenancy: the athlete id must be the one the handle resolves to through the Partner door's published-card seam;
 * anything else is "closed", the same answer as a Partner door that is off.
 */
import type { PartnerIntakePort } from "../../mila/public/ports";
import { partnerIntakeEnabled } from "./config";
import { isKind } from "./kinds";
import { publishedCard } from "./publishedCard";

/** Where a visitor continues a request of this kind on this card (a same-origin path). */
export const partnerPagePath = (handle: string, kind: string): string => `/p/${handle}/partner?kind=${encodeURIComponent(kind)}`;

export function createPartnerIntakePort(): PartnerIntakePort {
  return {
    async begin({ athleteId, handle, kind }) {
      if (!isKind(kind)) return { ok: false, reason: "invalid" };
      if (!partnerIntakeEnabled()) return { ok: false, reason: "closed" };
      const card = await publishedCard(handle);
      if (!card || card.athleteId !== athleteId || !card.partnerOpen) return { ok: false, reason: "closed" };
      return { ok: true, nextUrl: partnerPagePath(card.handle, kind) };
    },
  };
}
