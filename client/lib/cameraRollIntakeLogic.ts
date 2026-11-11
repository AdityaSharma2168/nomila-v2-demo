/**
 * cameraRollIntakeLogic — the camera-roll intake's pure rules on the phone (EXPO_PUBLIC_CAMERA_ROLL_INTAKE; design
 * "Media Intake Plan", option c; contract in shared/cameraRollIntake.ts). No React, no native modules: unit-tested.
 *
 *   mediaTypesFor     which device media types a review looks at (photos · videos · both)
 *   createdAfterFor   how far back it looks (since her last review · 7 days · 30 days)
 *   collapseBursts    a burst of near-identical frames shot within a second or two becomes its first frame — on the
 *                     phone, before any preview is made, so the burst costs one preview, not twelve
 *   contentTypeOf     the type an original is uploaded as, from its file name and kind
 *   dailyLimitOf      the server's "that's the most for today" answer, read out of an API error
 *   reviewCopy        the screen's words, by what the review looks at and what it looks for
 *   durationLabel     a clip's length as the tile shows it (0:07)
 *   initialTicks      what arrives pre-ticked: every keeper — or, for a post, the one best match
 *   importTally       "Added 3 photos and 1 video to your library"
 *   errorLineOf       the server's own sentence out of an API error, else a fallback
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import { encodeCameraRollAsk, type CameraRollKind, type CameraRollSince, type ReviewItemKind } from "../../shared/cameraRollIntake";

/** The device media types a review of `kind` reads. */
export function mediaTypesFor(kind: CameraRollKind): Array<"photo" | "video"> {
  return kind === "photos" ? ["photo"] : kind === "videos" ? ["video"] : ["photo", "video"];
}

/** The earliest capture time a review of `since` looks at, or undefined for "everything new since her last review". */
export function createdAfterFor(since: CameraRollSince, now: number = Date.now()): number | undefined {
  if (since === "7d") return now - 7 * 86_400_000;
  if (since === "30d") return now - 30 * 86_400_000;
  return undefined;
}

/** The fields of a device asset the burst rule reads. */
export interface BurstAsset {
  id: string;
  mediaType: string;
  creationTime: number;
  width: number;
  height: number;
}

/** Two photos this close together in capture time, with the same frame size, are one burst. */
export const BURST_WINDOW_MS = 1500;

/**
 * Collapse bursts: walking newest first, a PHOTO shot within BURST_WINDOW_MS of the last kept photo, at the same size,
 * is a frame of the same burst and is skipped. Videos are never collapsed. Returns what to keep and how many were
 * skipped. The server collapses again on what the previews look like; this is the free first pass.
 */
export function collapseBursts<T extends BurstAsset>(assets: readonly T[]): { kept: T[]; skipped: number } {
  const kept: T[] = [];
  let last: T | null = null;
  let skipped = 0;
  for (const a of assets) {
    if (a.mediaType !== "video" && last && last.mediaType !== "video"
      && Math.abs(last.creationTime - a.creationTime) <= BURST_WINDOW_MS
      && last.width === a.width && last.height === a.height) {
      skipped++;
      continue;
    }
    kept.push(a);
    if (a.mediaType !== "video") last = a;
  }
  return { kept, skipped };
}

/** The content type an original is uploaded as (the server accepts jpeg/png/webp/heic and mp4/quicktime). */
export function contentTypeOf(filename: string | null | undefined, kind: ReviewItemKind): string {
  const ext = String(filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (kind === "video") return ext === "mov" || ext === "qt" ? "video/quicktime" : "video/mp4";
  if (ext === "png") return "image/png";
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** The server's daily-cap refusal, read out of the API error ("429: {json}"), or null for any other error. */
export function dailyLimitOf(err: unknown): { message: string; limit: number; used: number } | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const m = /^429:\s*(\{[\s\S]*\})\s*$/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]) as { code?: string; error?: string; limit?: number; used?: number };
    if (j.code !== "daily_limit") return null;
    return { message: String(j.error ?? "That's the most Nomila can look at today."), limit: Number(j.limit ?? 0), used: Number(j.used ?? 0) };
  } catch {
    return null;
  }
}

/** The screen's words. */
export function reviewCopy(kind: CameraRollKind, lookingFor: string | null): { title: string; lede: string; start: string } {
  const what = kind === "photos" ? "photos" : kind === "videos" ? "videos" : "photos and videos";
  return {
    title: "Add from camera roll",
    lede: lookingFor
      ? `We'll look through your new ${what} for ${lookingFor.replace(/[.\s]+$/, "")}. Only a small preview of each leaves your phone; the full ${kind === "videos" ? "video" : "file"} is uploaded only for the ones you keep.`
      : `We'll look through your new ${what} and suggest the ones worth having in your library. Only a small preview of each leaves your phone; the full file is uploaded only for the ones you keep.`,
    start: lookingFor ? "Find it" : "Start review",
  };
}

/** A clip's length on its tile: m:ss. */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A scored item as the grid holds it: its device id, and what the server said (kind, rank). */
export interface TickCandidate {
  id: string;
  kind?: ReviewItemKind;
  rank: number;
}

/**
 * What arrives pre-ticked. A general review: every keeper (the server already capped them at 60 with a mix of shot
 * types). A review for one post: only the single best match — of the kind the post wants when it wants one — because
 * one clip goes into the kit; she can tick more.
 */
export function initialTicks(keepers: readonly TickCandidate[], forPost: boolean, kind: CameraRollKind): Set<string> {
  if (!forPost) return new Set(keepers.map((k) => k.id));
  const want = kind === "videos" ? "video" : kind === "photos" ? "photo" : null;
  const pool = want ? keepers.filter((k) => (k.kind ?? "photo") === want) : [...keepers];
  const best = [...(pool.length ? pool : keepers)].sort((a, b) => b.rank - a.rank)[0];
  return new Set(best ? [best.id] : []);
}

/** "Added 3 photos and 1 video to your library" — with what didn't make it, when anything didn't. */
export function importTally(imported: ReadonlyArray<{ media_type?: string | null }>, failed: number): string {
  const videos = imported.filter((i) => i.media_type === "VIDEO" || i.media_type === "REELS").length;
  const photos = imported.length - videos;
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const what = photos && videos ? `${n(photos, "photo")} and ${n(videos, "video")}` : videos ? n(videos, "video") : n(photos, "photo");
  return `Added ${what} to your library${failed ? ` — ${failed} didn't make it` : ""}`;
}

/** The server's own sentence (`{ error }`) out of an API error ("409: {json}"), else `fallback`. */
export function errorLineOf(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const m = /^\d{3}:\s*(\{[\s\S]*\})\s*$/.exec(text);
  if (!m) return fallback;
  try {
    const j = JSON.parse(m[1]) as { error?: unknown };
    return typeof j.error === "string" && j.error.trim() ? j.error.trim() : fallback;
  } catch {
    return fallback;
  }
}

// ─── The app-open check (client/lib/cameraRollPrepared.ts) ─────────────────────────────────────────────────────────

/** How often the app-open check may look at all, per athlete — at most four a day. */
export const PREPARE_EVERY_MS = 6 * 3_600_000;
/** A prepared review is offered for this long; its previews live a day on the server, so it stops well before. */
export const PREPARED_TTL_MS = 20 * 3_600_000;
/** How many of the newest items the check looks at, and how many must be new before any preview is made. */
export const PREPARE_SCAN = 60;
export const PREPARE_MIN_NEW = 5;

/** Whether the app-open check should look now: nothing already prepared, and the last look long enough ago. */
export function shouldCheck(now: number, lastCheckAt: number | null, hasPrepared: boolean): boolean {
  if (hasPrepared) return false;
  return lastCheckAt === null || now - lastCheckAt >= PREPARE_EVERY_MS;
}

/** Whether a prepared review made at `createdAt` may still be offered. */
export const preparedFresh = (createdAt: number, now: number): boolean => now - createdAt < PREPARED_TTL_MS && now >= createdAt;

/** Mila's one-tap offer, in plain words: what is waiting, never a claim she looked at anything herself. */
export function offerLine(photos: number, videos: number): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const what = photos && videos ? `${n(photos, "new photo")} and ${n(videos, "video")}` : videos ? n(videos, "new video") : n(photos, "new photo");
  return `${what} from your camera roll look worth adding. Review them?`;
}

/** The targeted ask a kit with nothing of hers opens: recent clips for a reel or story, else both, for this post. */
export function askForKit(decisionId: string, format: string): string {
  const kind: CameraRollKind = format === "reel" || format === "story" ? "videos" : "all";
  return encodeCameraRollAsk({ kind, since: "30d", forPost: decisionId });
}
