/**
 * curator — media selection for the Nomi Card (docs/media-kit-specs.md Spec 4 + 5 + 8).
 *
 * ART-DIRECTED: the Strategist's shot list (shotList.ts) gives one facet-targeted image brief per
 * card; the Curator CASTS each via `searchMedia` (embeddings do the semantic casting). So the deck
 * SPANS her facets — cover on her national-team side, fit on her off-field side — instead of five of
 * the same shot. Featured slots (cover/fit/audience/video) are cast from briefs; proof = top performers
 * (the receipts); the gallery pool fills atmospheric backgrounds. Everything deduped so nothing repeats.
 * Falls back to generic quality-ranked selection when no shot list is available.
 */
import { searchMedia, listVisibleBrands, brandNamesMatch, type SearchResult } from "./mediaSearch";
import { getAthleteContext } from "./athleteContext";
import { deriveShotList, type ShotList, type PhotoCard } from "./shotList";
import { faceOf, type AssetTags } from "../lib/visionTag";
import { createLogger } from "../logger";
import { frameHasText } from "./frameText";

const logger = createLogger("curator");
const GALLERY = 9;   // pool of atmospheric backgrounds — each THEME draws different ones per its mood

export interface CurateOptions {
  recencyHalfLifeMonths?: number; shotList?: ShotList | null; galleryTarget?: number;
  /** Set on a BRAND deck. Featured slots (hero/fit/audience/video) exclude any OTHER brand caught in
   *  frame (v1 rule — see mediaSearch.brandNamesMatch); the gallery still draws from them, just with
   *  preferBrandSafe's soft nudge. Omitted (public/generic deck) → no exclusion anywhere. */
  brand?: { name: string } | null;
  /** Set on the GENERIC deck: her partners' names. No photo with a partner's brand in frame, and no brand-led content
   *  (a partner's promotional video or poster), represents her on the card every brand sees. */
  avoidBrands?: string[];
}
export interface CuratedAsset { sourceId: string; gcsPath: string; url: string | null; views: number; tags: AssetTags | null; hero: number; ageMonths: number | null; facet?: string }
export interface CuratedVideo { posterPath: string | null; videoPath: string; views: number; facet?: string }
export interface CuratedMedia { hero: CuratedAsset | null; fit: CuratedAsset | null; audience: CuratedAsset | null; proof: CuratedAsset[]; gallery: CuratedAsset[]; video: CuratedVideo | null }

const toAsset = (r: SearchResult, facet?: string): CuratedAsset => ({
  sourceId: r.sourceId, gcsPath: r.gcsPath, url: r.url, views: r.views, tags: r.tags, hero: r.hero, ageMonths: r.ageMonths, facet,
});

export async function curateAthleteMedia(athleteId: string, opts: CurateOptions = {}): Promise<CuratedMedia> {
  // Phase A Step 2d-4: the shot list reads the one athlete context. Since P2-3 the context no longer needs an athletes_current row;
  // an unknown athlete (or any failed read) still means no shot list.
  const shotList = opts.shotList !== undefined ? opts.shotList : await getAthleteContext(athleteId).then((ctx) => deriveShotList(athleteId, null, ctx), () => null);
  const briefFor = (card: PhotoCard) => shotList?.shots?.find((s) => s.card === card);
  const rc = opts.recencyHalfLifeMonths;
  // Keyed by the media row's id: an upload or a generated asset has no platform source id (""), so keying by it made
  // every such photo look already used after the first one.
  const used = new Set<string>();

  // Brand safety is a LENS, applied here at the moment of use — never a filter on the library
  // (heroScore no longer zeroes on !brand_safe). On a BRAND deck, keep rival logos out of the
  // FEATURED slots (hero/fit/audience/video); the gallery still may draw them, just de-prioritized.
  const brandName = opts.brand?.name ?? null;
  const rivals = brandName ? (await listVisibleBrands(athleteId)).filter((b) => !brandNamesMatch(b, brandName)) : [];
  // brandLens: HARD exclude rivals on a brand deck; SOFT de-prioritize not-brand-safe shots otherwise.
  const brandLens = brandName
    ? { excludeBrands: rivals }
    // Generic card: a partner's brand never LEADS a picture (its poster, product shot), but a partner logo on her kit,
    // boots or the stadium boards is incidental and the photo stays (excludeBrandSubject, not excludeBrands).
    : { preferBrandSafe: true, noPromo: true, ...(opts.avoidBrands?.length ? { excludeBrandSubject: opts.avoidBrands } : {}) };

  // Cast one featured slot from its facet brief (semantic search), skipping anything already used.
  // A face slot (the cover, the audience portrait) needs her face in view, facing the camera: never a back-to-camera
  // shot (22 Oct 2026). Among those, a clearly visible face with a stored face box wins; a partial face only as a fallback.
  const cast = async (card: PhotoCard, purpose: "hero" | "fit", opts: { face?: boolean } = {}): Promise<CuratedAsset | null> => {
    const b = briefFor(card);
    const res = await searchMedia(athleteId, {
      brief: b?.searchQuery, filters: { athletePresent: true, onlyHer: true, noBurnedText: true, includeFrames: true, ...(opts.face ? { needFace: true } : {}), ...brandLens }, purpose, diverse: true, k: 12, recencyHalfLifeMonths: rc,
    });
    const open = res.filter((r) => !used.has(r.id));
    const clear = (r: (typeof res)[number]) => {
      const t = r.tags as unknown as Record<string, unknown> | null;
      return faceOf(t) === "clear" && !!(t as { face_box?: unknown } | null)?.face_box;
    };
    const pick = opts.face ? open.find(clear) ?? open[0] : open[0];
    if (pick) used.add(pick.id);
    return pick ? toAsset(pick, b?.facet) : null;
  };

  // Featured, facet-spanning slots.
  const hero = await cast("cover", "hero", { face: true });        // e.g. national-team side
  const fit = await cast("fit", "fit");                            // e.g. off-field / personal side
  const audience = await cast("audience", "hero", { face: true }); // e.g. a portrait

  // Video — cast from the video brief, playable pool only. Same lens as the other featured slots.
  const vb = briefFor("video");
  const vr = (await searchMedia(athleteId, { brief: vb?.searchQuery, filters: { playableVideo: true, ...brandLens }, purpose: "video", k: 1 }))[0];
  if (vr) used.add(vr.id);
  const video: CuratedVideo | null = vr?.videoGcsPath ? { posterPath: vr.gcsPath, videoPath: vr.videoGcsPath, views: vr.views, facet: vb?.facet } : null;

  // Proof = the receipts (top performers), distinct from the featured slots: only her OWN posts, showing her, and never a
  // frame with text burned in (a repost's caption, a meme overlay) — that reads as someone else's post.
  // The tags describe the whole post, not the frame the tile shows, so each candidate frame is also checked once
  // (frameText.ts, cached) until three clean ones are found.
  const proof: SearchResult[] = [];
  for (const r of (await searchMedia(athleteId, { purpose: "proof", filters: { ownPosts: true, onlyHer: true, noBurnedText: true }, diverse: true, k: 12 }))) {
    if (proof.length >= 3) break;
    if (used.has(r.id) || (await frameHasText(r.id, r.gcsPath))) continue;
    proof.push(r);
  }
  proof.forEach((p) => used.add(p.id));

  // Gallery pool — remaining distinct shots for the cards' atmospheric backdrops. NOT rival-excluded
  // even on a brand deck (a good shot is still a good backdrop); brand safety only softly nudges
  // ranking here (preferBrandSafe), never excludes. Sized to the DECK's demand (opts.galleryTarget,
  // from the assembler) so a longer brand deck doesn't run the pool dry and fall back to photo-less
  // cards; the per-theme atmospheric re-pick draws from this pool too (Spec 8).
  const target = Math.max(GALLERY, opts.galleryTarget ?? GALLERY);
  const generic = brandName ? {} : { noPromo: true, ...(opts.avoidBrands?.length ? { excludeBrandSubject: opts.avoidBrands } : {}) };
  const gallery = (await searchMedia(athleteId, { purpose: "hero", filters: { athletePresent: true, onlyHer: true, preferBrandSafe: true, ...generic }, diverse: true, k: target * 2 })).filter((r) => !used.has(r.id)).slice(0, target);

  const out: CuratedMedia = {
    hero, fit, audience, proof: proof.map((p) => toAsset(p)), gallery: gallery.map((g) => toAsset(g)), video,
  };
  logger.info({ athleteId, facets: shotList?.facets, hero: hero?.facet, fit: fit?.facet, audience: audience?.facet, hasVideo: !!video, galleryTarget: target, gallery: gallery.length }, "media cast from shot list");
  return out;
}

// ── Per-page casting (the brand book, 21 Oct 2026) ────────────────────────────────────────────────────────────────

/** One photo slot's brief: what the page needs, in words the library's embeddings can match. */
export interface PhotoBrief {
  /** The slot this fills ("cover", "pillar.0", "story" …). */
  key: string;
  /** What the photo should show, written from the page's own theme. */
  query: string;
  /** Her face must be visible (a portrait or cover slot). */
  needFace?: boolean;
  /**
   * "key" (default): the page's photo IS its argument (cover, big idea, a pillar, the story) — cast first, keeps its best
   * theme match. "decor": the photo dresses the page (the closing page, a gallery, a backdrop) — cast last, takes what
   * is left, and yields any moment a key slot already shows.
   */
  role?: "key" | "decor";
}
/** Below this tagged aesthetic quality a photo is not cast: the page goes type-led instead. */
export const CAST_MIN_QUALITY = 0.55;
/**
 * A pick whose RAW brief match (text-to-image embedding cosine, not normalised) reaches this is a STRONG match; below
 * it, DECENT. Absolute, so "decent" means a weaker fit in fact, not just "not the best of this set" (the normalised score
 * always rated the best candidate strong). Set 21 Oct 2026 from the test athlete's library: on-theme picks for briefs
 * her library clearly holds scored 0.14–0.17; looser themes 0.04–0.08; deliberately absent themes 0.01–0.06. Tied to the
 * embedding model in lib/mediaEmbed — re-set it if that model changes.
 */
export const STRONG_SIM = 0.09;
/**
 * How well a cast photo fits its brief. "strong": it matches the theme. "decent": it passed every hard gate (her, good
 * enough, clean, unused) but matches the theme less — still used (owner, 21 Oct 2026: "go with a decent one if one does
 * not exactly match"), and the treatment step can do more with it (tonal/duotone, cut-out, background blur) to make it
 * sit in the theme. Only when nothing passes the gates is a slot empty (type-led).
 */
export type CastTier = "strong" | "decent";
export type CastPick = CuratedAsset & { tier: CastTier };

/** The stricter look-alike bar (embedding cosine) a decor slot uses against photos already cast. */
export const DECOR_LOOKALIKE = 0.85;
/** Two photos posted or uploaded this close together are treated as the same moment (one shoot, one match). */
export const SAME_MOMENT_MS = 30 * 60_000;
/** True when a photo was taken in the same moment as one already used (by its posted/uploaded time). Pure. */
export function sameMoment(postedAt: string | null | undefined, used: readonly number[]): boolean {
  if (!postedAt) return false;
  const t = Date.parse(postedAt);
  return Number.isFinite(t) && used.some((u) => Math.abs(u - t) < SAME_MOMENT_MS);
}

/**
 * Cast each brief from her library, each photo at most once across the whole set. KEY slots (role "key", the default)
 * are cast first, in order, each keeping its best theme match; DECOR slots (role "decor") are cast after them and take
 * what is left — preferring, while the library allows, a different MOMENT from everything already cast (a photo posted
 * or uploaded within SAME_MOMENT_MS of one already cast is used only when nothing else passes), so a closing page or a
 * gallery never repeats a key page's shoot and never takes a key page's best photo. Each pick carries its tier
 * (strong / decent — CastTier). Hard gates on every slot:
 * only photos tagged as her (onlyHer), no burned-in text, no brand-led content, not rejected, at least CAST_MIN_QUALITY;
 * carousel frames are eligible (includeFrames). Ranking is searchMedia's: the brief's semantic match blended with the
 * tagged hero quality and recency, near-duplicates skipped. A slot nothing passes stays null — the template draws that
 * page type-led rather than with a weak photo. No model call: the briefs are embedded (fractions of a cent) and matched
 * against embeddings the library already has.
 */
export async function castBriefs(
  athleteId: string, briefs: PhotoBrief[], opts: { avoidBrands?: string[] } = {},
): Promise<Record<string, CastPick | null>> {
  const used = new Set<string>();
  const moments: number[] = [];
  const out: Record<string, CastPick | null> = {};
  const ordered = [...briefs.filter((b) => b.role !== "decor"), ...briefs.filter((b) => b.role === "decor")];
  for (const b of ordered) {
    const search = (diversityThreshold?: number) => searchMedia(athleteId, {
      brief: b.query, purpose: "hero", diverse: true, k: 12, avoidNear: [...used], diversityThreshold,
      filters: {
        athletePresent: true, onlyHer: true, noBurnedText: true, noPromo: true, includeFrames: true,
        minQuality: CAST_MIN_QUALITY, needFace: !!b.needFace,
        ...(opts.avoidBrands?.length ? { excludeBrandSubject: opts.avoidBrands } : {}),
      },
    }).catch(() => []);
    // Decor first looks past anything that merely RESEMBLES a photo already cast (same kit, same kind of scene: a stricter
    // look-alike bar), and only falls back to the normal bar when that leaves nothing.
    let res = b.role === "decor" ? await search(DECOR_LOOKALIKE) : [];
    if (!res.length) res = await search();
    // A strong match first (best-scored among them); else the best decent one that passed the gates.
    const free = res.filter((r) => !used.has(r.id));
    // Decor: a new moment first (strong, then decent); another frame of a moment already shown only when nothing else
    // passes. Key slots keep their best match (the id and look-alike checks still apply to them).
    const fresh = b.role === "decor" ? free.filter((r) => !sameMoment(r.postedAt, moments)) : free;
    const pick = fresh.find((r) => r.sim >= STRONG_SIM) ?? fresh[0] ?? free.find((r) => r.sim >= STRONG_SIM) ?? free[0] ?? null;
    if (pick) {
      used.add(pick.id);
      if (pick.postedAt && Number.isFinite(Date.parse(pick.postedAt))) moments.push(Date.parse(pick.postedAt));
    }
    out[b.key] = pick ? { ...toAsset(pick), tier: pick.sim >= STRONG_SIM ? "strong" : "decent" } : null;
  }
  // The result in the briefs' own order (key slots were cast first).
  const inOrder: Record<string, CastPick | null> = Object.fromEntries(briefs.map((b) => [b.key, out[b.key] ?? null]));
  const picks = Object.values(inOrder).filter((x): x is CastPick => !!x);
  logger.info({ athleteId, slots: briefs.length, strong: picks.filter((p) => p.tier === "strong").length, decent: picks.filter((p) => p.tier === "decent").length }, "photo briefs cast");
  return inOrder;
}
