/**
 * studio/orient — make the pixels tell the truth before a provider sees them.
 *
 * WHY THIS EXISTS. Measured against the live project on 2026-09-03: Gemini reads the RAW JPEG
 * buffer and ignores EXIF orientation entirely. A 400x300 landscape fixture flagged orientation 6
 * — which every viewer, and the athlete, sees as a 300x400 portrait — came back described by the
 * model as "400 pixels width, 300 pixels height" with the corner marker in the corner it occupies
 * in the UNROTATED buffer. The edit it produced was landscape too.
 *
 * That single fact breaks the edit path in two places at once:
 *
 *   1. THE MASK LANDS WRONG. Everything upstream is in DISPLAY space and is right there — she draws
 *      on an upright photo, studio/geometry.ts multiplies by display dimensions, and buildPrompt
 *      states that same display frame. The model then applies those coordinates to a picture lying
 *      on its side. Asked to edit an arm, it edits whatever occupies those coordinates in ITS view.
 *   2. THE OUTPUT COMES BACK ROTATED. Even with perfect coordinates, a portrait photo returns
 *      landscape, because the model renders in the space it was given.
 *
 * THE FIX IS THE BYTES, NOT THE ARITHMETIC. Rotating the coordinates into raw space would address
 * (1) and not (2), and would bet correctness on an undocumented provider behaviour that could
 * change silently in either direction. Baking the rotation into the pixels removes the disagreement
 * instead of encoding it: stored space becomes display space, so the mask is already right, the
 * prompt is already right, and the output comes back upright. There is then nothing left to get out
 * of sync.
 *
 * ─── COST, AND WHY ONLY SOMETIMES ───────────────────────────────────────────────────────────────
 *
 * This is the one place `sharp` is load-bearing in a request. It is not a new dependency — it is
 * declared in `dependencies` (^0.34.5) and has been installed all along — but making a native
 * module matter on Cloud Run is a real change, so the blast radius is deliberately one file and one
 * call site (resolveStoredReference in studio/generate.ts).
 *
 * A decode + rotate + re-encode of a 4000x6000 frame holds roughly 4000*6000*3 ≈ 72MB of raw
 * pixels transiently and costs order-100ms of CPU. That is why it is gated on `orientation !== 1`:
 * an upright frame — every PNG, every WebP, and every JPEG a camera wrote level — never enters this
 * module and pays nothing, keeping the cost on the minority of frames that genuinely need it. It
 * runs ONCE per edit, on the source frame only. It is never in a loop and never retried.
 *
 * The real endgame is normalizing at INGEST so nothing downstream ever sees a rotated buffer and
 * this per-edit cost disappears. That lives in rehostAthleteMedia / routes/media and needs a
 * library backfill, so it is owned elsewhere; this is the correct per-edit fix until then.
 *
 * ─── WHY EVERY orientation !== 1, NOT JUST 5-8 ──────────────────────────────────────────────────
 *
 * 5-8 are the ones that transpose the DIMENSIONS, which is what studio/imageSize.ts cares about.
 * They are not the only ones that move the PIXELS. Orientation 3 is a 180-degree turn: the
 * dimensions are unchanged, so nothing about the frame size looks wrong, and the picture is still
 * upside down — coordinates would be wrong on both axes and the output inverted. 2 and 4 are
 * mirrors. Anything that is not 1 changes what the model sees, so anything that is not 1 is
 * normalized.
 */
import sharp from "sharp";
import { saveBuffer, signedUrl } from "../lib/mediaStore";
import { parseImageSize, PROBE_BYTES } from "./imageSize";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";

const logger = createLogger("studio/orient");

/**
 * Ceiling on a frame we are willing to decode. Above this we refuse rather than risk the instance:
 * the raw pixel buffer, not the file, is what has to fit in memory.
 */
const MAX_ORIENT_BYTES = Number(process.env.STUDIO_MAX_ORIENT_BYTES ?? 40 * 1024 * 1024);

/** A rotate is CPU-bound and bounded; if it has not finished by here something is wrong. */
const ORIENT_TIMEOUT_MS = 20_000;

/** Reading a just-uploaded object back out of GCS. Images cap at 25MB (mediaStore.UPLOAD_LIMITS). */
const INGEST_FETCH_TIMEOUT_MS = 30_000;

export interface OrientedFrame {
  bytes: Buffer;
  mimeType: string;
}

/** Nothing to do: the buffer already reads the way it renders. */
export const needsOrienting = (orientation: number | null | undefined): boolean =>
  typeof orientation === "number" && Number.isInteger(orientation) && orientation > 1 && orientation <= 8;

/**
 * Apply a file's own EXIF orientation to its pixels and drop the flag.
 *
 * `sharp().rotate()` WITH NO ARGUMENT is the EXIF-driven form — it applies whatever transform the
 * file declares, mirrors included, and is a no-op when there is none. Passing an angle would rotate
 * unconditionally and is not what this wants.
 *
 * Metadata is NOT carried over. That is the point rather than an oversight: an output still
 * carrying `orientation: 6` would be rotated a second time by anything that does honour EXIF, which
 * is the same disagreement in the other direction. Upright pixels, no flag, nothing left to argue
 * about.
 *
 * The output format is the input format — `toBuffer()` without an explicit format keeps it — so a
 * JPEG stays a JPEG and no caller has to re-derive a content type.
 */
export async function orientToPixels(input: Buffer, contentType?: string): Promise<OrientedFrame> {
  if (input.length > MAX_ORIENT_BYTES) {
    throw new Error(`source frame is ${input.length} bytes, over the ${MAX_ORIENT_BYTES} orient cap`);
  }
  const started = Date.now();
  const { data, info } = await withTimeout(
    sharp(input, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true }),
    ORIENT_TIMEOUT_MS,
    "source frame orient",
  );
  logger.info(
    { inBytes: input.length, outBytes: data.length, width: info.width, height: info.height, ms: Date.now() - started },
    "source frame normalized to upright pixels",
  );
  return { bytes: data, mimeType: contentType ?? `image/${info.format}` };
}

// ─── Ingest-time normalization ──────────────────────────────────────────────────────────────────

/**
 * Straighten a freshly uploaded object IN PLACE, so nothing downstream ever sees a rotated buffer.
 *
 * WHY AT INGEST, WHEN THE PER-EDIT PATH ALREADY WORKS. The per-edit fix normalizes what the model
 * RECEIVES; it cannot do anything about what the model RETURNS. The provider hands back a new image
 * with no orientation metadata and no record of what it did, so there is no transform to undo on
 * the way out (studio/generate.ts assertEditKeptItsShape refuses rather than guesses). Resolving
 * orientation before the file is ever stored is the only thing that puts all four — the bytes, the
 * coordinates, the stated frame size, AND the returned image — in one unambiguous frame.
 *
 * NEW UPLOADS ONLY. Existing library photos keep their EXIF flag and keep going through the
 * per-edit path in resolveStoredReference, which stays exactly as it is. The two coexist by
 * construction rather than by coordination: once an object is stored upright its orientation is 1,
 * `needsOrienting` is false, and the per-edit path is a no-op on it. Backfilling the existing
 * library is a separate job in someone else's lane.
 *
 * ─── WHAT IT WILL AND WILL NOT TOUCH ────────────────────────────────────────────────────────────
 *
 *   measured + rotated    → rewritten upright, flag gone. Returns the true dimensions.
 *   measured + upright    → NOT rewritten. Returns the measured dimensions and nothing else
 *                           happens; re-encoding an already-correct photo would cost a generation
 *                           of JPEG quality for no reason at all.
 *   NOT measurable        → null. HEIC is an accepted upload type (mediaStore.UPLOAD_LIMITS) and
 *                           studio/imageSize.ts does not parse it, so "cannot measure" is a normal
 *                           case and must not fail an upload. It also cannot be silently trusted:
 *                           the caller records that the frame is unverified.
 *
 * A THROW MEANS THE UPLOAD FAILS. Every error here propagates. Storing the un-normalized bytes as a
 * fallback would put the exact file this exists to prevent into her library, wearing a row that
 * claims it was handled.
 */
/**
 * Read a stored object, or as much of its head as `maxBytes` allows.
 *
 * THROWS on any failure, which is the whole reason it exists rather than reusing probeImageSize:
 * the caller has to be able to tell "cannot read this" from "cannot parse this".
 */
async function readObject(gcsPath: string, maxBytes?: number): Promise<Buffer> {
  const url = await signedUrl(gcsPath, 60_000);
  const res = await withTimeout(
    fetch(url, maxBytes ? { headers: { Range: `bytes=0-${maxBytes - 1}` } } : undefined),
    INGEST_FETCH_TIMEOUT_MS,
    "upload read-back",
  );
  if (!res.ok) throw new Error(`could not read the uploaded object back (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export interface NormalizedUpload {
  /** True when the object in GCS was rewritten. False means it was already upright. */
  changed: boolean;
  /** TRUE upright dimensions, measured from the bytes — never what a client asserted. */
  width: number;
  height: number;
  /** What the file declared before normalization. 1 when it declared nothing. */
  wasOrientation: number;
  /** Size of the object now, when it was rewritten. */
  bytes?: number;
}

export async function normalizeStoredImage(
  gcsPath: string,
  contentType: string,
): Promise<NormalizedUpload | null> {
  // NOT probeImageSize. It answers null for BOTH "this is not a format we can parse" and "the read
  // failed", and those must not lead to the same place: the first is a normal HEIC upload, the
  // second would silently register a rotated photo as handled. Reading here keeps them apart — a
  // read failure throws and fails the upload, a parse failure returns null.
  const head = await readObject(gcsPath, PROBE_BYTES);
  const probed = parseImageSize(head);
  if (!probed) return null;

  if (!needsOrienting(probed.orientation)) {
    // Already upright. The dimensions are still worth having — media_assets.width/height is NULL
    // for most of a library and client-asserted for the rest. Costs one ranged read and no decode.
    return { changed: false, width: probed.width, height: probed.height, wasOrientation: probed.orientation };
  }

  const oriented = await orientToPixels(await readObject(gcsPath), contentType);

  // Overwrite the SAME object. saveBuffer builds its destination as `${basePath}.<ext>` from the
  // content type, which is the identical rule uploadObjectPath used to mint this path — so stripping
  // the extension round-trips exactly. Asserted rather than assumed: writing a second object and
  // leaving the rotated original registered is precisely the failure to avoid.
  const basePath = gcsPath.replace(/\.[^./]+$/, "");
  const stored = await saveBuffer(oriented.bytes, basePath, oriented.mimeType);
  if ("skipped" in stored) throw new Error("the straightened photo is over the media size cap");
  if (stored.gcs_path !== gcsPath) {
    throw new Error(`normalized object landed at ${stored.gcs_path}, not the registered path`);
  }

  logger.info(
    { gcsPath, wasOrientation: probed.orientation, width: probed.width, height: probed.height, bytes: stored.bytes },
    "upload normalized upright at ingest — no EXIF orientation remains",
  );
  return {
    changed: true,
    width: probed.width,
    height: probed.height,
    wasOrientation: probed.orientation,
    bytes: stored.bytes,
  };
}
