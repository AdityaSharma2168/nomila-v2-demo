/**
 * review-thumbnail — shrink one camera-roll photo to the small JPEG that gets scored.
 *
 * The promise the camera-roll review makes is that the ORIGINALS stay on the phone unless the
 * athlete ticks them. What leaves is a ≤512px, quality-0.7 JPEG — enough for the vision pass and
 * the embedding, and about 30–60 KB.
 *
 * `expo-image-manipulator` IS NOT A DEPENDENCY OF THIS APP TODAY, and adding a native module is a
 * new dev-client build, not an npm install — so this resolves it at runtime and degrades honestly
 * when it is missing:
 *
 *   • module present  → resize to 512 max side, JPEG 0.7 (supports both the classic
 *     `manipulateAsync` API and the SDK 52+ `ImageManipulator.manipulate()` context API)
 *   • module absent   → the photo's own file is used as-is, and anything over the server's review
 *     cap (400 KB) is SKIPPED rather than uploaded at full size. On a modern phone that skips most
 *     of the roll, which is exactly the signal that the dependency needs adding — the UI says so
 *     in as many words rather than silently reviewing a third of her photos.
 *
 * Installing `expo-image-manipulator` and rebuilding the dev client turns the full path on with no
 * code change here.
 */
import * as FileSystem from "expo-file-system/legacy";

export const REVIEW_MAX_SIDE = 512;
export const REVIEW_QUALITY = 0.7;

let _mod: any | null | undefined;   // undefined = not tried yet, null = not installed
function manipulator(): any | null {
  if (_mod !== undefined) return _mod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _mod = require("expo-image-manipulator");
  } catch {
    _mod = null;
  }
  return _mod;
}

/** True when real downscaling is available — the UI uses this to explain a thin review. */
export function canResize(): boolean {
  const m = manipulator();
  return !!(m && (m.manipulateAsync || m.ImageManipulator?.manipulate));
}

export interface ReviewThumb {
  uri: string;
  /** false ⇒ this is the original file (no manipulator); the caller must respect `maxBytes`. */
  resized: boolean;
  bytes: number | null;
}

async function sizeOf(uri: string): Promise<number | null> {
  try {
    // `size` is on FileInfo whenever the file exists — there is no option to ask for it.
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === "number" ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Produce the thumbnail for one photo, or null when it cannot be reviewed within `maxBytes`.
 * `uri` must be a readable local file (MediaLibrary's `localUri`, not a `ph://` asset uri).
 */
export async function makeReviewThumbnail(uri: string, maxBytes: number): Promise<ReviewThumb | null> {
  const m = manipulator();
  try {
    if (m?.manipulateAsync) {
      const out = await m.manipulateAsync(
        uri,
        [{ resize: { width: REVIEW_MAX_SIDE } }],
        { compress: REVIEW_QUALITY, format: m.SaveFormat?.JPEG ?? "jpeg" },
      );
      return { uri: out.uri, resized: true, bytes: await sizeOf(out.uri) };
    }
    if (m?.ImageManipulator?.manipulate) {
      const ctx = m.ImageManipulator.manipulate(uri).resize({ width: REVIEW_MAX_SIDE });
      const image = await ctx.renderAsync();
      const out = await image.saveAsync({ compress: REVIEW_QUALITY, format: m.SaveFormat?.JPEG ?? "jpeg" });
      return { uri: out.uri, resized: true, bytes: await sizeOf(out.uri) };
    }
  } catch {
    // fall through to the original-file path — a manipulator that throws on one photo is not a
    // reason to abandon the whole review
  }

  const bytes = await sizeOf(uri);
  if (bytes != null && bytes > maxBytes) return null;    // too big to send un-resized: skip it
  return { uri, resized: false, bytes };
}

// ─── Videos (EXPO_PUBLIC_CAMERA_ROLL_INTAKE) ─────────────────────────────────────────────────────────────────────────
//
// A video's preview is ONE FRAME of it, made on the phone: expo-video's player cuts a thumbnail (a native image
// reference), expo-image-manipulator shrinks it to 512 px and saves it as a JPEG. Both modules are already in the app's
// build — no new native module — and both are resolved at runtime, so a build without them skips videos honestly
// (the caller counts them) instead of uploading anything bigger.

let _video: any | null | undefined;
function videoModule(): any | null {
  if (_video !== undefined) return _video;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _video = require("expo-video");
  } catch {
    _video = null;
  }
  return _video;
}

/** True when this build can make a video's preview on the phone. */
export function canPreviewVideo(): boolean {
  const v = videoModule();
  const m = manipulator();
  return !!(v?.createVideoPlayer && m?.ImageManipulator?.manipulate);
}

/** The second a video's preview frame is cut at: one second in, or the first frame of a shorter clip. */
export function previewSecond(durationSeconds: number | null | undefined): number {
  return durationSeconds != null && durationSeconds > 1.5 ? 1 : 0;
}

/**
 * One frame of a local video as a ≤512px JPEG, or null when this build can't make one or it would be over `maxBytes`.
 * `uri` must be a readable local file (MediaLibrary's `localUri`). The player is always released.
 */
export async function makeVideoPreview(uri: string, durationSeconds: number | null, maxBytes: number): Promise<ReviewThumb | null> {
  const v = videoModule();
  const m = manipulator();
  if (!v?.createVideoPlayer || !m?.ImageManipulator?.manipulate) return null;
  let player: any = null;
  try {
    player = v.createVideoPlayer({ uri });
    const at = previewSecond(durationSeconds);
    let frames: any[] = [];
    try {
      frames = await player.generateThumbnailsAsync([at], { maxWidth: REVIEW_MAX_SIDE, maxHeight: REVIEW_MAX_SIDE });
    } catch {
      if (at > 0) frames = await player.generateThumbnailsAsync([0], { maxWidth: REVIEW_MAX_SIDE, maxHeight: REVIEW_MAX_SIDE });
    }
    const frame = frames?.[0];
    if (!frame) return null;
    // The player already bounded the frame to 512 px on its longer side: no resize, which would upscale a portrait one.
    const image = await m.ImageManipulator.manipulate(frame).renderAsync();
    const out = await image.saveAsync({ compress: REVIEW_QUALITY, format: m.SaveFormat?.JPEG ?? "jpeg" });
    const bytes = await sizeOf(out.uri);
    if (bytes != null && bytes > maxBytes) return null;
    return { uri: out.uri, resized: true, bytes };
  } catch {
    return null;
  } finally {
    try { player?.release?.(); } catch { /* already gone */ }
  }
}
