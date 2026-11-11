/**
 * partner/settings.ts — her Partner settings: the Serious offer switch and amount (owner decision 8 Oct 2026: ON by
 * default, $50, choices $50 / $100 / $150 / $250, under-18 athletes allowed for now). A row exists only once she
 * changes something; until then the defaults apply. The amount is never shown on the public card: a brand sees it only
 * at the hold step.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { partnerSettings } from "../../../shared/schema";
import { PARTNER } from "./config";

export interface PartnerSettingsView {
  serious_offer_enabled: boolean;
  serious_offer_cents: number;
  amounts: readonly number[];
}

export async function getPartnerSettings(athleteId: string): Promise<PartnerSettingsView> {
  const [s] = await db.select().from(partnerSettings).where(eq(partnerSettings.athlete_id, athleteId)).limit(1);
  return {
    serious_offer_enabled: s?.serious_offer_enabled ?? true,
    serious_offer_cents: s?.serious_offer_cents ?? PARTNER.seriousOfferDefaultCents,
    amounts: PARTNER.seriousOfferAmounts,
  };
}

export async function savePartnerSettings(athleteId: string, body: any): Promise<{ ok: true; settings: PartnerSettingsView } | { ok: false; error: string }> {
  const current = await getPartnerSettings(athleteId);
  const enabled = body?.serious_offer_enabled === undefined ? current.serious_offer_enabled : body.serious_offer_enabled;
  const cents = body?.serious_offer_cents === undefined ? current.serious_offer_cents : body.serious_offer_cents;
  if (typeof enabled !== "boolean") return { ok: false, error: "serious_offer_enabled must be true or false" };
  if (!(PARTNER.seriousOfferAmounts as readonly number[]).includes(cents)) {
    return { ok: false, error: `serious_offer_cents must be one of ${PARTNER.seriousOfferAmounts.join(", ")}` };
  }
  const now = new Date();
  await db.insert(partnerSettings).values({ athlete_id: athleteId, serious_offer_enabled: enabled, serious_offer_cents: cents, updated_at: now })
    .onConflictDoUpdate({ target: partnerSettings.athlete_id, set: { serious_offer_enabled: enabled, serious_offer_cents: cents, updated_at: now } });
  return { ok: true, settings: await getPartnerSettings(athleteId) };
}
