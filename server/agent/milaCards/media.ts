/**
 * agent/milaCards/media.ts — the server picks every card image (decision 8; DESIGN.md §9). The model passes ids only
 * (facts, ideas, a brand name, a capability key); this module resolves the ONE media slot each card leads with and
 * writes `media` into the DTO. A card is never left without a visual:
 *
 *   chart          drawn on the phone from the stored figures (never an image file)
 *   brand_logo     LogoMark (stored logo → Yoku → Google favicon → initials): the brand's name, logo URL and domain
 *   brand_cover    brand research's chosen cover (inbox_brands.image_url), when the brand has one (§9: cover first)
 *   athlete_photo  / content_thumb: the athlete's own library (the Curator's castable rows: herPhoto / herClip), and only
 *                  on a card that is ABOUT them; at most MAX_FACES_PER_SCREEN faces across the turn's cards — later
 *                  thumbnails get a face-free frame (athlete_present false) or atmosphere instead (decision 13)
 *   atmosphere     the shared library (atmosphere_library: Unsplash / Pexels stock under their own licences, each
 *                  checked for no people, logos or text), picked for their sport; no paid call is ever made here
 *   platform_mark  a connected service's mark through LogoMark platform
 *
 * Providers are injected (CardMediaDeps) so tests never reach the database or GCS.
 */
import { MAX_FACES_PER_SCREEN, type CardMedia } from "../../../shared/milaCards";
import type { DealCardBrand } from "../../../shared/agent";
import type { TurnState } from "../tools";

export interface LibraryRow {
  id: string;
  /** vision.athlete_present; null = never tagged (counted as a face: never guessed away). */
  athletePresent: boolean | null;
  gcsPath: string | null;
  mediaType: "photo" | "video" | string;
}

export interface AtmosphereRow { id: string; gcsPath: string }

export interface BrandRow { name: string; domain: string | null; logoUrl: string | null; coverUrl: string | null }

export interface CardMediaDeps {
  /** The athlete's main sport (athletes.sport), for the atmosphere pick. */
  sportOf(athleteId: string): Promise<string | null>;
  /** One atmosphere picture for a slot (key + words), never the same one twice in a turn. */
  atmosphere(sport: string | null, slot: { key: string; query?: string }, used: Set<string>): Promise<AtmosphereRow | null>;
  /** These library ids, re-loaded through herPhoto / herClip: anything not the athlete's does not come back. */
  library(athleteId: string, ids: string[]): Promise<Map<string, LibraryRow>>;
  /** A short-lived URL for a stored file. */
  sign(gcsPath: string): Promise<string | null>;
  /** Brand research by name (inbox_brands): its logo, domain and cover. */
  brand(name: string): Promise<BrandRow | null>;
}

/** What one turn's cards have used so far: faces (≤ 2) and atmosphere pictures (never twice). */
export interface MediaBudget { faces: number; atmosphere: Set<string> }

const budgets = new WeakMap<object, MediaBudget>();
/** The turn's budget (shared by every card tool of the turn); a call with no turn gets its own. */
export function budgetFor(turn: TurnState | undefined): MediaBudget {
  if (!turn) return { faces: 0, atmosphere: new Set() };
  let b = budgets.get(turn);
  if (!b) budgets.set(turn, (b = { faces: 0, atmosphere: new Set() }));
  return b;
}

const base = (kind: CardMedia["kind"], alt: string): CardMedia => ({
  kind, url: null, mediaId: null, atmosphereId: null, brand: null, chart: null, hasFace: false, alt: alt.slice(0, 120),
});

/** A chart from stored figures: 2–12 points, the last one highlighted, its big number and delta on top. */
export function chartMedia(points: number[], big: string, delta: string | null, alt: string): CardMedia | null {
  const p = points.filter((n) => Number.isFinite(n)).slice(-12);
  if (p.length < 2) return null;
  return { ...base("chart", alt), chart: { shape: "bars", points: p, highlight: p.length - 1, big: big.slice(0, 10), delta: delta ? delta.slice(0, 12) : null } };
}

export function logoMedia(brands: DealCardBrand[], alt: string): CardMedia | null {
  const list = brands.slice(0, 3);
  if (!list.length) return null;
  return { ...base("brand_logo", alt), brand: list[0], ...(list.length > 1 ? { brands: list } : {}) };
}

export function platformMedia(platform: string, alt: string): CardMedia {
  return { ...base("platform_mark", alt), platform };
}

/** The §9 fallback: an atmosphere picture for their sport, else the category default (a chart-less ground band). */
export async function atmosphereMedia(deps: CardMediaDeps, athleteId: string, budget: MediaBudget, slot: { key: string; query?: string }, alt: string): Promise<CardMedia> {
  try {
    const sport = await deps.sportOf(athleteId);
    const row = await deps.atmosphere(sport, slot, budget.atmosphere);
    if (row) {
      budget.atmosphere.add(row.id);
      const url = await deps.sign(row.gcsPath);
      if (url) return { ...base("atmosphere", alt), url, atmosphereId: row.id };
    }
  } catch {
    /* the default below */
  }
  // The category default: the phone draws the ground band with the card's kind chip (never a broken image).
  return base("atmosphere", alt);
}

/** A brand's cover when research has one, else its logo (LogoMark). */
export async function brandMedia(deps: CardMediaDeps, name: string, alt: string): Promise<{ media: CardMedia; brand: DealCardBrand } | null> {
  const row = await deps.brand(name).catch(() => null);
  if (!row) return null;
  const brand: DealCardBrand = { name: row.name, logoUrl: row.logoUrl, domain: row.domain, isPerson: false };
  if (row.coverUrl && /^https:\/\//.test(row.coverUrl)) return { media: { ...base("brand_cover", alt), url: row.coverUrl, brand }, brand };
  return { media: logoMedia([brand], alt)!, brand };
}

/**
 * The athlete's own picture for a card about them (an idea built from their clips): the Curator's candidates in order,
 * counted against the turn's face budget. Once two faces are used, only a face-free frame (athlete_present false) may
 * lead; with none, atmosphere. `kind` is athlete_photo for a photo, content_thumb for a clip's frame.
 */
export async function libraryMedia(deps: CardMediaDeps, athleteId: string, budget: MediaBudget, candidateIds: string[], alt: string, slot: { key: string; query?: string }): Promise<CardMedia> {
  const rows = candidateIds.length ? await deps.library(athleteId, candidateIds).catch(() => new Map<string, LibraryRow>()) : new Map<string, LibraryRow>();
  const ordered = candidateIds.map((id) => rows.get(id)).filter((r): r is LibraryRow => !!r && !!r.gcsPath);
  const faceFree = ordered.find((r) => r.athletePresent === false);
  const pick = budget.faces < MAX_FACES_PER_SCREEN ? ordered[0] : faceFree;
  if (pick) {
    const url = await deps.sign(pick.gcsPath!).catch(() => null);
    if (url) {
      const hasFace = pick.athletePresent !== false;
      if (hasFace) budget.faces += 1;
      return { ...base(pick.mediaType === "video" ? "content_thumb" : "athlete_photo", alt), url, mediaId: pick.id, hasFace };
    }
  }
  return atmosphereMedia(deps, athleteId, budget, slot, alt);
}

/** The real providers, loaded on first use (the database, GCS and brand research). */
export const dbCardMediaDeps: CardMediaDeps = {
  async sportOf(athleteId) {
    const { db } = await import("../../db");
    const { athletes } = await import("../../../shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    return row?.sport ?? null;
  },
  async atmosphere(sport, slot, used) {
    const { loadAtmospherePool, pickAtmosphere, sportIdFrom } = await import("../../services/atmosphere/documentFill");
    const sportId = sportIdFrom(sport);
    const pool = await loadAtmospherePool(sportId);
    // The slot "suggestion" purpose; the key keeps the pick stable per card.
    const pick = pickAtmosphere(pool, [{ key: `suggestion:${slot.key}`, query: slot.query }], sportId, new Set(used));
    const p = pick[`suggestion:${slot.key}`];
    return p ? { id: p.id, gcsPath: p.gcsPath } : null;
  },
  async library(athleteId, ids) {
    const { loadCastable } = await import("../../studio/agent/cast");
    const rows = await loadCastable(athleteId, ids);
    return new Map([...rows].map(([id, r]) => [id, { id: r.id, athletePresent: r.athletePresent, gcsPath: r.gcsPath, mediaType: r.mediaType }]));
  },
  async sign(gcsPath) {
    const { signedUrl } = await import("../../lib/mediaStore");
    return signedUrl(gcsPath);
  },
  async brand(name) {
    const { db } = await import("../../db");
    const { inboxBrands } = await import("../../../shared/schema");
    const { eq } = await import("drizzle-orm");
    const { normalizeBrand } = await import("../../lib/brandResolver");
    const normalized = normalizeBrand(name);
    if (!normalized) return null;
    const [row] = await db.select({ name: inboxBrands.name, domain: inboxBrands.domain, logoUrl: inboxBrands.logo_url, coverUrl: inboxBrands.image_url })
      .from(inboxBrands).where(eq(inboxBrands.normalized_name, normalized)).limit(1);
    return row ? { name: row.name, domain: row.domain, logoUrl: row.logoUrl, coverUrl: row.coverUrl } : null;
  },
};
