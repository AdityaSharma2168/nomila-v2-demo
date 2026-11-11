/**
 * mediaStore.ts — thin wrapper around the athlete-media GCS bucket.
 *
 * Auth: prod uses ADC — `new Storage()` picks up the Cloud Run runtime SA
 * (gamechanger-runtime), which can sign. Local ADC (a dev's gcloud login) cannot sign,
 * so we fall back to the SA key in GOOGLE_SERVICE_ACCOUNT_JSON when it's set — that env
 * var is unset in prod, so prod behavior is unchanged. Runtime SA has
 * roles/storage.objectAdmin on the bucket (done).
 *
 * v1 stores stills only (image or video poster); files stream fully into memory
 * (fine at the ≤25 MB cap). See docs/durable-media-rehosting.md.
 */
import { Storage } from "@google-cloud/storage";
import { createLogger } from "../logger";
import { safeFetch } from "./safeFetch";

const logger   = createLogger("media-store");
const BUCKET   = process.env.MEDIA_BUCKET ?? "nomila-v2-athlete-media";
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);  // 25 MB — stills only in v1

const saJson  = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const storage = saJson
  ? new Storage({ credentials: JSON.parse(saJson), projectId: JSON.parse(saJson).project_id })
  : new Storage();          // ADC (prod)
const bucket  = storage.bucket(BUCKET);

// Extension is derived from the response Content-Type, not the URL (IG CDN URLs carry no reliable ext).
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/heic": "heic", "video/mp4": "mp4", "video/quicktime": "mov",
};
const extFor = (ct: string) => EXT[ct.toLowerCase()] ?? "bin";

export type RehostResult = { gcs_path: string; content_type: string; bytes: number };

/** Download an ephemeral media URL → store at `${basePath}.<ext>`. null on failure, {skipped} if too big.
 *  `maxBytes` overrides the default cap (e.g. a larger cap for top-performer video files). */
export async function rehostFromUrl(url: string, basePath: string, maxBytes = MAX_BYTES): Promise<RehostResult | { skipped: "size" } | null> {
  try {
    // The url was chosen by a provider or a CDN, not by us — safeFetch (PR 7, Lane F2): https only, never an
    // internal address, every redirect hop checked and pinned. A refusal is caught below as a failed rehost.
    const res = await safeFetch(url);
    if (!res.ok) { logger.warn({ basePath, status: res.status }, "media fetch not ok"); return null; }
    const contentType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    const len = res.headers.get("content-length");
    if (len && Number(len) > maxBytes) return { skipped: "size" };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return { skipped: "size" };
    const dest = `${basePath}.${extFor(contentType)}`;
    await bucket.file(dest).save(buf, { resumable: false, contentType, metadata: { contentType } });
    return { gcs_path: dest, content_type: contentType, bytes: buf.byteLength };
  } catch (err: any) {
    logger.warn({ basePath, error: err.message?.slice(0, 120) }, "rehost failed");
    return null;
  }
}

/** Store bytes we ALREADY hold at `${basePath}.<ext>` — a generated asset, not a fetched one.
 *  Deliberately the same contract as rehostFromUrl minus the fetch: same extension-from-content-type
 *  rule, same size cap, same RehostResult. So a caller that may get either inline bytes or a URL back
 *  from a provider handles both through one shape (see server/studio/concept.ts). */
export async function saveBuffer(buf: Buffer, basePath: string, contentType: string, maxBytes = MAX_BYTES): Promise<RehostResult | { skipped: "size" }> {
  if (buf.byteLength > maxBytes) return { skipped: "size" };
  const dest = `${basePath}.${extFor(contentType)}`;
  await bucket.file(dest).save(buf, { resumable: false, contentType, metadata: { contentType } });
  return { gcs_path: dest, content_type: contentType, bytes: buf.byteLength };
}

/**
 * Read a stored object's bytes, capped. null when the object is absent or larger than `maxBytes` —
 * the caller decides what a missing still means (Mila names it in words rather than pretending).
 */
export async function readObject(gcsPath: string, maxBytes = MAX_BYTES): Promise<{ buf: Buffer; contentType: string } | null> {
  const file = bucket.file(gcsPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > maxBytes) return null;
  const [buf] = await file.download();
  return { buf, contentType: String(meta.contentType ?? "application/octet-stream") };
}

/**
 * Size and type of a stored object WITHOUT downloading it — null when absent. For a caller that got
 * null from readObject and needs to know which of its two nulls it was (absent vs over the cap).
 */
export async function headObject(gcsPath: string): Promise<{ bytes: number; contentType: string } | null> {
  const file = bucket.file(gcsPath);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [meta] = await file.getMetadata();
  return { bytes: Number(meta.size ?? 0), contentType: String(meta.contentType ?? "application/octet-stream") };
}

/** Short-TTL signed read URL for a stored object (default 1 h). Internal generators read GCS directly. */
export async function signedUrl(gcsPath: string, ttlMs = 3_600_000): Promise<string> {
  const [url] = await bucket.file(gcsPath).getSignedUrl({ action: "read", expires: Date.now() + ttlMs });
  return url;
}

/** Upload a local file (e.g. an ffmpeg-produced poster/transcode in /tmp) to GCS. Server-side only. */
export async function uploadLocalFile(localPath: string, gcsPath: string, contentType: string): Promise<void> {
  await bucket.upload(localPath, {
    destination: gcsPath,
    resumable: false,
    contentType,
    metadata: { contentType },
  });
}

// ─── Direct-to-GCS uploads (camera-roll / library) ──────────────────────────────
// Athlete uploads PUT their bytes straight to GCS with a short-lived signed WRITE url — the API
// never proxies the (potentially large, esp. video) file. Type + size are gated when the url is
// minted; the client sends the exact Content-Type it will PUT with.

export const UPLOAD_LIMITS = {
  image: { max: 25 * 1024 * 1024,  types: ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"] },
  video: { max: 200 * 1024 * 1024, types: ["video/mp4", "video/quicktime"] },
} as const;

/** Classify an upload content-type, or null if it's not an accepted image/video type. */
export function uploadKind(contentType: string): "image" | "video" | null {
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if ((UPLOAD_LIMITS.image.types as readonly string[]).includes(ct)) return "image";
  if ((UPLOAD_LIMITS.video.types as readonly string[]).includes(ct)) return "video";
  return null;
}

/** Durable GCS path for an athlete upload: athletes/<id>/uploads/<uuid>.<ext>. */
export function uploadObjectPath(athleteId: string, id: string, contentType: string): string {
  return `athletes/${athleteId}/uploads/${id}.${extFor(contentType)}`;
}

/**
 * Ephemeral GCS path for ONE camera-roll REVIEW thumbnail:
 * athletes/<id>/review/<sessionId>/<itemId>.jpg.
 *
 * A separate `review/` segment from `uploads/` on purpose. Nothing under it is ever registered as
 * a media_asset — these are small thumbnails we score and then throw away. The import step deletes
 * the session's prefix, and a bucket lifecycle rule is the backstop for every session she abandons.
 *
 * WHY THE `.review.jpg` SUFFIX AND NOT JUST THE PREFIX: GCS lifecycle conditions match a literal
 * prefix or suffix — there is no wildcard — so `athletes/<any id>/review/` cannot be written as a
 * rule at all, and the only prefix covering every athlete is `athletes/`, which would delete her
 * whole library after a day. The suffix selects exactly these objects while keeping the per-athlete
 * prefix the tenancy checks rely on. Nothing else in the bucket can collide: upload objects are
 * `<server-generated uuid>.<ext>`. The exact rule to apply is in the PR.
 *
 * Both ids come from the client, so both are sanitised here.
 */
export const REVIEW_SUFFIX = ".review.jpg";
export function reviewObjectPath(athleteId: string, sessionId: string, itemId: string): string {
  const safe = (s: string) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `athletes/${athleteId}/review/${safe(sessionId)}/${safe(itemId)}${REVIEW_SUFFIX}`;
}

/** Delete one object. Best effort — a missing object is not an error worth propagating. */
export async function deleteObject(gcsPath: string): Promise<void> {
  try { await bucket.file(gcsPath).delete({ ignoreNotFound: true }); }
  catch (err: any) { logger.warn({ gcsPath, error: err?.message?.slice(0, 120) }, "object delete failed"); }
}

/**
 * Delete one object and say whether it is gone: true when deleted or already missing, false when the delete failed —
 * for a caller that must not forget a path until its bytes are really gone (the post-kit preview clean-up).
 */
export async function removeObject(gcsPath: string): Promise<boolean> {
  try { await bucket.file(gcsPath).delete({ ignoreNotFound: true }); return true; }
  catch (err: any) { logger.warn({ gcsPath, error: err?.message?.slice(0, 120) }, "object remove failed"); return false; }
}

/** Delete everything under a prefix (a finished review session). Best effort; returns how many went. */
export async function deletePrefix(prefix: string): Promise<number> {
  try {
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true }).catch(() => {})));
    return files.length;
  } catch (err: any) {
    logger.warn({ prefix, error: err?.message?.slice(0, 120) }, "prefix delete failed");
    return 0;
  }
}

/** Short-TTL signed WRITE url — the client PUTs bytes with EXACTLY `contentType` (default 15 min). */
export async function signedUploadUrl(gcsPath: string, contentType: string, ttlMs = 15 * 60_000): Promise<string> {
  const [url] = await bucket.file(gcsPath).getSignedUrl({
    action: "write", version: "v4", expires: Date.now() + ttlMs, contentType,
  });
  return url;
}
