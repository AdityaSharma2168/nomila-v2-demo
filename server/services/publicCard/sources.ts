/**
 * publicCard/sources.ts — the light, single-table reads behind public card items that can be "pulled at once"
 * (design-public-card-v3 §10): her signed partners, her own media, her published offers. Shared by the draft builder
 * (gather.ts) and the reconcile (reconcile.ts). Keyed by the athlete id handed in; no model, no network.
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { deals, inboxBrands, mediaAssets, offers } from "../../../shared/schema";
import { quoteBookingCharge } from "../bookings/money";
import { isDeadLogoUrl, yokuLogoUrl } from "../../lib/brandLogoSources";

export interface GatheredPartner { dealId: string; brandName: string; logoUrl: string | null; signedAt: string }
export interface GatheredMedia { assetId: string; mediaType: "image" | "video"; postedAt: string | null; /** The stored object (server-only; the page sees an opaque key). */ path: string }
export interface GatheredOffer { offerId: string; publicId: string; title: string; priceCents: number; totalCents: number; currency: string; durationMinutes: number }

export async function signedPartners(athleteId: string, db = defaultDb): Promise<GatheredPartner[]> {
  const rows = await db.select({
    id: deals.id, brand_name: deals.brand_name, signed_at: deals.signed_at,
    b_name: inboxBrands.name, b_logo: inboxBrands.logo_url, b_domain: inboxBrands.domain,
  }).from(deals).leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(eq(deals.athlete_id, athleteId), isNotNull(deals.signed_at), or(isNull(deals.status), ne(deals.status, "rejected"))))
    .orderBy(asc(deals.signed_at));
  // One entry per brand: her earliest signed deal with it ("since").
  const seen = new Set<string>();
  const out: GatheredPartner[] = [];
  for (const r of rows) {
    const name = (r.b_name ?? r.brand_name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const logo = r.b_logo && !isDeadLogoUrl(r.b_logo) ? r.b_logo : r.b_domain ? yokuLogoUrl(r.b_domain) : null;
    out.push({ dealId: r.id, brandName: name, logoUrl: logo, signedAt: r.signed_at!.toISOString() });
  }
  return out;
}

export async function ownMedia(athleteId: string, db = defaultDb): Promise<GatheredMedia[]> {
  const rows = await db.select({ id: mediaAssets.id, media_type: mediaAssets.media_type, posted_at: mediaAssets.posted_at, gcs_path: mediaAssets.gcs_path, content_type: mediaAssets.content_type }).from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.origin, ["connected", "upload"]), eq(mediaAssets.status, "stored"),
      isNull(mediaAssets.deleted_at), isNotNull(mediaAssets.gcs_path),
      or(isNull(mediaAssets.approval_status), ne(mediaAssets.approval_status, "rejected")),
    ))
    .orderBy(asc(mediaAssets.posted_at)).limit(200);
  return rows.reverse().map((r) => ({
    // What is STORED decides the kind: most connected video rows hold only a poster still, which is an image.
    assetId: r.id, mediaType: (r.content_type ?? "").startsWith("video/") ? "video" : "image", postedAt: r.posted_at?.toISOString() ?? null, path: r.gcs_path!,
  }));
}

export async function publishedOffers(athleteId: string, db = defaultDb): Promise<GatheredOffer[]> {
  const rows = await db.select().from(offers).where(and(eq(offers.athlete_id, athleteId), eq(offers.status, "published"))).orderBy(asc(offers.created_at));
  return rows.map((o) => {
    const q = quoteBookingCharge(o.price_cents);
    return { offerId: o.id, publicId: o.public_id, title: o.title, priceCents: o.price_cents, totalCents: q.buyerTotalCents, currency: o.currency, durationMinutes: o.duration_minutes };
  });
}
