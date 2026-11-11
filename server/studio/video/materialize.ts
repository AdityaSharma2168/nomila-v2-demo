/**
 * materialize.ts — the bridge between ASSETS (ids in GCS) and the STITCH ENGINE (local paths).
 *
 * V6's stitch() takes local paths and refuses URLs, deliberately: "a stitch engine has nowhere to
 * carry a bearer token, so an expired or 401'd URL would surface as a deep ffmpeg decode failure
 * instead of a clean 'fetch it first'." This file is the "fetch it first", plus the return trip for
 * the file it produces. Network and tenancy live here; ffmpeg knows about neither.
 *
 * ─── WHY THE BRIDGE OWNS TENANCY ────────────────────────────────────────────────────────────────
 *
 * Because the runner has no request. A stitch job is claimed off the queue on a tick, so there is no
 * `req.athleteId!` in scope at the moment the ids are resolved — the athlete is read off the CLAIMED
 * ROW and passed in. Every resolve below filters on it, and an id that does not resolve under that
 * athlete is not found rather than forbidden: the same answer for "does not exist" and "is not
 * yours", so the spec cannot be used to probe another athlete's library.
 *
 * Resolution is ONE query over all the ids with a completeness check, not a lookup per id. That is
 * not a performance choice — resolving one at a time would download the legitimate clips BEFORE
 * discovering the foreign one, doing work and writing bytes on behalf of a request that has to fail.
 *
 * ─── WHY NOT mediaStore.readObject ──────────────────────────────────────────────────────────────
 *
 * It caps at MEDIA_MAX_BYTES (25 MB) and returns null above it, and it buffers the whole object in
 * memory. An uploaded clip is allowed up to 200 MB (UPLOAD_LIMITS.video.max), so readObject would
 * answer `null` for an ordinary clip and the caller would read a present-but-large file as a missing
 * one. We stream a signed URL to disk instead, with the video cap as the per-clip ceiling.
 *
 * ⚠️ ─── THE MEMORY CEILING, AND IT IS NOT MEASURED HERE ──────────────────────────────────────────
 *
 * ON CLOUD RUN /tmp IS RAM. services/videoPoster.ts:13-16 is explicit about it, and that worker
 * avoids the problem entirely by never downloading: ffmpeg reads straight from a signed URL and only
 * the small outputs touch /tmp. We cannot do that while V6 takes local paths, so every clip in a
 * timeline is resident in the instance's 2 GiB alongside Node and ffmpeg's own working set.
 *
 * Hence workspaceMaxBytes(): a timeline that would not fit is refused UP FRONT, by arithmetic on
 * sizes we already know, with a message naming both figures. An explicit refusal is worth having
 * because the alternative is an OOM kill — which arrives as a vanished instance, a lapsed lease and
 * a job that gets picked up and OOMs again.
 *
 * This ceiling is ARITHMETIC, NOT A MEASUREMENT. macOS /tmp is disk, so the tmpfs behaviour cannot
 * be measured on a laptop, and the number below is a budget rather than an observation.
 */
import type { StillFocus, StillMotion } from "./still";
import { createWriteStream } from "fs";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { mediaAssets } from "../../../shared/schema";
import {
  signedUrl,
  uploadLocalFile,
  UPLOAD_LIMITS,
} from "../../lib/mediaStore";
import { createLogger } from "../../logger";
import { STUDIO_PLATFORM, videoBytesPerSecond } from "../config";
import { bedMaxBytes, type BedSource } from "./beds";
import { DEFAULT_STILL_SEC, MAX_STILL_SEC, MIN_STILL_SEC } from "./spec";
import { herPhoto, VIDEO_TYPES } from "../photoPredicate";

const logger = createLogger("studio/video/materialize");

/**
 * One clip may not exceed what an UPLOAD may be — the same ceiling, read from the same constant, so
 * a clip that was allowed into the library is never refused on its way back out.
 *
 * Read at CALL TIME, the way studio/videoJobs.ts reads leaseMs() and maxAttempts(): a cap that is a
 * module constant can only be changed by a deploy, and cannot be exercised by a test without a
 * test-only export.
 */
export const clipMaxBytes = () =>
  Number(process.env.STUDIO_STITCH_CLIP_MAX_BYTES ?? UPLOAD_LIMITS.video.max);

/**
 * Every clip in one timeline, together. 1 GiB of a 2 GiB instance, leaving the other half for Node,
 * ffmpeg's working set and the output being written. See the memory note in the header — a budget,
 * not a measurement.
 */
export const workspaceMaxBytes = () =>
  Number(process.env.STUDIO_STITCH_WORKSPACE_MAX_BYTES ?? 1024 * 1024 * 1024);

/**
 * ─── THE CEILING, IN HER UNITS: 12 CLIPS · 664 MB · 3:00 ────────────────────────────────────────
 *
 * The three numbers below are what a timeline may actually be, and they are stated in the refusal
 * and returned on the status route so the assembly UI can say them BEFORE she hits one. A cap that
 * only exists as an OOM is not a cap.
 *
 * Where each comes from — arithmetic on constants that already exist, not fresh guesses:
 *
 *   instance memory       2 GiB     gcp/cloud-run-{dev,prod}.yaml, `memory: 2Gi`
 *   workspace budget      1 GiB     workspaceMaxBytes() above — half the instance; the other half
 *                                   is Node's RSS, ffmpeg's working set, and up to 79 other
 *                                   concurrent requests (containerConcurrency: 80)
 *   output bytes/second   2 MiB/s   studio/config.ts videoBytesPerSecond() — measured at 0.74 MB/s
 *                                   on the spike's 720p Veo clip and rounded up to roughly 1080p
 *   max timeline          180 s     the product cap; the output allowance follows FROM it
 *   output allowance      360 MiB   180 s × 2 MiB/s
 *   max source bytes      664 MiB   1 GiB − 360 MiB — DERIVED, so it cannot drift from the two
 *                                   figures it is made of
 *   max clips             12        ffmpeg's per-input working set (see maxClips)
 *
 * WHY THE OUTPUT IS COUNTED AT ALL: it is written INTO the workspace (outputPath below), so on
 * Cloud Run it is resident in the same tmpfs — the same RAM — as the inputs. Charging it at zero,
 * which is what this file did before layer 3, budgets a 1 GiB workspace and then lets ffmpeg write
 * a second 360 MB into the half we reserved for ffmpeg itself.
 *
 * BOTH byte and count caps are reachable, which is what keeps them from being decoration:
 *   generated clips (8 s Veo, ~16 MiB)   12 of them is 192 MiB and 96 s — THE COUNT binds first.
 *   uploaded clips (up to 200 MiB)       4 of them is 800 MiB          — THE BYTES bind, at four.
 */

/**
 * How many clips one timeline may join.
 *
 * ⚠️  THIS IS A BUDGET AND NOT A DERIVATION, unlike every other figure above, and it is the one
 * number in this file most worth measuring. Each input in a single filter graph carries its own
 * decoder context and, across an `xfade`, held frames; at 1080p that is on the order of 25 MB each,
 * so 12 is ~300 MB of ffmpeg working set inside the GiB this arithmetic leaves it. There is no
 * measurement of that anywhere in this repo and there cannot be one here — macOS /tmp is disk, so
 * the tmpfs behaviour that makes this matter does not exist on a laptop.
 *
 * Env-overridable precisely so measuring it on a real instance does not need a deploy.
 */
export const maxClips = () => Number(process.env.STUDIO_STITCH_MAX_CLIPS ?? 12);

/** The longest finished video a stitch may produce. The output allowance is 180 s × 2 MiB/s. */
export const maxTimelineSeconds = () =>
  Number(process.env.STUDIO_STITCH_MAX_TIMELINE_SEC ?? 180);

/**
 * What the OUTPUT may take out of the workspace, at the same bytes-per-second studio/preview.ts
 * projects a generated clip with. Reserved up front rather than discovered while ffmpeg writes.
 */
export const outputAllowanceBytes = () =>
  maxTimelineSeconds() * videoBytesPerSecond();

/**
 * What the INPUTS may take. Derived — never a typed constant — so that moving the timeline cap or
 * the workspace budget moves this with it instead of silently over-committing the instance.
 */
export const maxSourceBytes = () =>
  Math.max(0, workspaceMaxBytes() - outputAllowanceBytes());

/** The caps as one object, for the refusal messages and for the status route to hand the UI. */
export interface StitchLimits {
  maxClips: number;
  maxSourceBytes: number;
  maxTimelineSeconds: number;
  maxClipBytes: number;
  /** How long a photo may be held, and what it is held for when nobody chose (spec.ts). */
  minStillSec: number;
  maxStillSec: number;
  defaultStillSec: number;
}

export const stitchLimits = (): StitchLimits => ({
  maxClips: maxClips(),
  maxSourceBytes: maxSourceBytes(),
  maxTimelineSeconds: maxTimelineSeconds(),
  maxClipBytes: clipMaxBytes(),
  // The parser's own constants — served so the timeline never hardcodes a second copy of them.
  minStillSec: MIN_STILL_SEC,
  maxStillSec: MAX_STILL_SEC,
  defaultStillSec: DEFAULT_STILL_SEC,
});

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** "12 clips, 664 MB of video and 3:00 of footage" — one phrasing, used by every refusal. */
export function describeLimits(limits: StitchLimits = stitchLimits()): string {
  const secs = limits.maxTimelineSeconds;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return `${limits.maxClips} clips, ${mb(limits.maxSourceBytes)} MB of video and ${clock} of footage`;
}

/**
 * Where workspaces are created. `tmpdir()` in production — and on Cloud Run that is RAM, which is
 * the whole reason workspaceMaxBytes() exists.
 *
 * Overridable because a test that checks for LEAKED workspaces has to be able to look somewhere
 * only it writes to. Scanning the OS temp directory instead looked fine and was not: V6's own
 * stitch.test.ts mkdtemps with the same `studio-stitch-` prefix (stitch.test.ts:37), so under
 * parallel jest workers a leak assertion here would occasionally see THAT directory and fail a
 * green diff. A shared namespace is a flake generator; an injected root is not.
 */
export const workspaceRoot = () =>
  process.env.STUDIO_STITCH_WORKSPACE_DIR ?? tmpdir();

/**
 * The media types a stitch can actually join — defined in studio/photoPredicate.ts beside `herClip`,
 * the predicate the picker lists read, and re-exported here for everything that imports it from the
 * stitch. One array, so the lists cannot drift into offering a clip the stitch then refuses.
 */
export { VIDEO_TYPES };

/**
 * ─── A STILL: ONE OF HER PHOTOS, RESOLVED AS A PHOTO ────────────────────────────────────────────
 *
 * A position with `stillSec` names a PHOTOGRAPH, and is resolved through studio/photoPredicate.ts —
 * the caster's own "hers · stored · not deleted · top-level · a photograph" — never through the video
 * query above. The two predicates are disjoint by media type, so a photo cannot be joined as a clip
 * and a video cannot be held as a still: each id is asked about in exactly one way.
 *
 * The content types are what the runner can actually turn into a frame (sharp, studio/video/still.ts).
 * HEIC is an accepted UPLOAD type and is not here: this build's sharp decodes only AVIF out of the
 * HEIF family, so a HEIC still would pass the door and fail the job. Refused by name instead.
 */
export const STILL_CONTENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

/** One photo may be as large as an image UPLOAD may be — read at call time, like clipMaxBytes. */
export const stillImageMaxBytes = () =>
  Number(process.env.STUDIO_STITCH_STILL_MAX_BYTES ?? UPLOAD_LIMITS.image.max);

/**
 * What one still POSITION writes into the workspace besides its photo: the prepared frame (at most
 * 1080×1920, a few hundred KB to ~1 MB as a JPEG) and the clip it is encoded into. The clip is
 * charged at the OUTPUT rate for its hold — measured at 8 KB to 776 KB for 2–8 s, so this is a
 * ceiling well above the measurement, which is the direction a ceiling errs. Per position, not per
 * photo: the same photo held twice is encoded twice, once for each length.
 */
export const STILL_PREP_MAX_BYTES = 4 * 1024 * 1024;
export const stillWorkBytes = (stillSec: number) =>
  Math.ceil(stillSec * videoBytesPerSecond()) + STILL_PREP_MAX_BYTES;

export class MaterializeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_a_video"
      | "too_large"
      | "too_many_clips"
      | "timeline_too_long"
      | "workspace_too_large"
      | "download_failed"
      | "no_sound"
      | "unusable_photo",
    /**
     * WHICH part of the timeline the problem is about, so a door can point at it. Her clips, unless
     * said otherwise — every refusal before there was a sound video was about those.
     */
    readonly subject: "clips" | "sound" = "clips",
  ) {
    super(message);
    this.name = "MaterializeError";
  }
}

/**
 * One position on the timeline. A bare id is the same thing with no trim — accepted so that a
 * caller with nothing to say about trims does not have to say it.
 */
export interface TimelineEntry {
  assetId: string;
  trimStartSec?: number;
  trimEndSec?: number;
  /**
   * Present when `assetId` is one of her PHOTOGRAPHS, held for this many seconds — a still. Absent
   * means a video, as it always did. The two are resolved through disjoint predicates, so a photo
   * can never be joined as a clip nor a video held as a still.
   */
  stillSec?: number;
  /**
   * How a still MOVES over its hold — "pan", a slow push-in (studio/video/still.ts) — or absent for
   * dead still. Only beside `stillSec`: the door refuses it on a clip (spec.ts). $0 like the hold.
   */
  stillMotion?: StillMotion;
  /**
   * Where a zoom, sweep or punch heads — her tapped point, fractions of the upright photo — or absent
   * for the framing prior (the upper middle). Only beside one of those motions (spec.ts).
   */
  stillFocus?: StillFocus;
}

export type TimelineInput = string | TimelineEntry;

const entryOf = (e: TimelineInput): TimelineEntry =>
  typeof e === "string" ? { assetId: e } : e;

/** A resolved asset: what the row says, before anything has been downloaded. */
export interface ResolvedClip {
  assetId: string;
  gcsPath: string;
  /**
   * The best duration the ROW can offer: the MEASURED fraction when there is one, else the whole
   * second the picker asserted. One field rather than two, because no caller wants the worse of
   * the two numbers — see `resolveClips` for where the preference is applied.
   */
  durationSeconds: number | null;
  bytes: number | null;
  /**
   * True for one of her PHOTOS, resolved as a still. `durationSeconds` is then null — a photo has
   * no length of its own; the position's `stillSec` is how long it plays.
   */
  still?: true;
}

/** A disposable directory holding the clips, plus where the output should be written. */
export interface StitchWorkspace {
  dir: string;
  /** Local path per asset id. Deduplicated: the same clip twice in a timeline is downloaded once. */
  paths: Map<string, string>;
  /**
   * Local path per PHOTO asset id — the stills' source images, deduplicated the same way. Kept out
   * of `paths` on purpose: everything that reads `paths` (the probe, the engine request) expects a
   * video, and a photo there would be probed for a duration it does not have.
   */
  stills: Map<string, string>;
  /** The bed's local path, when one was asked for and fetched. Null is "no music", not "failed". */
  bedPath: string | null;
  /** Where V6 should write. Its directory exists, which stitch() requires. */
  outputPath: string;
  /** Idempotent. Safe to call twice, and safe to call after a throw. */
  dispose(): Promise<void>;
}

/**
 * Resolve asset ids to rows, scoped to one athlete.
 *
 * Throws on the FIRST problem it finds, before any bytes move. Order matters: not-found before
 * not-a-video, because "that isn't yours" must not be distinguishable from "that doesn't exist".
 */
export async function resolveClips(
  athleteId: string,
  assetIds: string[],
): Promise<ResolvedClip[]> {
  if (assetIds.length === 0) {
    throw new MaterializeError("A stitch needs at least one clip", "not_found");
  }
  const unique = [...new Set(assetIds)];

  const rows = await db
    .select({
      id: mediaAssets.id,
      media_type: mediaAssets.media_type,
      gcs_path: mediaAssets.gcs_path,
      duration_seconds: mediaAssets.duration_seconds,
      duration_seconds_precise: mediaAssets.duration_seconds_precise,
      bytes: mediaAssets.bytes,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(
      and(
        inArray(mediaAssets.id, unique),
        // THE TENANCY PREDICATE. Never trust an id from a client or a stored spec.
        eq(mediaAssets.athlete_id, athleteId),
        isNull(mediaAssets.deleted_at),
      ),
    );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) {
    // Deliberately the same answer for "no such asset" and "not this athlete's".
    throw new MaterializeError(
      `${missing.length === 1 ? "A clip" : `${missing.length} clips`} in this timeline could not be found`,
      "not_found",
    );
  }

  return unique.map((id) => {
    const row = byId.get(id)!;
    if (!VIDEO_TYPES.includes(row.media_type)) {
      throw new MaterializeError(
        `A stitch can only join clips, and one of these is a ${row.media_type}`,
        "not_a_video",
      );
    }
    // media_assets.status is ('stored','failed','skipped_size') — there is no "pending". A row that
    // is not stored is one whose bytes never arrived (a failed rehost, or one over the size cap), so
    // there is nothing to join even though the row exists.
    if (row.status !== "stored" || !row.gcs_path) {
      throw new MaterializeError(
        "A clip in this timeline isn't available — its file never finished arriving",
        "not_found",
      );
    }
    return {
      assetId: row.id,
      gcsPath: row.gcs_path,
      // ── WHERE "MEASURED BEATS ASSERTED" LANDS FOR DURATION ──────────────────────────────────
      //
      // Two columns, one question. duration_seconds_precise (migration 0058) is what ffprobe read
      // off the bytes; duration_seconds is an INTEGER that mostly holds whatever the client's
      // upload picker asserted, rounded. The precise one is preferred wherever it exists, and the
      // integer is the fallback rather than the source — which is how the doctrine is honoured
      // WITHOUT overwriting the old column, whose readers (the picker round trip, fmtDur in the
      // library grid) were not asked to change and have not.
      //
      // Both NULL is still possible and still correct: most Instagram video rows hold a poster
      // JPEG, not an mp4, so there are no bytes on our side to measure. That case falls through to
      // the byte-implied estimate in `effectiveSeconds` exactly as it did before.
      durationSeconds: row.duration_seconds_precise ?? row.duration_seconds,
      bytes: row.bytes,
    };
  });
}

/**
 * Resolve still ids to rows, scoped to one athlete, through THE PHOTO PREDICATE.
 *
 * One query with a completeness check, before any bytes move — resolveClips' shape, for its
 * reasons. An id that is another athlete's, deleted, a video or not stored does not come back, and
 * all of those are the same "could not be found": the predicate is the question, so there is no
 * answer that distinguishes "not yours" from "not there".
 */
export async function resolveStills(
  athleteId: string,
  assetIds: string[],
): Promise<ResolvedClip[]> {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return [];

  const rows = await db
    .select({
      id: mediaAssets.id,
      gcs_path: mediaAssets.gcs_path,
      content_type: mediaAssets.content_type,
      bytes: mediaAssets.bytes,
    })
    .from(mediaAssets)
    // THE TENANCY PREDICATE, the caster's own. Never trust an id from a client or a stored spec.
    .where(herPhoto(athleteId, inArray(mediaAssets.id, unique)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new MaterializeError(
      `${missing.length === 1 ? "A photo" : `${missing.length} photos`} in this timeline could not be found`,
      "not_found",
    );
  }

  return unique.map((id) => {
    const row = byId.get(id)!;
    if (!row.gcs_path) {
      throw new MaterializeError(
        "A photo in this timeline isn't available — its file never finished arriving",
        "not_found",
      );
    }
    const type = (row.content_type ?? "").toLowerCase().split(";")[0].trim();
    if (!STILL_CONTENT_TYPES.includes(type)) {
      const name = type.startsWith("image/")
        ? ` (${type.slice("image/".length).toUpperCase()})`
        : "";
      throw new MaterializeError(
        `One of these photos is in a format we can't put in a video yet${name} — save it as a JPEG and add it again`,
        "unusable_photo",
      );
    }
    return {
      assetId: row.id,
      gcsPath: row.gcs_path,
      durationSeconds: null,
      bytes: row.bytes,
      still: true as const,
    };
  });
}

/**
 * How long one timeline position contributes, in seconds — AN ESTIMATE, at the door.
 *
 * An explicit trim window is exact; a known row duration is next; and a row with no duration is
 * charged at the duration its SIZE implies.
 *
 * ⚠️ THAT LAST FALLBACK CAN UNDER-COUNT, AND IT IS THE ONLY GUESS IN THIS FILE. It divides SOURCE
 * bytes by the OUTPUT bitrate, and those are not the same quantity: a 200 MB upload at 3 Mbps is
 * 555 seconds of video and is counted here as 100. One such clip passes the 180 s cap alone and
 * then writes ≈1.1 GiB into a workspace that reserved 360 MiB for it.
 *
 * So this is a CHEAP PRE-FILTER and not the guard. It runs at the route, where there are no files
 * to measure — it exists so an obviously-oversized ask is refused before anything is downloaded.
 * The real bound is `assertProbedTimelineFits`, which runs after the download with ffprobe's own
 * numbers and cannot be fooled by a bitrate. A timeline that slips past this one is caught there,
 * before the encode and before any memory is at risk.
 */
export function effectiveSeconds(
  entry: TimelineEntry,
  clip: ResolvedClip,
): number {
  // A still is exactly as long as it is held — the one position whose length is never a guess.
  if (entry.stillSec !== undefined) return entry.stillSec;
  const implied = (clip.bytes ?? clipMaxBytes()) / videoBytesPerSecond();
  const whole = clip.durationSeconds ?? implied;
  const start = entry.trimStartSec ?? 0;
  const end = entry.trimEndSec ?? whole;
  return Math.max(0, end - start);
}

/**
 * Refuse a timeline that does not fit, naming ALL THREE caps so she is told what the shape of a
 * legal timeline is rather than only which wall she hit.
 *
 * The three quantities are counted over different things, and getting that wrong is the subtle bug:
 *
 *   CLIPS and SECONDS are counted over TIMELINE POSITIONS — the same clip twice is two inputs in
 *   ffmpeg's graph and two spans of output.
 *   BYTES are counted over UNIQUE ASSETS — the same clip twice is downloaded once (see the dedupe
 *   in materializeWorkspace), so charging it twice would refuse a legal timeline.
 *
 * Called from BOTH doors: the route, so an over-cap ask is refused before a row exists, and the
 * runner, because the library can change between queue and claim. One function, so the two answers
 * cannot drift.
 */
export function assertTimelineFits(
  timeline: TimelineInput[],
  resolved: ResolvedClip[],
  /**
   * True when a bed will also be downloaded into this workspace. Charged at its CEILING rather
   * than its size, because the size is not known until it has been fetched — and layer 3's whole
   * lesson was that a file nobody counts is charged at zero.
   */
  withBed = false,
): void {
  const limits = stitchLimits();
  const entries = timeline.map(entryOf);

  if (entries.length > limits.maxClips) {
    throw new MaterializeError(
      `A timeline can hold up to ${describeLimits(limits)}. This one has ${entries.length} clips.`,
      "too_many_clips",
    );
  }

  // UNIQUE, because that is what gets downloaded. An unknown size is the per-file ceiling — the
  // image cap for a photo, the clip cap for a video.
  const byId = new Map(resolved.map((c) => [c.assetId, c]));
  const bytes =
    resolved.reduce(
      (sum, c) =>
        sum + (c.bytes ?? (c.still ? stillImageMaxBytes() : clipMaxBytes())),
      0,
    ) +
    // PER STILL POSITION: the frame and the clip it becomes are written into this same tmpfs, and
    // a file nobody counts is charged at zero (layer 3's lesson). See stillWorkBytes.
    entries.reduce(
      (sum, e) =>
        sum + (e.stillSec === undefined ? 0 : stillWorkBytes(e.stillSec)),
      0,
    ) +
    // The bed is another file landing in the same tmpfs, charged at its CEILING because its real
    // size is not known until it has been fetched. Layer 3's lesson, applied before it bit: a file
    // nobody counts is a file charged at zero.
    (withBed ? bedMaxBytes() : 0);
  if (bytes > limits.maxSourceBytes) {
    throw new MaterializeError(
      `A timeline can hold up to ${describeLimits(limits)}. This one needs about ${mb(bytes)} MB.`,
      "workspace_too_large",
    );
  }

  // PER POSITION, because a clip used twice plays twice.
  const seconds = entries.reduce((sum, e) => {
    const clip = byId.get(e.assetId);
    return sum + (clip ? effectiveSeconds(e, clip) : 0);
  }, 0);
  if (seconds > limits.maxTimelineSeconds) {
    throw new MaterializeError(
      `A timeline can hold up to ${describeLimits(limits)}. This one runs about ${Math.round(seconds)} seconds.`,
      "timeline_too_long",
    );
  }
}

/**
 * Everything a timeline will DOWNLOAD: its clips, plus the video it takes its sound from.
 *
 * ─── HER SOUND IS RESOLVED EXACTLY THE WAY HER CLIPS ARE ────────────────────────────────────────
 *
 * Through `resolveClips`, with the same athlete — so "that isn't yours" and "that doesn't exist"
 * are one answer for it too, it must be a stored video, and no id off a spec is ever trusted. The
 * only thing that differs is the SENTENCE, because "a clip could not be found" would send her
 * looking at the wrong thing.
 *
 * ─── AND CHARGED EXACTLY THE WAY HER CLIPS ARE ──────────────────────────────────────────────────
 *
 * It lands in the same tmpfs as the clips, so it goes in the same `resolved` list and is charged
 * its REAL bytes by `assertTimelineFits` — not the curated bed's 25 MB ceiling, which is a number
 * about the product's tracks and would let a 180 MB video in at a seventh of its size. Deduped by
 * id: a video that is BOTH on the timeline and the sound is one download and one charge.
 *
 * Called from BOTH doors, like the rest of this file, so the route and the runner cannot disagree.
 */
export async function resolveTimeline(
  athleteId: string,
  /**
   * The positions — or bare ids, which are videos. A position with `stillSec` is one of her photos
   * and goes through the photo predicate; every other id goes through the video one, as before.
   */
  timeline: TimelineInput[],
  ownSoundAssetId?: string | null,
): Promise<ResolvedClip[]> {
  const entries = timeline.map(entryOf);
  const videoIds = entries
    .filter((e) => e.stillSec === undefined)
    .map((e) => e.assetId);
  const stillIds = entries
    .filter((e) => e.stillSec !== undefined)
    .map((e) => e.assetId);
  // An empty timeline still gets resolveClips' own refusal. A timeline of only stills asks it
  // nothing: it would refuse zero videos as "needs at least one clip".
  const clips =
    videoIds.length > 0 || stillIds.length === 0
      ? await resolveClips(athleteId, videoIds)
      : [];
  // Before any download, like every other resolve here — a foreign photo fails the timeline while
  // nothing has been fetched.
  const stills = await resolveStills(athleteId, stillIds);
  if (!ownSoundAssetId || clips.some((c) => c.assetId === ownSoundAssetId)) {
    return [...clips, ...stills];
  }
  try {
    const [sound] = await resolveClips(athleteId, [ownSoundAssetId]);
    return [...clips, sound, ...stills];
  } catch (err) {
    if (err instanceof MaterializeError) {
      throw new MaterializeError(
        err.code === "not_found"
          ? "The video this timeline takes its sound from could not be found"
          : "The sound has to come from one of your videos",
        err.code,
        "sound",
      );
    }
    throw err;
  }
}

/**
 * THE EXACT TIMELINE BOUND, measured rather than estimated.
 *
 * Runs after the clips are on disk and before ffmpeg is started, on durations ffprobe read out of
 * the files themselves. It is the guard `effectiveSeconds` cannot be: a byte-derived duration is
 * wrong by whatever the source bitrate happens to be, and wrong in the direction that lets a long
 * clip through.
 *
 * ─── WHY THIS IS WORTH A SECOND PASS OVER THE SAME QUESTION ─────────────────────────────────────
 *
 * A clip's stored duration can still be NULL after 0058. The upload probe and the two riders fill
 * duration_seconds_precise where there are bytes to measure, but an Instagram video row holds a
 * poster JPEG rather than an mp4, so for most of those there is nothing to probe and never will
 * be. Every NULL is budgeted by the estimate above. With the estimate alone, a single large
 * low-bitrate clip defeats the memory ceiling entirely, and the way you find out is the instance
 * dying.
 *
 * Counted PER POSITION with trims applied, the same way the estimate counts, and deliberately
 * WITHOUT subtracting crossfade overlap: the overlap only ever makes the output shorter, so
 * ignoring it errs high. Erring high is the correct direction for a ceiling.
 */
export function assertProbedTimelineFits(
  timeline: TimelineInput[],
  /** Real duration per asset id, from ffprobe. Duplicates share one entry, as they share one file. */
  probedSeconds: Map<string, number>,
): void {
  const limits = stitchLimits();
  const seconds = timeline.map(entryOf).reduce((sum, e) => {
    // A still has no file to probe and needs none: its length is the hold, exactly.
    if (e.stillSec !== undefined) return sum + e.stillSec;
    const whole = probedSeconds.get(e.assetId);
    // A file we could not probe is charged at the whole cap rather than at zero — the same posture
    // the byte budget takes on an unknown size. It cannot be measured, so it cannot be cheap.
    if (whole === undefined) return sum + limits.maxTimelineSeconds;
    const start = e.trimStartSec ?? 0;
    const end = e.trimEndSec ?? whole;
    return sum + Math.max(0, end - start);
  }, 0);

  if (seconds > limits.maxTimelineSeconds) {
    throw new MaterializeError(
      `A timeline can hold up to ${describeLimits(limits)}. This one runs about ${Math.round(seconds)} seconds.`,
      "timeline_too_long",
    );
  }
}

/**
 * Stream one stored object to a local file, capped.
 *
 * A signed URL rather than the SDK's download(): it is what services/videoPoster.ts already uses to
 * reach the same bucket, it streams, and it carries its own auth — so nothing here holds a token.
 * The cap is enforced WHILE WRITING, not from Content-Length, because a wrong or absent header must
 * not be the only thing standing between a 2 GiB instance and a file that does not fit in it.
 */
async function downloadTo(
  gcsPath: string,
  destination: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  const url = await signedUrl(gcsPath, 15 * 60_000);
  // A REAL abort, not a Promise.race. lib/withTimeout's loser keeps running — and a download that
  // keeps running into a workspace the caller has already rm -rf'd is worse than useless on Cloud
  // Run: the unlinked file's inode stays alive while the write stream holds it open, so the tmpfs
  // pages — the RAM this whole file exists to bound — are not reclaimed until the process exits.
  // The signal reaches fetch, `pipeline` tears the chain down, the descriptor closes, the pages go.
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok || !res.body) {
    throw new MaterializeError(
      `Couldn't read a clip from storage (${res.status})`,
      "download_failed",
    );
  }

  // Count WHILE WRITING and let `pipeline` own backpressure and teardown: it destroys every stream
  // in the chain when one errors, so a cap breach cannot leave a half-written file streaming on.
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        done(
          new MaterializeError(
            `A clip is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`,
            "too_large",
          ),
        );
        return;
      }
      done(null, chunk);
    },
  });

  // fetch() hands back the DOM ReadableStream declaration; Readable.fromWeb wants node:stream/web's.
  // They are the same object at runtime and TypeScript has no way to know it — this bridges two
  // declarations of one thing, which is why it is written as a type import rather than `any`.
  const source = Readable.fromWeb(
    res.body as unknown as import("stream/web").ReadableStream<Uint8Array>,
  );

  await pipeline(source, counter, createWriteStream(destination));
  return written;
}

/**
 * Resolve, then download every clip into one disposable directory.
 *
 * ⚠️ THE CALLER MUST `dispose()` IN A `finally`. This function cleans up after ITSELF on the way out
 * — a workspace that throws half-built leaves nothing behind — but once it has returned, the
 * directory's lifetime belongs to the caller and /tmp is RAM.
 */
export async function materializeWorkspace(
  athleteId: string,
  timeline: TimelineInput[],
  signal?: AbortSignal,
  /** The curated bed to lay under it, already resolved from its NAME by studio/video/beds.ts. */
  bed?: BedSource | null,
  /** One of HER videos to take the sound from, by id. Never alongside `bed` — the spec forbids it. */
  ownSoundAssetId?: string | null,
): Promise<StitchWorkspace> {
  const entries = timeline.map(entryOf);
  const resolved = await resolveTimeline(athleteId, entries, ownSoundAssetId);

  // Refuse up front, on the sizes and durations the rows already carry, naming all three caps.
  // A row with no byte count is charged at the per-clip ceiling rather than at zero — an unknown
  // size must never be treated as free, the same posture the spend gate takes on an unpriced model.
  assertTimelineFits(entries, resolved, !!bed);

  const dir = await mkdtemp(join(workspaceRoot(), "studio-stitch-"));
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await rm(dir, { recursive: true, force: true });
  };

  try {
    const paths = new Map<string, string>();
    const stills = new Map<string, string>();
    // What the still positions will write here later — reserved against the same budget the
    // downloads are measured against, so the re-check below is the arithmetic's own question.
    const reserved = entries.reduce(
      (sum, e) =>
        sum + (e.stillSec === undefined ? 0 : stillWorkBytes(e.stillSec)),
      0,
    );
    let total = 0;
    for (const [index, clip] of resolved.entries()) {
      const destination = join(
        dir,
        `${index}-${clip.assetId}.${clip.still ? "photo" : "mp4"}`,
      );
      total += await downloadTo(
        clip.gcsPath,
        destination,
        clip.still ? stillImageMaxBytes() : clipMaxBytes(),
        signal,
      );
      // Against the SOURCE budget, not the whole workspace: the difference is reserved for the
      // output, which ffmpeg writes into this same directory — and on Cloud Run that is RAM.
      // Re-checked here because a row's byte count is a claim, and this is the fact.
      if (total + reserved > maxSourceBytes()) {
        throw new MaterializeError(
          `A timeline can hold up to ${describeLimits()}. This one's clips came to more than that.`,
          "workspace_too_large",
        );
      }
      (clip.still ? stills : paths).set(clip.assetId, destination);
    }

    // THE BED LAST, and never resolved against the athlete — it is not hers, it is the product's
    // (studio/video/beds.ts). Its path comes off the allowlist, so there is nothing to scope.
    let bedPath: string | null = null;
    if (bed) {
      bedPath = join(dir, "bed.m4a");
      total += await downloadTo(bed.gcsPath, bedPath, bedMaxBytes(), signal);
    } else if (ownSoundAssetId) {
      // Already on disk: it was in `resolved`, so the loop above fetched it, counted it against
      // the source budget, and — if it is also a clip — fetched it ONCE. Nothing to download here.
      bedPath = paths.get(ownSoundAssetId) ?? null;
    }

    logger.info(
      {
        athleteId,
        clips: paths.size,
        stills: stills.size,
        requested: entries.length,
        totalBytes: total,
        sourceBudget: maxSourceBytes(),
        outputAllowance: outputAllowanceBytes(),
        bed: bed?.gcsPath ?? null,
      },
      "stitch workspace materialized",
    );
    return {
      dir,
      paths,
      stills,
      bedPath,
      outputPath: join(dir, "output.mp4"),
      dispose,
    };
  } catch (err) {
    // Half-built workspaces clean up after themselves. Only a RETURNED workspace is the caller's.
    await dispose();
    throw err;
  }
}

/**
 * The return trip: a stitched file becomes a media_asset the library and the Made shelf can see.
 *
 * ─── WHY THIS DOES NOT CALL recordGeneratedAsset ────────────────────────────────────────────────
 *
 * That function's `jobId` is required and writes media_assets.generation_job_id, which carries a
 * real FK to generation_jobs (studio/sql/generationGuards.sql). A stitch job id is not in that table
 * and would violate it. The link runs the other way for a stitch — studio_stitch_jobs.output_asset_id
 * — because one stitch produces exactly one file, where one generation produces many.
 *
 * Nothing is lost by not reusing it: the only extra thing it does is writeGeneratedThumbnail, which
 * returns null for VIDEO by design (studio/thumbnail.ts:77). The poster comes from the existing
 * media-poster cron, which selects exactly the row this writes — origin 'generated', media_type
 * 'VIDEO', status 'stored', gcs_thumb_path NULL (services/videoPoster.ts).
 *
 * Born `draft`, like every other piece of Studio output. A stitch is not a clearance.
 *
 * ─── IDEMPOTENT ON THE JOB, AND THAT IS A LAYER-3 REQUIREMENT ───────────────────────────────────
 *
 * The stitch reaper returns a lapsed job to `queued` ALWAYS — there is no orphan arm, because a
 * stitch spends nothing and re-running it costs CPU rather than money. So a second, third and
 * fourth run of the same job are ORDINARY, not exceptional, and an unconditional insert here would
 * write her a fresh library row on each one. The file would be fine (the path is deterministic, so
 * the object is overwritten); the ROWS would accumulate, and every one but the last would be
 * orphaned — nothing points at it, and it shows up in her library anyway.
 *
 * So the deterministic path is the identity: an existing undeleted row at it is UPDATED in place
 * and keeps its asset id, which also means a client already holding that id does not have it
 * invalidated by a reap it never saw. Not a unique constraint — media_assets has none on gcs_path,
 * and adding one is a shared-schema change that is not ours to make — so this is read-then-write
 * and is not race-proof on its own. What makes it sufficient is that the two runs it protects
 * against are SEQUENTIAL by construction: the lease, and the in-process capacity guard in
 * studio/stitchRunner.ts, exist to stop one job being worked twice at the same instant.
 */
export async function publishStitchOutput(input: {
  athleteId: string;
  stitchJobId: string;
  localPath: string;
  width: number;
  height: number;
  durationSeconds: number;
}): Promise<{ assetId: string; gcsPath: string }> {
  const gcsPath = `athletes/${input.athleteId}/studio/stitch/${input.stitchJobId}/output.mp4`;
  const bytes = (await stat(input.localPath)).size;

  await uploadLocalFile(input.localPath, gcsPath, "video/mp4");

  const fields = {
    // NULL on purpose — see the header. The link lives on studio_stitch_jobs.output_asset_id.
    generation_job_id: null,
    gcs_path: gcsPath,
    content_type: "video/mp4",
    width: input.width,
    height: input.height,
    bytes,
    // ROUNDED, because media_assets.duration_seconds is an INTEGER column — it was added for the
    // client's upload picker, which reports whole seconds. A float here is a write error, not a
    // truncation, and this column keeps meaning exactly what it meant before 0058.
    duration_seconds: Math.round(input.durationSeconds),
    // THE EXACT FIGURE, which this function has always been handed and until 0058 had nowhere to
    // put. It is ffprobe's reading of the file we just wrote (stitchRunner passes
    // manifest.output.durationSec), so it is measured, not asserted — and it costs nothing: no
    // probe, no fetch, no round trip. The manifest keeps its copy; this is the one a reader can
    // reach without the job.
    duration_seconds_precise: input.durationSeconds,
  };

  // Has this job already published? Scoped to the athlete as every read here is, even though the
  // path contains her id — a predicate that is merely implied by a string is not a predicate.
  const [existing] = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.athlete_id, input.athleteId),
        eq(mediaAssets.gcs_path, gcsPath),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(mediaAssets)
      .set({ ...fields, status: "stored" } as never)
      .where(eq(mediaAssets.id, existing.id));
    logger.info(
      {
        athleteId: input.athleteId,
        stitchJobId: input.stitchJobId,
        assetId: existing.id,
        bytes,
      },
      "stitch output re-published over its previous run — same asset id",
    );
    return { assetId: existing.id, gcsPath };
  }

  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: input.athleteId,
      platform: STUDIO_PLATFORM,
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      approval_status: "draft",
      ...fields,
      ingested_at: new Date(),
    } as never)
    .returning({ id: mediaAssets.id });

  logger.info(
    {
      athleteId: input.athleteId,
      stitchJobId: input.stitchJobId,
      assetId: row.id,
      bytes,
    },
    "stitch output published",
  );
  return { assetId: row.id, gcsPath };
}
