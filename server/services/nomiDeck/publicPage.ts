/**
 * nomiDeck/publicPage.ts — /p/:handle drawn by the engine (front door v2.1, simplified 22 Oct 2026; NOMI_ENGINE_V1
 * retired 2 Nov 2026). With no cached card for the athlete it answers null and the route draws the classic
 * published-snapshot page.
 *
 * Reads only: the published snapshot (which doors are on, the published offers) and the CACHED generic card — a public
 * page never builds a kit (no model spend from a visitor). Every text value of the card goes through the public page's
 * contact-detail filter, as the snapshot does.
 */
import type { MediaKitData } from "../mediaKitService";
import { cleanText } from "../publicCard/contactFilter";
import type { PublicCardView } from "../publicCard/view";
import type { PublicPageMetrics } from "../../../shared/publicPageStats";
// The engine, the cache and the reader reach the database: loaded on first use, so this module's pure parts test alone.
const engine = () => import("./index");
const kitCache = () => import("../kitCache");
import type { OwnerRailItem } from "./render";

/** Where a rail count takes her in the app (Business holds requests, bookings and shop). Views and likes stay put. */
const APP = "co.nomila.app://";
/** The owner's metrics rail from her stored 30-day counts. Pure; exported for the tests. */
export function ownerRail(m: PublicPageMetrics | null): OwnerRailItem[] {
  if (!m) return [];
  return [
    { key: "views", label: "Views", value: m.views, href: null },
    { key: "likes", label: "Likes", value: m.likes, href: null },
    { key: "requests", label: "Requests", value: m.requests, href: `${APP}opportunities` },
    { key: "bookings", label: "Bookings", value: m.bookings, href: `${APP}opportunities` },
    { key: "shop", label: "Shop", value: m.shop, href: `${APP}opportunities` },
  ];
}

const URLISH = /^(https?:|gs:|athletes\/|\/)/i;

/** Every string in the card through the contact-detail filter (paths and URLs untouched). Exported for the tests. */
export function publicSafeKit<T>(value: T): T {
  if (typeof value === "string") return (URLISH.test(value) ? value : cleanText(value)) as T;
  if (Array.isArray(value)) return value.map((v) => publicSafeKit(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, publicSafeKit(v)])) as T;
  return value;
}

/**
 * "Get your own Nomi Card": today's sign-up entry is the landing page's waitlist (NOMI_CLAIM_URL, default nomila.co),
 * which already keeps `?ref=` as the new athlete's referral_code (landing/index.html → POST /waitlist). The handle is the
 * referral. Later this points at the Claim-your-score campaign page.
 */
export function claimHref(handle: string | null | undefined): string {
  const base = process.env.NOMI_CLAIM_URL ?? "https://nomila.co";
  if (!handle) return base;
  try {
    const u = new URL(base);
    u.searchParams.set("ref", handle);
    return u.toString();
  } catch {
    return base;
  }
}

/** Which doors the published version has on (the publisher already applied her switches and the under-18 rule). */
export function doorsOn(view: Pick<PublicCardView, "tiles">): { partnerOn: boolean; bookOn: boolean; shopOn: boolean } {
  const has = (i: string) => view.tiles.some((t) => t.intent === i);
  return { partnerOn: has("partner"), bookOn: has("book"), shopOn: has("shop") };
}

export async function renderEnginePublicPage(
  view: PublicCardView,
  paths: { base: string; css: string; js: string; like: string; sheets?: string; book?: string },
  deps: { athleteIdOf?: (handle: string) => Promise<string | null>; cachedKit?: (athleteId: string) => Promise<MediaKitData | null> } = {},
): Promise<string | null> {
  const athleteIdOf = deps.athleteIdOf ?? (async (h: string) => { const r = await (await import("../publicCard/publicCardReader")).publicCardReader.read(h); return r.status === "ok" ? r.athleteId : null; });
  const cachedKit = deps.cachedKit ?? (async (id: string) => (await kitCache()).getCachedKit(id));
  const athleteId = await athleteIdOf(view.handle);
  if (!athleteId) return null;
  const kit = await cachedKit(athleteId);
  if (!kit || !kit.cards?.some((c) => c.type === "cover")) return null;
  const theme = kit.tokens?.theme ?? "luxe";
  const { engineDrawsTheme, renderFrontDoorForWeb } = await engine();
  if (!engineDrawsTheme(theme)) return null;
  const themed = publicSafeKit((await kitCache()).applyThemeImagery(kit, theme));
  return renderFrontDoorForWeb(themed, {
    theme, first: view.athlete.firstName, ...doorsOn(view),
    offers: view.offers.map((o) => ({ durationMin: o.durationMin, format: o.format })),
    basePath: paths.base, handle: view.handle, likeEndpoint: paths.like, cssHref: paths.css, jsHref: paths.js, sheetsJsHref: paths.sheets, bookJsHref: paths.book,
    claimHref: claimHref(view.handle),
  });
}

/**
 * The athlete's own preview of her public page (owner-only routes, the documents service): her doors as her card has
 * them (Partner only when there is no card yet), CSS inlined (the card preview's CSP allows it), nothing sent by the heart.
 */
export async function renderOwnerPublicPage(athleteId: string, kit: MediaKitData, theme?: string | null): Promise<string> {
  let on = { partnerOn: true, bookOn: false, shopOn: false };
  let handle: string | null = null;
  try {
    const { getPreview } = await import("../publicCard/service");
    const p = await getPreview(athleteId);
    handle = p.handle;
    on = { partnerOn: p.content.doors.partner !== false, bookOn: !!p.content.doors.book, shopOn: !!p.content.doors.shop };
  } catch { /* no card yet: Partner only */ }
  let metrics: PublicPageMetrics | null = null;
  try {
    metrics = await (await import("../publicPage/stats")).pageMetrics(athleteId);
  } catch { /* no counts: no rail */ }
  const look = theme ?? kit.tokens?.theme ?? "luxe";
  const first = kit.identity.name.split(" ")[0] || kit.identity.name;
  const { renderFrontDoorForWeb } = await engine();
  return renderFrontDoorForWeb(publicSafeKit((await kitCache()).applyThemeImagery(kit, look)), {
    theme: look, first, ...on, basePath: handle ? `/p/${handle}` : "#", handle, likeEndpoint: null, inlineCss: true,
    metrics: ownerRail(metrics),
    claimHref: claimHref(handle),
  });
}
