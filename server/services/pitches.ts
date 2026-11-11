/**
 * pitches — the Pitch object & its DERIVED status (docs/studio-pitches-plan.md).
 *
 * A "Pitch" is the brand-specific kit we already store: a `media_kits` row keyed
 * (athlete_id, brand_id) with brand_id > 0 (brand_id 0 = the public/generic card).
 * There is no separate pitch table — status is derived from tables that already exist:
 *
 *   ready   — a brand kit exists, never shared
 *   sent    — a non-revoked card_shares row exists for (athlete, brand)  → sent_at = min(created_at)
 *   opened  — any card_share_views row for those shares                  → opens_count, last_opened_at
 *   stale   — the public card (generic kit / generic overrides) changed AFTER this pitch was built
 *
 * (tailoring / failed become real once the pausable builder persists a build-state — Phase 5.)
 */
import { db } from "../db";
import { mediaKits, cardShares, cardShareViews, inboxBrands, athletes, socialAnalyticsSnapshots } from "../../shared/schema";
import { and, eq, gt, inArray, desc, sql } from "drizzle-orm";
import { getBrandContext } from "./shotList";
import { narrateWhyFits } from "./narrator";

const SHARE_BASE = process.env.PUBLIC_CARD_BASE_URL ?? "https://nomila.co";

export type PitchStatus = "tailoring" | "ready" | "sent" | "opened" | "failed";

export interface Pitch {
  brandId: number;
  brandName: string;
  brandLogo: string | null;
  brandDomain: string | null;
  category: string | null;
  status: PitchStatus;
  stale: boolean;
  opensCount: number;
  lastOpenedAt: string | null;
  sentAt: string | null;
  generatedAt: string | null;
  dealId: string | null;
  /** A hand-built deck hosted on a share (card_shares.custom_html) — open this instead of the kit. */
  hostedUrl: string | null;
  /** API-relative path to that deck's own cover card image (prefix with the API base). */
  coverPath: string | null;
}

function ms(d: Date | string | number | null | undefined): number | null {
  if (d == null) return null;
  const t = typeof d === "number" ? d : d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}
function iso(d: Date | string | number | null | undefined): string | null {
  const t = ms(d);
  return t == null ? null : new Date(t).toISOString();
}

/** Rank for the shelf sort: gold "opened" floats to the front, then sent, then ready. */
const STATUS_RANK: Record<PitchStatus, number> = { opened: 0, sent: 1, tailoring: 2, ready: 3, failed: 4 };

export async function listPitches(athleteId: string): Promise<Pitch[]> {
  // 1. brand-specific kits (brand_id > 0)
  const kits = await db
    .select({ brandId: mediaKits.brand_id, generatedAt: mediaKits.generated_at })
    .from(mediaKits)
    .where(and(eq(mediaKits.athlete_id, athleteId), gt(mediaKits.brand_id, 0)));
  if (kits.length === 0) return [];
  const brandIds = kits.map((k) => k.brandId);

  // 2. public-card freshness → the "stale" reference: when the public card was last actually REBUILT
  //    (i.e. the athlete's underlying data was re-assembled). COSMETIC edits are deliberately NOT counted:
  //    a theme pick flows to every brand pitch automatically (inherited look — no rebuild), and public-card
  //    deck/copy edits (card_overrides) live on a different row than a brand pitch's own content. Counting
  //    them made a single look-tap nag every pitch to "refresh" for nothing.
  const [genKit] = await db
    .select({ g: mediaKits.generated_at }).from(mediaKits)
    .where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, 0))).limit(1);
  const publicUpdatedAt = ms(genKit?.g);

  // 3. brand identity
  const brands = await db
    .select({ id: inboxBrands.id, name: inboxBrands.name, logo: inboxBrands.logo_url, domain: inboxBrands.domain, category: inboxBrands.category })
    .from(inboxBrands).where(inArray(inboxBrands.id, brandIds));
  const brandById = new Map(brands.map((b) => [b.id, b]));

  // 4. non-revoked shares for these brands (card_shares.brand_id is TEXT → compare stringified)
  const shares = await db
    .select({ id: cardShares.id, brandId: cardShares.brand_id, dealId: cardShares.deal_id, createdAt: cardShares.created_at,
              hasHtml: sql<boolean>`${cardShares.custom_html} is not null` })
    .from(cardShares)
    .where(and(
      eq(cardShares.athlete_id, athleteId),
      eq(cardShares.revoked, false),
      inArray(cardShares.brand_id, brandIds.map(String)),
    ));

  // 5. views for those shares
  const shareIds = shares.map((s) => s.id);
  const views = shareIds.length
    ? await db.select({ shareId: cardShareViews.share_id, openedAt: cardShareViews.opened_at })
        .from(cardShareViews).where(inArray(cardShareViews.share_id, shareIds))
    : [];
  const brandByShareId = new Map(shares.map((s) => [s.id, Number(s.brandId)]));

  const pitches: Pitch[] = kits.map((kit) => {
    const brand = brandById.get(kit.brandId);
    const mine = shares.filter((s) => Number(s.brandId) === kit.brandId);
    const sentAt = mine.reduce<number | null>((min, s) => {
      const t = ms(s.createdAt);
      return t == null ? min : min == null ? t : Math.min(min, t);
    }, null);
    const dealId = mine.map((s) => s.dealId).find(Boolean) ?? null;

    const myViews = views.filter((v) => brandByShareId.get(v.shareId) === kit.brandId);
    const opensCount = myViews.length;
    const lastOpenedAt = myViews.reduce<number | null>((max, v) => {
      const t = ms(v.openedAt);
      return t == null ? max : max == null ? t : Math.max(max, t);
    }, null);

    // A share carrying custom_html IS the deck (hand-built, hosted). Prefer the oldest such share.
    const hosted = mine.filter((s) => s.hasHtml).sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0))[0];
    const hostedUrl = hosted ? `${SHARE_BASE}/c/${hosted.id}` : null;
    const coverPath = hosted ? `/c/${hosted.id}/cover` : null;

    const status: PitchStatus = opensCount > 0 ? "opened" : mine.length > 0 ? "sent" : "ready";
    const staleRef = ms(kit.generatedAt);
    const stale = !!(publicUpdatedAt && staleRef && publicUpdatedAt > staleRef);

    return {
      brandId: kit.brandId,
      brandName: brand?.name ?? `Brand ${kit.brandId}`,
      brandLogo: brand?.logo ?? null,
      brandDomain: brand?.domain ?? null,
      category: brand?.category ?? null,
      status,
      stale,
      opensCount,
      lastOpenedAt: iso(lastOpenedAt),
      sentAt: iso(sentAt),
      generatedAt: iso(kit.generatedAt),
      dealId,
      hostedUrl,
      coverPath,
    };
  });

  // gold "opened" to the front, then by most-recent activity
  pitches.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    const at = ms(a.lastOpenedAt ?? a.sentAt ?? a.generatedAt) ?? 0;
    const bt = ms(b.lastOpenedAt ?? b.sentAt ?? b.generatedAt) ?? 0;
    return bt - at;
  });
  return pitches;
}

// ─── Pre-build insights (Studio create — Gate 2) ───────────────────────────────
// What the agent proposes to build around, BEFORE assembling the deck: the brand's current
// campaigns (already researched) + the fit angles (grounded, via the same Narrator the deck uses).
// This is the "confirm the angle" moment — surfaced work the engine otherwise does silently.

export interface PitchAngle { key: "audience" | "credibility" | "whitespace"; title: string; text: string }
export interface PitchInsights {
  brand: { id: number; name: string; logo: string | null; category: string | null; tier: string | null; audience: string | null };
  campaigns: string[];
  angles: PitchAngle[];
}

const ANGLE_TITLE: Record<PitchAngle["key"], string> = {
  audience: "Your audience overlap",
  credibility: "Your credibility",
  whitespace: "Clean whitespace",
};

export async function pitchInsights(
  athleteId: string,
  brandId: number,
  onStep?: (label: string) => void,
): Promise<PitchInsights | null> {
  const step = onStep ?? (() => {});
  const brand = await getBrandContext(brandId);
  if (!brand) return null;
  step("Pulling their brand profile");

  const [ath] = await db.select({ name: athletes.full_name, sport: athletes.sport })
    .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const [demo] = await db.select({ gender: socialAnalyticsSnapshots.top_audience_gender, age: socialAnalyticsSnapshots.top_audience_age_range })
    .from(socialAnalyticsSnapshots)
    .where(and(eq(socialAnalyticsSnapshots.athlete_id, athleteId), eq(socialAnalyticsSnapshots.source, "connected")))
    .orderBy(desc(socialAnalyticsSnapshots.snapshot_date)).limit(1);
  step("Scanning recent campaigns");

  const audienceDesc = [
    demo?.gender === "F" ? "young, women-led" : demo?.gender === "M" ? "young, men-led" : "young, highly engaged",
    demo?.age ? `(${demo.age})` : "",
  ].filter(Boolean).join(" ");

  step("Finding where you fit");
  // Identity gate: no fit angles unless the brand's research is confirmed to be about this company.
  const wf = !brand.researchConfirmed ? null : await narrateWhyFits({
    athleteName: ath?.name ?? "the athlete",
    sport: ath?.sport ?? "",
    brand: { name: brand.name, category: brand.category ?? "premium consumer", audience: brand.audience ?? undefined },
    audienceDesc,
    facts: [],
  }).catch(() => null);

  const angles: PitchAngle[] = wf
    ? (Object.keys(ANGLE_TITLE) as PitchAngle["key"][]).map((k) => ({ key: k, title: ANGLE_TITLE[k], text: wf[k] }))
    : [];

  return {
    brand: { id: brand.id, name: brand.name, logo: brand.logo ?? null, category: brand.category, tier: brand.tier, audience: brand.audience },
    campaigns: brand.recentCampaigns ?? [],
    angles,
  };
}
