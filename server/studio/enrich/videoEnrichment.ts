/**
 * studio/enrich/videoEnrichment — the video path of the enrichment worker.
 *
 * services/mediaEnrichment.ts loads this module ONLY when STUDIO_VIDEO_ENRICH is on, so with the
 * flag off the shared worker's behaviour is byte-for-byte what it was: a video row is tagged from
 * its poster and marked done. With it on, `enrichVideoChunk` runs FIRST in each pass, so a fresh
 * clip whose poster has just landed is tagged from the clip before the photo path would have
 * tagged it from the poster — the poster path then finds `vision` present and only embeds.
 *
 * ─── THE CANDIDATE, exactly ───────────────────────────────────────────────────────────────────
 *
 *   stored · top-level · not deleted
 *   AND content_type LIKE 'video/%'          — the bytes in gcs_path ARE a video (a synced reel
 *                                              stores a JPEG still and is not one; see the
 *                                              content_type-not-media_type rule in mediaEnrichment)
 *   AND gcs_thumb_path IS NOT NULL           — the poster cron has been: the transcode has run and
 *                                              the duration was measured, so the estimate is real
 *   AND metadata -> 'vision' -> 'beats' IS NULL   — not yet read as a clip. `vision` PRESENT is not
 *                                              a skip: every existing video row has poster tags,
 *                                              and those are what this path replaces
 *   AND metadata -> 'enrichment' ->> 'abandoned_at' IS NULL   — the shared brake
 *
 * ─── THE WRITE IS jsonb_set ON THE ONE KEY ────────────────────────────────────────────────────
 *
 * studio/qa/record.ts documents the race in the worker's whole-jsonb read-modify-write: two writers
 * on one row and the later one erases the earlier's key. This path is a second writer beside the
 * first, so it writes `vision` alone — `jsonb_set(coalesce(metadata,'{}'), '{vision}', …)` — and
 * touches `enrichment` the same way. The previous vision object rides along under `vision.prev`
 * (one level: its own `prev` is dropped) so the eval can diff poster-derived against clip-derived
 * on the same rows.
 *
 * ─── WHAT A FAILURE MEANS ─────────────────────────────────────────────────────────────────────
 *
 *   oversize     bytes > videoEnrichMaxBytes(): can never succeed inline → set down at once,
 *                reason "oversize", missing ["beats"]. The poster tags stay; the row stays castable.
 *   cap          the run's budget would be passed by this clip → the RUN stops, the row is left
 *                exactly as found (no attempt, no write). Named: VideoEnrichCapExceeded, logged once.
 *   anything else (download, transport, unparseable) → one consecutive attempt under
 *                metadata.enrichment, the shared budget, the shared abandonment at the cap.
 *
 * ─── EVERY NON-TAGGED ROW IS ONE LOG LINE, WITH THE ASSET ID ──────────────────────────────────
 *
 * Measured on the first live upload over the inline ceiling (22 Sep 2026, a 51 s / 196 MB clip):
 * the oversize branch wrote its marker and said nothing; a null from the reader (absent OR over the
 * cap — readObject answers null for both) fell through as a bare "failed" with no line; an
 * unparseable answer likewise. `grep <asset id>` on the server log found nothing, and the cron
 * response carried neither `abandoned` nor `raced`. Now: one `video not tagged` warn per row with
 * `assetId` and a `reason` from NotTaggedReason; a null read is stat'ed so an oversize OBJECT is
 * set down like an oversize column instead of costing an attempt; and the chunk's `abandoned` and
 * `raced` travel to the cron response (services/mediaEnrichment.ts, index.ts).
 *
 * What this path can NOT defend against is a third writer replacing the whole `metadata` object
 * from a stale read — services/videoPoster.ts did exactly that on its transcode step and erased
 * both a poster read and the enrichment marker on that clip 40 s after they were written. That
 * writer now uses jsonb_set too; see its header.
 *
 * ─── THE FULL READ (MEDIA_VIDEO_FIXES, media-intake plan fix 2) ───────────────────────────────
 *
 * With the flag on, every clip read is a FULL one: the same single call also writes what is said (vision.speech — a
 * timestamped transcript, language, speech and music present) and each beat's steadiness (videoTag.ts FULL_READ_BLOCK),
 * and after a successful write the bytes already in hand get $0 ffmpeg passes for frame rate, loudness, silence, blur,
 * frozen and black frames (metadata.signals, video/signals.ts) — their own catch, like the shots: a clip ffmpeg cannot
 * measure is still a clip that was read. A clip whose device provenance the poster worker already kept (one master,
 * services/videoPoster.ts) is not re-probed: its original is gone, and the re-encode would score worse.
 */
import { notAPreview } from "../../lib/previewAsset";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import { headObject, readObject } from "../../lib/mediaStore";
import { tagProfileFor } from "../../lib/tagProfile";
import { signedUrl } from "../../lib/mediaStore";
import {
  ffprobeContainer,
  scoreProvenance,
  type ContainerProber,
  type ProvenanceSignal,
} from "./provenanceSignal";
import { createLogger } from "../../logger";
import { shotDetectEnabled } from "../config";
import { detectShotsBytes, writeShots } from "../video/shots";
import { measureSignalsBytes, writeSignals, type ClipSignals } from "../video/signals";
import { mediaVideoFixesEnabled } from "../../lib/mediaVideoFixes";
import {
  enrichDailyCapUsd,
  videoEnrichChunk,
  videoEnrichMaxBytes,
} from "./config";
import {
  estimateVideoTokens,
  RunBudget,
  usdOf,
  VideoEnrichCapExceeded,
} from "./videoCost";
import {
  tagVideo,
  type VideoTagTransport,
  type VideoAssetTags,
} from "./videoTag";

const logger = createLogger("studio-video-enrichment");

const MAX_ENRICH_ATTEMPTS = Number(process.env.MEDIA_ENRICH_MAX_ATTEMPTS ?? 10);

/** The predicate, as SQL, for both the chunk select and the `remaining` count. */
/**
 * THE TRANSCRIPT BACKFILL's candidate (CAMERA_ROLL_INTAKE; services/transcriptBackfill.ts): one of HER clips — her own
 * upload (camera-roll imports included) or a synced Instagram video whose mp4 we hold — read before what is said was
 * written down (no `vision.speech`), and not set down by this backfill. Already-read clips are read again, in full, by
 * the same call the import path uses; generated clips and references never are.
 */
export const VIDEO_NO_SPEECH = sql`coalesce(${mediaAssets.content_type}, '') LIKE 'video/%'
  AND ${mediaAssets.gcs_thumb_path} IS NOT NULL
  AND ${mediaAssets.gcs_path} IS NOT NULL
  AND ${mediaAssets.deleted_at} IS NULL
  AND (${mediaAssets.origin} = 'upload' OR (${mediaAssets.origin} = 'connected' AND ${mediaAssets.platform} = 'instagram'))
  AND ${mediaAssets.metadata} -> 'vision' -> 'speech' IS NULL
  AND ${mediaAssets.metadata} -> 'transcript_backfill' ->> 'abandoned_at' IS NULL`;

export const VIDEO_UNTAGGED = sql`coalesce(${mediaAssets.content_type}, '') LIKE 'video/%'
  AND ${mediaAssets.gcs_thumb_path} IS NOT NULL
  AND ${mediaAssets.gcs_path} IS NOT NULL
  AND ${mediaAssets.deleted_at} IS NULL
  AND ${mediaAssets.metadata} -> 'vision' -> 'beats' IS NULL
  AND ${mediaAssets.metadata} -> 'enrichment' ->> 'abandoned_at' IS NULL`;

/**
 * Signal 1 (provenanceSignal.ts) for a row that is not generated — read off the ORIGINAL when the
 * transcode kept one, over a signed URL. A generated row is ground truth already and gets null.
 * A probe that fails scores `unknown`; it never fails the tag.
 */
async function provenanceOf(
  c: Cand,
  probe: ContainerProber,
): Promise<ProvenanceSignal | null> {
  if (c.origin === "generated") return null;
  // One master (MEDIA_VIDEO_FIXES): the poster worker read the camera's atoms off the original before deleting it.
  // That record stands; the re-encode in gcs_path would only score worse. null leaves the key alone.
  if (
    mediaVideoFixesEnabled() &&
    (c.metadata as { provenance_signal?: unknown } | null)?.provenance_signal
  )
    return null;
  const original = (c.metadata as { original_gcs_path?: unknown } | null)
    ?.original_gcs_path;
  const path = typeof original === "string" && original ? original : c.path;
  try {
    const url = await signedUrl(path, 15 * 60_000);
    return scoreProvenance(await probe(url), { ingestedAt: c.ingestedAt });
  } catch (err) {
    logger.warn({ err, assetId: c.id }, "provenance probe failed");
    return scoreProvenance(null, { ingestedAt: c.ingestedAt });
  }
}

export interface VideoEnrichResult {
  total: number;
  tagged: number;
  failed: number;
  abandoned: number;
  /** True when the run stopped on the cap — the rest are still candidates for the next pass. */
  capped: boolean;
  /** Rows another run read first while this one was in flight: paid for, discarded, not an attempt. */
  raced: number;
  spentUsd: number;
  remaining: number;
  /** Athletes this pass left for tomorrow on the daily cap (`STUDIO_ENRICH_DAILY_CAP_USD`) — PR 4, C1. */
  dailyCapped: number;
  /**
   * What became of each candidate, by id (PR 9.5). `tagged`, a NotTaggedReason, or `daily_cap` for a
   * clip left for tomorrow. A candidate the run cap stopped BEFORE is absent — it was never looked at.
   * The single-clip read reads its one row off this; the counts above are unchanged.
   */
  outcomes: ClipOutcome[];
}

export type ClipOutcome = {
  id: string;
  outcome: "tagged" | NotTaggedReason | "daily_cap";
};

/**
 * THE AT-CAP REFUSAL, one string (PR 9.5, D2). Logged by the chunk when her day is spent and passed
 * through, verbatim, as the reason a user-triggered read answers with — the route never words a cap
 * refusal of its own, so the mutation "read at cap runs anyway" asserts this string by name.
 */
export const DAILY_CAP_REFUSAL =
  "video enrichment daily cap — the rest of her clips wait for tomorrow";

export interface VideoEnrichOpts {
  athleteId?: string;
  /**
   * ONE clip, by id — the user-triggered read (PR 9.5, F22 B1). Narrows the candidate select to that
   * row and nothing else; every other rule (the predicate, the caps, the booking, the compare-and-set)
   * is unchanged. Pass `athleteId` with it: the id alone is never trusted to be hers.
   */
  assetId?: string;
  chunk?: number;
  /** Test seam. The product passes nothing and gets the Gemini transport. */
  transport?: VideoTagTransport;
  /** Test seam for bytes. The product reads GCS. */
  loadBytes?: (gcsPath: string, maxBytes: number) => Promise<Buffer | null>;
  /** Test seam for "how big is the object" when the loader answered null. null = absent. */
  statBytes?: (gcsPath: string) => Promise<number | null>;
  /** Test seam for the container probe (provenanceSignal.ts). The product ffprobes a signed URL of the original. */
  probeContainer?: ContainerProber;
  budget?: RunBudget;
  /** The per-athlete daily cap; absent reads `STUDIO_ENRICH_DAILY_CAP_USD`, null is no cap. Test seam. */
  dailyCapUsd?: number | null;
  /** The clock the UTC day is read off. Test seam. */
  now?: () => Date;
  /**
   * Whether a read is a FULL one (speech + steadiness + measured signals). Absent: MEDIA_VIDEO_FIXES decides for every
   * clip. Test seam, and the hook a later caller narrows to some clips.
   */
  full?: (c: { id: string; metadata: unknown }) => boolean;
  /** Test seam for the $0 signal passes. The product runs ffmpeg on the bytes in hand. */
  measureSignals?: (bytes: Buffer, clipId?: string) => Promise<ClipSignals>;
  /**
   * CAMERA_ROLL_INTAKE with the Studio clip lane OFF: read only clips that came in through a camera-roll review
   * (`metadata.review`), so an imported clip still gets its full read and nothing else in her library is touched.
   */
  onlyIntake?: boolean;
  /**
   * THE TRANSCRIPT BACKFILL: read clips that have no transcript yet (VIDEO_NO_SPEECH) instead of clips not yet read
   * (VIDEO_UNTAGGED) — always a full read; its compare-and-set and its attempt record are its own (`vision.speech`,
   * `metadata.transcript_backfill`), so it never touches the clip lane's state.
   */
  rereadForSpeech?: boolean;
}

/**
 * Why a candidate was not tagged this pass. Logged per row with the asset id — the `reason` a
 * reader greps for. `raced` is not a failure and counts no attempt.
 */
export type NotTaggedReason =
  | "oversize_column"
  | "oversize_object"
  | "missing_object"
  | "unreadable_object"
  | "unparseable"
  | "transport_error"
  | "raced";

type Cand = {
  id: string;
  path: string;
  bytes: number | null;
  durationS: number | null;
  metadata: unknown;
  athleteId: string;
  origin: string | null;
  ingestedAt: Date | null;
};

const defaultLoad = async (
  gcsPath: string,
  maxBytes: number,
): Promise<Buffer | null> => (await readObject(gcsPath, maxBytes))?.buf ?? null;
const defaultStat = async (gcsPath: string): Promise<number | null> =>
  (await headObject(gcsPath))?.bytes ?? null;

function conds(
  athleteId?: string,
  leaveOut: readonly string[] = [],
  assetId?: string,
  onlyIntake = false,
  speech = false,
) {
  const c = [
    eq(mediaAssets.status, "stored"),
    isNull(mediaAssets.parent_media_id),
    // K-S7 (PR 20, docs/probes/ship.md): a video she only POINTED the direction engine at is read by that engine alone,
    // exactly as the photo lane already rules (services/mediaEnrichment.ts, the origin 'reference' clause) — reading it
    // here would make it searchable as hers. ⚠️ MUTATION (videoEnrichment.test): drop this line — "a reference video is
    // never a candidate" reds by name.
    ne(mediaAssets.origin, "reference"), notAPreview(),
    speech ? VIDEO_NO_SPEECH : VIDEO_UNTAGGED,
  ];
  if (athleteId) c.push(eq(mediaAssets.athlete_id, athleteId));
  // One clip on demand (PR 9.5, B1): the same predicate, narrowed to her one row — a read row, an
  // abandoned row or another athlete's row selects nothing, exactly as the batch would skip it.
  if (assetId) c.push(eq(mediaAssets.id, assetId));
  // CAMERA_ROLL_INTAKE with the Studio clip lane off: only clips she imported through a review.
  if (onlyIntake) c.push(sql`${mediaAssets.metadata} -> 'review' IS NOT NULL`);
  // Athletes already at today's cap: their clips are not this pass's (they stay candidates).
  if (leaveOut.length)
    c.push(notInArray(mediaAssets.athlete_id, [...leaveOut]));
  return and(...c);
}

// ─── THE DAILY CAP (PR 4, C1) ─────────────────────────────────────────────────────────────────
//
// Every clip call that reached the model books what it cost on its own row, one key, in SQL:
// `metadata.enrich_spend = { day: "YYYY-MM-DD" (UTC), usd }` — added to when the day matches, reset
// when it does not. A pass sums today's per athlete, leaves an athlete at the cap out of the select,
// and skips (untouched, no attempt) a clip whose estimate would cross what her day has left. The day
// key rolling at 00:00 UTC is the resume. No table and no migration: the rows are the ledger.

/** The UTC calendar day of `d`, as the key is written. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Today's booked clip spend per athlete (one athlete when given). Read-only. */
export async function spentToday(
  day: string,
  athleteId?: string,
): Promise<Map<string, number>> {
  const res = await db.execute(sql`
    SELECT athlete_id AS "athleteId",
           sum((metadata -> 'enrich_spend' ->> 'usd')::numeric)::float8 AS usd
      FROM ${mediaAssets}
     WHERE metadata -> 'enrich_spend' ->> 'day' = ${day}
       ${athleteId ? sql`AND athlete_id = ${athleteId}` : sql``}
     GROUP BY athlete_id`);
  return new Map(
    (res.rows ?? []).map((r) => [String(r.athleteId), Number(r.usd)]),
  );
}

/** Book one call's cost on its row — the one key, added to within the day, reset across days. */
async function bookSpend(id: string, usd: number, day: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{enrich_spend}',
             jsonb_build_object('day', ${day}::text, 'usd',
               CASE WHEN metadata -> 'enrich_spend' ->> 'day' = ${day}
                    THEN (metadata -> 'enrich_spend' ->> 'usd')::numeric ELSE 0 END + ${usd}::numeric))
     WHERE id = ${id}`);
}

/**
 * Compare-and-set: the write lands only if the row is STILL not read as a clip. True when it landed.
 *
 * Measured on the first live pass (22 Sep 2026): two cron requests in flight at once selected the
 * same candidates, and 9 of 67 rows were read twice — the second write replaced the first's
 * `vision` and stashed the CLIP read under `prev`, so the poster-derived object the eval diffs
 * against was gone for those rows. The WHERE repeats the candidate predicate's own `beats IS NULL`;
 * the loser's UPDATE touches 0 rows and its read is discarded. The money for the second read is
 * already spent — a claim taken before the call would save it, and is not built.
 *
 * `prev` is computed in SQL from the row AS IT IS AT WRITE TIME, not from the candidate read — so
 * even a poster tag written between select and update is what gets stashed, never lost.
 */
async function writeVision(
  id: string,
  tags: VideoAssetTags,
  provenance: ProvenanceSignal | null,
  speech = false,
): Promise<boolean> {
  const json = JSON.stringify(tags);
  // The provenance signal rides in the SAME statement, its own key — null leaves the key alone
  // (a generated row, which is skipped, or an older caller).
  const withVision = sql`jsonb_set(
             coalesce(metadata, '{}'::jsonb) - ${speech ? "transcript_backfill" : "enrichment"}::text,
             '{vision}',
             ${json}::jsonb || jsonb_build_object('prev',
               CASE WHEN jsonb_typeof(metadata -> 'vision') = 'object' THEN (metadata -> 'vision') - 'prev' ELSE 'null'::jsonb END)
           )`;
  const value = provenance
    ? sql`jsonb_set(${withVision}, '{provenance_signal}', ${JSON.stringify(provenance)}::jsonb)`
    : withVision;
  const res = await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = ${value},
           metadata_updated_at = now()
     WHERE id = ${id}
       AND ${speech ? sql`metadata -> 'vision' -> 'speech' IS NULL` : sql`metadata -> 'vision' -> 'beats' IS NULL`}
     RETURNING id`);
  // RETURNING rather than rowCount: node-postgres reports `rowCount`, PGlite `affectedRows`, and
  // both hand back `rows` — the one shape the product and its test share.
  return ((res as { rows?: unknown[] }).rows?.length ?? 0) > 0;
}

async function writeAttempt(
  id: string,
  prior: Record<string, unknown>,
  abandon: "oversize" | "attempts" | null,
  key: "enrichment" | "transcript_backfill" = "enrichment",
): Promise<void> {
  const attempts =
    abandon === "oversize"
      ? Number(prior.attempts ?? 0)
      : Number(prior.attempts ?? 0) + 1;
  const state: Record<string, unknown> = {
    ...prior,
    attempts,
    last_attempt_at: new Date().toISOString(),
  };
  if (abandon) {
    state.abandoned_at = new Date().toISOString();
    state.abandoned_missing = [key === "enrichment" ? "beats" : "speech"];
    state.abandoned_reason = abandon;
  }
  await db.execute(sql`
    UPDATE ${mediaAssets}
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), ${`{${key}}`}::text[], ${JSON.stringify(state)}::jsonb),
           metadata_updated_at = now()
     WHERE id = ${id}`);
}

/**
 * The full read's $0 signals, on the bytes the read already downloaded (MEDIA_VIDEO_FIXES). Its own catch: a clip
 * ffmpeg cannot measure is still a clip that was read, and the read's outcome — tagged, and paid for — does not move.
 */
async function recordSignals(
  c: Cand,
  bytes: Buffer,
  measure: (bytes: Buffer, clipId?: string) => Promise<ClipSignals>,
): Promise<void> {
  try {
    await writeSignals(c.id, c.athleteId, await measure(bytes, c.id));
  } catch (err) {
    logger.warn(
      {
        assetId: c.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "signal measurement failed — the read stands",
    );
  }
}

/** ONE bounded chunk of clips not yet read as clips. Sequential: one clip in flight at a time, so the budget is exact. */
/**
 * quality-scrappy piece 3, behind STUDIO_SHOT_DETECT: the clip's shot boundaries, found on the bytes this read already
 * downloaded and written beside the beats it just stored (video/shots.ts). $0 and local. Its own catch: a clip ffmpeg
 * cannot score is still a clip that was read, and the read's outcome — tagged, and paid for — does not move.
 */
async function recordShots(c: Cand, bytes: Buffer): Promise<void> {
  try {
    await writeShots(c.id, c.athleteId, await detectShotsBytes(bytes));
  } catch (err) {
    logger.warn(
      {
        assetId: c.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "shot detection failed — the read stands",
    );
  }
}

export async function enrichVideoChunk(
  opts: VideoEnrichOpts = {},
): Promise<VideoEnrichResult> {
  const chunk = opts.chunk ?? videoEnrichChunk();
  const load = opts.loadBytes ?? defaultLoad;
  const stat = opts.statBytes ?? defaultStat;
  const budget = opts.budget ?? new RunBudget();
  const maxBytes = videoEnrichMaxBytes();
  const dailyCap =
    opts.dailyCapUsd !== undefined ? opts.dailyCapUsd : enrichDailyCapUsd();
  const day = utcDay((opts.now ?? (() => new Date()))());
  const speechMode = !!opts.rereadForSpeech;
  const stateKey = speechMode ? "transcript_backfill" as const : "enrichment" as const;
  const fullFor = speechMode ? () => true : opts.full ?? (() => mediaVideoFixesEnabled());
  const measure = opts.measureSignals ?? ((b: Buffer, clipId?: string) => measureSignalsBytes(b, undefined, clipId ?? null));
  const today =
    dailyCap === null
      ? new Map<string, number>()
      : await spentToday(day, opts.athleteId);
  const atCap = new Set(
    dailyCap === null
      ? []
      : [...today].filter(([, usd]) => usd >= dailyCap).map(([a]) => a),
  );
  /** Book a call's cost on its row and in this pass's view of her day. */
  const book = async (c: Cand, usd: number) => {
    today.set(c.athleteId, (today.get(c.athleteId) ?? 0) + usd);
    await bookSpend(c.id, usd, day);
  };

  const rows = await db
    .select({
      id: mediaAssets.id,
      path: mediaAssets.gcs_path,
      bytes: mediaAssets.bytes,
      precise: mediaAssets.duration_seconds_precise,
      whole: mediaAssets.duration_seconds,
      metadata: mediaAssets.metadata,
      athleteId: mediaAssets.athlete_id,
      origin: mediaAssets.origin,
      ingestedAt: mediaAssets.ingested_at,
    })
    .from(mediaAssets)
    .where(conds(opts.athleteId, [...atCap], opts.assetId, opts.onlyIntake, opts.rereadForSpeech))
    .limit(chunk);
  const cand: Cand[] = rows.map((r) => ({
    id: r.id,
    path: r.path!,
    bytes: r.bytes === null || r.bytes === undefined ? null : Number(r.bytes),
    durationS: r.precise ?? (r.whole && r.whole > 0 ? r.whole : null),
    metadata: r.metadata,
    athleteId: r.athleteId,
    origin: r.origin ?? null,
    ingestedAt: r.ingestedAt ?? null,
  }));

  let tagged = 0,
    failed = 0,
    abandoned = 0,
    raced = 0,
    capped = false;
  const outcomes: ClipOutcome[] = [];
  for (const c of cand) {
    const meta = ((c.metadata as any) ?? {}) as Record<string, unknown>;
    const prior =
      (meta[stateKey] as Record<string, unknown> | undefined) ?? {};

    // Why this row was NOT tagged — null means it was. Every non-null value is logged with the
    // asset id: the first live 51 s upload left no line at all (see the header).
    let reason: NotTaggedReason | null = null;
    let error: string | undefined;
    let objectBytes: number | null = null;

    // Her day first: a clip whose estimate would cross what today has left waits for tomorrow —
    // untouched, no attempt, no line per row (one line per athlete, below).
    // ⚠️ MUTATION (videoEnrichment.test): skip this check — "the second clip waits for tomorrow" reds.
    if (dailyCap !== null) {
      const est = usdOf(estimateVideoTokens(c.durationS));
      if ((today.get(c.athleteId) ?? 0) + est > dailyCap) {
        if (!atCap.has(c.athleteId))
          logger.info(
            {
              athleteId: c.athleteId,
              spentTodayUsd: Number((today.get(c.athleteId) ?? 0).toFixed(4)),
              nextUsd: Number(est.toFixed(4)),
              capUsd: dailyCap,
              day,
            },
            DAILY_CAP_REFUSAL,
          );
        atCap.add(c.athleteId);
        outcomes.push({ id: c.id, outcome: "daily_cap" });
        continue;
      }
    }

    // Deterministic, and known before a byte is read: the bytes column is written at upload / record.
    if (c.bytes !== null && c.bytes > maxBytes) {
      reason = "oversize_column";
    } else {
      let reserved: number;
      try {
        reserved = budget.reserve(c.durationS);
      } catch (err) {
        if (err instanceof VideoEnrichCapExceeded) {
          logger.warn(
            {
              spentUsd: err.spentUsd,
              nextUsd: err.nextUsd,
              capUsd: err.capUsd,
              left: cand.length - tagged - failed - abandoned,
            },
            err.message,
          );
          capped = true;
          break;
        }
        throw err;
      }

      try {
        const bytes = await load(c.path, maxBytes);
        if (!bytes) {
          // The reader answers null for "absent" AND for "bigger than the cap". Only one of those
          // is forever, so ask which before deciding whether this costs an attempt.
          budget.release(reserved);
          objectBytes = await stat(c.path).catch(() => null);
          reason =
            objectBytes === null
              ? "missing_object"
              : objectBytes > maxBytes
                ? "oversize_object"
                : "unreadable_object";
        } else if (bytes.byteLength > maxBytes) {
          // The column said one thing and the object another: the object is the truth.
          budget.release(reserved);
          objectBytes = bytes.byteLength;
          reason = "oversize_object";
        } else {
          objectBytes = bytes.byteLength;
          const full = fullFor(c);
          const { tags, usage } = await tagVideo(
            bytes,
            c.path,
            c.durationS,
            opts.transport,
            // Who the tagger looks for — her row, once per athlete per process minute.
            await tagProfileFor(c.athleteId),
            full,
          );
          budget.settle(reserved, usage);
          // Paid for whatever happens next — tagged, unparseable or raced. A call that reported
          // no usage books its estimate.
          await book(c, usage ? usdOf(usage) : reserved);
          if (!tags) reason = "unparseable";
          // The backfill is for what is said: an answer without `speech` would write, leave the row a candidate and
          // clear its attempt record, so it would be read — and paid for — again every tick. It is an attempt instead,
          // set down after MAX_ENRICH_ATTEMPTS like any other.
          else if (speechMode && !tags.speech) reason = "unparseable";
          else if (
            !(await writeVision(
              c.id,
              tags,
              await provenanceOf(c, opts.probeContainer ?? ffprobeContainer),
              speechMode,
            ))
          )
            reason = "raced";
          else {
            if (shotDetectEnabled()) await recordShots(c, bytes);
            if (full) await recordSignals(c, bytes, measure);
          }
        }
      } catch (err: any) {
        budget.release(reserved);
        // It may have reached the model before it failed: the day books the estimate (a ceiling,
        // like the run cap), the run gives it back as it always has.
        await book(c, reserved).catch(() => {});
        reason = "transport_error";
        error = String(err?.message ?? err).slice(0, 200);
      }
    }

    outcomes.push({ id: c.id, outcome: reason ?? "tagged" });
    if (reason === null) {
      tagged++;
      continue;
    }
    if (reason === "raced") {
      raced++;
      logger.info({ assetId: c.id, reason }, "video not tagged");
      continue;
    }
    const oversize =
      reason === "oversize_column" || reason === "oversize_object";
    const attempts = oversize
      ? Number(prior.attempts ?? 0)
      : Number(prior.attempts ?? 0) + 1;
    const abandon: "oversize" | "attempts" | null = oversize
      ? "oversize"
      : attempts >= MAX_ENRICH_ATTEMPTS
        ? "attempts"
        : null;
    if (!oversize) failed++;
    if (abandon) abandoned++;
    await writeAttempt(c.id, prior, abandon, stateKey);
    logger.warn(
      {
        assetId: c.id,
        reason,
        error,
        bytesColumn: c.bytes,
        objectBytes,
        durationS: c.durationS,
        attempts,
        abandoned: abandon,
      },
      "video not tagged",
    );
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(conds(opts.athleteId, [], opts.assetId, opts.onlyIntake, opts.rereadForSpeech));
  const result: VideoEnrichResult = {
    total: cand.length,
    tagged,
    failed,
    abandoned,
    capped,
    raced,
    spentUsd: Number(budget.spentUsd.toFixed(4)),
    remaining: Number(n),
    dailyCapped: dailyCap === null ? 0 : atCap.size,
    outcomes,
  };
  logger.info(
    {
      athleteId: opts.athleteId,
      chunk,
      ...result,
      calls: budget.calls,
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
    },
    "video enrichment chunk done",
  );
  return result;
}
