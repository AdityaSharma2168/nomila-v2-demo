/**
 * studio/thumbnail — a small, embeddable copy of a generated frame, written when the frame is.
 *
 * ─── WHY A GENERATED ASSET NEEDS ONE AND AN INGESTED ONE DOES NOT ──────────────────────────────
 *
 * `mediaEnrichment` embeds `r.thumb ?? r.path`, so an asset with no thumbnail is embedded from its
 * FULL-RESOLUTION original. That works for everything the library ingests — a connected Instagram
 * asset has a median size of ~58KB — and it does not work for what Studio makes. Measured
 * 2026-09-09 over 127 generated assets: median 3.0MB, max 24.6MB, and the largest are 4000x6000
 * JPEGs written at quality 100. Base64 inflates by 4/3, so a 24.6MB frame is ~32.8M characters
 * against Vertex's 27,000,000-character cap, and `embedImageGcs` gets an error back and returns
 * null.
 *
 * The consequence is not "no embedding". It is that dedup goes BLIND on exactly the assets it
 * exists for. `mediaSearch` suppresses near-duplicates with `cand.emb && picked.some(…)`, so a
 * missing embedding makes `dup` falsy and the asset can never be suppressed — and one studio
 * session is many near-identical recolors of one frame. The thing dedup is for is the one thing it
 * could not see.
 *
 * ─── WHY THE FIX IS HERE AND NOT IN THE EMBEDDER ───────────────────────────────────────────────
 *
 * Downscaling inside `embedImageGcs` would put a Studio-shaped problem in a function every origin
 * shares, and would leave `gcs_thumb_path` null so the UI keeps signing full-res URLs for a grid of
 * thumbnails. Writing the thumbnail at record time fixes both readers at once with no branch: the
 * embedder's existing `r.thumb ?? r.path` picks it up because it is a thumb, and studio/content.ts
 * already prefers `gcs_thumb_path` for `thumbUrl`.
 *
 * ⚠️ NOTE THE ROADMAP'S PREMISE IS WRONG AND THE FIX IS RIGHT ANYWAY. It reads "route them down the
 * path the 263 connected assets use" — but those 263 have NO thumbnail either; they embed off
 * `gcs_path` and get away with it on size. There is no existing image-thumbnail writer to join. The
 * only writers of `gcs_thumb_path` today are videoPoster.ts and fetchTopVideoFiles.ts, both video
 * posters. This is a new path, and it is new for images only.
 */
import sharp from "sharp";
import { saveBuffer, readObject } from "../lib/mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("studio/thumbnail");

/**
 * The long edge of a generated asset's thumbnail.
 *
 * 1024 is chosen against the CAP rather than against taste, and with an order of magnitude to
 * spare: a 1024-long-edge JPEG at the quality below lands in the low hundreds of KB, which is
 * ~0.2M base64 characters against a 27M limit. The failing frames were 32.8M. Sizing this to "as
 * large as still fits" would put the next 8000px model output right back over the line, which is
 * the failure being fixed rather than a smaller version of it.
 *
 * It is also comfortably above what the embedder can use — `multimodalembedding@001` works from a
 * downsampled copy internally — and above what the library grid renders.
 */
export const THUMB_LONG_EDGE_PX = 1024;

/** Quality 80 is the thumbnail default across the ecosystem and the artefacts are invisible at this size. */
const THUMB_QUALITY = 80;

/** Written beside the asset, so the pair is obvious in a bucket listing and in a log line. */
export const THUMB_SUFFIX = ".thumb";

/**
 * Make and store a thumbnail for one generated IMAGE. Returns its GCS path, or null.
 *
 * ⚠️ NULL IS A SUPPORTED OUTCOME AND NEVER AN EXCEPTION. This runs immediately after a paid
 * generation has succeeded and its bytes are safely stored. A thumbnail that cannot be made is a
 * degraded search experience; a throw here would lose her the asset she just paid for, turning a
 * retrieval problem into a data-loss one. Every failure path logs and returns null, and the row is
 * written without a thumb exactly as it is today.
 *
 * IMAGES ONLY. A video's `gcs_thumb_path` is its POSTER, extracted with ffmpeg by
 * services/videoPoster.ts, which already owns that job and runs from the same cron. Producing a
 * second, differently-made poster here would give one column two meanings.
 */
export async function writeGeneratedThumbnail(
  gcsPath: string,
  opts: { bytes?: Buffer; mediaType?: "IMAGE" | "VIDEO" } = {},
): Promise<string | null> {
  if (opts.mediaType === "VIDEO") return null;

  try {
    // Prefer the bytes the caller already holds — the generation path has them in memory, and
    // re-downloading what we just uploaded is a round trip for nothing. Reading back is the
    // fallback for a rehosted-from-url asset and for the backfill, which has only a path.
    const source = opts.bytes ?? (await readObject(gcsPath))?.buf;
    if (!source) {
      logger.warn({ gcsPath }, "no bytes to thumbnail — asset stays full-res for the embedder");
      return null;
    }

    const thumb = await sharp(source)
      .rotate() // honour EXIF before resizing, or a portrait frame thumbnails sideways
      .resize(THUMB_LONG_EDGE_PX, THUMB_LONG_EDGE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer();

    // `saveBuffer` appends the extension for the content type, so the base carries the suffix.
    const base = gcsPath.replace(/\.[^./]+$/, "") + THUMB_SUFFIX;
    const stored = await saveBuffer(thumb, base, "image/jpeg");
    if ("skipped" in stored) {
      // Unreachable at this size by construction, and it is still checked: a silent `skipped` read
      // as success would write a path to an object that is not there.
      logger.warn({ gcsPath, bytes: thumb.byteLength }, "thumbnail hit the media size cap");
      return null;
    }

    logger.info(
      { gcsPath, thumbPath: stored.gcs_path, sourceBytes: source.byteLength, thumbBytes: stored.bytes },
      "generated asset thumbnailed",
    );
    return stored.gcs_path;
  } catch (err) {
    logger.warn(
      { gcsPath, error: err instanceof Error ? err.message.slice(0, 160) : String(err) },
      "could not thumbnail a generated asset — it stays full-res for the embedder",
    );
    return null;
  }
}
