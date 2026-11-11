/**
 * mediaSearch — retrieve from the enriched library by PURPOSE (docs/media-kit-specs.md Spec 5).
 * The selection half of the Media Intelligence Layer: given a text brief and/or filters, rank the
 * athlete's enriched assets by semantic similarity (embedding) blended with purpose signals
 * (heroScore · views · recency) and tag filters (brand_safe · shot_type · brands_visible).
 *
 * Consumers: the Nomi Card Curator, post generation, proactive ads — all call this instead of
 * re-tagging. No model calls except one embedText for the brief.
 */
import { notAPreview } from "../lib/previewAsset";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { embedText, cosine } from "../lib/mediaEmbed";
import { signedUrl } from "../lib/mediaStore";
import { burnedTextOf, faceOf, heroScore, isTheAthlete, type AssetTags } from "../lib/visionTag";

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export interface MediaFilters {
  brandSafe?: boolean;        // HARD exclude — opt-in only; no caller should default this to true
  shotTypes?: string[];       // e.g. ["action","portrait"]
  excludeBrands?: string[];   // conflict brands to keep out of a BRAND deck's featured slots entirely
  preferBrandSafe?: boolean;  // SOFT lens — rank not-brand-safe shots lower (×0.85) instead of excluding
  athletePresent?: boolean;
  /** Only photos the profile-aware tagger called the athlete (`subject: "the_athlete"`); stricter than athletePresent. */
  onlyHer?: boolean;
  playableVideo?: boolean;    // only assets with a downloaded video file (content_type video/*)
  /** Only her own posts (pulled from her connected accounts) — the proof card's receipts are hers, never an upload. */
  ownPosts?: boolean;
  /** Leave out frames with text burned in (a repost's caption, a meme overlay, a screenshot) — see hasBurnedInText. */
  noBurnedText?: boolean;
  /**
   * Also cast from the single frames inside her carousel posts (child rows; photos only). Off by default: a carousel's
   * frames are not posts, so proof and post-level surfaces never see them; a page that wants "the best photo of her
   * for this theme" (the brand book) does.
   */
  includeFrames?: boolean;
  /** Leave out frames the tagger scored below this aesthetic quality (0..1). A bad photo is worse than no photo. */
  minQuality?: number;
  /** Only frames where her face is visible (face_visibility clear/partial). */
  needFace?: boolean;
  /** Leave out brand-led content (a partner's promotional video or poster) — see isPromotional. */
  noPromo?: boolean;
  /**
   * Leave out photos where one of these brands is the SUBJECT (its poster, campaign creative, product shot) — see
   * brandIsSubject. A logo that is only incidental (team kit, shoes, ball, stadium boards on a photo of her) stays.
   * The generic card's rule; a BRAND deck's rival exclusion stays the stricter `excludeBrands`.
   */
  excludeBrandSubject?: string[];
  /** Photos only or videos only (media_type VIDEO / REELS, or a video file, is a video). Mila's media_search. */
  kind?: "photo" | "video";
  /** Only assets posted or uploaded on or after / on or before this instant (undated rows are left out when either is set). */
  postedAfter?: Date;
  postedBefore?: Date;
  /** Only assets where this brand is tagged as visible (brandNamesMatch). */
  brandVisible?: string;
  /** true: someone is in the frame (the athlete or another person); false: nobody. Untagged rows are left out. */
  people?: boolean;
  /** Only rows TAGGED brand safe (strict: untagged rows are left out, unlike `brandSafe`). Mila's media_search. */
  markedBrandSafe?: boolean;
  /** Leave out soft-deleted rows (deleted_at set). Mila's media_search: what she deleted is never offered back. */
  notDeleted?: boolean;
}

/**
 * Is a visible brand the SUBJECT of the picture rather than incidental to it? From the stored tags only: the tagger's
 * role "product", a text graphic, or promotional content (isPromotional). A photo of her where a logo merely appears
 * (kit, boots, ball, boards) is incidental. Tags that can't tell → not the subject (the photo is kept).
 */
export function brandIsSubject(tags: unknown): boolean {
  const t = (tags ?? {}) as Record<string, any>;
  return t.role === "product" || t.shot_type === "text_graphic" || isPromotional(t);
}

/**
 * Does the tagger say the frame carries burned-in text (an overlay, a caption, a screenshot, a meme)? Read from what it
 * already wrote — description, reason, edit_note (and the previous tagging, kept under `prev`) — no new model call.
 */
const BURNED_TEXT = /\btext overlays?\b|\boverlaid text\b|\bon-screen text\b|\bcaption(?:ed)? (?:text|overlay)\b|\bscreenshot\b|\bmeme\b|\bwatermark|\bsubtitles?\b|\btext reading\b|\btext saying\b/i;
export function hasBurnedInText(tags: unknown): boolean {
  const t = (tags ?? {}) as Record<string, any>;
  // The tagger's own answer (text_in_image, 21 Oct 2026) when the row carries one; the description reading otherwise.
  const own = burnedTextOf(t);
  if (own !== null) return own;
  const read = (x: Record<string, any> | undefined) => [x?.description, x?.reason, x?.edit_note].filter((s) => typeof s === "string").join(" ");
  return BURNED_TEXT.test(read(t)) || BURNED_TEXT.test(read(t.prev));
}

/** Is it brand-led content (a promotional video, an ad, a campaign poster) rather than a photo of her? */
const PROMO = /\bpromotional\b|\badvertis|\bsponsored\b|\bcommercial\b|\bcampaign (?:video|poster|image|shot)\b|\bposter\b|\bproduct shot\b/i;
export function isPromotional(tags: unknown): boolean {
  const t = (tags ?? {}) as Record<string, any>;
  return PROMO.test(String(t.description ?? "")) || t.shot_type === "text_graphic";
}

// v1 brand-name match rule (documented, not just implemented): case-insensitive, punctuation-
// insensitive, and a substring match either direction once both sides are at least 3 chars — so
// "Nike" matches "nike", and "adidas" matches "Adidas Originals" (a sub-label/variant of the same
// brand). This is intentionally loose: a false-positive "match" only means an asset is treated as
// the DECK's own brand (kept in), where the cost of being wrong is low; a false-negative miss would
// wrongly treat the deck's own brand as a rival, which is the failure mode we're avoiding.
export function normalizeBrandName(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}
export function brandNamesMatch(a: string, b: string): boolean {
  const na = normalizeBrandName(a), nb = normalizeBrandName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na));
}

/** All brand/logo names ever tagged as visible in this athlete's own media library — the raw
 *  material for deriving a v1 "rival" list (see curator.ts): anything here that ISN'T the deck's
 *  own brand counts as another brand in frame. */
export async function listVisibleBrands(athleteId: string): Promise<string[]> {
  const rows = await db.select({ metadata: mediaAssets.metadata }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), ne(mediaAssets.origin, "reference"), notAPreview()));
  const set = new Set<string>();
  for (const r of rows) {
    const tags = ((r.metadata as any)?.vision as AssetTags | undefined) ?? null;
    for (const b of tags?.brands_visible ?? []) if (b?.trim()) set.add(b.trim());
  }
  return Array.from(set);
}
/** A video row: the platform says VIDEO / REELS, or the stored file is a video. */
function isVideoRow(x: { mediaType: string; playable: boolean }): boolean {
  return x.playable || /^(VIDEO|REELS)$/i.test(x.mediaType);
}

/** Someone is in the frame, from the stored tags only: the ternary subject when tagged, else athlete_present / shot type. */
export function hasPeople(tags: AssetTags): boolean {
  if (tags.subject) return tags.subject !== "nobody";
  return !!tags.athlete_present || tags.shot_type === "portrait" || tags.shot_type === "group";
}

export type Purpose = "hero" | "fit" | "proof" | "video" | "generic";
export interface SearchOpts {
  brief?: string; filters?: MediaFilters; purpose?: Purpose; recencyHalfLifeMonths?: number; k?: number;
  diverse?: boolean;          // greedily skip near-duplicates (embedding cosine > threshold) — kills repeats at the source
  /** Rows already used elsewhere (a book's other pages): drop candidates that are them OR look like them (embedding
   *  cosine > threshold) — a carousel frame and its post's cover are different rows with the same picture. */
  avoidNear?: string[];
  diversityThreshold?: number;
  /** Sign the file URLs (default true). A caller that never shows the file (Mila's media_search) skips the signing. */
  signUrls?: boolean;
}
export interface SearchResult {
  id: string; sourceId: string; gcsPath: string; url: string | null;
  videoGcsPath: string | null; videoUrl: string | null; playable: boolean;
  views: number; ageMonths: number | null; tags: AssetTags | null;
  hero: number; sim: number; score: number;
  /** The brief's semantic match, normalised 0..1 across this search's candidates (0 when there was no brief). */
  simN: number;
  /** When it was posted or uploaded (ISO), or null — lets a caller tell photos of the same moment apart. */
  postedAt: string | null;
  /** Where the row came from (connected · discovery · upload · generated) and the platform's media type. */
  origin: string;
  mediaType: string;
}

function recency(ageMonths: number | null, halfLife: number): number {
  if (ageMonths == null) return 0.6;
  return Math.pow(0.5, Math.max(0, ageMonths) / halfLife);
}

export async function searchMedia(athleteId: string, opts: SearchOpts = {}): Promise<SearchResult[]> {
  const rows = await db.select({
    id: mediaAssets.id, sourceId: mediaAssets.source_media_id, ct: mediaAssets.content_type,
    thumb: mediaAssets.gcs_thumb_path, path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, posted: mediaAssets.posted_at, origin: mediaAssets.origin, mt: mediaAssets.media_type,
    views: sql<number>`coalesce((${mediaAssets.insights}->>'video_views')::bigint, coalesce(${mediaAssets.like_count},0)+coalesce(${mediaAssets.comments_count},0))`,
  }).from(mediaAssets)
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"),
      opts.filters?.includeFrames
        ? or(isNull(mediaAssets.parent_media_id), sql`coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%'`)
        : isNull(mediaAssets.parent_media_id),
      ne(mediaAssets.origin, "reference"), notAPreview(),
      opts.filters?.notDeleted ? isNull(mediaAssets.deleted_at) : undefined));

  const q = opts.brief ? await embedText(opts.brief) : null;
  const f = opts.filters ?? {};
  const halfLife = opts.recencyHalfLifeMonths ?? 18;
  const now = Date.now();

  const items = rows.map((r) => {
    const meta = ((r.metadata as any) ?? {}) as Record<string, unknown>;
    const tags = (meta.vision as AssetTags | undefined) ?? null;
    const emb = meta.embedding as number[] | undefined;
    const ageMonths = r.posted ? (now - new Date(r.posted).getTime()) / MS_PER_MONTH : null;
    // for a video, gcs_path is the playable file only when content_type is video/*; else it's a still
    const playable = (r.ct ?? "").startsWith("video/");
    return { id: r.id, sourceId: r.sourceId ?? "", gcsPath: (r.thumb ?? r.path)!, videoUrl: playable ? r.path : null, playable, views: Number(r.views), ageMonths, tags, emb, sim: q && emb ? cosine(q, emb) : 0, origin: r.origin, mediaType: r.mt ?? "", postedMs: r.posted ? new Date(r.posted).getTime() : null, postedAt: r.posted ? new Date(r.posted).toISOString() : null };
  }).filter((x) => x.gcsPath);

  const filtered = items.filter((x) => {
    if (f.playableVideo && !x.playable) return false;
    if (f.brandSafe && x.tags && !x.tags.brand_safe) return false;
    if (f.athletePresent && x.tags && !x.tags.athlete_present) return false;
    // Strict: a photo cast AS her (curator: cover, story, hero; post-kit search). Only the profile-aware tagger's
    // `the_athlete` counts; untagged and legacy blind-tagged rows are unsure, so they're out (lib/visionTag isTheAthlete).
    if (f.onlyHer && !isTheAthlete(x.tags)) return false;
    if (f.ownPosts && x.origin !== "connected") return false;
    if (f.noBurnedText && hasBurnedInText(x.tags)) return false;
    if (f.noPromo && isPromotional(x.tags)) return false;
    if (f.minQuality != null && !(x.tags && x.tags.aesthetic_quality >= f.minQuality && x.tags.disposition !== "reject")) return false;
    if (f.needFace && faceOf(x.tags as unknown as Record<string, unknown>) === "none") return false;
    if (f.shotTypes?.length && x.tags && !f.shotTypes.includes(x.tags.shot_type)) return false;
    if (f.excludeBrands?.length && x.tags?.brands_visible?.some((b) => f.excludeBrands!.some((e) => brandNamesMatch(b, e)))) return false;
    if (f.kind && (isVideoRow(x) ? "video" : "photo") !== f.kind) return false;
    if ((f.postedAfter || f.postedBefore) && x.postedMs == null) return false;
    if (f.postedAfter && x.postedMs! < f.postedAfter.getTime()) return false;
    if (f.postedBefore && x.postedMs! > f.postedBefore.getTime()) return false;
    if (f.brandVisible && !x.tags?.brands_visible?.some((b) => brandNamesMatch(b, f.brandVisible!))) return false;
    if (f.people != null && (!x.tags || hasPeople(x.tags) !== f.people)) return false;
    if (f.markedBrandSafe && x.tags?.brand_safe !== true) return false;
    if (f.excludeBrandSubject?.length && brandIsSubject(x.tags)
      && x.tags?.brands_visible?.some((b) => f.excludeBrandSubject!.some((e) => brandNamesMatch(b, e)))) return false;
    return true;
  });

  // Raw multimodal cosine is low-absolute (~0.05–0.2) and can't blend with 0..1 signals directly,
  // so min-max normalize semantic similarity ACROSS the candidate set → simN in [0,1].
  const rawSims = filtered.filter((x) => q && x.emb).map((x) => x.sim);
  const lo = rawSims.length ? Math.min(...rawSims) : 0;
  const hi = rawSims.length ? Math.max(...rawSims) : 1;
  const simN = (x: typeof filtered[number]) => (q && x.emb && hi > lo ? (x.sim - lo) / (hi - lo) : 0);

  const scored = filtered.map((x) => {
    const hero = x.tags ? heroScore(x.tags) : 0;
    const viewsN = Math.min(1, Math.log10(1 + x.views) / 7);   // ~0..1
    const rec = recency(x.ageMonths, halfLife);
    const s = simN(x);
    let score: number;
    switch (opts.purpose) {
      case "hero":
      case "fit":   score = (0.4 * hero + 0.4 * s + 0.2) * rec; break;   // quality × brief × recency
      case "proof": score = 0.5 * viewsN + 0.3 * s + 0.2 * recency(x.ageMonths, 48); break;
      case "video": score = 0.4 * hero + 0.4 * s + 0.2 * rec; break;
      default:      score = q ? 0.7 * s + 0.3 * (0.6 * hero + 0.4 * viewsN) : 0.6 * hero + 0.4 * viewsN;
    }
    // Soft lens: a not-brand-safe shot is still eligible, just nudged down — never zeroed/excluded.
    if (f.preferBrandSafe && x.tags && x.tags.brand_safe === false) score *= 0.85;
    return { ...x, hero, score, simN: s };
  }).sort((a, b) => b.score - a.score);

  // Diversity — greedily skip near-duplicates (camera-roll bursts) by embedding cosine, so the
  // returned set is visually distinct at the source (not deduped later at render).
  const k = opts.k ?? 8;
  const thr = opts.diversityThreshold ?? 0.92;
  if (opts.avoidNear?.length) {
    const avoid = new Set(opts.avoidNear);
    const avoidEmb = items.filter((x) => avoid.has(x.id) && x.emb).map((x) => x.emb!);
    for (let i = scored.length - 1; i >= 0; i--) {
      const c = scored[i];
      if (avoid.has(c.id) || (c.emb && avoidEmb.some((e) => cosine(c.emb!, e) > thr))) scored.splice(i, 1);
    }
  }
  let top: typeof scored;
  if (opts.diverse) {
    const picked: typeof scored = [];
    for (const cand of scored) {
      if (picked.length >= k) break;
      const dup = cand.emb && picked.some((p) => p.emb && cosine(cand.emb!, p.emb) > thr);
      if (!dup) picked.push(cand);
    }
    top = picked;
  } else {
    top = scored.slice(0, k);
  }

  const sign = opts.signUrls !== false;
  return Promise.all(top.map(async (x) => ({
    id: x.id, sourceId: x.sourceId, gcsPath: x.gcsPath, url: sign ? await signedUrl(x.gcsPath) : null,
    videoGcsPath: x.videoUrl, videoUrl: x.videoUrl && sign ? await signedUrl(x.videoUrl) : null, playable: x.playable,
    views: x.views, ageMonths: x.ageMonths, tags: x.tags, hero: x.hero, sim: x.sim, score: x.score, simN: x.simN, postedAt: x.postedAt,
    origin: x.origin, mediaType: x.mediaType,
  })));
}
