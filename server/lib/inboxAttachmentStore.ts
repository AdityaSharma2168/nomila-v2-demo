/**
 * inboxAttachmentStore.ts — GCS wrapper for deal documents: attachments that arrive on
 * inbound mail, and contracts the athlete uploads herself.
 *
 * Deliberately a separate bucket from nomila-v2-athlete-media. That bucket holds
 * athlete-owned creative for media kits and cards; the media tooling (mediaSearch,
 * curator, kitCache) reasons about paths inside it, and it carries the athlete's own
 * retention expectations. Inbound third-party commercial documents are a different
 * data class with a different owner and different deletion rules, so they get their
 * own bucket and its own lifecycle policy.
 *
 * ATHLETE-UPLOADED CONTRACTS share this bucket by decision — one place for every deal
 * document, rather than making the app look in two. They are a third data class again
 * (she owns them, and she may delete them on her own terms), so they get their own path
 * prefix instead of being mixed into the inbox tree: 'contracts/' vs 'inbox/'. A prefix
 * is enough to keep ownership checks honest and to let a lifecycle rule treat the two
 * differently later, without splitting the bucket now.
 *
 * Auth: ADC, same as mediaStore — the Cloud Run runtime SA (gamechanger-runtime)
 * needs roles/storage.objectAdmin on this bucket. NOTE: signing requires a real
 * service-account key, which local user ADC does not have, so signedAttachmentUrl
 * only works deployed. Listing/metadata works everywhere.
 */
import { Storage } from "@google-cloud/storage";
import { createLogger } from "../logger";

const logger = createLogger("inbox-attachment-store");

const BUCKET = process.env.INBOX_ATTACHMENT_BUCKET ?? "nomila-v2-inbox-attachments";

/** Hard ceiling on what we will store at all. Above this the attachment is dropped. */
export const MAX_ATTACHMENT_BYTES = Number(process.env.INBOX_ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024);

const storage = new Storage();          // ADC
const bucket  = storage.bucket(BUCKET);

/**
 * Durable object path for one attachment.
 *
 * Content-addressed by the caller-supplied `hash` so the SAME pdf arriving on two
 * messages of a thread (a Fwd: of the original, say) lands on one object instead of
 * two — that is how the first pass stored a 4.6 MB deck twice.
 */
export function attachmentObjectPath(athleteId: string, hash: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(-80) || "attachment.pdf";
  return `athletes/${athleteId}/inbox/${hash}/${safe}`;
}

/**
 * Durable object path for a contract the ATHLETE uploaded.
 *
 * Keyed by a server-minted uploadId rather than a content hash: the hash exists to
 * deduplicate the same PDF arriving on several messages of one thread, which cannot
 * happen here — she picks a file and sends it once. Using an opaque id also means the
 * path is unguessable, and re-uploading the same contract deliberately makes a second
 * object rather than silently overwriting the first.
 */
export function contractObjectPath(athleteId: string, uploadId: string, filename: string): string {
  // NB the character class is [^\w.\-] — word chars, dot, hyphen. Written without its
  // backslashes it reads "not w, dot or hyphen", which strips every letter except a lowercase
  // w: "Mia Bhuta Endorsement Agreement (2023-2028).pdf" became "_-_._".
  const safe = filename.replace(/[^\w.\-]+/g, "_").slice(-80) || "contract.pdf";
  return `athletes/${athleteId}/contracts/${uploadId}/${safe}`;
}

/**
 * Short-TTL signed WRITE url, so the client PUTs bytes straight to GCS.
 *
 * Mirrors mediaStore.signedUploadUrl: the API never carries the file. A contract is the
 * largest thing the athlete will send us and the least interesting to proxy — routing it
 * through Cloud Run would buy nothing but memory pressure and a request timeout.
 *
 * Signing needs a real service-account key, which local user ADC does not have, so this
 * works deployed and not locally — the same limitation signedAttachmentUrl already has.
 */
export async function signedAttachmentUploadUrl(
  gcsPath: string,
  contentType: string,
  ttlMs = 15 * 60_000,
): Promise<string> {
  const [url] = await bucket.file(gcsPath).getSignedUrl({
    action: "write", version: "v4", expires: Date.now() + ttlMs, contentType,
  });
  return url;
}

/**
 * Read an object back. Returns null rather than throwing — the caller is extracting text
 * from a file the athlete just uploaded, and a storage hiccup should degrade to "we could
 * not read it yet", not lose the upload she already completed.
 */
export async function getAttachment(gcsPath: string): Promise<Buffer | null> {
  try {
    const [buf] = await bucket.file(gcsPath).download();
    return buf;
  } catch (err: any) {
    logger.warn({ gcsPath, error: err.message?.slice(0, 160) }, "attachment download failed");
    return null;
  }
}

/** Store bytes at `gcsPath`. Idempotent: re-uploading the same content-addressed path is a no-op overwrite. */
export async function putAttachment(
  gcsPath: string,
  buf: Buffer,
  contentType = "application/pdf",
): Promise<boolean> {
  try {
    await bucket.file(gcsPath).save(buf, { resumable: false, contentType, metadata: { contentType } });
    return true;
  } catch (err: any) {
    // Never fail ingestion over storage — the extracted text is the part that
    // drives the deal, and it is already in the body by this point.
    logger.warn({ gcsPath, error: err.message?.slice(0, 160) }, "attachment upload failed");
    return false;
  }
}

/** Short-TTL signed read URL (default 15 min) for handing to the app. */
export async function signedAttachmentUrl(gcsPath: string, ttlMs = 15 * 60_000): Promise<string> {
  const [url] = await bucket.file(gcsPath).getSignedUrl({
    action: "read", version: "v4", expires: Date.now() + ttlMs,
  });
  return url;
}
