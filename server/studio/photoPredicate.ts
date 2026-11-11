/**
 * studio/photoPredicate — which rows are HER photographs, as one SQL predicate. And, beside it, which
 * rows are her CLIPS (`herClip`), for the same reason: more than one surface asks.
 *
 * Two surfaces resolve a photograph out of an id they did not choose, and both must give the same
 * answer: the Agent's caster (studio/agent/cast.ts), which re-loads every row a search hands back,
 * and the stitch (studio/video/materialize.ts), which resolves a still off a timeline a client sent
 * and, later, off a job row. One predicate, so "hers" cannot mean two things.
 *
 * ─── ⚠️  IT IMPORTS NOTHING THAT CAN SPEND, AND THAT IS WHY IT IS ITS OWN FILE ─────────────────
 *
 * The predicate used to live inside cast.ts, which imports lib/mediaEmbed (a model call) and
 * services/mediaSearch. The stitch runner may reach nothing that spends — stitchRunner.test.ts walks
 * its import graph and fails on the first spend path — so importing the caster to get four lines of
 * SQL would have dragged a model client into the $0 queue. drizzle and the schema, and nothing else.
 */
import { notAPreview } from "../lib/previewAsset";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  ne,
  type SQL,
} from "drizzle-orm";
import { mediaAssets } from "../../shared/schema";

/** A photograph, in the types the Studio treats as one. The Board's picker offers the same two. */
export const PHOTO_TYPES = ["IMAGE", "CAROUSEL_ALBUM"];

/**
 * NOT A REFERENCE. A row with origin 'reference' is a picture she POINTED AT — fetched from a link
 * she gave the direction engine (PR 7, Lane C; migration 0062) and stored under her prefix so a
 * plan row can name it. It is not her footage: never a photo of her, never a scene of hers, never
 * offered to the planner, the her-room, the picker or the gallery. Every predicate here carries
 * this, so the one reader that must see such a row — the reference engine, by id, under her
 * athlete_id — is the only one that does. ⚠️ MUTATION (direction/routes.test): drop it — "a fetched
 * reference is stored as hers and NEVER offered as her footage" reds.
 */
const notAReference = () => ne(mediaAssets.origin, "reference");

/**
 * THE PREDICATE. Hers · stored · not deleted · top-level · a photograph · not a reference.
 *
 * A row that fails any of it simply does not come back — another athlete's id and an id that does
 * not exist are the same answer, so a caller cannot use it to probe a library that is not hers.
 * `more` only ever narrows it.
 */
export const herPhoto = (athleteId: string, ...more: SQL[]) =>
  and(
    eq(mediaAssets.athlete_id, athleteId),
    eq(mediaAssets.status, "stored"),
    isNull(mediaAssets.deleted_at),
    isNull(mediaAssets.parent_media_id),
    inArray(mediaAssets.media_type, PHOTO_TYPES),
    notAReference(),
    notAPreview(),
    ...more,
  );

/**
 * The media types a stitch can actually join. An IMAGE here is a caller bug, not a decode failure.
 *
 * Here rather than in studio/video/materialize.ts, which re-exports it, so the lists that OFFER a
 * clip (GET /studio/stitch/clips, GET /studio/media) and the stitch that ACCEPTS one read the same
 * array — one list, so the doors cannot drift into offering a clip the stitch then refuses.
 */
export const VIDEO_TYPES = ["VIDEO", "REELS"];

/**
 * HER CLIPS, as one predicate. Hers · stored · not deleted · top-level · a video type · with video
 * bytes behind `gcs_path`.
 *
 * The last two are what a photograph's predicate has no use for. An Instagram video row that holds
 * only its POSTER has `media_type` VIDEO and a JPEG in `gcs_path`; offering it would queue a stitch the
 * server refuses at resolve time. So a clip is a video TYPE whose stored bytes are video.
 *
 * Two lists offer clips — the Video tab's (GET /studio/stitch/clips) and the shared picker's
 * (GET /studio/media) — and both read this, so they cannot come to offer different things. Disjoint
 * from `herPhoto` by media type: an id is a photo or a clip, never both.
 */
export const herClip = (athleteId: string, ...more: SQL[]) =>
  and(
    eq(mediaAssets.athlete_id, athleteId),
    eq(mediaAssets.status, "stored"),
    isNull(mediaAssets.deleted_at),
    isNull(mediaAssets.parent_media_id),
    inArray(mediaAssets.media_type, VIDEO_TYPES),
    isNotNull(mediaAssets.gcs_path),
    sql`${mediaAssets.content_type} LIKE 'video/%'`,
    notAReference(),
    notAPreview(),
    ...more,
  );

/**
 * HER PHOTOGRAPHS OR HER CLIPS — the two predicates above, either. For the one caller that resolves
 * ids it did not choose into rows that may be EITHER: the Agent's caster (studio/agent/cast.ts),
 * since a plan may name a clip (C2 Half B). It is `herPhoto OR herClip`, nothing looser: an id that
 * is neither — a poster-only Instagram video, a deleted row, another athlete's — still does not come
 * back. `more` narrows both arms.
 */
export const herPhotoOrClip = (athleteId: string, ...more: SQL[]) =>
  and(or(herPhoto(athleteId), herClip(athleteId)), ...more);
