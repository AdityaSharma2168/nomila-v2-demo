/**
 * studio/imageSize — the true pixel dimensions of a stored frame, read from the bytes.
 *
 * WHY THIS EXISTS AT ALL. U3 maps a box the athlete drew (normalized fractions) into the source
 * frame's ORIGINAL pixel space, and that multiplication is only as honest as the dimensions it
 * multiplies by. `media_assets.width/height` cannot supply them:
 *
 *   - ingested/rehosted Instagram media never gets them — skills/rehostAthleteMedia.ts writes
 *     neither column, so they are NULL for most of a library;
 *   - uploads carry whatever the client asserted (routes/media.ts stores `width` unverified),
 *     which is the input class the tenancy rule says never to trust.
 *
 * So the dimensions come from the object itself. A ranged read of the header — not the whole
 * 4000x6000 file — plus a pure parser over the returned buffer.
 *
 * NOT `sharp`, and the reason has changed rather than gone away. When this was written sharp was
 * declared in package.json and imported nowhere, so making a native module load-bearing on Cloud
 * Run to read four struct offsets was a deploy risk with no upside. That premise is now STALE:
 * studio/orient.ts imports sharp and runs it in-request on the source frame of every rotated edit,
 * and studio/composite.ts runs it on every edit's paste-back. It is load-bearing on this exact code
 * path already.
 *
 * The conclusion survives the premise anyway, on a different argument. Reading a header is not
 * decoding an image: this parser does a 256KB RANGED read and touches no pixels, where sharp would
 * decode enough of a 24MP frame to answer, and it must stay callable on an object we have not
 * decided to spend on yet. The parser below is ~120 lines of pure arithmetic and is unit-tested.
 *
 * The IO is deliberately confined to `probeImageSize`. Everything else here is a pure function of
 * a Buffer, which is what makes the geometry provable in jest.
 *
 * ─── ONE SPACE: DISPLAY ─────────────────────────────────────────────────────────────────────────
 *
 * There are two pixel spaces for any EXIF-rotated photo, and the whole feature is correct only if
 * every step picks the SAME one:
 *
 *   STORED  — the pixels as they sit in the file. A phone portrait is very often a LANDSCAPE
 *             buffer carrying orientation 6.
 *   DISPLAY — the picture as anything renders it, after that rotation is applied. Upright.
 *
 * This module returns DISPLAY, and that is the choice the rest of the path is built on:
 *
 *   - the athlete draws on a rendered, upright photo, so her fractions are fractions of DISPLAY;
 *   - studio/geometry.ts multiplies those fractions by what this returns, so its pixels are DISPLAY;
 *   - buildPrompt (studio/preview.ts) states the frame size and the coordinates together, and the
 *     model reads them against the picture it can see — which is the upright one. A coordinate in
 *     STORED space would be 90 degrees off the image the model is looking at.
 *
 * So DISPLAY is not an arbitrary pick: it is the only space the model can act on, because the mask
 * is language rather than an alpha channel. `stored` is carried alongside for diagnosis only.
 * NOTHING in the edit path may multiply by it.
 */
import { signedUrl } from "../lib/mediaStore";
import { withTimeout } from "../lib/withTimeout";
import { createLogger } from "../logger";

const logger = createLogger("studio/imageSize");

/**
 * How much of the head of the object to read.
 *
 * A JPEG's SOF marker sits after every APP segment, and a phone photo's APP1 routinely carries an
 * embedded EXIF thumbnail plus an ICC profile. 64KB misses those and would refuse a legitimate
 * edit; a Range header costs the same either way, so this is set well past the realistic worst
 * case. If the parser still cannot find dimensions in 256KB we refuse rather than guess.
 */
export const PROBE_BYTES = 256 * 1024;

/** The signed url is used once, immediately. It never leaves this module and is never logged. */
const PROBE_URL_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface ImageSize {
  /**
   * DISPLAY width — the frame AS RENDERED, after EXIF orientation is applied.
   *
   * This is the space the athlete draws in and the space studio/geometry.ts maps into, and the two
   * being the same space is the whole correctness argument (see the ONE SPACE note below).
   */
  width: number;
  /** DISPLAY height. Same space as `width`. */
  height: number;
  /** Which container the dimensions came out of. Logged, never shown to an athlete. */
  format: "jpeg" | "png" | "webp";
  /**
   * The EXIF orientation the file declares; 1 when there is none, and 1 for every PNG and WebP
   * (neither parser reads an orientation, so neither may claim one).
   *
   * SURFACED RATHER THAN CONSUMED AND DROPPED. It was previously read, used to transpose, and
   * thrown away inside the parser, which left nothing downstream able to tell a rotated frame from
   * an upright one — so a mask that landed wrong could not be diagnosed after the fact, and no test
   * could assert that the display and the mapping had used the SAME transform. It is carried now so
   * both are possible.
   */
  orientation: number;
  /**
   * The dimensions as they sit in the BUFFER, before orientation is applied. Equal to
   * `width`/`height` for orientations 1-4, transposed for 5-8.
   *
   * Nothing in the edit path multiplies by these — coordinates live in display space. They exist so
   * a wrong-mask report can be told apart from a wrong-dimensions one.
   */
  stored: { width: number; height: number };
}

// ─── JPEG ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Frame markers that carry dimensions. SOF0/1/2/3, 5/6/7, 9/10/11, 13/14/15 — i.e. every 0xC_ in
 * the range EXCEPT 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC), which are not frame headers at all.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Markers that stand alone — no length field follows, so the scanner must not read one. */
const STANDALONE = new Set([
  0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
]);

/**
 * EXIF orientation, if the file declares one.
 *
 * THIS IS NOT PEDANTRY — it is the difference between a mask landing on the subject and landing
 * rotated 90 degrees off. A phone shot in portrait is very often stored landscape with
 * orientation 6, and every viewer that renders it — the browser, React Native's <Image>, and
 * whatever the provider ingests it through — applies that rotation. The SOF marker reports the
 * UNROTATED buffer. Take SOF at face value on such a file and width/height are swapped, which is
 * exactly the axis-transposition failure U3's whole design exists to prevent.
 *
 * Returns NULL — not 1 — when this segment does not carry an orientation, and that distinction is
 * the whole point. APP1 is a SHARED marker: Exif uses it, and so does the XMP packet that phones
 * and Lightroom write, and a real file carries BOTH. Answering 1 for "this is the XMP segment, ask
 * someone else" is indistinguishable from "Exif is present and says upright", so a caller that
 * assigned on every APP1 would let the XMP packet silently overwrite a real orientation.
 *
 * That is not hypothetical: it is exactly what happened to every 24MP upload in the library (see
 * the second-APP1 note in imageSize.test.ts). Null means "no claim"; the caller keeps its default.
 */
function exifOrientation(
  buf: Buffer,
  start: number,
  length: number,
): number | null {
  // "Exif\0\0" then a TIFF header.
  if (length < 14 || buf.toString("ascii", start, start + 4) !== "Exif")
    return null;
  const tiff = start + 6;
  const endian = buf.toString("ascii", tiff, tiff + 2);
  if (endian !== "II" && endian !== "MM") return null;
  const le = endian === "II";
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return null;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    if (u16(entry) !== 0x0112) continue; // Orientation
    const value = u16(entry + 8);
    // An out-of-range flag is a positive statement that the file is nonsense, so it resolves to 1
    // (no transform) rather than to null — there IS an Exif orientation here and it is unusable.
    return value >= 1 && value <= 8 ? value : 1;
  }
  return null;
}

/** Orientations 5-8 rotate by 90 degrees, which transposes the rendered dimensions. */
const TRANSPOSES = new Set([5, 6, 7, 8]);

function parseJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let orientation = 1;
  let offset = 2;

  while (offset + 1 < buf.length) {
    // Segments are byte-aligned on 0xFF; fill bytes between them are legal, so skip them.
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) {
      offset++;
      marker = buf[offset + 1];
    }
    offset += 2;

    if (STANDALONE.has(marker)) continue;
    // Start of scan: entropy-coded data from here on, and no frame header can follow.
    if (marker === 0xda) break;

    if (offset + 2 > buf.length) break;
    const length = buf.readUInt16BE(offset);
    if (length < 2) return null; // malformed, not merely truncated
    if (offset + length > buf.length) break; // truncated inside this segment

    if (marker === 0xe1) {
      // Only an APP1 that actually IS Exif may speak. A non-Exif APP1 (XMP) returns null and must
      // leave whatever a real Exif segment already established alone — in either segment order.
      const declared = exifOrientation(buf, offset + 2, length - 2);
      if (declared !== null) orientation = declared;
    }

    if (SOF_MARKERS.has(marker)) {
      // [length(2)][precision(1)][height(2)][width(2)][components(1)]
      if (length < 7) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      const stored = { width, height };
      return TRANSPOSES.has(orientation)
        ? { width: height, height: width, format: "jpeg", orientation, stored }
        : { width, height, format: "jpeg", orientation, stored };
    }

    offset += length;
  }
  return null;
}

/**
 * A format that carries no orientation of its own. Stored space and display space are the same, and
 * saying so explicitly is what stops a caller assuming an unread orientation is an absent one.
 */
const upright = (
  width: number,
  height: number,
  format: ImageSize["format"],
): ImageSize => ({
  width,
  height,
  format,
  orientation: 1,
  stored: { width, height },
});

// ─── PNG ────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function parsePng(buf: Buffer): ImageSize | null {
  // IHDR is required by the spec to be the FIRST chunk, so its offsets are fixed.
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width && height ? upright(width, height, "png") : null;
}

// ─── WebP ───────────────────────────────────────────────────────────────────────────────────────

function parseWebp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WEBP"
  )
    return null;

  const chunk = buf.toString("ascii", 12, 16);

  if (chunk === "VP8 ") {
    // Lossy: 3-byte frame tag, then the 3-byte sync code, then two 14-bit dimensions.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width && height ? upright(width, height, "webp") : null;
  }

  if (chunk === "VP8L") {
    // Lossless: signature byte, then 14 bits of (width-1) and 14 bits of (height-1), LE.
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return upright(width, height, "webp");
  }

  if (chunk === "VP8X") {
    // Extended: canvas size as two 24-bit LE values, each stored minus one.
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return upright(width, height, "webp");
  }

  return null;
}

// ─── The pure entry point ───────────────────────────────────────────────────────────────────────

/**
 * Dimensions from a header buffer, or null if this is not an image we can measure.
 *
 * NEVER THROWS. A truncated, empty or hostile buffer is a `null`, which the caller turns into a
 * refusal — the one thing that must not happen is a partially-parsed number reaching the geometry.
 */
export function parseImageSize(buf: Buffer): ImageSize | null {
  // The smallest buffer that could hold SOI plus a frame header. Each parser below enforces its own
  // (larger) minimum — PNG needs 24 bytes and WebP 30 — so this only skips obvious noise.
  if (!buf || buf.length < 12) return null;
  try {
    return parsePng(buf) ?? parseJpeg(buf) ?? parseWebp(buf);
  } catch {
    // A malformed file that indexes past a segment is a refusal, not a 500.
    return null;
  }
}

// ─── The one IO function ────────────────────────────────────────────────────────────────────────

/**
 * Read the head of a stored object and measure it. Null when the object is missing, unreadable or
 * not a format we can parse — every one of which the caller must treat as "refuse the edit".
 *
 * The caller is responsible for having already authorized the path against the athlete. This
 * function does no tenancy check of its own and must never be handed a client-supplied path.
 */
export async function probeImageSize(
  gcsPath: string,
): Promise<ImageSize | null> {
  try {
    // A signed read url + a Range header, rather than a GCS client of our own. `signedUrl` is
    // mediaStore's existing public entry point and already owns the ADC-vs-service-account
    // credential fork, so this needs no change to shared code and no second Storage client.
    const url = await signedUrl(gcsPath, PROBE_URL_TTL_MS);
    const res = await withTimeout(
      fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } }),
      PROBE_TIMEOUT_MS,
      "source frame probe",
    );
    // 206 is the expected answer; 200 means the server ignored the Range and sent the whole object,
    // which is still parseable — the header is at the front either way.
    if (!res.ok) {
      logger.warn({ gcsPath, status: res.status }, "source frame probe not ok");
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const size = parseImageSize(buf);
    if (!size)
      logger.warn(
        { gcsPath, bytesRead: buf.length },
        "could not measure source frame",
      );
    return size;
  } catch (err) {
    // The MESSAGE, never the error object and never the url. A signed read url's query string is
    // the credential (the same rule costLog.safeRef follows), and a serialized fetch error can
    // carry the request url with it. `gcsPath` is the durable path and is safe to log.
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), gcsPath },
      "source frame probe failed",
    );
    return null;
  }
}
