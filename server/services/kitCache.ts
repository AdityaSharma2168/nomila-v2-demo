/**
 * kitCache — the cache-not-recompute layer behind the /card route (docs/media-kit-specs.md Spec 4).
 *
 * The expensive agent DAG (Curator + multi-model Narrator + judge) runs on EVENTS (data change /
 * athlete edit / explicit refresh) and caches the resulting MediaKitData in `media_kits`. A brand
 * view just reads the cache and renders — no model calls per view. The cached kit stores GCS PATHS
 * (durable); `signKit` mints fresh 1h signed URLs at serve time (a cached signed URL would break an
 * hour later). Signing is a local crypto op (~sub-ms per image), so per-view signing is cheap.
 */
import { db } from "../db";
import { inboxBrands, mediaKits } from "../../shared/schema";
import { researchConfirmed } from "../lib/brandIdentity";
import { recommendDeckLook, resolveDeckLook, type LookAdvice } from "../../shared/deckLooks";
import { and, eq, sql } from "drizzle-orm";
import { assembleMediaKit, type MediaKitData } from "./mediaKitService";
import { getOverrides, applyOverrides } from "./cardOverrides";
import { signedUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("kit-cache");

// Per-theme atmospheric imagery (Spec 8): each look draws DIFFERENT background images from the pool
// per its mood. Only the data cards (index) vary — the featured facet images stay locked to
// the synced copy. Nomila (the default look) keeps the assembler default; the others re-pick from the pool.
const THEME_MOOD: Record<string, { prefer: string }> = {
  broadcast: { prefer: "action" }, luxe: { prefer: "portrait" },
};
function moodScore(img: { shotType: string; hero: number }, prefer: string): number {
  if (prefer === "hero") return img.hero;
  return (img.shotType === prefer ? 1 : 0) + img.hero * 0.3;
}
export function applyThemeImagery(kit: MediaKitData, theme: string, skip?: Set<string>): MediaKitData {
  const mood = THEME_MOOD[theme];
  const pool = kit.imagePool ?? [];
  if (!mood || pool.length < 2) return kit;                       // campaign / no pool → assembler default
  const ranked = [...pool].sort((a, b) => moodScore(b, mood.prefer) - moodScore(a, mood.prefer));
  const dataCards = new Set(["index"]);
  let i = 0;
  // A manually-swapped card (in `skip`) keeps its photo — the athlete's pick wins over per-look auto
  // curation (the cascade model: manual → shared across looks; auto only fills the gaps).
  const cards = kit.cards.map((c: any) =>
    (dataCards.has(c.type) && !skip?.has(c.id) ? { ...c, bg: ranked[i++ % ranked.length]?.gcsPath ?? c.bg } : c));
  return { ...kit, cards: cards as MediaKitData["cards"] };
}

/** Sign every GCS-path image field of a cached (path) kit → a render-ready kit with fresh URLs. */
export async function signKit(kit: MediaKitData): Promise<MediaKitData> {
  const sign = (p?: string | null) => (p ? signedUrl(p) : Promise.resolve(null));
  const cards = await Promise.all((kit.cards as any[]).map(async (c) => {
    const out: any = { ...c };
    if (c.type === "cover" || c.type === "fit" || c.type === "campaignConcept" || c.type === "signatureIdea") out.image = await sign(c.image);
    else if (c.type === "index" || c.type === "audience" || c.type === "rates"
      || c.type === "payments" || c.type === "whyFits" || c.type === "story" || c.type === "values" || c.type === "achievements"
      || c.type === "activationPlan") out.bg = await sign(c.bg ?? null);
    else if (c.type === "content") out.tiles = await Promise.all((c.tiles ?? []).map(async (t: any) => ({ ...t, image: await sign(t.image) })));
    else if (c.type === "video") { out.posterUrl = await sign(c.posterUrl); out.videoUrl = c.videoUrl ? await signedUrl(c.videoUrl) : c.videoUrl; }
    return out;
  }));
  return { ...kit, cards: cards as MediaKitData["cards"] };
}

/**
 * Legacy retirement, phase 1 (owner decision 8 Oct 2026): the "rates" card (the computed rate card and projected
 * annual value, labelled "verified") and the "payments" card (packages priced off that same rate card, "Verified
 * rates") are retired until a new rate model exists. Dropped from every kit served — cached, live share and frozen
 * snapshot alike, and from the editor's library so they can't be re-added — rather than shown with a placeholder.
 * The stored kit is untouched (no data deletion); the assembler no longer builds them.
 *
 * Phase 2 (owner decision 1, 8 Oct 2026): the "mix" card ("Inside the score": the four legacy capitals) is retired
 * too, and an "index" card is served only when it carries her M.I.A. score (`scale: "mia"`). An index card cached
 * before that holds the legacy /850 score and tier word, so it is dropped; the next rebuild adds the M.I.A. one.
 */
export const RETIRED_CARD_TYPES: ReadonlySet<string> = new Set(["rates", "payments", "mix"]);
const retiredCard = (c: any): boolean => RETIRED_CARD_TYPES.has(c?.type) || (c?.type === "index" && c?.scale !== "mia");
export function withoutRetiredCards<T extends MediaKitData>(kit: T): T {
  const cards = kit.cards as any[];
  const identity = kit.identity as any;
  const legacyIdentity = !!identity && ("tier" in identity || "tierDisplay" in identity);
  if (!cards.some(retiredCard) && !legacyIdentity) return kit;
  const drop = new Set(cards.filter(retiredCard).map((c) => c.id));
  const { tier: _tier, tierDisplay: _tierDisplay, ...cleanIdentity } = identity ?? {};
  return {
    ...kit,
    ...(identity ? { identity: cleanIdentity } : {}),
    cards: cards.filter((c) => !drop.has(c.id)) as MediaKitData["cards"],
    ...(kit.deck ? { deck: kit.deck.filter((id) => !drop.has(id)) } : {}),
  };
}

/**
 * Identity gate on a brand-tailored kit, applied on every read: a kit cached before the brand's research was
 * found unconfirmed may carry a "why she fits" card written about a different company. The card is dropped
 * from what is served (cards and deck) while the brand is not researchConfirmed; the stored kit is untouched.
 * The generic kit (brandId 0) has no whyFits card and is returned as is.
 */
export async function gateBrandFit(kit: MediaKitData, brandId: number): Promise<MediaKitData> {
  if (!brandId || !(kit.cards as any[]).some((c) => c.type === "whyFits")) return kit;
  const [b] = await db.select({ enrichment: inboxBrands.enrichment }).from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  if (researchConfirmed(b?.enrichment)) return kit;
  const drop = new Set((kit.cards as any[]).filter((c) => c.type === "whyFits").map((c) => c.id));
  return {
    ...kit,
    cards: (kit.cards as any[]).filter((c) => !drop.has(c.id)) as MediaKitData["cards"],
    ...(kit.deck ? { deck: kit.deck.filter((id) => !drop.has(id)) } : {}),
  };
}

/** Cached MediaKitData (path form). Assembles + caches on miss / when stale / when refresh forced.
 *  The athlete's editor overrides are applied over the (regenerable) base at serve — pass `raw` to
 *  get the un-edited base (the editor needs it, with the full card library + copy alternates). */
export async function getOrBuildKit(athleteId: string, opts: { maxAgeMs?: number; refresh?: boolean; brandId?: number; raw?: boolean } = {}): Promise<MediaKitData> {
  const brandId = opts.brandId ?? 0;   // 0 = generic; else a per-brand tailored card (Spec 9)
  let base: MediaKitData | null = null;
  if (!opts.refresh) {
    const [row] = await db.select().from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, brandId))).limit(1);
    if (row?.data) {
      const ageMs = Date.now() - new Date(row.generated_at ?? 0).getTime();
      if (opts.maxAgeMs == null || ageMs < opts.maxAgeMs) base = row.data as MediaKitData;
    }
  }
  if (!base) base = await buildAndCacheKit(athleteId, { brandId });
  base = withoutRetiredCards(await gateBrandFit(base, brandId));
  if (opts.raw) return base;
  return withoutRetiredCards(await withOverrides(athleteId, brandId, base));
}

/** The CACHED kit only (overrides applied, as getOrBuildKit serves it) — null on a cache miss.
 *  NEVER builds: for public, unauthenticated surfaces (a live /c/:shareId), where a request must
 *  not be able to start the paid agent DAG. */
export async function getCachedKit(athleteId: string, opts: { brandId?: number } = {}): Promise<MediaKitData | null> {
  const brandId = opts.brandId ?? 0;
  const [row] = await db.select().from(mediaKits).where(and(eq(mediaKits.athlete_id, athleteId), eq(mediaKits.brand_id, brandId))).limit(1);
  if (!row?.data) return null;
  return withoutRetiredCards(await withOverrides(athleteId, brandId, withoutRetiredCards(await gateBrandFit(row.data as MediaKitData, brandId))));
}

async function withOverrides(athleteId: string, brandId: number, base: MediaKitData): Promise<MediaKitData> {
  const ov = await getOverrides(athleteId, brandId);
  // The look (owner decision, 23 Oct 2026). Her generic card wears the look she picked for it (Nomila when none,
  // or when she picked a retired one). A BRAND deck wears the look she picked for THAT brand; until she picks, the
  // look recommended from the brand's confirmed research category (brandLookAdvice), which also rides on the kit
  // as tokens.lookAdvice so the pitch screen can show why it is preselected.
  if (brandId === 0) {
    const theme = resolveDeckLook(ov?.theme ?? base.tokens?.theme);
    return applyOverrides(base, { ...(ov ?? {}), theme });
  }
  const advice = await brandLookAdvice(brandId);
  const theme = ov?.theme ? resolveDeckLook(ov.theme) : advice.look;
  const kit = applyOverrides(base, { ...(ov ?? {}), theme });
  return { ...kit, tokens: { ...kit.tokens, lookAdvice: advice } };
}

/**
 * The recommended look for a pitch to this brand, from the category its research gave — read only when that research
 * is confirmed to be about the right company (researchConfirmed, the same gate as gateBrandFit). The category column
 * is the research's own (storeUnconfirmed clears it with the research), with enrichment.industry as the fallback for
 * rows researched before the column was filled. A missing brand, unconfirmed research or no category → Nomila.
 */
export async function brandLookAdvice(brandId: number): Promise<LookAdvice> {
  const [b] = await db
    .select({ name: inboxBrands.name, category: inboxBrands.category, enrichment: inboxBrands.enrichment })
    .from(inboxBrands).where(eq(inboxBrands.id, brandId)).limit(1);
  if (!b) return recommendDeckLook({ name: "this brand", confirmed: false });
  const confirmed = researchConfirmed(b.enrichment);
  const industry = (b.enrichment as { industry?: unknown } | null)?.industry;
  const category = b.category ?? (typeof industry === "string" ? industry : null);
  return recommendDeckLook({ name: b.name, category: confirmed ? category : null, confirmed });
}

// In-process background rebuilds, one per (athlete × brand). A request that lands while one is
// running is coalesced into ONE more pass after it, so the newest data always wins and an older,
// slower build can never overwrite a newer one.
const rebuilds = new Map<string, { again: boolean; done: Promise<void> }>();

/** Rebuild + cache a kit in the background (server-side, after an invalidation), so a live share
 *  never sits at "being refreshed" waiting for the athlete to open her app. Fire-and-forget: the
 *  returned promise never rejects; failures are logged and the next authenticated read rebuilds. */
export function rebuildKitInBackground(athleteId: string, brandId = 0): Promise<void> {
  const key = `${athleteId}:${brandId}`;
  const running = rebuilds.get(key);
  if (running) { running.again = true; return running.done; }
  const state = { again: false, done: Promise.resolve() };
  state.done = (async () => {
    try {
      do {
        state.again = false;
        try {
          await buildAndCacheKit(athleteId, { brandId });
        } catch (err: any) {
          logger.warn({ athleteId, brandId, error: String(err?.message ?? err).slice(0, 160) }, "background kit rebuild failed");
        }
      } while (state.again);
    } finally {
      rebuilds.delete(key);
    }
  })();
  rebuilds.set(key, state);
  return state.done;
}

/** Run the (expensive) agent DAG and cache the result (per athlete × brand). Call on data-change /
 *  athlete-edit events, or to pre-build a tailored card when a deal comes in (Spec 9). */
export async function buildAndCacheKit(athleteId: string, opts: { brandId?: number; onStep?: (label: string) => void; angles?: string[] } = {}): Promise<MediaKitData> {
  const brandId = opts.brandId ?? 0;
  const kit = await assembleMediaKit(athleteId, { brandId: brandId || undefined, onStep: opts.onStep, angles: opts.angles });
  // Upsert the GENERAL kit (opportunity_id NULL). The conflict target is the partial unique index
  // media_kits_brand_general_uniq — so targetWhere must match its predicate (docs §5 O4).
  await db.insert(mediaKits)
    .values({ athlete_id: athleteId, brand_id: brandId, data: kit as any, theme: kit.tokens?.theme, generated_at: new Date() })
    .onConflictDoUpdate({ target: [mediaKits.athlete_id, mediaKits.brand_id], targetWhere: sql`opportunity_id IS NULL`, set: { data: kit as any, theme: kit.tokens?.theme, generated_at: new Date() } });
  logger.info({ athleteId, brandId, cards: kit.cards.length }, "nomi card assembled + cached");
  return kit;
}
