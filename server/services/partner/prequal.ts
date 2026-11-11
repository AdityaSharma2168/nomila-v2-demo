/**
 * partner/prequal.ts — what her board card says about a request that came from her public card.
 *
 * The "pre-qualified" markers (design §6 step 5), every one a fact, never a score:
 *   email_confirmed    the sender opened the confirm link (always true once it is on her board)
 *   domain_match       the sender's email domain is the website's domain (free-mail never matches)
 *   research_confirmed the brand's research passed the identity gate (enrichment.identity confirmed)
 *   budget             the stated range against HER minimum for that kind of work (deal_preferences.minimum_rates):
 *                      at_or_above | spans | below | no_minimum | not_stated — seen only by her (this is her API)
 *   dates_past         the stated timing (or a press deadline) has already passed
 * Computed on read from stored rows, so a research result that lands later shows without a write.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxBrands, partnerRequests, payments, type PartnerRequest } from "../../../shared/schema";
import { readIdentity } from "../../lib/brandIdentity";
import { floorFor, loadQualificationFloors, type QualificationFloors, type WorkKind } from "../../skills/dealQualification";
import { BUDGETS, KIND_MAP, type PartnerRequestKind } from "./kinds";
import type { Brief } from "./requests";

export type BudgetMarker = "at_or_above" | "spans" | "below" | "no_minimum" | "not_stated";

export interface PrequalMarkers {
  email_confirmed: boolean;
  domain_match: boolean;
  research_confirmed: boolean;
  budget: BudgetMarker | null;
  dates_past: boolean;
}

/**
 * The Serious offer on her card (design §6a): the "Verified · $X held" badge and its one line. Read from the ledger
 * (payments, kind 'deposit' on the request); nothing here moves money.
 *   held      the hold is live: "N days left to reply before the hold is released", or after her reply
 *             "Replied · the hold counts toward the first payment if you agree"
 *   credited  she agreed; it was captured and counts toward the brand's first payment
 */
export interface SeriousOfferBadge {
  amount_cents: number;
  state: "held" | "credited";
  badge: string;
  line: string;
  /** When the hold is released if nothing happens (her reply window, then the deposit window). */
  release_at: string | null;
  replied: boolean;
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function seriousOfferBadge(p: { status: string; brand_total_cents: number | null; expires_at: Date | string | null }, repliedAt: Date | string | null, now: Date): SeriousOfferBadge | null {
  const cents = p.brand_total_cents ?? 0;
  if (!cents) return null;
  const releaseAt = p.expires_at ? new Date(p.expires_at) : null;
  if (p.status === "authorized" || p.status === "reauthorized") {
    const days = releaseAt ? Math.max(0, Math.ceil((releaseAt.getTime() - now.getTime()) / 86_400_000)) : null;
    return {
      amount_cents: cents, state: "held", badge: `Verified · ${usd(cents)} held`, replied: !!repliedAt,
      release_at: releaseAt ? releaseAt.toISOString() : null,
      line: repliedAt ? "Replied · the hold counts toward the first payment if you agree"
        : days != null ? `${days} day${days === 1 ? "" : "s"} left to reply before the hold is released` : "Waiting for your reply",
    };
  }
  if (p.status === "funded" || p.status === "settled") {
    return { amount_cents: cents, state: "credited", badge: `Verified · ${usd(cents)} credited`, replied: !!repliedAt, release_at: null, line: "The hold counts toward the brand's first payment" };
  }
  return null;
}

export interface PartnerRequestCard {
  request_id: string;
  ref: string;
  kind: PartnerRequestKind;
  /** The chip the visitor chose; press shows "Press". */
  kind_label: string;
  press: boolean;
  received_at: string | null;
  seen_at: string | null;
  markers: PrequalMarkers;
  /** The brand added a Serious offer hold (null otherwise, and for press). */
  serious_offer: SeriousOfferBadge | null;
}

/** Last calendar day the stated timing covers, or null when open-ended. */
export function timingEnd(brief: Brief): string | null {
  if (brief.type === "press") return brief.deadline;
  const t = brief.timing;
  if (t.kind === "range") return t.to;
  if (t.kind === "month") {
    const [y, m] = t.month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  return null;
}

export function budgetMarker(brief: Brief, kind: PartnerRequestKind, floors: QualificationFloors | null): BudgetMarker | null {
  if (brief.type === "press") return null;
  if (brief.budget === "not_sure") return "not_stated";
  const floor = floorFor(KIND_MAP[kind].dealType as WorkKind, floors);
  if (!floor || floor.source !== "minimum_rate") return "no_minimum";
  const range = BUDGETS[brief.budget];
  if (range.min != null && range.min >= floor.floor) return "at_or_above";
  if (range.max != null && range.max < floor.floor) return "below";
  return "spans";
}

export function markersFor(row: PartnerRequest, brandEnrichment: unknown, floors: QualificationFloors | null, now: Date): PrequalMarkers {
  const brief = row.brief as Brief;
  const end = timingEnd(brief);
  return {
    email_confirmed: row.status === "confirmed",
    domain_match: row.email_domain_match,
    research_confirmed: readIdentity(brandEnrichment)?.status === "confirmed",
    budget: budgetMarker(brief, row.kind as PartnerRequestKind, floors),
    dates_past: !!end && end < now.toISOString().slice(0, 10),
  };
}

/** deal id → its request card, for the deals of HERS that came from her public card. */
export async function partnerCardsForDeals(athleteId: string, dealIds: string[], now: Date = new Date()): Promise<Map<string, PartnerRequestCard>> {
  const out = new Map<string, PartnerRequestCard>();
  if (!dealIds.length) return out;
  const rows = await db.select({ r: partnerRequests, enrichment: inboxBrands.enrichment })
    .from(partnerRequests)
    .innerJoin(deals, eq(deals.id, partnerRequests.deal_id))
    .leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(eq(partnerRequests.athlete_id, athleteId), eq(deals.athlete_id, athleteId), inArray(partnerRequests.deal_id, dealIds)));
  if (!rows.length) return out;
  const floors = await loadQualificationFloors(athleteId);
  const holds = await db.select({ request: payments.partner_request_id, status: payments.status, brand_total_cents: payments.brand_total_cents, expires_at: payments.expires_at })
    .from(payments).where(and(eq(payments.athlete_id, athleteId), eq(payments.kind, "deposit"), inArray(payments.partner_request_id, rows.map(({ r }) => r.id))));
  const holdBy = new Map(holds.map((h) => [h.request!, h]));
  for (const { r, enrichment } of rows) {
    const k = KIND_MAP[r.kind as PartnerRequestKind];
    out.set(r.deal_id!, {
      request_id: r.id, ref: r.public_ref, kind: r.kind as PartnerRequestKind, kind_label: k.press ? "Press" : k.label, press: k.press,
      received_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
      seen_at: r.brief_seen_at ? new Date(r.brief_seen_at).toISOString() : null,
      markers: markersFor(r, enrichment, floors, now),
      serious_offer: holdBy.get(r.id) ? seriousOfferBadge(holdBy.get(r.id)!, r.first_reply_at, now) : null,
    });
  }
  return out;
}

/** She opened the card: the visitor's page moves to "[First] is reviewing" (the day only). Once. */
export async function markRequestsSeen(athleteId: string, dealIds: string[], now: Date = new Date()): Promise<void> {
  if (!dealIds.length) return;
  const rows = await db.select({ id: partnerRequests.id, seen: partnerRequests.brief_seen_at }).from(partnerRequests)
    .where(and(eq(partnerRequests.athlete_id, athleteId), inArray(partnerRequests.deal_id, dealIds)));
  const unseen = rows.filter((r) => !r.seen).map((r) => r.id);
  if (unseen.length) await db.update(partnerRequests).set({ brief_seen_at: now, updated_at: now }).where(inArray(partnerRequests.id, unseen));
}

/** Every request on one of HER opportunities: marked seen when she opens that opportunity's card. */
export async function markOpportunityRequestsSeen(athleteId: string, opportunityId: string, now: Date = new Date()): Promise<void> {
  const ds = await db.select({ id: deals.id }).from(deals).where(and(eq(deals.athlete_id, athleteId), eq(deals.opportunity_id, opportunityId)));
  await markRequestsSeen(athleteId, ds.map((d) => d.id), now);
}
