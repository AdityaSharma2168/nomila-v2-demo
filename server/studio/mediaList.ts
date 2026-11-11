/**
 * studio/mediaList — the shared Studio picker's list: what a mount may offer, in what order, one page
 * at a time. The routes are GET /studio/media and GET /studio/media/search (routes/studio.ts); the
 * picker is client/components/studio/StudioMediaPicker.tsx, mounted on the Board, the Agent screen
 * and the Video tab.
 *
 * ─── ELIGIBILITY: OUR PREDICATES, NARROWED BY THE MOUNT ─────────────────────────────────────────
 *
 * `kind=photos` is `herPhoto` and `kind=clips` is `herClip` (studio/photoPredicate.ts) — the caster's
 * and the stitch's own, so a photos mount never receives a clip and nothing is offered that its door
 * refuses. Then, only ever narrowing:
 *
 *   still    photos a stitch can hold — STILL_CONTENT_TYPES, so no HEIC (what /stitch/stills does)
 *   origin   what the mount offers: upload · generated · synced (connected ∪ discovery — Instagram,
 *            TikTok and YouTube alike, which is why the chip says "From your accounts")
 *   bytes    a row with nothing behind gcs_path has nothing to show
 *
 * Untagged rows are offered: she is choosing by eye, not by tag. Rejected generations are offered, as
 * /stitch/* offers them.
 *
 * ─── THE ORDER AND THE CURSOR ───────────────────────────────────────────────────────────────────
 *
 * Each row by its own date — `COALESCE(posted_at, ingested_at)` DESC NULLS LAST, then id DESC, the
 * /stitch/* order — so what she just made is at the top and an old shoot sits where its date puts it.
 *
 * The cursor is a KEYSET on that pair, never an offset. An upload made from the picker gets
 * `posted_at = now` (the client sends no capture date — use-media-library.ts `uploadOneMedia`) and
 * lands ABOVE page 1; under an offset every later page would then start one row early and serve the
 * previous page's last row again, a tile she could pick twice.
 *
 * Two things GET /me/media's cursor gets wrong (routes/media.ts), handled here on purpose:
 *
 *   - AN UNDATED ROW. `ingested_at` is nullable, so the key can be NULL. A page that ends on an
 *     undated row hands back a cursor whose key is null, and the next page is the rest of the undated
 *     tail — /me/media hands back `posted: null`, the client drops it, and page 1 comes round again.
 *   - MICROSECONDS. The key travels as TEXT, formatted by Postgres in UTC with all six digits, never
 *     through a JS Date. Every writer stamps a JS Date today, so milliseconds would be exact now; the
 *     text form removes the dependency, so a writer that ever uses the database's `now()` cannot make
 *     two rows a microsecond apart skip or repeat at a page edge.
 *
 * The cursor is opaque to the client: base64url JSON, validated field by field on the way back in.
 */
import {
  desc,
  inArray,
  isNotNull,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { mediaAssets } from "../../shared/schema";
import { signedUrl } from "../lib/mediaStore";
import { herClip, herPhoto } from "./photoPredicate";
import { clipReadStateOf, type ClipReadState } from "./enrich/readState";
import { libraryFieldsEnabled } from "./config";
import {
  identityBoundSql,
  madeHereNotHer,
  photoRankSql,
} from "./referenceGate";
import { STILL_CONTENT_TYPES } from "./video/materialize";

/** A page's rows when the caller asks for no number — the compact strip's size. */
export const MEDIA_PAGE_DEFAULT = 24;
/** The most one page may hold — the /stitch/* lists' 60, so the Video tab's strip loses nothing. */
export const MEDIA_PAGE_MAX = 60;

/** The origins a mount can ask for, by the name the picker uses, and the column values each covers. */
export const MEDIA_ORIGINS = {
  upload: ["upload"],
  generated: ["generated"],
  synced: ["connected", "discovery"],
} as const;
export type MediaOrigin = keyof typeof MEDIA_ORIGINS;

export interface MediaQuery {
  kind: "photos" | "clips";
  /** Photos a stitch can hold: STILL_CONTENT_TYPES only. Photos only. */
  still: boolean;
  /** The column values to keep, or null for every origin. */
  origins: string[] | null;
}

type Refusal = { error: string; field: string };

const oneString = (v: unknown): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" ? v : null;

/** The list's shape from a query string — or the reason it is not one. */
export function parseMediaQuery(
  query: Record<string, unknown>,
): MediaQuery | Refusal {
  const kind = oneString(query.kind);
  if (kind !== "photos" && kind !== "clips") {
    return { error: "kind is photos or clips", field: "kind" };
  }

  const still = oneString(query.still);
  if (still !== undefined && still !== "1" && still !== "0") {
    return { error: "still is 1 or 0", field: "still" };
  }
  if (still === "1" && kind !== "photos") {
    return {
      error: "still narrows photos — a clip is never held as a still",
      field: "still",
    };
  }

  const origin = oneString(query.origin);
  if (origin === null)
    return { error: "origin is one comma-separated list", field: "origin" };
  let origins: string[] | null = null;
  if (origin !== undefined && origin !== "") {
    const names = origin.split(",");
    const unknown = names.find((n) => !(n in MEDIA_ORIGINS));
    if (unknown !== undefined) {
      return {
        error: `origin is any of: ${Object.keys(MEDIA_ORIGINS).join(", ")}`,
        field: "origin",
      };
    }
    origins = [
      ...new Set(names.flatMap((n) => MEDIA_ORIGINS[n as MediaOrigin])),
    ];
  }

  return { kind, still: still === "1", origins };
}

/** The most rows one `ids` lookup may name — an upload asks for one; this is headroom, never a page. */
export const MEDIA_IDS_MAX = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ids`: rows by id, answered through the mount's OWN predicate (quality-scrappy, Investigation 12). What an upload
 * made from inside a picker asks: "can THIS mount use the row I just made?" — never "is it on your first page?". The
 * first page is ranked (PR 12), an unread upload ranks −1, and on a library of any size it was never there, so every
 * in-picker upload was refused "it can't be used here" (measured: 346 of one athlete's photos outrank a fresh one).
 * Absent: undefined. One comma-separated list of 1..MEDIA_IDS_MAX uuids, else a refusal.
 */
export function parseMediaIds(raw: unknown): string[] | undefined | Refusal {
  if (raw === undefined) return undefined;
  const refusal = {
    error: `ids is one comma-separated list of 1 to ${MEDIA_IDS_MAX} asset ids`,
    field: "ids",
  };
  if (typeof raw !== "string" || raw === "") return refusal;
  const ids = [...new Set(raw.split(","))];
  if (ids.length > MEDIA_IDS_MAX || !ids.every((id) => UUID.test(id)))
    return refusal;
  return ids;
}

/** A page size from the query string: the default when absent, a whole number within bounds, or a refusal. */
export function parseMediaLimit(raw: unknown): number | Refusal {
  if (raw === undefined) return MEDIA_PAGE_DEFAULT;
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MEDIA_PAGE_MAX) {
    return {
      error: `limit is a whole number from 1 to ${MEDIA_PAGE_MAX}`,
      field: "limit",
    };
  }
  return n;
}

/**
 * THE PREDICATE a mount's list is: ours, narrowed. Browse and search both read it, so the two cannot
 * come to offer different things.
 */
export function mediaPredicate(
  athleteId: string,
  q: MediaQuery,
  ...more: SQL[]
) {
  const narrow: SQL[] = [isNotNull(mediaAssets.gcs_path)];
  if (q.origins) narrow.push(inArray(mediaAssets.origin, q.origins));
  if (q.kind === "clips") return herClip(athleteId, ...narrow, ...more);
  if (q.still)
    narrow.push(inArray(mediaAssets.content_type, STILL_CONTENT_TYPES));
  return herPhoto(athleteId, ...narrow, ...more);
}

/** Each row by its own date. */
export const mediaDate = sql`COALESCE(${mediaAssets.posted_at}, ${mediaAssets.ingested_at})`;

/** The list's order — newest first by each row's own date, undated rows last, then id. */
export const mediaOrder = [
  sql`${mediaDate} DESC NULLS LAST`,
  desc(mediaAssets.id),
];

/**
 * PR 12 — THE PHOTO RANK (ruling 3, amended 24 Sep 2026: someone else ranks below the unread).
 * The tiers are documented on `PHOTO_RANK_SQL` (referenceGate.ts). One number so the cursor can
 * carry it (`h`) and page N+1 continues page N's order exactly. Within a rank, the date order below.
 * Raw SQL text, because it is spliced into both the column and the cursor's `after` clause and must
 * be the same expression in both.
 */
// The rank expression lives beside the identity expression it reads (referenceGate.ts photoRankSql). Both are read
// per QUERY, not at module load (drizzle calls `getSQL` when it builds each query): with STUDIO_LIBRARY_FIELDS on they
// read the chain rule (ADI-R19-BOARD), off today's rule — byte for byte what this list always selected.
const photoRankRaw: SQLWrapper = {
  getSQL: () => sql.raw(photoRankSql(libraryFieldsEnabled())),
};
const identityBoundRaw: SQLWrapper = {
  getSQL: () => sql.raw(identityBoundSql(libraryFieldsEnabled())),
};
const photoRank = sql`(${photoRankRaw})`;

/**
 * Whether this list is served in PR 12's ranked order: with the flag on, photos AND clips (Adi's
 * ruling, 24 Sep 2026: YOUR VIDEOS sorts and labels off the clip's poster tag — the same `vision`
 * object, written by the photo lane from the poster frame, or by the clip lane whole).
 */
export const rankedList = (_kind: MediaQuery["kind"]): boolean =>
  libraryFieldsEnabled();

/** The order a list is served in: ranked (PR 12) or by date. ⚠️ MUTATION (studio.media.test "picker ignores hero_suitability"): return `mediaOrder` for both — reds. */
export const mediaOrderFor = (kind: MediaQuery["kind"]) =>
  rankedList(kind) ? [sql`${photoRank} DESC`, ...mediaOrder] : mediaOrder;

/** What a row needs for a tile, a preview and the cursor. */
export const MEDIA_COLUMNS = {
  id: mediaAssets.id,
  gcs_path: mediaAssets.gcs_path,
  gcs_thumb_path: mediaAssets.gcs_thumb_path,
  origin: mediaAssets.origin,
  duration_seconds: mediaAssets.duration_seconds,
  duration_seconds_precise: mediaAssets.duration_seconds_precise,
  // How many beats the clip lane wrote (C2 Half A) — 0 when none or when the row is a photo. What
  // lets the Agent form cut a picked video into the plan rather than append it whole.
  beats: sql<number>`CASE WHEN jsonb_typeof(${mediaAssets.metadata} -> 'vision' -> 'beats') = 'array' THEN jsonb_array_length(${mediaAssets.metadata} -> 'vision' -> 'beats') ELSE 0 END`,
  // Whether a beats array exists at all (a read that found none is still a read), the read mark and
  // the shared brake — the three keys studio/enrich/readState.ts reads. Never the whole metadata: the
  // 1408-d embedding lives there.
  read_done: sql<boolean>`jsonb_typeof(${mediaAssets.metadata} -> 'vision' -> 'beats') = 'array'`,
  clip_read: sql<unknown>`${mediaAssets.metadata} -> 'clip_read'`,
  abandoned_reason: sql<
    string | null
  >`${mediaAssets.metadata} -> 'enrichment' ->> 'abandoned_reason'`,
  // PR 12 (STUDIO_LIBRARY_FIELDS): what the tagger knows, for the tile's label and the photo order.
  // Served only with the flag on (shapeMediaRow); selected always, which costs nothing.
  tagged: sql<boolean>`(${mediaAssets.metadata} -> 'vision') IS NOT NULL`,
  subject: sql<
    string | null
  >`${mediaAssets.metadata} -> 'vision' ->> 'subject'`,
  athletePresent: sql<
    string | null
  >`${mediaAssets.metadata} -> 'vision' ->> 'athlete_present'`,
  shotType: sql<
    string | null
  >`${mediaAssets.metadata} -> 'vision' ->> 'shot_type'`,
  disposition: sql<
    string | null
  >`${mediaAssets.metadata} -> 'vision' ->> 'disposition'`,
  // Ruling 24 Sep: the caster's identity_bound, so a made-here row without her can say so.
  identityBound: sql<boolean | null>`(${identityBoundRaw})`,
  // The photo rank (see `photoRank`) — what the ranked order sorts on first and the cursor carries as `h`.
  rank: sql<number | null>`(${photoRankRaw})`,
  // ⚠️ TEXT, in UTC, with microseconds — see the header. NULL for an undated row.
  sortKey: sql<
    string | null
  >`to_char(${mediaDate} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
};

export interface MediaCursor {
  /** The row's date as `sortKey` wrote it, or null for an undated row. */
  k: string | null;
  id: string;
  /** PR 12: the row's photo rank, on a ranked list's cursor only. A cursor from the other mode is refused (ruling 5). */
  h?: number;
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeMediaCursor = (c: MediaCursor): string =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

/** A cursor off the query string: absent (undefined), well-formed, or null for anything else. */
export function decodeMediaCursor(
  raw: unknown,
): MediaCursor | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const c = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    const { k, id, h } = c as Record<string, unknown>;
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    if (k !== null && (typeof k !== "string" || !KEY_RE.test(k))) return null;
    if (h === undefined) return { k, id };
    if (typeof h !== "number" || !Number.isFinite(h)) return null;
    return { k, id, h };
  } catch {
    return null;
  }
}

/**
 * The rows after a cursor, in the list's order.
 *
 *   a dated cursor     older rows · the same date and a smaller id · AND EVERY UNDATED ROW, which
 *                      sorts after all the dated ones
 *   an undated cursor  the rest of the undated tail: undated, with a smaller id
 */
export const mediaAfter = (c: MediaCursor): SQL => {
  const byDate =
    c.k === null
      ? sql`(${mediaDate} IS NULL AND ${mediaAssets.id} < ${c.id}::uuid)`
      : sql`(${mediaDate} < ${c.k}::timestamptz OR (${mediaDate} = ${c.k}::timestamptz AND ${mediaAssets.id} < ${c.id}::uuid) OR ${mediaDate} IS NULL)`;
  // PR 12: a ranked cursor — lower rank, or the same rank and after by date. ⚠️ MUTATION
  // (studio.media.test "picker ignores hero_suitability"): drop the rank arm — the walk repeats rows.
  if (c.h === undefined) return byDate;
  return sql`(${photoRank} < ${c.h} OR (${photoRank} = ${c.h} AND ${byDate}))`;
};

/**
 * A cursor fits the list it is presented to: a ranked list's cursor carries `h`; a date-ordered
 * list's does not. A cursor from the other mode (the flag flipped, or a photos cursor on clips) is
 * refused with the same 400 as a malformed one, and the client starts from page 1 (ruling 5).
 * ⚠️ MUTATION (studio.media.test "stale cursor strands the picker"): accept either — page 2 is served
 * in the other order, repeating and skipping rows.
 */
export const cursorFits = (c: MediaCursor, kind: MediaQuery["kind"]): boolean =>
  (c.h !== undefined) === rankedList(kind);

type MediaRow = {
  id: string;
  gcs_path: string | null;
  gcs_thumb_path: string | null;
  origin: string;
  duration_seconds: number | null;
  duration_seconds_precise: number | null;
  tagged?: boolean | null;
  identityBound?: boolean | null;
  subject?: string | null;
  athletePresent?: string | null;
  shotType?: string | null;
  disposition?: string | null;
  beats?: number | string | null;
  /** PR 9.5 — the read state's inputs. Absent from a caller that selected only the tile columns. */
  read_done?: boolean | null;
  clip_read?: unknown;
  abandoned_reason?: string | null;
};

/** One photo, as a tile and a preview see it: the full picture, and the thumbnail — or the picture again. */
export interface MediaPhoto {
  kind: "photo";
  assetId: string;
  imageUrl: string;
  thumbUrl: string;
  /** The column's word. The client owns what she reads ("Made here", "Uploaded"). */
  origin: string;
  /**
   * PR 12, served with STUDIO_LIBRARY_FIELDS on and absent otherwise. `tagged` false is "not read yet" (the word `read` belongs to a CLIP's read state, PR 9.5);
   * `subject` is the tagger's word (the_athlete | another_person | nobody), falling back to the
   * pre-ternary boolean, null when it said nothing; `reject` is disposition reject — offered, labelled.
   */
  tagged?: boolean;
  subject?: string | null;
  shotType?: string | null;
  reject?: boolean;
  /** Made here and the job carried no reference of her (referenceGate `madeHereNotHer`) — labelled, and never her likeness. */
  madeHereNotHer?: boolean;
}

/** One clip: the mp4, its poster once one exists (null until then, never the mp4), and its length. */
export interface MediaClip {
  kind: "clip";
  assetId: string;
  videoUrl: string;
  posterUrl: string | null;
  durationSec: number | null;
  /** NULL IS AN ANSWER — "nothing measured this row" — and is served as null, not as the integer. */
  durationPreciseSec: number | null;
  origin: string;
  /** How many beats its clip read found — 0 until the clip lane has read it. A picked video with beats can be CUT into an Agent plan. */
  beats: number;
  /**
   * Where its clip read stands (PR 9.5): unread with the quote a read would cost, reading, done,
   * failed or at_cap with the reason. What the "Read this clip · $0.0X" affordance renders.
   */
  read: ClipReadState;
  /** PR 12 (ruling 24 Sep): the poster tag's facts, as on a photo — served with the flag on. */
  tagged?: boolean;
  subject?: string | null;
  shotType?: string | null;
  reject?: boolean;
  madeHereNotHer?: boolean;
}

/** PR 12: the tile's facts off the row. `subject` reads the ternary, else the pre-ternary boolean (R-3). */
const tagFields = (
  r: MediaRow,
): Pick<
  MediaPhoto,
  "tagged" | "subject" | "shotType" | "reject" | "madeHereNotHer"
> => {
  const read = r.tagged === true;
  const subject =
    r.subject === "the_athlete" ||
    r.subject === "another_person" ||
    r.subject === "nobody"
      ? r.subject
      : r.athletePresent === "true"
        ? "the_athlete"
        : null;
  return {
    tagged: read,
    subject: read ? subject : null,
    shotType: read ? (r.shotType ?? null) : null,
    reject: read && r.disposition === "reject",
    madeHereNotHer: madeHereNotHer({
      origin: r.origin,
      identityBound: r.identityBound ?? null,
    }),
  };
};

/**
 * A row as the picker receives it. The fields are /stitch/stills' and /stitch/clips' own, so the Video
 * tab can hand a row straight to its timeline, plus `kind`.
 */
export async function shapeMediaRow(
  kind: MediaQuery["kind"],
  r: MediaRow,
): Promise<MediaPhoto | MediaClip> {
  if (kind === "photos") {
    return {
      kind: "photo",
      assetId: r.id,
      imageUrl: await signedUrl(r.gcs_path!),
      thumbUrl: await signedUrl(r.gcs_thumb_path ?? r.gcs_path!),
      origin: r.origin,
      ...(libraryFieldsEnabled() ? tagFields(r) : {}),
    };
  }
  return {
    kind: "clip",
    assetId: r.id,
    videoUrl: await signedUrl(r.gcs_path!),
    // An <Image> handed a video url is an empty tile — the rule /stitch/clips keeps.
    posterUrl: r.gcs_thumb_path ? await signedUrl(r.gcs_thumb_path) : null,
    durationSec: r.duration_seconds ?? null,
    durationPreciseSec: r.duration_seconds_precise ?? null,
    origin: r.origin,
    beats: Number(r.beats ?? 0) || 0,
    ...(libraryFieldsEnabled() ? tagFields(r) : {}),
    read: clipReadStateOf(
      {
        beats: r.read_done ? Number(r.beats ?? 0) || 0 : null,
        clipRead: r.clip_read ?? null,
        abandonedReason: r.abandoned_reason ?? null,
        durationSeconds:
          r.duration_seconds_precise ??
          (r.duration_seconds && r.duration_seconds > 0
            ? r.duration_seconds
            : null),
      },
      new Date(),
    ),
  };
}

// ─── Search: ranked here, over what our own predicate already let through ──────────────────────

/** The most a search serves. One page, no cursor — see GET /studio/media/search. */
export const MEDIA_SEARCH_LIMIT = 60;

/** What she reads when her words could not be embedded. She can still browse. */
export const MEDIA_SEARCH_UNAVAILABLE =
  "Search isn't available right now — you can still browse everything below.";

/** A stored embedding as the driver hands it back — parsed jsonb, or the text of it. */
const asVector = (raw: unknown): number[] | null => {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return Array.isArray(v) && v.length > 0 ? (v as number[]) : null;
};

/**
 * Rows best match first, by `score` of each row's own embedding and NOTHING else — no hero score, no
 * views (see the route for why). A row with no embedding ranks after every row with one.
 *
 * The rows arrive in the list's order (newest first) and the sort is stable, so equal scores — every
 * unembedded row among them — keep that order. Compared, never subtracted: two -Infinity scores
 * subtract to NaN, which leaves a sort's order undefined (the rule cast.ts `rankWithoutHer` keeps).
 */
export function rankBySimilarity<T extends { embedding: unknown }>(
  rows: T[],
  score: (embedding: number[]) => number,
): T[] {
  return rows
    .map((row) => {
      const v = asVector(row.embedding);
      const s = v ? score(v) : -Infinity;
      return { row, s: Number.isFinite(s) ? s : -Infinity };
    })
    .sort((a, b) => (a.s === b.s ? 0 : a.s > b.s ? -1 : 1))
    .map((x) => x.row);
}
