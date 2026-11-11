/**
 * mediaVideoFixes — the switch and the knobs for the media-intake plan's video fixes (design "Media Intake Plan",
 * 12 Oct 2026, §3e fixes 1, 2, 3 and 6). One flag, MEDIA_VIDEO_FIXES, default OFF: unset, or anything but exactly
 * "true", and every path below behaves exactly as it did before.
 *
 *   1  skills/fetchTopVideoFiles.ts   the mp4 for EVERY Instagram video she owns, not only the top 8 — the most-viewed
 *                                     first, then the newest, under a per-tick count and byte budget
 *   2  studio/enrich/videoTag.ts      the clip read also writes what is SAID (a timestamped transcript, language,
 *      studio/video/signals.ts        whether anyone speaks, whether music plays) and each beat's camera steadiness; and
 *                                     $0 ffmpeg passes measure frame rate, resolution, bitrate, loudness, silence, blur,
 *                                     frozen and black frames (metadata.signals)
 *   3  services/videoPoster.ts        ONE master per clip: no re-encode when the source is already H.264 at 1080p or
 *                                     less; after a re-encode the original is parked for MEDIA_ORIGINAL_KEEP_DAYS (30)
 *                                     and then purged (its device provenance is read first and kept)
 *   6  services/videoPoster.ts        an uploaded video is content-checked on its poster (SafeSearch) when the poster is
 *                                     cut; a blocked clip is taken out of her library and its bytes deleted
 *
 * Read per call, never frozen at import, so a test (or a config change) flips it without a reload.
 */

/** The master switch. Exactly "true" is on. */
export const mediaVideoFixesEnabled = (): boolean => process.env.MEDIA_VIDEO_FIXES === "true";

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Fix 1: at most this many Instagram mp4s are fetched per athlete per nightly tick. */
export const instagramVideoTickMax = (): number => positiveInt(process.env.INSTAGRAM_VIDEO_FETCH_TICK_MAX, 40);

/**
 * Fix 1: the nightly chain stays bounded — once this many bytes are fetched for one athlete in one tick, the rest wait
 * for the next night. A single file can take it over by up to one file's size (each file is still capped at 100 MB).
 */
export const instagramVideoTickBytes = (): number => positiveInt(process.env.INSTAGRAM_VIDEO_FETCH_TICK_MB, 500) * 1024 * 1024;

/** Fix 1: a video whose mp4 could not be fetched this many nights running is left as its poster. */
export const INSTAGRAM_VIDEO_FETCH_MAX_FAILURES = 3;

/** Fix 3: a source whose SHORT side is at most this is already "1080p" and is never scaled. */
export const MASTER_SHORT_SIDE = 1080;

/**
 * Fix 3's undo window: after a re-encode the original is not deleted on the spot but parked
 * (metadata.original_pending_delete) for this many days, then purged by the poster worker. A bad re-encode (an HDR
 * phone clip flattened to SDR, a dropped audio track) can be put right by pointing gcs_path back at it until then.
 */
export const originalKeepDays = (): number => positiveInt(process.env.MEDIA_ORIGINAL_KEEP_DAYS, 30);
