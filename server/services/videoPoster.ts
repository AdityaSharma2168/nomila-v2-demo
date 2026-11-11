/**
 * videoPoster.ts — the media-poster worker (driven by the media-poster-cron, mirroring
 * media-enrich-cron). Uploaded AND Studio-generated videos land with NO poster
 * (gcs_thumb_path NULL), so the library grid can't render them — routes/media.ts will not
 * hand <Image> an mp4 url, so a posterless clip is an empty tile. For each such video this
 * worker, via ffmpeg:
 *
 *   0. DURATION (best-effort, migration 0058) — one ffprobe of the container header against the
 *      URL the poster is cut from, written to duration_seconds_precise on the poster's own UPDATE.
 *      A rider: no extra fetch, no extra round trip, and it never costs the poster.
 *   1. POSTER (always) — extract a frame → upload as gcs_thumb_path. This alone makes the
 *      clip visible in the grid, and it removes the row from the work queue (so failures
 *      below never cost us the poster).
 *   2. TRANSCODE (best-effort) — re-encode to web-friendly 1080p H.264 (faststart) to cut
 *      storage + playback egress. On success we repoint gcs_path at the transcode and stash
 *      the original path in metadata.original_gcs_path; on any failure we keep the original.
 *
 * ffmpeg reads straight from a signed GCS URL (streams — never buffers the input in memory,
 * which matters on Cloud Run where /tmp is RAM) and writes only the small outputs to /tmp.
 * Runs are CPU-bound cron REQUESTS (full CPU), not fire-and-forget (which Cloud Run throttles).
 *
 * Scaling knobs (for the ~1k-user launch): BATCH + the cron interval. At higher upload
 * volume, move to Cloud Tasks / the Google Transcoder API — the row-driven contract here
 * (find posterless videos, set gcs_thumb_path) stays the same.
 *
 * ─── METADATA IS WRITTEN ONE KEY AT A TIME, IN SQL ────────────────────────────────────────────
 *
 * This worker is not the only writer of `metadata` on a row it holds. The poster UPDATE in step 1
 * makes the row a candidate for enrichment at once (its predicate is "video with a poster"), and
 * step 2 then transcodes for up to minutes. Both of this worker's metadata writes used to be
 * `{ ...row.metadata, key }` — the object as read at batch-select time — so whatever enrichment
 * wrote in that window was replaced. Measured 22 Sep 2026 on a 51 s upload: poster at 13:20:05Z,
 * a poster-frame read and the enrichment marker written after it, the transcode's write at
 * 13:20:45Z left `metadata` = {moderation, original_gcs_path} and no trace either had happened.
 * The same race studio/qa/record.ts documents for the enrichment worker's own read-modify-write.
 * Both writes are `jsonb_set` on their one key now, and the poster landing kicks enrichment (see
 * processPosterBatch).
 *
 * ─── MEDIA_VIDEO_FIXES ON (media-intake plan, fixes 3 and 6) ──────────────────────────────────
 *
 * ONE MASTER PER CLIP. Every clip used to be stored twice: the transcode AND the original, kept at
 * metadata.original_gcs_path. With the flag on, the source is probed first (one ffprobe of the container header):
 *   • already H.264 with a short side of 1080 or less → it IS the master; no re-encode, nothing else written
 *   • anything else → re-encoded with its SHORT side capped at 1080 (a portrait 1080×1920 phone clip is 1080p and is
 *     never shrunk — the old `width > 1920 || height > 1080` test shrank exactly those to 608×1080), then the original
 *     is PARKED for deletion: metadata.original_pending_delete = { path, delete_after } (MEDIA_ORIGINAL_KEEP_DAYS,
 *     default 30), and purgeExpiredOriginals (run at the top of every poster batch while the flag is on) deletes it
 *     once that date has passed. Until then a bad re-encode can be undone by pointing gcs_path back at `path`. The
 *     original stays under athletes/<id>/, so an account deletion still takes it. Its device provenance (studio/enrich/provenanceSignal.ts) is read off that same probe first and kept
 *     as metadata.provenance_signal, because the re-encode does not carry the camera's atoms across.
 *
 * A VIDEO IS CONTENT-CHECKED ON ITS POSTER. Uploads registered `moderation: { skipped: "video" }` because there was
 * no frame to hand SafeSearch. The poster is that frame: an UPLOADED clip (origin 'upload' only — never her synced
 * posts, never Studio's own output) is checked here, the verdict replaces the "skipped" marker, and a blocked clip is
 * taken out of her library (deleted_at) and its bytes deleted — the same answer an uploaded photo gets at register.
 * A check that cannot run fails OPEN, as uploads do (lib/moderation.ts): the row keeps `{ error }`. The clip read's
 * own content_flags (hateful / sexual / self-harm) already force reject and unsafe on every clip it reads.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";
import { stat, unlink } from "fs/promises";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { deleteObject, removeObject, signedUrl, uploadLocalFile } from "../lib/mediaStore";
import { probeDurationSeconds } from "../studio/video/probe";
import { MASTER_SHORT_SIDE, mediaVideoFixesEnabled, originalKeepDays } from "../lib/mediaVideoFixes";
import { moderateGcsImage } from "../lib/moderation";
import { ffprobeContainer, scoreProvenance, type ContainerProbe } from "../studio/enrich/provenanceSignal";
import { createLogger } from "../logger";

const logger = createLogger("video-poster");
const execFileP = promisify(execFile);

// ffmpeg needs the https protocol explicitly whitelisted to read the signed GCS URL.
const PROTO = ["-protocol_whitelist", "file,http,https,tcp,tls,crypto"];
const POSTER_TIMEOUT_MS = 45_000;
const TRANSCODE_TIMEOUT_MS = 150_000;
// Per-cron-run time budget — keep the request comfortably under Cloud Run's 300s timeout.
const RUN_BUDGET_MS = 220_000;

/** The post-poster enrichment kick. Dynamic so the poster worker never loads the enrichment worker (and its model clients) until a poster has actually landed. */
async function kick(opts: { athleteId: string }): Promise<unknown> {
  const { enrichNextChunk } = await import("./mediaEnrichment.js");
  return enrichNextChunk(opts);
}

async function fileSize(p: string): Promise<number> {
  try { const s = await stat(p); return s.size; } catch { return 0; }
}
async function rm(p: string): Promise<void> { try { await unlink(p); } catch { /* ignore */ } }

async function ffmpeg(args: string[], timeoutMs: number): Promise<void> {
  // stderr carries ffmpeg progress (can be large) — allow room and don't treat it as failure.
  await execFileP("ffmpeg", ["-y", "-nostdin", ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

type Row = {
  id: string;
  athlete_id: string;
  gcs_path: string | null;
  width: number | null;
  height: number | null;
  metadata: any;
  /** Read with MEDIA_VIDEO_FIXES on: which clips are content-checked, and whose provenance is read. */
  origin?: string | null;
  ingested_at?: Date | null;
};

/** The video stream's size and codec off a container probe, or nulls when the probe has none. */
export function sourceShape(probe: ContainerProbe | null): { width: number | null; height: number | null; codec: string | null } {
  const v = (probe?.streams ?? []).find((st) => st.codec_type === "video") as
    | { width?: unknown; height?: unknown; codec_name?: unknown } | undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
  return { width: n(v?.width), height: n(v?.height), codec: typeof v?.codec_name === "string" ? v.codec_name : null };
}

/**
 * Fix 3: whether the source already IS the master — H.264 with a known short side of 1080 or less. Pure.
 * Unknown size or another codec (HEVC from a phone, ProRes, VP9 …) is re-encoded, so every master plays everywhere.
 */
export function keepAsMaster(shape: { width: number | null; height: number | null; codec: string | null }): boolean {
  if (shape.width === null || shape.height === null) return false;
  return (shape.codec ?? "").toLowerCase() === "h264" && Math.min(shape.width, shape.height) <= MASTER_SHORT_SIDE;
}

/**
 * Fix 3's scale: the SHORT side capped at 1080, never upscaled, both sides even (libx264 + yuv420p need it). The
 * quotes keep the expression's commas inside the one filter; there is no shell — execFile hands it to ffmpeg as is.
 */
export const MASTER_SCALE = `scale='if(lte(iw,ih),trunc(min(iw,${MASTER_SHORT_SIDE})/2)*2,-2)':'if(lte(iw,ih),-2,trunc(min(ih,${MASTER_SHORT_SIDE})/2)*2)'`;

/** Fix 6: an uploaded clip's poster through SafeSearch. "blocked" means the row is gone from her library. */
async function moderatePoster(row: Row, posterPath: string): Promise<"blocked" | "checked"> {
  const verdict = await moderateGcsImage(posterPath);
  if (verdict.blocked) {
    const record = { ...(verdict.scores ?? {}), blocked: true, categories: verdict.categories, on: "poster" };
    await db.update(mediaAssets)
      .set({
        deleted_at: new Date(),
        metadata: sql`jsonb_set(coalesce(${mediaAssets.metadata}, '{}'::jsonb), '{moderation}', ${JSON.stringify(record)}::jsonb)`,
        metadata_updated_at: new Date(),
      } as never)
      .where(eq(mediaAssets.id, row.id));
    if (row.gcs_path) await deleteObject(row.gcs_path);   // don't keep bytes we just refused
    await deleteObject(posterPath);
    logger.warn({ id: row.id, categories: verdict.categories }, "uploaded video rejected by content gate (poster)");
    return "blocked";
  }
  const record = verdict.scores ? { ...verdict.scores, on: "poster" } : { error: verdict.error ?? "unknown", on: "poster" };
  await db.update(mediaAssets)
    .set({
      metadata: sql`jsonb_set(coalesce(${mediaAssets.metadata}, '{}'::jsonb), '{moderation}', ${JSON.stringify(record)}::jsonb)`,
      metadata_updated_at: new Date(),
    })
    .where(eq(mediaAssets.id, row.id));
  return "checked";
}

/** Generate a poster (always) + transcode (best-effort) for one uploaded video. Returns the outcome. */
export async function processOneVideo(row: Row): Promise<"postered" | "transcoded" | "failed" | "blocked"> {
  if (!row.gcs_path) return "failed";
  const fixes = mediaVideoFixesEnabled();
  const srcUrl = await signedUrl(row.gcs_path, 60 * 60_000);
  const posterLocal = join(tmpdir(), `${row.id}-poster.jpg`);
  const transLocal = join(tmpdir(), `${row.id}-1080.mp4`);

  // ── 0) DURATION (migration 0058) — a rider on a URL we have already signed. ──
  //
  // This worker visits every posterless uploaded AND generated clip, so it is where the clips the
  // upload probe could not reach end up: a row whose probe failed, a Studio output, and the
  // Instagram top-performer mp4s that fetchTopVideoFiles swaps in. One ffprobe of a container
  // header, against the same signed URL the poster is about to be cut from — no extra fetch, no
  // extra byte, and it is over before the frame extract starts.
  //
  // BEST-EFFORT AND FIRST. Its own try/catch, ahead of the poster, so a clip ffprobe cannot read
  // still gets its poster — the poster is what makes the clip visible in her library, and it must
  // never be lost over a missing number. The write rides along on the poster's UPDATE below rather
  // than taking a second round trip.
  //
  // Probed from the SOURCE, before the transcode in step 2 repoints gcs_path. A re-encode
  // preserves duration, so the source's reading is the right one either way.
  let probedSeconds: number | null = null;
  try {
    probedSeconds = await probeDurationSeconds(srcUrl);
  } catch (err: any) {
    logger.info({ id: row.id, error: String(err?.message ?? err).slice(0, 200) }, "duration probe failed");
  }

  // ── 1) POSTER — try a frame at 1s, fall back to the very first frame (clips < 1s). ──
  try {
    try {
      await ffmpeg([...PROTO, "-ss", "1", "-i", srcUrl, "-frames:v", "1", "-q:v", "3", posterLocal], POSTER_TIMEOUT_MS);
    } catch { /* seek past the end on a <1s clip — retry from the start */ }
    if ((await fileSize(posterLocal)) === 0) {
      await ffmpeg([...PROTO, "-i", srcUrl, "-frames:v", "1", "-q:v", "3", posterLocal], POSTER_TIMEOUT_MS);
    }
    if ((await fileSize(posterLocal)) === 0) throw new Error("poster frame is empty");

    const posterPath = `athletes/${row.athlete_id}/uploads/${row.id}-poster.jpg`;
    await uploadLocalFile(posterLocal, posterPath, "image/jpeg");
    await db.update(mediaAssets)
      .set({
        gcs_thumb_path: posterPath,
        // Only when we actually measured one — an omitted key leaves the column alone, where
        // `probedSeconds` would write NULL over a value the upload probe had already got right.
        ...(probedSeconds !== null ? { duration_seconds_precise: probedSeconds } : {}),
        metadata_updated_at: new Date(),
      })
      .where(eq(mediaAssets.id, row.id));
    logger.info({ id: row.id, durationSeconds: probedSeconds }, "poster generated");
    // Fix 6: the poster is the frame the upload never had. Her uploads only, and only while still marked unchecked.
    if (fixes && row.origin === "upload" && row.metadata?.moderation?.skipped === "video") {
      if ((await moderatePoster(row, posterPath)) === "blocked") return "blocked";
    }
  } catch (err: any) {
    // Mark the row so the cron doesn't retry a genuinely un-posterable clip forever. ONE key, set in
    // SQL — never `{ ...row.metadata, poster_error }`, which writes back the object as it was at
    // batch-select time and erases whatever landed since (see the header).
    await db.update(mediaAssets)
      .set({
        metadata: sql`jsonb_set(coalesce(${mediaAssets.metadata}, '{}'::jsonb), '{poster_error}', ${JSON.stringify(String(err?.message ?? err).slice(0, 200))}::jsonb)`,
        metadata_updated_at: new Date(),
      })
      .where(eq(mediaAssets.id, row.id))
      .catch(() => {});
    await rm(posterLocal);
    logger.warn({ id: row.id, error: err?.message }, "poster generation failed");
    return "failed";
  } finally {
    await rm(posterLocal);
  }

  // ── 2) TRANSCODE — best-effort; the poster already succeeded above. ──
  // Fix 3 (flag on): one probe of the source — its shape decides whether it already IS the master, and its atoms are
  // the provenance a re-encode would lose.
  const container = fixes ? await ffprobeContainer(srcUrl) : null;
  if (fixes && keepAsMaster(sourceShape(container))) {
    logger.info({ id: row.id, ...sourceShape(container) }, "source kept as the master — no re-encode");
    return "postered";
  }
  try {
    // Only downscale when we KNOW the source exceeds 1080p (avoid upscaling small clips → bigger files).
    const needsDownscale = (row.width ?? 0) > 1920 || (row.height ?? 0) > 1080;
    const vf = fixes
      ? ["-vf", MASTER_SCALE]   // short side ≤ 1080, never upscaled — right for any size, known or not
      : needsDownscale ? ["-vf", "scale=1920:1080:force_original_aspect_ratio=decrease"] : [];
    await ffmpeg([
      ...PROTO, "-i", srcUrl,
      ...vf,
      "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", "-f", "mp4",
      transLocal,
    ], TRANSCODE_TIMEOUT_MS);

    const size = await fileSize(transLocal);
    if (size === 0) throw new Error("transcode output is empty");
    const transPath = `athletes/${row.athlete_id}/uploads/${row.id}-1080.mp4`;
    await uploadLocalFile(transLocal, transPath, "video/mp4");
    if (fixes) {
      // One master: the re-encode replaces the original. The camera's provenance is kept from the probe of the
      // original (a generated clip is ground truth already and has none), then the original is parked for deletion
      // (see the header) — never deleted on the spot, so a bad re-encode can still be undone.
      const provenance = row.origin === "generated" ? null : scoreProvenance(container, { ingestedAt: row.ingested_at ?? null });
      const parked = row.gcs_path !== transPath
        ? { path: row.gcs_path, delete_after: new Date(Date.now() + originalKeepDays() * 86_400_000).toISOString() }
        : null;
      let meta = sql`coalesce(${mediaAssets.metadata}, '{}'::jsonb) - 'original_gcs_path'`;
      if (parked) meta = sql`jsonb_set(${meta}, '{original_pending_delete}', ${JSON.stringify(parked)}::jsonb)`;
      if (provenance) meta = sql`jsonb_set(${meta}, '{provenance_signal}', ${JSON.stringify(provenance)}::jsonb)`;
      await db.update(mediaAssets)
        .set({ gcs_path: transPath, content_type: "video/mp4", bytes: size, metadata: meta, metadata_updated_at: new Date() })
        .where(eq(mediaAssets.id, row.id));
      logger.info({ id: row.id, size, original: row.gcs_path, deleteAfter: parked?.delete_after ?? null }, "re-encoded to the 1080p master; original parked for deletion");
      return "transcoded";
    }
    // ONE key, set in SQL. The transcode can take minutes, and enrichment runs against this row the
    // moment the poster above lands — `{ ...row.metadata, original_gcs_path }` wrote the object as
    // it was at batch-select time over the top of that (measured 22 Sep 2026: a clip's poster read
    // and its enrichment marker both erased 40 s after they were written).
    await db.update(mediaAssets)
      .set({
        gcs_path: transPath, content_type: "video/mp4", bytes: size,
        metadata: sql`jsonb_set(coalesce(${mediaAssets.metadata}, '{}'::jsonb), '{original_gcs_path}', ${JSON.stringify(row.gcs_path)}::jsonb)`,
        metadata_updated_at: new Date(),
      })
      .where(eq(mediaAssets.id, row.id));
    logger.info({ id: row.id, size }, "transcoded to 1080p");
    return "transcoded";
  } catch (err: any) {
    // Keep the original video — the poster already made it usable. Don't fail the row.
    logger.warn({ id: row.id, error: err?.message }, "transcode failed (keeping original)");
    return "postered";
  } finally {
    await rm(transLocal);
  }
}

/**
 * Fix 3's purge: originals parked by a re-encode whose undo window has passed are deleted, a few per tick. The key is
 * dropped only once the bytes are really gone (removeObject), so a failed delete is retried on the next tick. A parked
 * path that is the row's live file, or not under the row's own athlete, is never deleted — only forgotten.
 */
export async function purgeExpiredOriginals(limit = 20, now: Date = new Date()): Promise<number> {
  const rows = await db.select({
    id: mediaAssets.id,
    athlete_id: mediaAssets.athlete_id,
    gcs_path: mediaAssets.gcs_path,
    gcs_thumb_path: mediaAssets.gcs_thumb_path,
    path: sql<string | null>`${mediaAssets.metadata} -> 'original_pending_delete' ->> 'path'`,
  })
    .from(mediaAssets)
    .where(and(
      eq(mediaAssets.media_type, "VIDEO"),
      sql`${mediaAssets.metadata} -> 'original_pending_delete' ->> 'delete_after' <= ${now.toISOString()}`,
    ))
    .limit(limit);
  let purged = 0;
  for (const r of rows) {
    const path = typeof r.path === "string" && r.path ? r.path : null;
    const deletable = path !== null && path !== r.gcs_path && path !== r.gcs_thumb_path && path.startsWith(`athletes/${r.athlete_id}/`);
    if (deletable && !(await removeObject(path))) continue;   // not gone: keep the record, retry next tick
    await db.update(mediaAssets)
      .set({ metadata: sql`${mediaAssets.metadata} - 'original_pending_delete'`, metadata_updated_at: new Date() })
      .where(eq(mediaAssets.id, r.id));
    if (deletable) purged++;
  }
  if (rows.length) logger.info({ purged, seen: rows.length }, "parked originals purged");
  return purged;
}

/** Process a batch of posterless uploaded videos within a wall-clock budget. */
export async function processPosterBatch(limit = 3): Promise<{ processed: number; failed: number; transcoded: number; remaining: number }> {
  // Fix 3 (flag on): originals past their undo window go first. Best effort — the posters never wait on it. With the
  // flag off nothing is parked, and originals are kept as they always were.
  if (mediaVideoFixesEnabled()) {
    await purgeExpiredOriginals().catch((err: any) => logger.warn({ error: String(err?.message ?? err).slice(0, 160) }, "original purge failed"));
  }
  const rows = await db.select({
    id: mediaAssets.id,
    athlete_id: mediaAssets.athlete_id,
    gcs_path: mediaAssets.gcs_path,
    width: mediaAssets.width,
    height: mediaAssets.height,
    metadata: mediaAssets.metadata,
    origin: mediaAssets.origin,
    ingested_at: mediaAssets.ingested_at,
  })
    .from(mediaAssets)
    .where(and(
      // Uploaded clips AND generated ones. Studio video output lands origin='generated', and
      // routes/media.ts correctly refuses to hand <Image> an mp4 url — so without a poster a
      // generated clip renders as nothing at all in the library grid. Same work, same worker; the
      // only thing that made it upload-only was that generated video did not exist yet. And
      // connected ones: fetchTopVideoFiles swaps an Instagram mp4 in with no thumbnail, and this is
      // where it gets its poster, precise duration and original_gcs_path (PR 4, Mia-approved).
      inArray(mediaAssets.origin, ["upload", "generated", "connected"]),
      eq(mediaAssets.media_type, "VIDEO"),
      eq(mediaAssets.status, "stored"),
      isNull(mediaAssets.gcs_thumb_path),
      sql`${mediaAssets.content_type} like 'video/%'`,
      sql`coalesce(${mediaAssets.metadata}->>'poster_error', '') = ''`,
    ))
    .orderBy(mediaAssets.created_at)
    .limit(limit);

  const started = Date.now();
  let processed = 0, failed = 0, transcoded = 0;
  const postered = new Set<string>();
  for (const row of rows) {
    if (Date.now() - started > RUN_BUDGET_MS) break;   // leave the rest for the next tick
    const r = await processOneVideo(row as Row);
    if (r === "failed" || r === "blocked") failed++;
    else { processed++; if (r === "transcoded") transcoded++; postered.add(row.athlete_id); }
  }

  // ─── THE RE-KICK: a clip that just got its poster is now enrichable, so say so ─────────────
  //
  // The upload route kicks enrichment the moment a row is registered (routes/media.ts), which for
  // a video is minutes BEFORE this worker cuts its poster — so that kick never sees the clip, and
  // nothing else asks until the next scheduled cron. Measured 22 Sep 2026: a 51 s upload sat
  // enrichable and untouched for half an hour. One kick per athlete, AFTER the loop — i.e. after
  // the transcode, so the enrichment reads the 1080p re-encode rather than a source that may be
  // over the inline ceiling. Same entry point as every other caller (enrichNextChunk serialises
  // in-process), never a parallel path; the per-run budget assumes one runner and keeps it. Not
  // awaited, like the upload kick: on Cloud Run the scheduler remains the guarantee, this is what
  // makes the minutes after a poster lands — and every local run — timely.
  for (const athleteId of postered) {
    void kick({ athleteId }).catch((err: any) =>
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "post-poster enrich failed"),
    );
  }

  // Rough count of what's still waiting (for the cron log / response).
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(and(
      inArray(mediaAssets.origin, ["upload", "generated", "connected"]),
      eq(mediaAssets.media_type, "VIDEO"),
      eq(mediaAssets.status, "stored"),
      isNull(mediaAssets.gcs_thumb_path),
      sql`${mediaAssets.content_type} like 'video/%'`,
      sql`coalesce(${mediaAssets.metadata}->>'poster_error', '') = ''`,
    ));
  return { processed, failed, transcoded, remaining: Number(n) };
}
