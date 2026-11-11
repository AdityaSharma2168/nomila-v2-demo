/**
 * mediaEnrichment — enrich ALL owned media once (docs/media-kit-specs.md Spec 5). For every stored,
 * top-level asset: vision-tag it (metadata.vision) AND embed it (metadata.embedding), so the whole
 * library becomes a searchable index that any process — Nomi Card, post generation, proactive ads —
 * retrieves from by purpose. DECOUPLES enrichment (once, here) from selection (per-purpose, mediaSearch).
 *
 * ROBUSTNESS (mirrors media_backfill_state's pattern):
 * - Resumable + idempotent: skips already-enriched assets; `enrichNextChunk` targets only the
 *   un-enriched, so a cron can tick until the library is done and safely re-run after any failure.
 * - Background + throttled: `enrichNextChunk` does a BOUNDED chunk per call → the cron endpoint runs
 *   it fire-and-forget without holding up the user or agents.
 * - Bounded concurrency (CONC) so we don't hammer Vertex quotas; transient failures just get retried
 *   on the next tick (the asset is still un-enriched).
 *
 * ─── AND A FAILURE THAT WILL NEVER SUCCEED IS NOT A TRANSIENT ONE ──────────────────────────────
 *
 * "Retried on the next tick" above was unbounded, and `UNENRICHED` is
 * `vision IS NULL OR embedding IS NULL` — so a row that tags fine and can NEVER embed stays a
 * candidate forever. Measured 2026-09-09: two 4000x6000 generated frames of ~24.5MB each. Base64 is
 * 4/3, so they are ~32.8M characters against Vertex's 27,000,000 cap and the embed call cannot
 * succeed at any tick. They had been re-downloaded and re-sent every tick for two days.
 *
 * So the brake reads the REASON, because the two failure shapes deserve opposite answers:
 *
 *   OVERSIZE is deterministic. `embedImageGcsWithReason` measures the buffer before it uploads, so
 *     "these bytes are bigger than the API accepts" is known locally and is true forever. There is
 *     nothing to back off from — the row is marked on the FIRST hit, and every later tick is saved
 *     the download.
 *   EVERYTHING ELSE is treated as transient — quota, 5xx, auth, a malformed response — and counts
 *     against MAX_ENRICH_ATTEMPTS, which is set high enough that an outage does not silently
 *     retire a library. The counter is CONSECUTIVE: any success on a row resets it to zero, so a
 *     bad afternoon spread over weeks never accumulates into an abandonment.
 *
 * The marker CLEARS itself on success, and `reEmbed` ignores it outright — so a row abandoned for a
 * reason that later stops applying (a thumbnail arriving, which is what studio/thumbnail.ts does)
 * is one deliberate re-run away from being enriched, never permanently written off.
 */
import { notAPreview } from "../lib/previewAsset";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { tagAsset } from "../lib/visionTag";
import { tagProfileFor } from "../lib/tagProfile";
import { embedImageGcsWithReason } from "../lib/mediaEmbed";
import { createLogger } from "../logger";
import { enrichDailyCapUsd, videoEnrichEnabled } from "../studio/enrich/config";
import { cameraRollIntakeEnabled, intakeConfig, isIntakeRow } from "../lib/cameraRollIntake";
import { mediaVideoFixesEnabled } from "../lib/mediaVideoFixes";

const logger = createLogger("media-enrichment");
const CONC = 4;

/**
 * How many CONSECUTIVE non-deterministic failures a row may take before it stops being a candidate.
 *
 * Ten, and deliberately generous: this budget now only ever covers failures we could NOT explain,
 * so the thing it must not do is retire a healthy library during a provider outage. The
 * deterministic case no longer spends any of it — an oversize row is marked on its first hit — so
 * a high number costs nothing in the case the brake was built for. Any success resets the count,
 * which means ten is ten IN A ROW, not ten ever.
 */
const MAX_ENRICH_ATTEMPTS = Number(process.env.MEDIA_ENRICH_MAX_ATTEMPTS ?? 10);

/** What we have recorded about a row that would not enrich. Lives under `metadata.enrichment`. */
interface EnrichmentState {
  attempts?: number;
  last_attempt_at?: string;
  /** Set on the cap, or immediately on a deterministic failure. Its PRESENCE removes the row from UNENRICHED. */
  abandoned_at?: string;
  /** Which half was still missing when we gave up — the field a human reads first. */
  abandoned_missing?: string[];
  /** "oversize" (deterministic, first hit) or "attempts" (the consecutive-failure budget ran out). */
  abandoned_reason?: "oversize" | "attempts";
}

export interface EnrichResult {
  total: number; embedded: number; tagged: number; skipped: number; failed: number;
  /** Set down this pass (oversize on sight, or the attempt budget). Not a failure: no retry is coming. */
  abandoned: number;
  /** Video rows another run read first — paid for, discarded, not an attempt. 0 on the photo path. */
  raced: number;
}

type Row = { id: string; img: string; metadata: unknown; content_type?: string | null; athleteId: string };


/**
 * The clip lane (studio/enrich/videoEnrichment.ts) still owes this row its beats: a video, the
 * flag on, no `beats` yet. `metadata.enrichment` is one record shared by both lanes, and this
 * lane's "it finally worked" below deleted it — including the clip lane's attempt count, written
 * seconds earlier in the same pass when the clip read failed and this lane then tagged the poster
 * frame. The count restarted from zero on every such pass, so a clip that never reads could never
 * reach abandonment (22 Sep 2026). Same species as the poster worker's transcode write: one lane's
 * whole-record write destroying another lane's state.
 */
const clipStillOwed = (c: Row, patch: Record<string, unknown>): boolean =>
  (videoEnrichEnabled() || (cameraRollIntakeEnabled() && isIntakeRow(patch))) &&
  (c.content_type ?? "").startsWith("video/") &&
  !(patch.vision as { beats?: unknown } | undefined)?.beats;

/** enrich a batch of rows in bounded-parallel; idempotent per asset. */
async function enrichRows(cand: Row[], reEmbed: boolean): Promise<Omit<EnrichResult, "total">> {
  let embedded = 0, tagged = 0, skipped = 0, failed = 0, abandoned = 0;
  for (let i = 0; i < cand.length; i += CONC) {
    const batch = cand.slice(i, i + CONC);
    await Promise.all(batch.map(async (c) => {
      const meta = ((c.metadata as any) ?? {}) as Record<string, unknown>;
      const hasVision = !!meta.vision;
      const hasEmbed = Array.isArray(meta.embedding) && (meta.embedding as unknown[]).length > 0;
      if (hasVision && hasEmbed && !reEmbed) { skipped++; return; }
      const prior = ((meta.enrichment as EnrichmentState | undefined) ?? {});
      // A row already set down stays down unless somebody asked for a re-run. `reEmbed` is the
      // escape hatch — the deliberate "the reason has changed, try again" (a thumbnail landing).
      if (prior.abandoned_at && !reEmbed) { skipped++; return; }

      const patch: Record<string, unknown> = { ...meta };
      let changed = false;
      let progressed = false;
      let deterministic = false;
      if (!hasVision) {
        const t = await tagAsset(c.img, await tagProfileFor(c.athleteId));
        if (t) { patch.vision = t; tagged++; changed = true; progressed = true; } else failed++;
      }
      if (!hasEmbed || reEmbed) {
        const e = await embedImageGcsWithReason(c.img);
        if (e.ok) { patch.embedding = e.embedding; embedded++; changed = true; progressed = true; }
        else { failed++; if (e.reason === "oversize") deterministic = true; }
      }

      // ─── THE TREADMILL BRAKE ──────────────────────────────────────────────────────────────
      //
      // Written even when NOTHING ELSE CHANGED, which is the whole point: the old code only wrote
      // `if (changed)`, so a row that failed both halves left no trace and was indistinguishable
      // next tick from one nobody had ever tried. That is what made the retry loop unbounded.
      const missing = [
        ...(patch.vision ? [] : ["vision"]),
        ...(Array.isArray(patch.embedding) && (patch.embedding as unknown[]).length > 0 ? [] : ["embedding"]),
      ];
      if (missing.length) {
        // CONSECUTIVE, so a success anywhere on this row wipes the slate. A row that embeds fine
        // and merely lost its vision call to a blip must not creep toward abandonment over weeks.
        const attempts = progressed ? 1 : Number(prior.attempts ?? 0) + 1;
        const state: EnrichmentState = { ...prior, attempts, last_attempt_at: new Date().toISOString() };
        // A deterministic failure does not get a budget: retrying identical bytes against a
        // published size limit cannot produce a different answer, and each go costs a full download.
        if (deterministic || attempts >= MAX_ENRICH_ATTEMPTS) {
          state.abandoned_at = new Date().toISOString();
          state.abandoned_missing = missing;
          state.abandoned_reason = deterministic ? "oversize" : "attempts";
          abandoned++;
        }
        patch.enrichment = state;
        changed = true;
      } else if (prior.attempts !== undefined && !clipStillOwed(c, patch)) {
        // It finally worked. Clearing the record matters: a row carrying `attempts: 2` forever
        // would read as a half-broken asset to whoever looks next, and it is not one. Unless the
        // clip lane still owes it beats — then the count is that lane's, and it stays.
        delete patch.enrichment;
        changed = true;
      }

      if (changed) await db.update(mediaAssets).set({ metadata: patch as any, metadata_updated_at: new Date() }).where(eq(mediaAssets.id, c.id));
    }));
  }
  if (abandoned) logger.warn({ abandoned, maxAttempts: MAX_ENRICH_ATTEMPTS }, "assets set down — see metadata.enrichment.abandoned_reason on each");
  return { embedded, tagged, skipped, failed, abandoned, raced: 0 };
}

/**
 * The candidate predicate.
 *
 * The `abandoned_at` clause is what makes the retry loop terminate. Note it reads the KEY rather
 * than a boolean: `->> 'abandoned_at' IS NULL` is true for a row with no metadata at all, for a row
 * with metadata but no `enrichment`, and for a row mid-backoff with attempts recorded and no
 * abandonment — all three of which are still candidates, and all three of which a `= false` test
 * would have silently dropped.
 *
 * ─── AND A VIDEO WITH NO POSTER IS NOT A CANDIDATE YET ─────────────────────────────────────────
 *
 * Enrichment reads `thumb ?? path`. For a video whose poster has not been cut, that is the mp4, and
 * neither the tagger nor the image embedder can read it — so the row failed both halves on every
 * pass, burned all MAX_ENRICH_ATTEMPTS inside ONE cron request (the cron loops this function up to
 * 60 times per request, and each pass re-reads the candidates), and was set down for good, poster or
 * no poster. Measured 2026-09-21: 4 rows, each set down 61–182 s after it was written and 64–74 s
 * after a quarter-hour mark, which is the cron's schedule. Uploads AND generated clips: both land
 * posterless and both wait on the media-poster cron (services/videoPoster.ts), which cuts the
 * poster within about five minutes.
 *
 * So the row simply waits. It is not tried, it counts no attempt and it is not in `remaining`, and
 * the first pass after its poster lands enriches it from a real image.
 *
 * ⚠️ KEYED ON `content_type`, NOT `media_type`, AND THAT IS THE BLAST-RADIUS RULE. The question is
 * "are the bytes enrichment would read a video", and `content_type` is what says so. A synced
 * Instagram VIDEO/REELS row stores its STILL in `gcs_path` with `gcs_thumb_path` null
 * (skills/rehostAthleteMedia.ts) and enriches fine today — and the poster cron never visits origin
 * 'connected'. A `media_type <> 'VIDEO' OR gcs_thumb_path IS NOT NULL` gate would retire every one of
 * those for good. This clause only defers rows that could never enrich as they stand; nothing that
 * can succeed today stops being a candidate.
 *
 * `coalesce` because a null `content_type` must stay a candidate, as it is today — without it the
 * NOT LIKE is null and the row would quietly drop out.
 */
const UNENRICHED = sql`(${mediaAssets.metadata} -> 'vision' IS NULL OR ${mediaAssets.metadata} -> 'embedding' IS NULL)
  AND ${mediaAssets.metadata} -> 'enrichment' ->> 'abandoned_at' IS NULL
  AND (${mediaAssets.gcs_thumb_path} IS NOT NULL OR coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%')`;

/**
 * The rows a pass may enrich: top-level rows, plus — with ENRICH_CAROUSEL_FRAMES on (21 Oct 2026, dev first) — the single
 * photo frames inside her carousel posts. A carousel's frames are often her best photos (a shoot's selects), and a page
 * casting "the best photo of her for this theme" (brand book, curator castBriefs) can only find them once tagged and
 * embedded. Video children stay out (their own lane). Off: exactly the old top-level-only scope.
 */
export const carouselFramesEnabled = (): boolean => process.env.ENRICH_CAROUSEL_FRAMES?.trim().toLowerCase() === "true";
const enrichScope = () => carouselFramesEnabled()
  ? or(isNull(mediaAssets.parent_media_id), sql`coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%'`)!
  : isNull(mediaAssets.parent_media_id);

/** The estimated cost of enriching one photo (tag + embed), USD — the retag's measured tag cost plus the embed. */
export const ENRICH_USD_PER_PHOTO = 0.005;

/**
 * The carousel-frame backfill: frames not yet tagged or embedded, for one athlete. `apply` false only counts (the quote);
 * true enriches at most `limit` through the same door and the same unit of work (enrichRows) as every pass.
 */
export async function enrichCarouselFrames(athleteId: string, opts: { limit: number; apply: boolean }): Promise<{ candidates: number; usd: number; result?: EnrichResult }> {
  const conds = [eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), sql`${mediaAssets.parent_media_id} IS NOT NULL`,
    sql`coalesce(${mediaAssets.content_type}, '') NOT LIKE 'video/%'`, ne(mediaAssets.origin, "reference"), notAPreview(), UNENRICHED];
  const rows = await db.select({ id: mediaAssets.id, thumb: mediaAssets.gcs_thumb_path, path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, content_type: mediaAssets.content_type })
    .from(mediaAssets).where(and(...conds)).limit(opts.limit);
  const cand: Row[] = rows.map((r) => ({ id: r.id, img: (r.thumb ?? r.path)!, metadata: r.metadata, content_type: r.content_type, athleteId })).filter((r) => r.img);
  const quote = { candidates: cand.length, usd: Number((cand.length * ENRICH_USD_PER_PHOTO).toFixed(4)) };
  if (!opts.apply || !cand.length) return quote;
  const run = chain.then(() => enrichRows(cand, false));
  chain = run.catch(() => undefined);
  const res = await run;
  return { ...quote, result: { total: cand.length, ...res } };
}

/** Full enrichment for one athlete (backfill / on-demand). opts.limit caps a controlled run. */
export async function enrichAthleteMedia(athleteId: string, opts: { limit?: number; reEmbed?: boolean } = {}): Promise<EnrichResult> {
  const rows = await db.select({ id: mediaAssets.id, thumb: mediaAssets.gcs_thumb_path, path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, content_type: mediaAssets.content_type })
    .from(mediaAssets)
    // origin 'reference' (0062): a picture she pointed the direction engine at — read by that engine alone,
    // never tagged or embedded as hers, so it can never surface in a search of her library.
    .where(and(eq(mediaAssets.athlete_id, athleteId), eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), ne(mediaAssets.origin, "reference"), notAPreview()))
    .limit(opts.limit ?? 100000);
  const cand: Row[] = rows.map((r) => ({ id: r.id, img: (r.thumb ?? r.path)!, metadata: r.metadata, content_type: r.content_type, athleteId })).filter((r) => r.img);
  const res = await enrichRows(cand, !!opts.reEmbed);
  const result = { total: cand.length, ...res };
  logger.info({ athleteId, ...result }, "media enrichment (athlete) complete");
  return result;
}

/**
 * ONE bounded, resumable chunk of UN-enriched assets — for the background cron. Returns how many
 * remain so the caller/cron knows whether to tick again. Optionally scoped to one athlete.
 *
 * SERIALISED IN-PROCESS. Every caller — the cron request, the post-upload kick, the post-poster
 * kick, the backfill — goes through this one door, and the door admits one run at a time: a call
 * that arrives while another is in flight waits for it, then selects its own candidates against
 * the rows the earlier run has already written. The video path's per-run budget assumes exactly
 * one runner (studio/enrich/videoCost.ts), and two runs selecting the same clip is a read paid for
 * twice (its compare-and-set keeps the data right, `raced` counts the money). Across instances the
 * compare-and-set is still the only guard; this closes the in-process case, which is every local
 * run and every same-instance overlap.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * THE TRANSCRIPT BACKFILL (CAMERA_ROLL_INTAKE): one bounded pass over her clips that were read before what is said was
 * written down — her uploads (camera-roll imports included) and her synced Instagram videos whose mp4 we hold. Each is
 * read again in FULL by the same call an imported clip gets (transcript, speech, music, steadiness, signals). Through
 * the SAME door as every run, so it never reads a clip a cron pass is reading.
 *
 * Rate-limited three ways: `chunk` clips a pass (TRANSCRIPT_BACKFILL_PER_TICK, default 4), the clip lane's per-run
 * budget (STUDIO_VIDEO_ENRICH_MAX_RUN_USD), and the athlete's daily cap (STUDIO_ENRICH_DAILY_CAP_USD, else the intake's
 * CAMERA_ROLL_INTAKE_CLIP_DAILY_USD — never absent). Resumable by construction: a clip with a transcript is no longer a
 * candidate; a clip that keeps failing is set down under its own key (metadata.transcript_backfill), never the lane's.
 * Off with the flag: returns without reading anything.
 *
 * Transcripts stay on her own media rows — private to her account, never on her public page, never used for training.
 */
export function backfillTranscripts(opts: { athleteId?: string; chunk?: number; now?: () => Date } = {}): Promise<import("../studio/enrich/videoEnrichment").VideoEnrichResult | null> {
  if (!cameraRollIntakeEnabled()) return Promise.resolve(null);
  const run = chain.then(async () => {
    const { enrichVideoChunk } = await import("../studio/enrich/videoEnrichment.js");
    return enrichVideoChunk({
      athleteId: opts.athleteId, rereadForSpeech: true, now: opts.now,
      chunk: opts.chunk ?? transcriptBackfillPerTick(),
      dailyCapUsd: enrichDailyCapUsd() ?? intakeConfig().clipReadDailyUsd,
    });
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Clips the transcript backfill reads per pass. */
export const transcriptBackfillPerTick = (): number => {
  const n = Number(process.env.TRANSCRIPT_BACKFILL_PER_TICK);
  return Number.isInteger(n) && n > 0 && n <= 50 ? n : 4;
};

/**
 * ONE clip, on demand (PR 9.5, F22 B2) — through the SAME door, so a user's tap and a cron pass in
 * flight never read the same clip twice in this process. Nothing but the video lane runs: no photo
 * tagging, no embedding. The caller (studio/enrich/clipRead.ts) has already checked the flags.
 */
export function enrichOneClip(opts: { athleteId: string; assetId: string; now?: () => Date }): Promise<import("../studio/enrich/videoEnrichment").VideoEnrichResult> {
  const run = chain.then(async () => {
    const { enrichVideoChunk } = await import("../studio/enrich/videoEnrichment.js");
    return enrichVideoChunk({ athleteId: opts.athleteId, assetId: opts.assetId, chunk: 1, now: opts.now });
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * ONE photo, on demand (PR 19, ADI-R19-BOARD4) — the Studio price check's read of a photo it would otherwise refuse as
 * unread. Through the SAME door as every other run, so a price check and a cron pass never tag the same photo twice in
 * this process, and through the SAME unit of work (`enrichRows`): the same fields (vision, embedding) by the same
 * tagger and embedder, skipped when both are there, never tried on a row set down. It is the read the cron would have
 * made, made now — the cron then finds the row done. Read under HER athlete id; returns the row's metadata after the
 * run, or null when the row is not hers or not a candidate.
 */
export function enrichOnePhoto(opts: { athleteId: string; assetId: string }): Promise<unknown | null> {
  const run = chain.then(async () => {
    const own = and(eq(mediaAssets.id, opts.assetId), eq(mediaAssets.athlete_id, opts.athleteId));
    const [r] = await db.select({ id: mediaAssets.id, thumb: mediaAssets.gcs_thumb_path, path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, content_type: mediaAssets.content_type })
      .from(mediaAssets)
      .where(and(own, eq(mediaAssets.status, "stored"), isNull(mediaAssets.parent_media_id), ne(mediaAssets.origin, "reference"), notAPreview()));
    const img = r ? (r.thumb ?? r.path) : null;
    if (!r || !img) return null;
    await enrichRows([{ id: r.id, img, metadata: r.metadata, content_type: r.content_type, athleteId: opts.athleteId }], false);
    const [after] = await db.select({ metadata: mediaAssets.metadata }).from(mediaAssets).where(own);
    return after?.metadata ?? null;
  });
  chain = run.catch(() => undefined);
  return run;
}

export function enrichNextChunk(opts: { athleteId?: string; chunk?: number } = {}): Promise<EnrichResult & { remaining: number }> {
  const run = chain.then(() => enrichNextChunkNow(opts));
  chain = run.catch(() => undefined);
  return run;
}

async function enrichNextChunkNow(opts: { athleteId?: string; chunk?: number }): Promise<EnrichResult & { remaining: number }> {
  const chunk = opts.chunk ?? 20;

  // ─── THE VIDEO PATH (C2 Half A) — behind STUDIO_VIDEO_ENRICH, default off ──────────────────
  //
  // With the flag off this block is inert: the module is not loaded and a video row is tagged from
  // its poster, below, exactly as before. With it on, clips not yet read AS clips are tagged first
  // (whole-clip fields + beats into metadata.vision, via jsonb_set on that one key — see
  // studio/enrich/videoEnrichment.ts), so the photo path then finds `vision` present and only
  // embeds. Its own candidates and its own `remaining`, added to this pass's. A run that stops on
  // the video cap reports `remaining > 0` and the next pass resumes it.
  //
  // ITS COUNTS JOIN THIS PASS'S. The cron (server/index.ts) stops ticking on `total === 0`, and on
  // the first live pass `total` was the photo path's alone — 0 while 59 clips waited — so every
  // request did exactly one chunk. `total`, `tagged` and `failed` are summed across both paths.
  const video = { total: 0, tagged: 0, failed: 0, abandoned: 0, raced: 0, remaining: 0 };
  // CAMERA_ROLL_INTAKE: a clip she imported through a review gets its FULL read (what happens and when, a transcript,
  // quality signals) even with the Studio clip lane off — then ONLY such clips are read, under a daily cap that is
  // never absent (STUDIO_ENRICH_DAILY_CAP_USD, else the intake's own).
  const intake = cameraRollIntakeEnabled();
  if (videoEnrichEnabled() || intake) {
    const { enrichVideoChunk } = await import("../studio/enrich/videoEnrichment.js");
    const onlyIntake = !videoEnrichEnabled();
    const v = await enrichVideoChunk({
      athleteId: opts.athleteId,
      ...(onlyIntake ? { onlyIntake: true, dailyCapUsd: enrichDailyCapUsd() ?? intakeConfig().clipReadDailyUsd } : {}),
      ...(intake ? { full: (c: { metadata: unknown }) => mediaVideoFixesEnabled() || isIntakeRow(c.metadata) } : {}),
    });
    video.total = v.total; video.tagged = v.tagged; video.failed = v.failed;
    video.abandoned = v.abandoned; video.raced = v.raced; video.remaining = v.remaining;
  }

  // origin 'reference' (0062) is never a candidate: a picture she pointed the direction engine at is
  // read by that engine alone — tagging or embedding it would make it searchable as hers.
  const conds = [eq(mediaAssets.status, "stored"), enrichScope(), ne(mediaAssets.origin, "reference"), notAPreview(), UNENRICHED];
  if (opts.athleteId) conds.push(eq(mediaAssets.athlete_id, opts.athleteId));
  const rows = await db.select({ id: mediaAssets.id, thumb: mediaAssets.gcs_thumb_path, path: mediaAssets.gcs_path, metadata: mediaAssets.metadata, content_type: mediaAssets.content_type, athleteId: mediaAssets.athlete_id })
    .from(mediaAssets).where(and(...conds)).limit(chunk);
  const cand: Row[] = rows.map((r) => ({ id: r.id, img: (r.thumb ?? r.path)!, metadata: r.metadata, content_type: r.content_type, athleteId: r.athleteId })).filter((r) => r.img);
  const res = await enrichRows(cand, false);

  const remConds = [eq(mediaAssets.status, "stored"), enrichScope(), ne(mediaAssets.origin, "reference"), notAPreview(), UNENRICHED];
  if (opts.athleteId) remConds.push(eq(mediaAssets.athlete_id, opts.athleteId));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(mediaAssets).where(and(...remConds));
  const result = {
    total: cand.length + video.total,
    ...res,
    tagged: res.tagged + video.tagged,
    failed: res.failed + video.failed,
    abandoned: res.abandoned + video.abandoned,
    raced: video.raced,
    remaining: Number(n) + video.remaining,
  };
  logger.info({ ...opts, ...result }, "media enrichment chunk done");
  return result;
}
