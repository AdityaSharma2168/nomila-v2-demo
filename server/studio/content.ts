/**
 * studio/content — what the athlete's Studio has actually made, read from the real content store.
 *
 * This replaces the hardcoded SAMPLE_POSTS strip on the Studio screen, and now also feeds the Made
 * shelf. It is still empty for most athletes, and that is the correct answer rather than a bug:
 * only what Studio has actually generated appears, and an empty shelf is the truth where five
 * invented tiles (a gorjana reel, a Nike teaser) were not.
 *
 * ─── THE TENANCY SHAPE, AND WHY IT IS THIS WAY AROUND ──────────────────────────────────────────
 *
 * `content_posts` HAS NO `athlete_id` COLUMN. It is (id, asset_id, platform, permalink, insights,
 * deal_id, posted_at, created_at) — ownership lives one hop away, on `media_assets.athlete_id`.
 * A query that starts `.from(contentPosts)` therefore has NOTHING to filter on and returns every
 * athlete's publish records. That is not a hypothetical: it is the default a reasonable person
 * writes when the table is called "content_posts" and the feature is called "Posts & Ads".
 *
 * So the direction of the read IS the safety property:
 *
 *   query 1  starts at media_assets, where athlete_id is a real column, and filters on it.
 *   query 2  starts at content_posts but is bounded by `inArray(asset_id, <ids from query 1>)` —
 *            ids already proven to belong to this athlete.
 *
 * Query 1 carries the tenancy predicate for the ASSETS. Query 2 has no tenancy decision to get
 * wrong, because it can only see ids query 1 already cleared.
 *
 * Two queries rather than one leftJoin for a second reason: an asset can have MANY content_posts
 * rows (a repost is a new publish record), so a join FANS OUT and needs a distinct-on to be
 * correct. Fetching separately and folding in memory is both correct and cheaper to read.
 *
 * ─── WHO A PIECE WAS MADE FOR ──────────────────────────────────────────────────────────────────
 *
 * The Made shelf sorts into sections by AUDIENCE, and the audience is not on media_assets:
 * `media_assets.deal_id` is provenance for INGESTED brand content and recordGeneratedAsset() never
 * writes it, so it is NULL on every generated row. `content_posts.deal_id` is likewise empty —
 * nothing publishes Studio output yet. Neither can answer the question.
 *
 * What IS populated is `generation_jobs.brand_id`, written from the frozen brief when the job is
 * opened (studio/jobs.ts), reachable from the asset by `media_assets.generation_job_id`. So query 1
 * picks it up with two leftJoins. Both are many-to-one onto a PRIMARY KEY — an asset has at most
 * one job, a job at most one brand — so unlike content_posts these cannot fan out, and the row
 * count is unchanged.
 *
 * The join to generation_jobs carries `athlete_id` as well as the id, which makes TWO tenancy
 * predicates in this function rather than the one the shape above implies. That is deliberate:
 * `media_assets.generation_job_id` is declared without `.references()` (the FK is added out of band
 * by studio/sql/studioGenerationDdl.sql), so it is a bare uuid, and a bad write pointing an asset
 * at another athlete's job would otherwise surface THEIR brand name on HER shelf. With the
 * predicate the join simply misses and the brand reads null — a fail-safe, not a leak.
 *
 * `inbox_brands` needs no predicate of its own: it is a global brand catalog keyed by advertiser
 * name, not athlete-scoped data, so reading a row out of it discloses nothing about anyone.
 *
 * INDEXES: `idx_media_assets_athlete` (athlete_id, posted_at desc) covers query 1's filter,
 * `idx_content_posts_asset` covers query 2's lookup, and both new joins land on a primary key.
 * Nothing needs adding to shared/schema.ts.
 *
 * Pure read. No writes, no model call, no spend.
 */
import { notAPreview } from "../lib/previewAsset";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { contentPosts, generationJobs, inboxBrands, mediaAssets } from "../../shared/schema";
import { signedUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("studio/content");

/** Hard ceiling on a page, whatever the client asks for. */
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 24;

/** Where a piece has been published. Null until it actually goes out. */
export interface PublishRecord {
  platform: string;
  permalink: string | null;
  postedAt: string | null;
}

/**
 * One tile in the Studio strip.
 *
 * `approvalStatus` is the clearance state from studio/approval.ts — draft / approved / rejected —
 * NOT "did the render finish" and NOT "is it posted". Those are three different concepts and the
 * UI must not merge them (see the approval.ts header). `published` answers the third one.
 */
export interface StudioContentItem {
  assetId: string;
  mediaType: string;
  /** Signed at serve, ~1h, never persisted. Null when the row carries no pixels. */
  url: string | null;
  thumbUrl: string | null;
  caption: string | null;
  approvalStatus: string | null;
  published: PublishRecord | null;
  createdAt: string | null;
  /**
   * WHO IT WAS MADE FOR — the brand named in the frozen brief, or null for her own work.
   *
   * Off `generation_jobs.brand_id`, not off either `deal_id`; see the header for why those two are
   * NULL on every generated row. Null here means "no brand was named", never "we could not tell":
   * a piece made without a brand is a genuinely personal piece, which is the shelf's other section.
   */
  brandId: number | null;
  brandName: string | null;
}

/**
 * The athlete's Studio-made content, newest first.
 *
 * `athleteId` MUST come from `req.athleteId` on an authenticated route — never a client body, query
 * string, or model tool call. Everything below is read for whoever that id names.
 */
export async function listStudioContent(
  athleteId: string,
  opts: { limit?: number } = {},
): Promise<StudioContentItem[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  // ── Query 1 — the asset read, and where tenancy is decided. ──
  //
  // Both joins are many-to-one onto a primary key, so neither multiplies rows: the LIMIT below
  // still counts assets, exactly as it did before the brand came along.
  const assets = await db
    .select({
      id: mediaAssets.id,
      media_type: mediaAssets.media_type,
      gcs_path: mediaAssets.gcs_path,
      gcs_thumb_path: mediaAssets.gcs_thumb_path,
      caption: mediaAssets.caption,
      approval_status: mediaAssets.approval_status,
      created_at: mediaAssets.created_at,
      brand_id: generationJobs.brand_id,
      brand_name: inboxBrands.name,
    })
    .from(mediaAssets)
    // The athlete_id here is the fail-safe described in the header: generation_job_id is a bare
    // uuid with no FK on this side, so an asset pointing at someone else's job must miss the join
    // and read a null brand rather than name their partner on her shelf.
    .leftJoin(
      generationJobs,
      and(
        eq(mediaAssets.generation_job_id, generationJobs.id),
        eq(generationJobs.athlete_id, athleteId),
      ),
    )
    // No predicate: inbox_brands is a global catalog, not anybody's data.
    .leftJoin(inboxBrands, eq(generationJobs.brand_id, inboxBrands.id))
    .where(
      and(
        eq(mediaAssets.athlete_id, athleteId),
        // Studio's own output. Ingested Instagram posts belong to the media library, not here —
        // and per migration 0022 they stay ungated (approval_status NULL) forever.
        eq(mediaAssets.origin, "generated"),
        // A post-kit preview is a by-product of its kit, not something she made (lib/previewAsset.ts).
        notAPreview(),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .orderBy(desc(mediaAssets.created_at))
    .limit(limit);

  if (assets.length === 0) return [];

  // ── Query 2 — bounded by ids query 1 already cleared. No tenancy decision here. ──
  const ids = assets.map((a) => a.id);
  const posts = await db
    .select({
      asset_id: contentPosts.asset_id,
      platform: contentPosts.platform,
      permalink: contentPosts.permalink,
      posted_at: contentPosts.posted_at,
    })
    .from(contentPosts)
    .where(inArray(contentPosts.asset_id, ids));

  // Many posts per asset (reposts). Keep the most recent as the tile's publish state.
  const latest = new Map<string, PublishRecord>();
  for (const p of posts) {
    const prev = latest.get(p.asset_id);
    const at = p.posted_at ? p.posted_at.toISOString() : null;
    if (!prev || (at && (!prev.postedAt || at > prev.postedAt))) {
      latest.set(p.asset_id, { platform: p.platform, permalink: p.permalink, postedAt: at });
    }
  }

  const sign = (p: string | null) => (p ? signedUrl(p) : Promise.resolve(null));

  const items = await Promise.all(
    assets.map(async (a): Promise<StudioContentItem> => {
      const url = await sign(a.gcs_path);
      return {
        assetId: a.id,
        mediaType: a.media_type,
        url,
        thumbUrl: a.gcs_thumb_path ? await sign(a.gcs_thumb_path) : url,
        caption: a.caption,
        approvalStatus: a.approval_status,
        published: latest.get(a.id) ?? null,
        createdAt: a.created_at ? a.created_at.toISOString() : null,
        brandId: a.brand_id ?? null,
        brandName: a.brand_name ?? null,
      };
    }),
  );

  logger.debug({ athleteId, count: items.length }, "studio content read");
  return items;
}
