/**
 * use-camera-roll-review — the machinery behind "Review my camera roll" (and, with EXPO_PUBLIC_CAMERA_ROLL_INTAKE on,
 * "Add from camera roll").
 *
 * THE DEAL WITH THE ATHLETE, in one paragraph: we look at her recent photos on the phone, send up
 * only a ≤512px thumbnail of each one for scoring, show her what we'd keep and why, and upload the
 * ORIGINAL of a photo only if she leaves it ticked. Nothing is stored on our side until she taps
 * Import. Anything she has already been shown is remembered locally (client/lib/reviewed-assets.ts)
 * so a second run only looks at what she has shot since.
 *
 * Native-first: expo-media-library has no web implementation worth the name, so the whole entry
 * point is hidden on web (`cameraRollReviewAvailable`).
 *
 * FLAG OFF: PHOTOS ONLY, exactly as before. Scoring a video means pulling a frame, and the review
 * pass had no poster to score — the UI says "Photos only for now" rather than silently dropping her clips.
 *
 * FLAG ON (the camera-roll intake, design "Media Intake Plan", option c):
 *   • videos too: a video's preview is one frame of it, made on the phone (lib/review-thumbnail.ts makeVideoPreview —
 *     modules already in the build, no new native build); its full file is uploaded only if she keeps it
 *   • a review can be narrowed (photos · videos · both; new since her last review · 7 days · 30 days) and targeted
 *     (what a post needs, or her words) — the server leans its ranking toward it
 *   • bursts of near-identical photos are collapsed on the phone before any preview is made
 *   • each scored item carries a short description (shot type, setting, what she's doing, quality)
 *   • Cancel deletes the previews at once (discardReview) instead of leaving them for the 1-day lifecycle
 *
 * The run itself (`runCameraRollReview`) is a plain function, so the app-open check can prepare a review without a
 * screen; the hook wraps it with React state.
 */
import { useCallback, useRef, useState } from "react";
import { Dimensions, PixelRatio, Platform } from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import type * as ImagePicker from "expo-image-picker";
// SDK 54 moved the classic FileSystem API (uploadAsync / FileSystemUploadType) to the `legacy` entry.
import * as FileSystem from "expo-file-system/legacy";
import { apiRequest } from "../lib/query-client";
import { makeReviewThumbnail, canResize, canPreviewVideo, makeVideoPreview } from "../lib/review-thumbnail";
import { mintAndPutOriginal, RightsAckRequired, type MediaItem } from "./use-media-library";
import { CAMERA_ROLL_INTAKE } from "../lib/flags";
import { collapseBursts, contentTypeOf, createdAfterFor, dailyLimitOf, mediaTypesFor } from "../lib/cameraRollIntakeLogic";
import type { CameraRollKind, CameraRollSince, ReviewItemKind, ReviewSummary } from "../../shared/cameraRollIntake";

/** The feature is native-only in v0 — see the header. */
export const cameraRollReviewAvailable = Platform.OS !== "web";

/** How far back one run looks when she picks "All photos". */
export const SCAN_LIMIT = 500;
/** Server cap per review/import call (server: ROLL_REVIEW_MAX_ITEMS). */
export const BATCH = 100;
/** Server cap per review thumbnail (server: ROLL_REVIEW_THUMB_MAX_BYTES). */
export const THUMB_MAX_BYTES = 400 * 1024;

export interface ReviewTagSummary {
  shot_type: string;
  brand_safe: boolean;
  brands_visible: string[];
  disposition: string;
}
export interface KeepEntry {
  itemId: string;
  rank: number;
  reason: string;
  tags: ReviewTagSummary;
  /** The intake only: what the item is, its short description, and how close it is to what a targeted review looks for. */
  kind?: ReviewItemKind;
  summary?: ReviewSummary;
  fit?: number | null;
}
export interface DropEntry { itemId: string; reason: string; code: string }
interface ReviewResponse {
  keep: KeepEntry[];
  more: KeepEntry[];
  drop: DropEntry[];
  likenessAvailable: boolean;
  likenessNote: string | null;
  /** The intake only. */
  lookingFor?: string | null;
  daily?: { limit: number; used: number };
}

/** One photo or video, joined back to the device asset it came from. */
export interface ReviewedPhoto {
  asset: MediaLibrary.Asset;
  entry?: KeepEntry;
  drop?: DropEntry;
}

export interface ReviewOutcome {
  keep: ReviewedPhoto[];
  more: ReviewedPhoto[];
  drop: ReviewedPhoto[];
  likenessAvailable: boolean;
  likenessNote: string | null;
  /**
   * Scanned but never sent — screenshots, videos, already-reviewed, or too big to resize. With the intake on, also
   * collapsed bursts and videos this build can't preview.
   */
  skipped: { screenshots: number; alreadyReviewed: number; tooLarge: number; bursts?: number; videosUnsupported?: number };
  sessionId: string;
  /** The intake only: what a targeted review looked for (the server's words), and the day's cap when it was reached. */
  lookingFor?: string | null;
  limitNote?: string | null;
}

export interface ScanProgress { phase: "scanning" | "reviewing" | "done"; done: number; total: number }

// ─── device screen size, for the screenshot heuristic ───────────────────────────────────────────
const screen = Dimensions.get("screen");
const SCREEN_W = Math.round(screen.width * PixelRatio.get());
const SCREEN_H = Math.round(screen.height * PixelRatio.get());

/**
 * Is this a screenshot? Three tiers, best signal first:
 *   1. iOS tells us outright via `mediaSubtypes` (…and only on iOS).
 *   2. Android names the file `Screenshot_2026-…`.
 *   3. Otherwise: EXACT device screen pixel dimensions, either orientation. Deliberately exact —
 *      "roughly screen-sized" would eat legitimately cropped photos.
 */
export function isScreenshot(a: MediaLibrary.Asset): boolean {
  const subtypes = (a as MediaLibrary.Asset & { mediaSubtypes?: string[] }).mediaSubtypes;
  if (Array.isArray(subtypes) && subtypes.some((s) => String(s).toLowerCase().includes("screenshot"))) return true;
  if (/^screenshot|screen[ _-]?shot/i.test(a.filename ?? "")) return true;
  // A screen RECORDING is a screenshot that moves — never her footage.
  if (a.mediaType === MediaLibrary.MediaType.video && /^(screen[ _-]?recording|screenrecord|rpreplay)/i.test(a.filename ?? "")) return true;
  const w = Math.round(a.width), h = Math.round(a.height);
  return (w === SCREEN_W && h === SCREEN_H) || (w === SCREEN_H && h === SCREEN_W);
}

const mimeFor = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "heic" || ext === "heif" ? "image/heic" : ext === "webp" ? "image/webp" : "image/jpeg";
};

const kindOfAsset = (a: MediaLibrary.Asset): ReviewItemKind => (a.mediaType === MediaLibrary.MediaType.video ? "video" : "photo");

/** The camera roll's own capture date, as an ISO string the server can trust. */
const createdAtOf = (a: MediaLibrary.Asset): string | undefined =>
  a.creationTime ? new Date(a.creationTime).toISOString() : undefined;

/** What a targeted review looks for: a post action (the server reads what it needs) or her own words. */
export interface ReviewTarget { forPost?: string; lookingFor?: string }

export interface RunReviewArgs {
  albumId?: string;
  /** Ids we've already shown her — from client/lib/reviewed-assets.ts. */
  reviewedIds: Set<string>;
  onProgress?: (p: ScanProgress) => void;
  /** The intake only (ignored with the flag off). */
  kind?: CameraRollKind;
  since?: CameraRollSince;
  target?: ReviewTarget;
  /** How many items to look through (default SCAN_LIMIT). The app-open check looks at fewer. */
  scanLimit?: number;
  /**
   * The quiet checks (app open, charging): only items already on the phone. An iCloud-offloaded photo or video is
   * skipped rather than downloaded in full just to cut a preview she didn't ask for (data, battery). Her own review
   * leaves this off, so it still fetches what she points it at.
   */
  onDeviceOnly?: boolean;
}

/**
 * Scan → thumbnail → upload → score. Returns everything the consent grid needs. A plain function: the hook wraps it,
 * and the app-open check runs it with no screen. `isCancelled` is polled between items.
 * Runs in batches of BATCH: each batch's thumbnails are PUT, then scored in one call, so she
 * sees "Reviewing 200 of 480…" move rather than waiting on the whole roll.
 */
export async function runCameraRollReview(
  { albumId, reviewedIds, onProgress, kind: askedKind, since = "last_review", target, scanLimit, onDeviceOnly }: RunReviewArgs,
  isCancelled: () => boolean = () => false,
  intake: boolean = CAMERA_ROLL_INTAKE,
): Promise<ReviewOutcome> {
  const sessionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const skipped: ReviewOutcome["skipped"] = { screenshots: 0, alreadyReviewed: 0, tooLarge: 0, ...(intake ? { bursts: 0, videosUnsupported: 0 } : {}) };
  const report = (p: ScanProgress) => onProgress?.(p);
  const kind: CameraRollKind = intake ? askedKind ?? "all" : "photos";
  const createdAfter = intake ? createdAfterFor(since) : undefined;

  report({ phase: "scanning", done: 0, total: 0 });
  const page = await MediaLibrary.getAssetsAsync({
    first: scanLimit ?? SCAN_LIMIT,
    // Flag off: photos only, as before. On: what she asked for.
    mediaType: mediaTypesFor(kind).map((t) => (t === "video" ? MediaLibrary.MediaType.video : MediaLibrary.MediaType.photo)),
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],   // newest first
    ...(albumId ? { album: albumId } : {}),
    ...(createdAfter ? { createdAfter } : {}),
  });

  let candidates: MediaLibrary.Asset[] = [];
  for (const a of page.assets) {
    if (reviewedIds.has(a.id)) { skipped.alreadyReviewed++; continue; }
    if (isScreenshot(a)) { skipped.screenshots++; continue; }
    candidates.push(a);
  }
  if (intake) {
    const { kept, skipped: bursts } = collapseBursts(candidates);
    candidates = kept;
    skipped.bursts = bursts;
  }
  const videoPreviews = intake && canPreviewVideo();

  const byId = new Map(candidates.map((a) => [a.id, a]));
  const keep: ReviewedPhoto[] = [], more: ReviewedPhoto[] = [], drop: ReviewedPhoto[] = [];
  let likenessAvailable = false;
  let likenessNote: string | null = null;
  let lookingFor: string | null = null;
  let limitNote: string | null = null;
  let done = 0;

  for (let i = 0; i < candidates.length; i += BATCH) {
    if (isCancelled() || limitNote) break;
    const slice = candidates.slice(i, i + BATCH);
    const sent: Record<string, unknown>[] = [];

    for (const a of slice) {
      if (isCancelled()) break;
      try {
        const isVideo = kindOfAsset(a) === "video";
        if (isVideo && !videoPreviews) { skipped.videosUnsupported = (skipped.videosUnsupported ?? 0) + 1; continue; }
        // `uri` is `ph://…` on iOS and unreadable by the file APIs — getAssetInfoAsync gives a
        // real localUri (and, for an iCloud-offloaded photo, downloads it first).
        const info = onDeviceOnly
          ? await MediaLibrary.getAssetInfoAsync(a, { shouldDownloadFromNetwork: false })
          : await MediaLibrary.getAssetInfoAsync(a);
        if (onDeviceOnly && (info.isNetworkAsset || !info.localUri)) continue;   // in iCloud only: not fetched for a quiet check
        const localUri = info.localUri ?? a.uri;
        const thumb = isVideo
          ? await makeVideoPreview(localUri, a.duration ?? null, THUMB_MAX_BYTES)
          : await makeReviewThumbnail(localUri, THUMB_MAX_BYTES);
        if (!thumb) { skipped.tooLarge++; continue; }

        const mintRes = await apiRequest("POST", "/api/v1/me/media/review/upload-url", {
          sessionId, itemId: itemIdFor(a), bytes: thumb.bytes ?? undefined,
        });
        const mint = (await mintRes.json()) as { gcsPath: string; uploadUrl: string };
        const put = await FileSystem.uploadAsync(mint.uploadUrl, thumb.uri, {
          httpMethod: "PUT",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { "Content-Type": "image/jpeg" },
        });
        if (put.status < 200 || put.status >= 300) continue;   // one bad thumbnail is not a failed run
        sent.push({
          itemId: itemIdFor(a), gcsPath: mint.gcsPath,
          width: a.width, height: a.height, createdAt: createdAtOf(a),
          ...(intake ? { kind: kindOfAsset(a), ...(isVideo && a.duration ? { durationSec: a.duration } : {}) } : {}),
        });
      } catch {
        // Same reasoning: an item we cannot read or upload is simply not reviewed.
      } finally {
        done++;
        report({ phase: "reviewing", done, total: candidates.length });
      }
    }

    if (!sent.length) continue;
    let body: ReviewResponse;
    try {
      const res = await apiRequest("POST", "/api/v1/me/media/review", {
        sessionId, items: sent, ...(intake && target && (target.forPost || target.lookingFor) ? { target } : {}),
      });
      body = (await res.json()) as ReviewResponse;
    } catch (e) {
      // The intake's daily cap: keep what is already scored and say why the rest wait (never a crash).
      const limit = intake ? dailyLimitOf(e) : null;
      if (limit) { limitNote = limit.message; break; }
      throw e;
    }
    likenessAvailable = body.likenessAvailable;
    likenessNote = body.likenessNote ?? likenessNote;
    if (body.lookingFor) lookingFor = body.lookingFor;
    const join = (list: KeepEntry[], into: ReviewedPhoto[]) => {
      for (const e of list) { const asset = byId.get(assetIdFor(e.itemId)); if (asset) into.push({ asset, entry: e }); }
    };
    join(body.keep, keep);
    join(body.more, more);
    for (const d of body.drop) { const asset = byId.get(assetIdFor(d.itemId)); if (asset) drop.push({ asset, drop: d }); }
  }

  report({ phase: "done", done, total: candidates.length });
  return {
    keep, more, drop, likenessAvailable, likenessNote, skipped, sessionId,
    ...(intake ? { lookingFor, limitNote } : {}),
  };
}

export function useCameraRollReview() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const cancelled = useRef(false);

  const cancel = useCallback(() => { cancelled.current = true; }, []);

  const run = useCallback(async (args: RunReviewArgs): Promise<ReviewOutcome> => {
    cancelled.current = false;
    setRunning(true);
    try {
      return await runCameraRollReview(
        { ...args, onProgress: (p) => { setProgress(p); args.onProgress?.(p); } },
        () => cancelled.current,
      );
    } finally {
      setRunning(false);
    }
  }, []);

  return { run, cancel, running, progress, canResize: canResize(), canPreviewVideo: canPreviewVideo() };
}

/**
 * Device asset ids are not URL/GCS-path safe (iOS uses `…/L0/001` shapes), and the server sanitises
 * whatever it is handed — which would break the join back to the asset. So the id we send is a
 * reversible, safe encoding of it, and the mapping stays entirely on the phone.
 */
export function itemIdFor(a: MediaLibrary.Asset): string {
  return `i${encodeToken(a.id)}`;
}
function assetIdFor(itemId: string): string {
  return decodeToken(itemId.replace(/^i/, ""));
}
function encodeToken(id: string): string {
  return Array.from(id).map((c) => (/[A-Za-z0-9]/.test(c) ? c : `-${c.charCodeAt(0).toString(16)}-`)).join("");
}
function decodeToken(tok: string): string {
  return tok.replace(/-([0-9a-f]{1,4})-/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export interface ImportProgress { done: number; total: number }
export interface ImportArgs {
  sessionId: string;
  photos: ReviewedPhoto[];
  ackRights?: boolean;
  onProgress?: (p: ImportProgress) => void;
}
export interface ImportResult { imported: MediaItem[]; failedCount: number }

/**
 * Import the ticked items: PUT each ORIGINAL through the ordinary signed-url path (reusing
 * `mintAndPutOriginal`, so the rights ack and the PUT behave identically to a normal upload), then
 * register them in one call to /me/media/review/import — which is what stamps `posted_at` with the
 * item's real capture date and records `metadata.review`. With the intake on, a video is uploaded as a
 * video (its full file — the one thing that leaves the phone at full size, and only because she kept it).
 *
 * A `RightsAckRequired` on the FIRST item stops the whole import so the caller can show the ack
 * panel once and retry; the ack is account-wide, so every later item would fail identically.
 */
export async function importReviewedPhotos({ sessionId, photos, ackRights, onProgress }: ImportArgs): Promise<ImportResult> {
  const items: Record<string, unknown>[] = [];
  let failedCount = 0;

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    onProgress?.({ done: i, total: photos.length });
    try {
      const info = await MediaLibrary.getAssetInfoAsync(p.asset);
      const localUri = info.localUri ?? p.asset.uri;
      const kind = CAMERA_ROLL_INTAKE ? kindOfAsset(p.asset) : "photo";
      const contentType = CAMERA_ROLL_INTAKE ? contentTypeOf(p.asset.filename, kind) : mimeFor(p.asset.filename ?? "");
      // A MediaLibrary asset in the shape mintAndPutOriginal expects. Flag off, `type: "image"` is
      // honest — that version imports photos only.
      const asAsset = {
        uri: localUri, width: p.asset.width, height: p.asset.height,
        type: kind === "video" ? "video" : "image", fileName: p.asset.filename, mimeType: contentType,
      } as unknown as ImagePicker.ImagePickerAsset;
      const { gcsPath } = await mintAndPutOriginal(asAsset, ackRights);
      items.push({
        itemId: itemIdFor(p.asset), uploadedGcsPath: gcsPath, contentType,
        width: p.asset.width, height: p.asset.height,
        createdAt: createdAtOf(p.asset),
        rank: p.entry?.rank, reason: p.entry?.reason,
        // MediaLibrary's duration is in seconds; the server measures it again and prefers its own.
        ...(kind === "video" && p.asset.duration ? { durationSeconds: p.asset.duration } : {}),
      });
    } catch (e) {
      if (e instanceof RightsAckRequired && i === 0) throw e;
      failedCount++;
    }
  }
  onProgress?.({ done: photos.length, total: photos.length });

  if (!items.length) return { imported: [], failedCount };

  const imported: MediaItem[] = [];
  // The register endpoint takes the same ≤100 cap the review does.
  for (let i = 0; i < items.length; i += BATCH) {
    const res = await apiRequest("POST", "/api/v1/me/media/review/import", {
      sessionId, items: items.slice(i, i + BATCH),
    });
    const body = (await res.json()) as { imported: MediaItem[]; failed: unknown[] };
    imported.push(...(body.imported ?? []));
    failedCount += (body.failed ?? []).length;
  }
  return { imported, failedCount };
}

/**
 * The intake only: she closed the review without importing — delete the session's previews now and scrub their scores
 * (POST /me/media/review/discard). Best effort: the bucket's 1-day lifecycle is still the backstop.
 */
export async function discardReview(sessionId: string): Promise<void> {
  if (!CAMERA_ROLL_INTAKE) return;
  try { await apiRequest("POST", "/api/v1/me/media/review/discard", { sessionId }); } catch { /* best effort */ }
}
