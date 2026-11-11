/**
 * mediaPickerLogic — the shared Studio media picker's decisions, as pure functions.
 *
 * The picker (client/components/studio/StudioMediaPicker.tsx) is mounted on the Board, the Agent
 * screen and the Video tab. It lists from GET /studio/media and GET /studio/media/search
 * (server/studio/mediaList.ts). What each mount may offer, which chips it shows, what the strip draws
 * and what an upload turns into are decided here, where a test can hold them without a renderer.
 *
 * ─── ⚠️  SELECTION STAYS WITH THE PARENT ────────────────────────────────────────────────────────
 *
 * The picker never decides add, toggle or cap. It draws the parent's selection (`selectedIds`, in
 * pick order) and reports a tap with the WHOLE row, so every parent keeps the exact semantics it had:
 * the Board appends a row, the Agent toggles up to its cap, the Video tab appends a position.
 */
import type { ClipRead } from "./clipReadLogic";
import type { ClipChoice, StillChoice } from "./stitchLogic";

export type PickerKind = "photos" | "clips";
export type PickerOrigin = "upload" | "generated" | "synced";

/**
 * Where the picker is mounted.
 *
 * ⚠️ RESERVED — TYPED, NOT READ IN V1. What a mount lists is decided by `kind`, `forStill` and
 * `origins`. This exists for the next step: showing why a caster could not use a row ("nobody is
 * tagged in this photo — it can't be a shot of you"), the picker-side twin of `picksWithoutHer`.
 */
export type PickerContext =
  | "board"
  | "agent-pick"
  | "agent-product"
  | "agent-video"
  | "video-clip"
  | "video-still";

/** One photo: a StillChoice (the Video tab's own shape) plus its kind. `origin` is her words. */
export interface PickerPhoto extends StillChoice {
  kind: "photo";
  /**
   * PR 12 — what the tagger knows, for the tile's label (`tileLabel`). `tagged` false is "not read yet"
   * (`read` is a CLIP's read state, PR 9.5).
   * An older server sends none of this: read as `tagged: true` with nothing to say, never "not read yet".
   * Optional on the type so the Video tab's own rows (StillChoice) need not carry them.
   */
  tagged?: boolean;
  /** the_athlete | another_person | nobody, or null when the tagger said nothing about who. */
  subject?: string | null;
  shot?: string | null;
  /** disposition reject — offered, labelled "not usable", never hidden (ruling 3). */
  reject?: boolean;
  /** Made here and the job carried no photo of her (ruling 24 Sep) — \"Made here · not from you\", whatever the tag says. */
  madeHereNotHer?: boolean;
}
/** One clip: a ClipChoice (the Video tab's own shape) plus its kind. `origin` is her words. */
export interface PickerClip extends ClipChoice {
  kind: "clip";
  /** How many beats its clip read found — 0 until read. Only the Agent form's video tray reads it. */
  beats: number;
  /** Where its clip read stands (PR 9.5, server/studio/enrich/readState.ts). Null from an older server. */
  read: ClipRead | null;
  /** PR 12 (ruling 24 Sep): the poster tag's facts, the same four as a photo's, for `tileLabel`. */
  tagged?: boolean;
  subject?: string | null;
  shot?: string | null;
  reject?: boolean;
  /** Made here and the job carried no photo of her (ruling 24 Sep) — \"Made here · not from you\", whatever the tag says. */
  madeHereNotHer?: boolean;
}

/** What `tileLabel` reads — the four facts, on a photo or a clip. */
export type TileFacts = Pick<
  PickerPhoto,
  "tagged" | "subject" | "shot" | "reject" | "madeHereNotHer"
>;
export type PickerRow = PickerPhoto | PickerClip;

/**
 * What each mount may offer (decided 21 Sep 2026).
 *
 * The Board and the Agent: her uploads and what she made here. Synced posts stay off both until the
 * EXIF question is re-measured — #312 kept ingested media out because it keeps its orientation flag,
 * and that reason may be obsolete now that the first frame is rotated downstream, but nobody has
 * measured it (docs/studio-media-picker-followups.md card 1). The Video tab: all three, as before.
 */
export const MOUNT_ORIGINS: Record<PickerContext, readonly PickerOrigin[]> = {
  board: ["upload", "generated"],
  "agent-pick": ["upload", "generated"],
  "agent-product": ["upload", "generated"],
  "agent-video": ["upload", "generated"],
  "video-clip": ["upload", "generated", "synced"],
  "video-still": ["upload", "generated", "synced"],
};

/**
 * What each chip says. "From your accounts", not "Instagram": synced rows come from Instagram, TikTok
 * and YouTube alike (server/skills/rehostAthleteMedia.ts PLATFORMS).
 */
export const ORIGIN_CHIP: Record<PickerOrigin, string> = {
  upload: "Uploaded",
  generated: "Made here",
  synced: "From your accounts",
};

/**
 * The origins to ask the server for: the chips she has on, among those the mount allows — or, with no
 * chip on, everything the mount allows. A chip the mount does not offer can never reach the query.
 */
export function originsFor(
  selected: readonly PickerOrigin[],
  allowed: readonly PickerOrigin[],
): PickerOrigin[] {
  const on = allowed.filter((o) => selected.includes(o));
  return on.length ? on : [...allowed];
}

/** The query string both routes read. Origins are sorted so one set is one cache key. */
export function mediaQuery(p: {
  kind: PickerKind;
  origins: readonly PickerOrigin[];
  still?: boolean;
  limit?: number;
  cursor?: string | null;
  q?: string;
  /** Rows by id, through the mount's own filters — a lookup, never a page (quality-scrappy, Investigation 12). */
  ids?: readonly string[];
}): string {
  const s = new URLSearchParams({ kind: p.kind });
  if (p.still) s.set("still", "1");
  if (p.origins.length) s.set("origin", [...p.origins].sort().join(","));
  if (p.limit) s.set("limit", String(p.limit));
  if (p.cursor) s.set("cursor", p.cursor);
  if (p.q) s.set("q", p.q);
  if (p.ids?.length) s.set("ids", p.ids.join(","));
  return s.toString();
}

/** One row as either route sends it. `origin` is the column's word. */
export type WireMediaRow =
  | {
      kind: "photo";
      assetId: string;
      imageUrl: string;
      thumbUrl: string;
      origin: string | null;
      /** PR 12 — absent from an older server, or with its flag off. */
      tagged?: boolean;
      subject?: string | null;
      shotType?: string | null;
      reject?: boolean;
      madeHereNotHer?: boolean;
    }
  | {
      kind: "clip";
      assetId: string;
      videoUrl: string;
      posterUrl: string | null;
      durationSec: number | null;
      durationPreciseSec: number | null;
      origin: string | null;
      /** Absent from an older server: read as 0. */
      beats?: number;
      /** Absent from an older server: read as null — no affordance. */
      read?: ClipRead | null;
      /** PR 12 — absent from an older server, or with its flag off. */
      tagged?: boolean;
      subject?: string | null;
      shotType?: string | null;
      reject?: boolean;
      madeHereNotHer?: boolean;
    };

/**
 * A wire row as the picker holds it — field by field, so nothing unasked-for travels, and `origin` in
 * her words through the SAME map the Video tab's lists use (passed in, so this file stays pure).
 */
export function rowFromWire(
  w: WireMediaRow,
  label: (origin: string) => string,
): PickerRow {
  const origin = w.origin ? label(w.origin) : null;
  if (w.kind === "photo") {
    return {
      kind: "photo",
      assetId: w.assetId,
      imageUrl: w.imageUrl,
      thumbUrl: w.thumbUrl,
      origin,
      // ⚠️ MUTATION (mediaPickerLogic.test "the picker labels an untagged row with a subject"): default
      // `tagged` to false, or keep `subject` on an unread row — reds by name.
      tagged: w.tagged !== false,
      subject:
        w.tagged === false
          ? null
          : typeof w.subject === "string"
            ? w.subject
            : null,
      shot:
        w.tagged === false
          ? null
          : typeof w.shotType === "string"
            ? w.shotType
            : null,
      reject: w.reject === true,
      madeHereNotHer: w.madeHereNotHer === true,
    };
  }
  return {
    kind: "clip",
    assetId: w.assetId,
    videoUrl: w.videoUrl,
    posterUrl: w.posterUrl,
    durationSec: w.durationSec,
    // NULL IS LOAD-BEARING — "nothing measured this row" — never collapsed into the integer.
    durationPreciseSec: w.durationPreciseSec ?? null,
    origin,
    beats: typeof w.beats === "number" && w.beats > 0 ? w.beats : 0,
    read: w.read ?? null,
    tagged: w.tagged !== false,
    subject:
      w.tagged === false
        ? null
        : typeof w.subject === "string"
          ? w.subject
          : null,
    shot:
      w.tagged === false
        ? null
        : typeof w.shotType === "string"
          ? w.shotType
          : null,
    reject: w.reject === true,
    madeHereNotHer: w.madeHereNotHer === true,
  };
}

/**
 * What the compact strip draws: anything she has selected that the first page does not hold — picked
 * from further down in "View more" — at the head, in pick order, then the first page.
 *
 * ⚠️ WITHOUT THE PINNING, A PICK FROM PAGE 3 IS INVISIBLE. The strip is the newest page; a selection
 * made in the modal from further down would be held by the parent and shown nowhere, its number
 * missing from the strip it is supposed to be numbered in. `seen` is every row the picker has loaded.
 */
export function stripRows(
  firstPage: readonly PickerRow[],
  selectedIds: readonly string[] | undefined,
  seen: ReadonlyMap<string, PickerRow>,
): PickerRow[] {
  const onPage = new Set(firstPage.map((r) => r.assetId));
  const pinned = (selectedIds ?? [])
    .filter((id) => !onPage.has(id))
    .map((id) => seen.get(id))
    .filter((r): r is PickerRow => r !== undefined);
  return [...pinned, ...firstPage];
}

/**
 * The mark on a tile: its place in her picks ("1", "2") on a numbered mount, "" for selected on an
 * un-numbered one, or null. A mount that holds no selection (the Board, the Video tab — each tap adds)
 * never marks anything.
 */
export function markFor(
  assetId: string,
  selectedIds: readonly string[] | undefined,
  numbered: boolean,
): string | null {
  const i = selectedIds ? selectedIds.indexOf(assetId) : -1;
  if (i === -1) return null;
  return numbered ? String(i + 1) : "";
}

/**
 * What an upload made from the picker turns into.
 *
 * ⚠️ PICKED ONLY IF THE SERVER LISTS IT FOR THIS MOUNT. The register answer says the upload landed;
 * only the list says it can be used HERE. `listed` is the answer to "this row, for this mount" (use-studio-media
 * `fetchStudioMediaRows`, by id) — NEVER the first page: that page is ranked, a fresh upload is unread and ranks
 * last, and read against it every in-picker upload was refused (quality-scrappy, Investigation 12). The case that matters: a HEIC from an iPhone uploaded into
 * the Video tab's photos lands in her library and is not a photo a stitch can hold — expo-image-picker
 * hands HEIC back as HEIC (ImageUtils.swift), and the still door refuses it by name. So it is not
 * picked and she is told why, in the door's own words, rather than watching it vanish.
 */
export function uploadOutcome(
  uploadedId: string,
  listed: readonly PickerRow[],
  forStill: boolean,
  mimeType?: string | null,
): { pick: PickerRow } | { refusal: string } {
  const row = listed.find((r) => r.assetId === uploadedId);
  if (row) return { pick: row };
  if (forStill) {
    const type = (mimeType ?? "").toLowerCase();
    const name = type.startsWith("image/")
      ? ` (${type.slice("image/".length).toUpperCase()})`
      : "";
    return {
      refusal: `It's in your library, but it's in a format we can't put in a video yet${name} — save it as a JPEG and add it again.`,
    };
  }
  return { refusal: "It's in your library, but it can't be used here." };
}

// ─── PR 12: the tile's label, and the cursor that went stale ────────────────────────────────────

/** The tagger's `subject`, in her words. */
export const SUBJECT_WORDS: Record<string, string> = {
  the_athlete: "You",
  another_person: "Someone else",
  nobody: "No one",
};

/** A shot type as the tile says it — the tagger's word with its underscore gone. */
const shotWords = (shot: string): string => shot.replace(/_/g, " ");

/**
 * What a tile says under its picture (PR 12), or null for nothing — a server that sent no fields.
 * A CLIP is labelled off its poster tag exactly like a photo (Adi's ruling, 24 Sep 2026). "Not read yet" while the tagger has not seen it; otherwise who and the shot;
 * a reject says so and is still offered (ruling 3). Pure; the picker draws whatever this returns.
 *
 * ⚠️ MUTATIONS (mediaPickerLogic.test): "picker hides or unlabels a reject-disposition photo" —
 * return null on a reject; "the picker labels an untagged row with a subject" — skip the unread arm;
 * "a video row with subject=another_person shows You" — read `the_athlete` for a clip.
 */
export const MADE_HERE_NOT_HER = "Made here · not from you";

/** ⚠️ MUTATION (mediaPickerLogic.test "a made-here still with no person reference shows You"): drop the madeHereNotHer arm — reds. */
export function tileLabel(row: TileFacts, enabled: boolean): string | null {
  if (!enabled) return null;
  // Ruling 24 Sep: the tag is not consulted on a made-here row without her — the tagger calls a
  // generated stranger "the athlete". The job's references decide, deterministically.
  if (row.madeHereNotHer)
    return row.reject ? `${MADE_HERE_NOT_HER} · not usable` : MADE_HERE_NOT_HER;
  if (row.tagged === false) return "Not read yet";
  const parts = [
    row.subject ? (SUBJECT_WORDS[row.subject] ?? null) : null,
    row.shot ? shotWords(row.shot) : null,
    row.reject ? "not usable" : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The list refused the cursor we sent: the server's order changed under us (its flag flipped), and
 * page N+1 in the old order would repeat and skip rows. The hook restarts from page 1 on this.
 * ⚠️ MUTATION (use-studio-media.test "stale cursor strands the picker"): return false — the picker
 * keeps its stale pages and shows an error instead.
 */
export const isStaleCursor = (
  status: number,
  body: unknown,
  cursor: string | null,
): boolean =>
  cursor !== null &&
  status === 400 &&
  (body as { field?: unknown } | null)?.field === "cursor";
