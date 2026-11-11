/**
 * media.ts — read API for the athlete's own durable media library (media_assets).
 *
 * GET /api/v1/me/media — the connected athlete's re-hosted posts, newest first,
 * keyset-paginated by (posted_at, id). Top-level items only (IMAGE|VIDEO|REELS|
 * CAROUSEL_ALBUM); CAROUSEL_CHILD rows are nested under their album parent, not
 * returned as top-level entries. Signed URLs are generated fresh per request
 * (~1 h TTL) and never persisted. status='stored' only. Athlete-scoped.
 */
import { notAPreview } from "../lib/previewAsset";
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { requireAuth } from "../lib/auth";
import { db } from "../db";
import { mediaAssets, athletes } from "../../shared/schema";
import type { MediaAsset } from "../../shared/schema";
import { and, eq, lt, or, isNull, inArray, sql, desc, ne } from "drizzle-orm";
import { containsPattern } from "../lib/likePattern";
import {
  signedUrl, signedUploadUrl, uploadKind, uploadObjectPath, UPLOAD_LIMITS,
  reviewObjectPath, deleteObject, deletePrefix,
} from "../lib/mediaStore";
import { enrichNextChunk } from "../services/mediaEnrichment";
import { normalizeStoredImage } from "../studio/orient";
import { probeDurationSeconds } from "../studio/video/probe";
import { tagAsset } from "../lib/visionTag";
import { tagProfileFor } from "../lib/tagProfile";
import { embedImageGcs, embedText } from "../lib/mediaEmbed";
import { cameraRollIntakeEnabled, intakeConfig } from "../lib/cameraRollIntake";
import { carryFor, countToday, purgeOld, recordScored, scrubSession, type Carry, type ScoredPreview } from "../services/reviewItems";
import { LOOKING_FOR_MAX_CHARS, REVIEW_ITEM_KINDS, type ReviewItemKind } from "../../shared/cameraRollIntake";
import { moderateGcsImage } from "../lib/moderation";
import { reviewCandidates, rollReviewConfig, centroid, cosine, type ReviewCandidate } from "../lib/rollReview";
import { createLogger } from "../logger";
import { clipReadStateOf, readInputOf } from "../studio/enrich/readState";
import { libraryFieldsEnabled } from "../studio/config";
import { CHAIN_IDENTITY_BOUND_SQL, madeHereNotHer, photoRankSql, rankOf } from "../studio/referenceGate";
import { faceOf } from "../lib/visionTag";

const PHOTO_TYPES = ["IMAGE", "CAROUSEL_ALBUM"];
const VIDEO_TYPES = ["VIDEO", "REELS"];

/**
 * PR 12 lane 3 — THE PHOTO RANK on the shared library: the ONE expression both lists sort on
 * (studio/referenceGate.ts PHOTO_RANK_SQL — tiers documented there). A video ranks off its poster
 * tag, on every tab (ruling 24 Sep). Read only with STUDIO_LIBRARY_FIELDS on — off, the query and
 * the response are byte-identical to before. On, its identity arm is the chain rule (ADI-R19-BOARD).
 */
const PHOTO_RANK = sql`(${sql.raw(photoRankSql(true))})`;

/**
 * Her standing for each made-here row on a page, by the chain rule (ADI-R19-BOARD: an edit of her upload is her),
 * one query under her athlete id — so "Made here · not from you" is the rule's fact, never the tag's. Keyed by ASSET:
 * two edits from one job's source can differ in their chains. Only with STUDIO_LIBRARY_FIELDS on.
 */
async function standingOf(athleteId: string, rows: readonly MediaAsset[]): Promise<Map<string, boolean | null>> {
  const ids = rows.filter((r) => r.generation_job_id).map((r) => r.id);
  const out = new Map<string, boolean | null>();
  if (!ids.length) return out;
  const found = await db.select({
    id: mediaAssets.id,
    bound: sql<boolean | null>`(${sql.raw(CHAIN_IDENTITY_BOUND_SQL)})`,
  }).from(mediaAssets).where(and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.id, ids)));
  for (const f of found) out.set(f.id, f.bound);
  return out;
}

/** The subject a tile says: the ternary, else the pre-ternary boolean (R-3), else null. */
function subjectOfVision(vision: Record<string, unknown> | null): string | null {
  const s = vision?.subject;
  if (s === "the_athlete" || s === "another_person" || s === "nobody") return s;
  return vision?.athlete_present === true ? "the_athlete" : null;
}

/** PR 12 lane 3: the tile's facts, the same four names and shapes the Studio picker consumes (MediaPhoto). */
function tileFields(vision: Record<string, unknown> | null): { tagged: boolean; subject: string | null; hero: number | null; reject: boolean } {
  const tagged = !!vision;
  const hero = typeof vision?.hero_suitability === "number" ? vision.hero_suitability : null;
  return { tagged, subject: tagged ? subjectOfVision(vision) : null, hero, reject: tagged && vision?.disposition === "reject" };
}

const logger = createLogger("routes/media");
const router = Router();
const PAGE = 24;
const TOP  = 10;

const signOrNull = (p: string | null) => (p ? signedUrl(p) : Promise.resolve(null));

/** Sign URLs + attach carousel children + surface stat fields (views/reach/saves/shares) for a row set. */
async function shapeItems(rows: MediaAsset[], athleteId: string): Promise<Record<string, unknown>[]> {
  // Ruling 24 Sep, as ADI-R19-BOARD's chain rule (flag on): her standing for every made-here row on the page.
  const identityBound = libraryFieldsEnabled() ? await standingOf(athleteId, rows) : new Map<string, boolean | null>();
  const albumIds = rows.filter((r) => r.media_type === "CAROUSEL_ALBUM" && r.source_media_id).map((r) => r.source_media_id!);
  const kidsByParent = new Map<string, MediaAsset[]>();
  if (albumIds.length) {
    const kids = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), inArray(mediaAssets.parent_media_id, albumIds)))
      .orderBy(desc(mediaAssets.id));
    for (const k of kids) {
      const arr = kidsByParent.get(k.parent_media_id!) ?? [];
      arr.push(k); kidsByParent.set(k.parent_media_id!, arr);
    }
  }
  const num = (v: unknown) => (v == null ? null : Number(v));
  return Promise.all(rows.map(async (r) => {
    const url     = await signOrNull(r.gcs_path);
    const isVideo = (r.content_type ?? "").startsWith("video/") || VIDEO_TYPES.includes(r.media_type);
    // What the bytes at gcs_path ARE decides what the client may do with them, not media_type:
    //   • an Instagram VIDEO/REELS row usually holds only the POSTER (image/jpeg or image/webp) —
    //     the mp4 is fetched for the top performers alone. That poster is the grid image.
    //   • an uploaded video (or a top-performer) holds the mp4; its poster, when made, is in
    //     gcs_thumb_path. Until then there is NO image to show, and thumb_url must say so
    //     rather than hand <Image> an mp4 URL.
    // Before this, thumb_url fell back to `url` for both, and the client — to survive case two —
    // refused every video without gcs_thumb_path. That hid 203 of Mia's 212 clips as grey tiles.
    const videoBytes = (r.content_type ?? "").startsWith("video/");
    const thumb   = r.gcs_thumb_path ? await signOrNull(r.gcs_thumb_path) : videoBytes ? null : url;
    const ins = (r.insights ?? {}) as Record<string, unknown>;
    const vision = ((r.metadata as any)?.vision ?? null) as null | { brand_safe?: boolean; shot_type?: string; brands_visible?: string[] };
    const item: Record<string, unknown> = {
      id: r.source_media_id, asset_id: r.id,
      gcs_path: r.gcs_path,                       // durable pick id — card overrides key on gcsPath
      platform: r.platform, origin: r.origin,     // origin → the picker's source badge (Instagram / Uploaded)
      media_type: r.media_type, permalink: r.permalink,
      caption: r.caption, posted_at: r.posted_at, like_count: r.like_count, comments_count: r.comments_count,
      views: num(ins.video_views), reach: num(ins.reach), saves: num(ins.saved), shares: num(ins.shares),
      // poster in the grid; mp4 in the expanded view — only when we actually hold an mp4
      url, thumb_url: thumb, video_url: isVideo && videoBytes ? url : null,
      // durable poster path (video override carries it): the made poster, else the stored still
      poster_gcs_path: r.gcs_thumb_path ?? (isVideo && !videoBytes ? r.gcs_path : null),
      // TWO DURATIONS, BOTH SERVED, because they answer different questions and the client is
      // entitled to know which it has. `duration_seconds` is the whole second the upload picker
      // asserted — unchanged, and still what the library grid's fmtDur renders. The precise one is
      // what ffprobe MEASURED (migration 0058) and is the only one a timeline may do arithmetic
      // with; it is NULL whenever nothing has been able to measure the row, which for most
      // Instagram video rows is permanent — they hold a poster JPEG, not an mp4.
      //
      // ADDITIVE. Nothing is renamed or removed, so a client that only knows the old key is
      // unaffected, and one that prefers the new key falls back to the old one on a null.
      duration_seconds: r.duration_seconds ?? null,
      duration_seconds_precise: r.duration_seconds_precise ?? null,
      enriched: !!vision,                          // false ⇒ still "processing" (held out of auto-curation)
      brand_safe: vision?.brand_safe ?? null, shot_type: vision?.shot_type ?? null,
      brands_visible: vision?.brands_visible ?? [],
      // PR 12 lane 3: additive, and only with the flag on — off, this object is exactly what it was.
      ...(libraryFieldsEnabled()
        ? {
            ...tileFields(vision as Record<string, unknown> | null),
            face: faceOf(vision as Record<string, unknown> | null),
            madeHereNotHer: madeHereNotHer({ origin: r.origin, identityBound: identityBound.get(r.id) ?? null }),
          }
        : {}),
    };
    if (r.media_type === "CAROUSEL_ALBUM") {
      const kids = kidsByParent.get(r.source_media_id!) ?? [];
      item.children = await Promise.all(kids.map(async (k) => ({ id: k.source_media_id, media_type: k.media_type, url: await signOrNull(k.gcs_path) })));
    }
    return item;
  }));
}

router.get("/media", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const cPosted  = typeof req.query.cursor_posted === "string" ? new Date(req.query.cursor_posted) : null;
  const cId      = typeof req.query.cursor_id === "string" ? req.query.cursor_id : null;
  // PR 12 lane 3: the rank the previous page ended on, on a ranked list's cursor only.
  const cHeroRaw = typeof req.query.cursor_hero === "string" ? Number(req.query.cursor_hero) : null;
  const cHero    = cHeroRaw !== null && Number.isFinite(cHeroRaw) ? cHeroRaw : null;
  const platform = typeof req.query.platform === "string" ? req.query.platform : null;
  const source   = typeof req.query.source === "string" ? req.query.source : null;   // origin: connected|upload|generated|discovery
  const typeQ    = typeof req.query.type === "string" ? req.query.type : null;   // 'photos' | 'videos'
  const q        = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const typeCond = typeQ === "photos" ? inArray(mediaAssets.media_type, PHOTO_TYPES)
                 : typeQ === "videos" ? inArray(mediaAssets.media_type, VIDEO_TYPES) : undefined;
  // Search over what the vision agent saw (description / brands / shot_type / setting / attire / vibe)
  // + the post caption. Restricted to metadata.vision so the embedding vector isn't scanned.
  const qCond = q.length >= 2
    ? or(sql`(${mediaAssets.metadata} -> 'vision')::text ILIKE ${containsPattern(q)}`, sql`${mediaAssets.caption} ILIKE ${containsPattern(q)}`)
    : undefined;
  try {
    // Keyset cursor on (posted_at DESC, id DESC). Non-null posted_at is the common case;
    // the rare null-posted_at tail is a v1 simplification (falls to the last page).
    // PR 12 lane 3: photos, flag on → hero first. A ranked page's cursor carries `hero`, and the
    // "after" is rank-then-date. ⚠️ MUTATION (media.test "media list order changes with
    // STUDIO_LIBRARY_FIELDS off"): drop `libraryFieldsEnabled()` from `ranked` — reds by name.
    const ranked = libraryFieldsEnabled(); // every tab — a video ranks off its poster tag (ruling 24 Sep)
    const byDate = cPosted && cId
      ? or(lt(mediaAssets.posted_at, cPosted), and(eq(mediaAssets.posted_at, cPosted), lt(mediaAssets.id, cId)))
      : undefined;
    const cursor = byDate && ranked && cHero !== null
      ? or(sql`${PHOTO_RANK} < ${cHero}`, and(sql`${PHOTO_RANK} = ${cHero}`, byDate))
      : byDate;
    const order = ranked
      ? [sql`${PHOTO_RANK} DESC`, sql`${mediaAssets.posted_at} DESC NULLS LAST`, desc(mediaAssets.id)]
      : [sql`${mediaAssets.posted_at} DESC NULLS LAST`, desc(mediaAssets.id)];

    const rows = await db.select().from(mediaAssets)
      .where(and(
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.parent_media_id),   // top-level only
        ne(mediaAssets.origin, "reference"), notAPreview(),   // a link she gave the direction engine is never her footage (0062)
        ...(platform ? [eq(mediaAssets.platform, platform)] : []),
        ...(source ? [eq(mediaAssets.origin, source)] : []),
        ...(typeCond ? [typeCond] : []),
        ...(qCond ? [qCond] : []),
        ...(cursor ? [cursor] : []),
      ))
      .orderBy(...order)
      .limit(PAGE + 1);

    const hasMore = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const firstPage = !cPosted || !cId;

    const items = await shapeItems(page, athleteId);

    // Summary + Top Performing — first page only (gallery header + top row).
    let summary: unknown = undefined;
    let top: unknown = undefined;
    if (firstPage) {
      const counts = await db.select({
        platform:   mediaAssets.platform,
        media_type: mediaAssets.media_type,
        n:          sql<number>`count(*)::int`,
      }).from(mediaAssets)
        .where(and(
          eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id),
          ne(mediaAssets.origin, "reference"), notAPreview(),
          ...(platform ? [eq(mediaAssets.platform, platform)] : []),
        ))
        .groupBy(mediaAssets.platform, mediaAssets.media_type);
      const by_platform: Record<string, number> = {};
      let total = 0, photos = 0, videos = 0;
      for (const r of counts) {
        by_platform[r.platform] = (by_platform[r.platform] ?? 0) + r.n;
        total += r.n;
        if (r.media_type === "IMAGE" || r.media_type === "CAROUSEL_ALBUM") photos += r.n; else videos += r.n;
      }
      const [ath] = await db.select({ ack: athletes.media_rights_ack_at }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
      summary = { total, by_platform, by_type: { photos, videos }, rights_ack: !!ath?.ack };

      // Ranked by views where we have them (TikTok/YouTube, enriched IG), else by
      // engagement (likes+comments) — matches the views-or-likes stat pill on the tile.
      const topRows = await db.select().from(mediaAssets)
        .where(and(
          eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id),
          ne(mediaAssets.origin, "reference"), notAPreview(),
          ...(platform ? [eq(mediaAssets.platform, platform)] : []),
        ))
        .orderBy(sql`coalesce((${mediaAssets.insights}->>'video_views')::bigint, coalesce(${mediaAssets.like_count}, 0) + coalesce(${mediaAssets.comments_count}, 0)) DESC`)
        .limit(TOP);
      top = await shapeItems(topRows, athleteId);
    }

    const last = page[page.length - 1];
    // The cursor's rank must be PHOTO_RANK_SQL's answer for the last row — so it reads the same
    // identity fact the page did (shapeItems' one query), through the same table (rankOf).
    const heroOf = async (r: MediaAsset): Promise<number> => {
      const v = ((r.metadata as any)?.vision ?? null) as Record<string, unknown> | null;
      const bound = (await standingOf(athleteId, [r])).get(r.id) ?? null;
      return rankOf(v, { origin: r.origin, identityBound: bound });
    };
    res.json({
      items, top,
      next_cursor: hasMore && last ? { posted: last.posted_at, id: last.id, ...(ranked ? { hero: await heroOf(last) } : {}) } : null,
      summary,
    });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "Failed to load media");
    res.status(500).json({ error: "Failed to load media" });
  }
});

// GET /api/v1/me/media/:assetId — one asset with the FULL vision analysis ("What Mila saw") + provenance.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get("/media/:assetId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const assetId = req.params.assetId;
  if (!UUID_RE.test(assetId)) { res.status(404).json({ error: "not found" }); return; }
  try {
    const [row] = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.athlete_id, athleteId))).limit(1);
    if (!row) { res.status(404).json({ error: "not found" }); return; }
    const [shaped] = await shapeItems([row], athleteId);
    const meta = (row.metadata ?? {}) as any;
    const emb = meta.embedding;
    // A VIDEO's clip-read state (PR 9.5, F22 B4): `vision` alone says "poster-tagged", not "read" —
    // `read.state === "done"` (or `vision.beats` being an array) is what "Analyzed" means for a clip.
    const isVideo = (row.content_type ?? "").startsWith("video/");
    const durationS = row.duration_seconds_precise ?? (row.duration_seconds && row.duration_seconds > 0 ? row.duration_seconds : null);
    const read = isVideo ? clipReadStateOf(readInputOf(meta, durationS), new Date()) : null;
    res.json({ ...shaped, vision: meta.vision ?? null, embedded: Array.isArray(emb) && emb.length > 0, read });
  } catch (err: any) {
    logger.error({ athleteId, assetId, error: err.message }, "media detail failed");
    res.status(500).json({ error: "Failed to load media detail" });
  }
});

// POST /api/v1/me/media/upload-url — mint a durable path + short-lived signed WRITE url so the client
// PUTs bytes straight to GCS. Gates the one-time rights acknowledgment. Body: { contentType, bytes?, ackRights? }.
router.post("/media/upload-url", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { contentType, bytes, ackRights } = req.body ?? {};
  const kind = uploadKind(String(contentType ?? ""));
  if (!kind) { res.status(415).json({ error: "Unsupported media type" }); return; }
  if (typeof bytes === "number" && bytes > UPLOAD_LIMITS[kind].max) {
    res.status(413).json({ error: `Too large — ${kind} max ${Math.round(UPLOAD_LIMITS[kind].max / 1048576)}MB` }); return;
  }
  try {
    // one-time rights acknowledgment: block until the athlete has confirmed (or is confirming now)
    const [ath] = await db.select({ ack: athletes.media_rights_ack_at }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (!ath?.ack) {
      if (ackRights !== true) { res.status(428).json({ error: "rights_ack_required" }); return; }
      await db.update(athletes).set({ media_rights_ack_at: new Date() }).where(eq(athletes.id, athleteId));
    }
    const uploadId = randomUUID();
    const ct       = String(contentType).split(";")[0].trim();
    const gcsPath  = uploadObjectPath(athleteId, uploadId, ct);
    const uploadUrl = await signedUploadUrl(gcsPath, ct);
    res.json({ uploadId, gcsPath, uploadUrl, kind, contentType: ct });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "upload-url mint failed");
    res.status(500).json({ error: "Failed to start upload" });
  }
});

// ─── Registration, shared by the two paths that create an upload row ────────────────────────────
// POST /me/media (one deliberate upload) and POST /me/media/review/import (the batch the athlete
// ticked in the camera-roll review) must produce IDENTICAL rows — same straightening, same content
// gate, same enrichment, same shape back. So the body of the register lives here once and both
// routes call it, rather than the second path growing a copy that drifts.
//
// IMAGES ARE STRAIGHTENED BEFORE THEY ARE REGISTERED. A phone portrait is routinely stored landscape
// with an EXIF orientation flag, and the image model we edit through reads the raw buffer and
// ignores that flag (measured — see the studio/orient.ts header). Normalizing here, once, is what
// puts the pixels, the mask coordinates, the frame size in the prompt AND the model's returned
// image in one frame; the per-edit path in studio/generate.ts can only fix the first three, because
// nothing comes back with the provider's output saying what it did.
//
// NEW UPLOADS ONLY, deliberately. Existing library photos keep their flag and keep going through
// the per-edit path, which is unchanged — once an object is stored upright its orientation is 1 and
// that path is a no-op on it, so the two coexist without coordinating.

export interface RegisterInput {
  gcsPath: string;
  contentType: string;
  width?: unknown;
  height?: unknown;
  durationSeconds?: unknown;
  bytes?: unknown;
  /** The photo's REAL capture date (ISO string or epoch ms) — see `postedAtFrom`. */
  createdAt?: unknown;
  /** Set by the camera-roll import; recorded as metadata.review. */
  review?: { sessionId: string; rank?: number; reason?: string; kind?: ReviewItemKind; previewModeration?: Record<string, unknown> | null };
  /**
   * CAMERA_ROLL_INTAKE: what the review already paid for — the preview's tags and embedding, from the server's own
   * record (services/reviewItems.ts), never from the phone. Written as metadata.vision / metadata.embedding so the
   * enrichment worker finds both present and does not tag or embed the row a second time.
   */
  carry?: Pick<Carry, "vision" | "embedding">;
  /** The Mila composer's Product tile: 'product' tags the asset as a Studio product reference. */
  role?: unknown;
}
interface RegisterOutcome { status: number; body: Record<string, unknown> }

/**
 * WHY posted_at TAKES createdAt. Every upload used to be stamped `posted_at = now`, so a photo shot
 * last summer sorted above an Instagram post from yesterday, won every recency tie in the library,
 * in search and in curation, and the column really meant "when did you upload this". The camera roll
 * always knows the capture date and the OS picker usually does, so when the client sends one the row
 * carries the date the photo was TAKEN. Absent or unusable ⇒ `now`, exactly as before. A future date
 * is a wrong device clock, not a fact, so it is clamped.
 */
export function postedAtFrom(createdAt: unknown, now: Date): Date {
  if (createdAt == null || createdAt === "") return now;
  const d = typeof createdAt === "number" ? new Date(createdAt) : new Date(String(createdAt));
  if (Number.isNaN(d.getTime())) return now;
  if (d.getTime() > now.getTime()) return now;
  if (d.getTime() < Date.UTC(1990, 0, 1)) return now;   // pre-digital-camera ⇒ a bad clock, not a date
  return d;
}

async function registerUploadedAsset(athleteId: string, input: RegisterInput): Promise<RegisterOutcome> {
  const { gcsPath, contentType, width, height, durationSeconds, bytes, role } = input;
  const kind = uploadKind(String(contentType ?? ""));
  if (!kind) return { status: 415, body: { error: "Unsupported media type" } };
  // only register objects under THIS athlete's upload prefix (the path we just handed out)
  if (typeof gcsPath !== "string" || !gcsPath.startsWith(`athletes/${athleteId}/uploads/`)) {
    return { status: 400, body: { error: "Invalid gcsPath" } };
  }
  const ct = String(contentType).split(";")[0].trim();

  // Straighten the object in place, and take its TRUE dimensions off the bytes while we have them —
  // `width`/`height` in the body are whatever the client asserted, which is the input class the
  // tenancy rule says never to trust, and they are the reason this column is unreliable today.
  let measured: Awaited<ReturnType<typeof normalizeStoredImage>> = null;
  if (kind === "image") {
    try {
      measured = await normalizeStoredImage(gcsPath, ct);
      if (!measured) {
        // Not a format studio/imageSize.ts can measure — HEIC is accepted for upload and is not
        // parsed. Registering it is right; claiming it was checked would not be.
        logger.info({ athleteId, gcsPath, contentType: ct }, "upload not measurable — stored unverified");
      }
    } catch (err: any) {
      // NO FALLBACK TO THE UN-NORMALIZED BYTES. Storing them is the exact bug this prevents, and it
      // would arrive wearing a row that says the photo was handled. The object stays in GCS
      // unregistered, which keeps it out of her library entirely.
      logger.error({ athleteId, gcsPath, error: err?.message }, "upload normalization failed — not registering");
      return {
        status: 422,
        body: {
          error:
            "We couldn't prepare that photo. It's stored rotated and we straighten it on the way in, " +
            "so an edit lands where you draw it — that step failed, and nothing was added to your " +
            "library. Try uploading it again.",
        },
      };
    }
  }

  // ── A VIDEO'S REAL LENGTH, MEASURED (migration 0058) ────────────────────────────────────────
  //
  // The image branch above takes true dimensions off the bytes because "width/height in the body
  // are whatever the client asserted". `durationSeconds` is the same input class and had the same
  // problem, with two extra ones: it is only ever sent by the OS picker, so a clip that arrived
  // any other way had no duration at all; and the column it landed in is an INTEGER, so the
  // fraction the picker did send was rounded away on arrival.
  //
  // ffprobe reads the container header over the signed URL — it does NOT download the clip, which
  // matters on Cloud Run where /tmp is RAM and a phone capture is tens of MB.
  //
  // FAILS OPEN, and that is the opposite of the image branch one screen up. A photo that could not
  // be straightened is REFUSED, because storing it is the precise bug that code prevents. A clip
  // whose length could not be measured has nothing wrong with it — it is still her video, it still
  // plays, and the only thing missing is a number. Refusing the upload over it would be trading a
  // real loss for a cosmetic one. The row registers; duration_seconds_precise stays NULL or falls
  // back to what the picker said, and the media-poster cron probes it again later.
  let measuredDurationSec: number | null = null;
  if (kind === "video") {
    try {
      measuredDurationSec = await probeDurationSeconds(await signedUrl(gcsPath, 60 * 60_000));
    } catch (err: any) {
      logger.info(
        { athleteId, gcsPath, error: String(err?.message ?? err).slice(0, 200) },
        "upload duration not measurable — registering without a measured duration",
      );
    }
  }

  // THE CONTENT GATE. `brand_safe` from the vision pass is a model's guess about sponsor-
  // friendliness, not moderation, and until this there was no moderation anywhere. SafeSearch runs
  // on the object we are about to register.
  //
  // FAILS OPEN HERE, and fails CLOSED in the camera-roll review — the asymmetry is deliberate and
  // is explained in lib/moderation.ts. In one line: this photo was chosen deliberately, one at a
  // time, so a transient Vision outage must not stop an athlete adding her own picture to her own
  // library; a 500-photo review pass she never looked at is the opposite case.
  //
  // Images only. SafeSearch takes a still, and a video upload has no frame to hand it until the
  // poster exists — videos record `{ skipped: "video" }` so the gap is visible in the row rather
  // than looking like a pass.
  let moderation: Record<string, unknown>;
  if (kind === "image") {
    const verdict = await moderateGcsImage(gcsPath);
    if (verdict.blocked) {
      await deleteObject(gcsPath);   // don't keep bytes we just refused
      logger.warn({ athleteId, gcsPath, categories: verdict.categories }, "upload rejected by content gate");
      return { status: 422, body: { error: "content_rejected", categories: verdict.categories } };
    }
    moderation = verdict.scores ? { ...verdict.scores } : { error: verdict.error ?? "unknown" };
  } else {
    moderation = { skipped: "video" };
  }

  try {
    const now = new Date();
    const metadata: Record<string, unknown> = { moderation };
    if (input.review) metadata.review = input.review;
    if (input.carry) {
      metadata.vision = input.carry.vision;
      metadata.embedding = input.carry.embedding;
      metadata.vision_from = "review_preview";
    }
    // The Mila composer's "Product" tile: a Studio product reference. Kept in metadata (enrichment
    // merges into it, so the tag survives vision/embedding writes). Only this one value is accepted.
    if (role === "product") { metadata.role = "product"; metadata.via = "mila"; }
    const [row] = await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "upload", origin: "upload",
      media_type: kind === "video" ? "VIDEO" : "IMAGE",
      gcs_path: gcsPath, content_type: ct,
      bytes: measured?.bytes ?? (typeof bytes === "number" ? bytes : null),
      // Measured beats asserted. Falls back to the client's numbers only for video and for the
      // formats we cannot read.
      width: measured?.width ?? (typeof width === "number" ? width : null),
      height: measured?.height ?? (typeof height === "number" ? height : null),
      // UNCHANGED BY 0058, deliberately. This column means "what the picker said, in whole
      // seconds", its readers were not asked to change, and the measured value does not go here —
      // one provenance per column. The precision readers prefer the column below and fall back to
      // this one (see video/materialize.ts resolveClips).
      duration_seconds: kind === "video" && typeof durationSeconds === "number" ? Math.round(durationSeconds) : null,
      // MEASURED, else the client's unrounded fraction, else nothing. The fallback is worth having
      // even though it is asserted: the picker's figure is a fraction, which is strictly more than
      // the integer column can hold, and a clip we could not probe is exactly the clip with no
      // other source. NULL stays a real answer — it means "not measured", never "zero".
      duration_seconds_precise:
        kind === "video"
          ? (measuredDurationSec ?? (typeof durationSeconds === "number" ? durationSeconds : null))
          : null,
      status: "stored", posted_at: postedAtFrom(input.createdAt, now), ingested_at: now,
      metadata: metadata as any,
    }).returning();
    // background enrichment — targets un-enriched assets for this athlete (i.e. the one we just added)
    enrichNextChunk({ athleteId }).catch((e: any) => logger.warn({ athleteId, error: e?.message }, "post-upload enrich failed"));
    const [item] = await shapeItems([row], athleteId);
    return { status: 201, body: { item } };
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "media register failed");
    return { status: 500, body: { error: "Failed to save media" } };
  }
}

// POST /api/v1/me/media — register an object the client just PUT to GCS as a media_asset
// (origin=upload) and kick the same enrichment (vision tags + embedding) synced media runs.
// Body: { gcsPath, contentType, width?, height?, durationSeconds?, bytes?, createdAt? }.
// Returns the shaped library item for optimistic insert.
router.post("/media", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { gcsPath, contentType, width, height, durationSeconds, bytes, createdAt, role } = req.body ?? {};
  const out = await registerUploadedAsset(athleteId, { gcsPath, contentType, width, height, durationSeconds, bytes, createdAt, role });
  res.status(out.status).json(out.body);
});

// ─── "Review my camera roll" ────────────────────────────────────────────────────────────────────
//
// Three endpoints, in the order the phone calls them:
//
//   1. POST /me/media/review/upload-url  — a signed PUT for ONE small review THUMBNAIL
//   2. POST /me/media/review             — score a batch of those thumbnails, return keep/more/drop
//   3. POST /me/media/review/import      — upload the ORIGINALS she ticked, register them, bin the rest
//
// The shape of the deal with the athlete: her whole camera roll is looked at, but only ~50 KB
// thumbnails ever leave the phone for scoring, they live under `athletes/<id>/review/<session>/`,
// they are never registered as media_assets, and the import step deletes the session's prefix. A
// bucket lifecycle rule on the `review/` prefix (age 1 day) covers every session she abandons.
// NOTHING is kept unless she ticks it — which is also why the thumbnail mint does NOT require the
// rights acknowledgment: there is nothing to have rights over yet. The ack is asked, as before, on
// the first ORIGINAL upload in step 3.

const SESSION_RE = /^[A-Za-z0-9._-]{1,80}$/;

// POST /api/v1/me/media/review/upload-url — one review thumbnail. Body: { sessionId, itemId, bytes? }.
router.post("/media/review/upload-url", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const cfg = rollReviewConfig();
  const { sessionId, itemId, bytes } = req.body ?? {};
  if (!SESSION_RE.test(String(sessionId ?? "")) || !SESSION_RE.test(String(itemId ?? ""))) {
    res.status(400).json({ error: "Invalid sessionId or itemId" }); return;
  }
  // Thumbnails only, and small ones. The cap is what keeps this an anonymous-ish scan rather than a
  // silent upload of her camera roll at full resolution.
  if (typeof bytes === "number" && bytes > cfg.thumbMaxBytes) {
    res.status(413).json({ error: `Review thumbnail too large — max ${Math.round(cfg.thumbMaxBytes / 1024)}KB` }); return;
  }
  try {
    const gcsPath   = reviewObjectPath(athleteId, String(sessionId), String(itemId));
    const uploadUrl = await signedUploadUrl(gcsPath, "image/jpeg");
    res.json({ gcsPath, uploadUrl, contentType: "image/jpeg", maxBytes: cfg.thumbMaxBytes });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "review upload-url mint failed");
    res.status(500).json({ error: "Failed to start review" });
  }
});

/**
 * The likeness proxy. There is no face-recognition service in this stack and adding one for this is
 * both overkill and a much bigger privacy promise to keep. Instead: the athlete's OWN library
 * already carries a 1408-d multimodal embedding per asset and a vision verdict on whether she is in
 * it, so the mean of the embeddings of the assets she IS in is a serviceable "this is what her
 * photos look like" centroid, and cosine distance to it separates her from her friends' selfies
 * and her screenshots of other people well enough to keep those off the pre-ticked grid.
 *
 * It is a PROXY and it is honest about that: under `likenessMinRefs` reference assets the centroid
 * is too weak to trust, so the rule is skipped entirely and the response says `likenessAvailable:
 * false` rather than quietly applying a bad filter.
 */
async function likenessCentroid(athleteId: string, cfg: ReturnType<typeof rollReviewConfig>): Promise<number[] | null> {
  const rows = await db.select({ metadata: mediaAssets.metadata })
    .from(mediaAssets)
    .where(and(
      eq(mediaAssets.athlete_id, athleteId),
      eq(mediaAssets.status, "stored"),
      isNull(mediaAssets.deleted_at),
      sql`${mediaAssets.metadata} -> 'vision' ->> 'athlete_present' = 'true'`,
      sql`${mediaAssets.metadata} -> 'embedding' IS NOT NULL`,
    ))
    .limit(400);
  const vectors = rows
    .map((r) => (r.metadata as any)?.embedding)
    .filter((e: unknown): e is number[] => Array.isArray(e) && e.length > 0);
  if (vectors.length < cfg.likenessMinRefs) return null;
  return centroid(vectors);
}

/**
 * CAMERA_ROLL_INTAKE — the words a targeted review looks for: what a post action needs (read off the post itself,
 * through the athlete-scoped store), else the words she gave. Null for an untargeted review. Loaded lazily: the agent
 * store is not this router's to build at import.
 */
async function lookingForOf(athleteId: string, target: unknown): Promise<string | null> {
  if (!target || typeof target !== "object") return null;
  const t = target as { forPost?: unknown; lookingFor?: unknown };
  if (typeof t.forPost === "string" && t.forPost) {
    const [{ postNeeds }, { dbPostKitDeps }] = await Promise.all([import("../agent/postKit/intake"), import("../agent/postKit/deps")]);
    const deps = dbPostKitDeps();
    const needs = await postNeeds(deps.store, deps.preferences, athleteId, t.forPost).catch(() => null);
    if (needs) return needs.lookingFor;
  }
  const words = typeof t.lookingFor === "string" ? t.lookingFor.replace(/\s+/g, " ").trim().slice(0, LOOKING_FOR_MAX_CHARS) : "";
  return words || null;
}

/** Raw text↔image cosines are small and bunched (≈0.05–0.2), so a batch's are spread to 0..1 — as searchMedia does. */
export function spreadFit(raw: ReadonlyArray<number | null>): Array<number | null> {
  const nums = raw.filter((v): v is number => v !== null);
  if (!nums.length) return raw.map(() => null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return raw.map((v) => (v === null ? null : hi - lo < 1e-9 ? 0.5 : (v - lo) / (hi - lo)));
}

// POST /api/v1/me/media/review — score a batch of already-uploaded review thumbnails.
// Body: { sessionId, items: [{ itemId, gcsPath, width, height, createdAt?, kind? }], target? }.
// CAMERA_ROLL_INTAKE: `kind` is "photo" | "video" (a video's thumbnail is one phone-made frame); `target` is
// { forPost } (a post action's id) or { lookingFor } (words). Off: both are ignored and the answer is exactly as before.
router.post("/media/review", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const intake = cameraRollIntakeEnabled();
  const icfg = intakeConfig();
  let cfg = rollReviewConfig();
  const { sessionId, items } = req.body ?? {};
  if (!SESSION_RE.test(String(sessionId ?? ""))) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "No items" }); return; }
  if (items.length > cfg.maxItems) {
    res.status(413).json({ error: `Too many items — max ${cfg.maxItems} per call` }); return;
  }
  // Tenancy: every path must be under THIS athlete's review prefix. One bad path fails the batch —
  // a request that reaches for another athlete's objects is not a request to partially honour.
  const prefix = `athletes/${athleteId}/`;
  const bad = items.find((i: any) => typeof i?.gcsPath !== "string" || !i.gcsPath.startsWith(prefix) || !SESSION_RE.test(String(i?.itemId ?? "")));
  if (bad) { res.status(400).json({ error: "Invalid item path" }); return; }
  const kindOf = (i: any): ReviewItemKind => (i?.kind === "video" ? "video" : "photo");
  if (intake && items.some((i: any) => i?.kind !== undefined && !(REVIEW_ITEM_KINDS as readonly unknown[]).includes(i.kind))) {
    res.status(400).json({ error: `Invalid item kind — use one of: ${REVIEW_ITEM_KINDS.join(", ")}` }); return;
  }

  // CAMERA_ROLL_INTAKE: the day's cap, counted on the server's own record. Her old rows go first.
  let usedToday = 0;
  if (intake) {
    await purgeOld(icfg.purgeAfterHours, athleteId).catch(() => 0);
    usedToday = await countToday(athleteId);
    if (usedToday + items.length > icfg.dailyPreviews) {
      res.status(429).json({
        error: `That's the most photos and videos Nomila can look at in one day (${icfg.dailyPreviews}). The rest can be reviewed tomorrow.`,
        code: "daily_limit", limit: icfg.dailyPreviews, used: usedToday,
      });
      return;
    }
  }

  try {
    const cent = await likenessCentroid(athleteId, cfg);
    // CAMERA_ROLL_INTAKE: a targeted review embeds what it looks for once; the words are never put into a prompt.
    const lookingFor = intake ? await lookingForOf(athleteId, req.body?.target) : null;
    const targetVec = lookingFor ? await embedText(lookingFor).catch(() => null) : null;
    if (intake && targetVec) cfg = { ...cfg, fitWeight: icfg.fitWeight };
    // Who the tagger looks for — her row, once for the batch (services/mediaEnrichment.ts).
    const profile = await tagProfileFor(athleteId);

    // Bounded fan-out — the same CONC the enrichment service uses, for the same reason (Vertex quota).
    const CONC = 4;
    const scored: ReviewCandidate[] = [];
    for (let i = 0; i < items.length; i += CONC) {
      const slice = items.slice(i, i + CONC);
      const done = await Promise.all(slice.map(async (it: any): Promise<ReviewCandidate> => {
        const path = String(it.gcsPath);
        // The content gate first — and it is the ONE call whose failure drops the item (fail closed).
        const moderation = await moderateGcsImage(path);
        if (moderation.blocked || moderation.error) {
          return { itemId: String(it.itemId), moderation, tags: null, embedding: null, likeness: null };
        }
        const [tags, embedding] = await Promise.all([tagAsset(path, profile), embedImageGcs(path)]);
        const likeness = cent && embedding ? cosine(embedding, cent) : null;
        return { itemId: String(it.itemId), moderation, tags, embedding, likeness };
      }));
      scored.push(...done);
    }

    if (intake) {
      // The fit to what a targeted review looks for, spread across this batch; then the kind each entry carries.
      const fits = spreadFit(scored.map((c) => (targetVec && c.embedding ? cosine(c.embedding, targetVec) : null)));
      const byId = new Map(items.map((i: any) => [String(i.itemId), kindOf(i)]));
      scored.forEach((c, k) => { c.kind = byId.get(c.itemId) ?? "photo"; c.fit = targetVec ? fits[k] : null; });
      // The server's own record of every scored preview: Import carries from it, the cap counts it.
      const rows: ScoredPreview[] = scored.map((c) => ({
        itemId: c.itemId, kind: c.kind ?? "photo", tags: c.tags, embedding: c.embedding, likeness: c.likeness, fit: c.fit ?? null,
        moderation: c.moderation ? (c.moderation.scores ? { ...c.moderation.scores } : { error: c.moderation.error ?? "unknown" }) : null,
      }));
      await recordScored(athleteId, String(sessionId), rows);
    }

    const outcome = reviewCandidates(scored, cfg);
    res.json({
      ...outcome,
      ...(intake ? { lookingFor, daily: { limit: icfg.dailyPreviews, used: usedToday + items.length } } : {}),
      likenessAvailable: cent != null,
      // Say so out loud rather than letting the client infer it from a missing field.
      likenessNote: cent
        ? null
        : `Skipped the "looks like you" check — it needs at least ${cfg.likenessMinRefs} photos of you already in your library.`,
      cap: { keepCap: cfg.keepCap, perShotType: Math.max(1, Math.floor(cfg.keepCap * cfg.shotTypeShare)) },
    });
  } catch (err: any) {
    logger.error({ athleteId, sessionId, error: err.message }, "camera-roll review failed");
    res.status(500).json({ error: "Review failed" });
  }
});

// POST /api/v1/me/media/review/import — register the ORIGINALS the athlete ticked (already PUT to
// her uploads prefix), then bin the session's thumbnails.
// Body: { sessionId, items: [{ itemId, uploadedGcsPath, contentType, width, height, createdAt?, rank?, reason? }] }.
router.post("/media/review/import", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const cfg = rollReviewConfig();
  const { sessionId, items } = req.body ?? {};
  if (!SESSION_RE.test(String(sessionId ?? ""))) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "No items" }); return; }
  if (items.length > cfg.maxItems) {
    res.status(413).json({ error: `Too many items — max ${cfg.maxItems} per call` }); return;
  }
  const prefix = `athletes/${athleteId}/`;
  if (items.some((i: any) => typeof i?.uploadedGcsPath !== "string" || !i.uploadedGcsPath.startsWith(prefix))) {
    res.status(400).json({ error: "Invalid item path" }); return;
  }

  const imported: Record<string, unknown>[] = [];
  const failed: { itemId: string; status: number; error: string }[] = [];
  // CAMERA_ROLL_INTAKE: what the review already paid for, by item — the server's own record, never the phone's.
  const intake = cameraRollIntakeEnabled();
  const carried = intake ? await carryFor(athleteId, String(sessionId), items.map((i: any) => String(i?.itemId ?? ""))) : new Map<string, Carry>();
  // Sequential: each register straightens and content-checks an object, and a burst of those in
  // parallel buys nothing but contention on the same two APIs.
  for (const it of items) {
    const carry = carried.get(String(it.itemId ?? ""));
    const out = await registerUploadedAsset(athleteId, {
      gcsPath: String(it.uploadedGcsPath),
      contentType: String(it.contentType ?? ""),
      width: it.width, height: it.height, bytes: it.bytes,
      durationSeconds: intake ? it.durationSeconds : undefined,
      createdAt: it.createdAt,
      review: {
        sessionId: String(sessionId),
        ...(typeof it.rank === "number" ? { rank: it.rank } : {}),
        ...(typeof it.reason === "string" ? { reason: it.reason.slice(0, 200) } : {}),
        // A video's preview verdict is kept beside it as a record; the server still checks the clip's own poster.
        ...(carry ? { kind: carry.kind, ...(carry.kind === "video" ? { previewModeration: carry.moderation } : {}) } : {}),
      },
      ...(carry ? { carry: { vision: carry.vision, embedding: carry.embedding } } : {}),
    });
    if (out.status === 201) imported.push(out.body.item as Record<string, unknown>);
    else failed.push({ itemId: String(it.itemId ?? ""), status: out.status, error: String(out.body.error ?? "failed") });
  }

  // Best effort, and deliberately after the registers: the thumbnails are the only copy of the
  // review we can still act on if a register throws, and they cost nothing to keep for one more day
  // (the lifecycle rule takes them anyway).
  deletePrefix(`athletes/${athleteId}/review/${String(sessionId)}/`)
    .then((n) => logger.info({ athleteId, sessionId, deleted: n }, "review thumbnails cleaned up"))
    .catch(() => {});
  // CAMERA_ROLL_INTAKE: nothing about the items she did not pick stays behind (the rows stay, empty, for the cap).
  if (intake) await scrubSession(athleteId, String(sessionId)).catch(() => 0);

  res.status(imported.length ? 201 : 207).json({ imported, failed, importedCount: imported.length });
});

// POST /api/v1/me/media/review/discard — CAMERA_ROLL_INTAKE: she closed the review without importing. The session's
// previews are deleted now (not in a day) and their scores scrubbed. Body: { sessionId }. 404 while the flag is off.
router.post("/media/review/discard", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!cameraRollIntakeEnabled()) { res.status(404).json({ error: "Not found" }); return; }
  const athleteId = req.athleteId!;
  const { sessionId } = req.body ?? {};
  if (!SESSION_RE.test(String(sessionId ?? ""))) { res.status(400).json({ error: "Invalid sessionId" }); return; }
  const [deleted, scrubbed] = await Promise.all([
    deletePrefix(`athletes/${athleteId}/review/${String(sessionId)}/`),
    scrubSession(athleteId, String(sessionId)).catch(() => 0),
  ]);
  res.json({ deleted, scrubbed });
});

export default router;
