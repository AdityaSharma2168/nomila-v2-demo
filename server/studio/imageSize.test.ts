/**
 * imageSize.test — the header parser that supplies the dimensions everything else multiplies by.
 *
 * Every fixture here is SYNTHESISED in-test from the format specs. Nothing is a real athlete's
 * photo, and no bytes are read from GCS.
 *
 * The orientation cases are the ones to read. A phone shot in portrait is routinely stored
 * landscape with an EXIF orientation of 6, and every renderer between the athlete and the model
 * applies that rotation. Taking the SOF marker at face value on such a file transposes width and
 * height — the exact axis swap the geometry suite exists to catch, arriving from a different
 * direction.
 */
import { parseImageSize, PROBE_BYTES } from "./imageSize";

// ─── Fixture builders ───────────────────────────────────────────────────────────────────────────

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A minimal SOFn payload: precision, height, width, component count. */
function sofPayload(width: number, height: number): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(8, 0);
  b.writeUInt16BE(height, 1);
  b.writeUInt16BE(width, 3);
  b.writeUInt8(3, 5);
  return b;
}

/** An APP1/Exif segment carrying exactly one IFD0 entry: Orientation. Little-endian. */
function exifPayload(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 begins 8 bytes into the TIFF header
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22); // no next IFD
  return Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
}

/**
 * An APP1 segment that is NOT Exif — the XMP packet every phone and every Lightroom export writes.
 * It shares the APP1 marker with Exif and says nothing about orientation.
 */
function xmpPayload(): Buffer {
  return Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/>',
      "ascii",
    ),
  ]);
}

function jpeg(opts: {
  width: number;
  height: number;
  marker?: number;
  orientation?: number;
  padBytes?: number;
  /** Emit an XMP APP1 as well — after the Exif one by default, before it when "before". */
  xmp?: boolean | "before";
}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.xmp === "before") parts.push(jpegSegment(0xe1, xmpPayload()));
  if (opts.orientation)
    parts.push(jpegSegment(0xe1, exifPayload(opts.orientation)));
  if (opts.xmp === true) parts.push(jpegSegment(0xe1, xmpPayload()));
  // Stands in for an embedded thumbnail / ICC profile sitting between SOI and SOF.
  if (opts.padBytes)
    parts.push(jpegSegment(0xe2, Buffer.alloc(opts.padBytes, 0x7f)));
  parts.push(
    jpegSegment(opts.marker ?? 0xc0, sofPayload(opts.width, opts.height)),
  );
  parts.push(Buffer.from([0xff, 0xda])); // SOS — entropy data would follow
  return Buffer.concat(parts);
}

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(20, 16);
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a; // sync code
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8L", 12, "ascii");
  b.writeUInt32LE(20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return b;
}

function webpExtended(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUInt32LE(10, 16);
  const w = width - 1,
    h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
  return b;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────────────────────

describe("JPEG", () => {
  it("reads a baseline SOF0 at the spike's portrait size", () => {
    expect(parseImageSize(jpeg({ width: 4000, height: 6000 }))).toEqual({
      width: 4000,
      height: 6000,
      format: "jpeg",
      // No EXIF at all: display space and stored space are the same space.
      orientation: 1,
      stored: { width: 4000, height: 6000 },
    });
  });

  it("reads the landscape orientation too", () => {
    expect(parseImageSize(jpeg({ width: 6000, height: 4000 }))).toEqual({
      width: 6000,
      height: 4000,
      format: "jpeg",
      orientation: 1,
      stored: { width: 6000, height: 4000 },
    });
  });

  it("reads a progressive SOF2", () => {
    expect(
      parseImageSize(jpeg({ width: 3024, height: 4032, marker: 0xc2 })),
    ).toMatchObject({ width: 3024, height: 4032 });
  });

  it.each([0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])(
    "reads frame marker 0x%s",
    (marker) => {
      expect(
        parseImageSize(jpeg({ width: 800, height: 600, marker })),
      ).toMatchObject({ width: 800, height: 600 });
    },
  );

  it("skips a huge APP segment to reach the SOF — the EXIF-heavy case the 256KB probe exists for", () => {
    const buf = jpeg({ width: 4000, height: 6000, padBytes: 60_000 });
    expect(buf.length).toBeGreaterThan(60_000);
    expect(buf.length).toBeLessThan(PROBE_BYTES);
    expect(parseImageSize(buf)).toMatchObject({ width: 4000, height: 6000 });
  });

  it.each([1, 2, 3, 4])(
    "leaves dimensions alone for non-rotating orientation %i",
    (orientation) => {
      expect(
        parseImageSize(jpeg({ width: 4032, height: 3024, orientation })),
      ).toMatchObject({ width: 4032, height: 3024 });
    },
  );

  it.each([5, 6, 7, 8])(
    "transposes dimensions for rotating orientation %i",
    (orientation) => {
      // Stored landscape, displayed portrait. The mask must be mapped against what is DISPLAYED.
      expect(
        parseImageSize(jpeg({ width: 4032, height: 3024, orientation })),
      ).toMatchObject({ width: 3024, height: 4032 });
    },
  );

  it.each([5, 6, 7, 8])(
    "carries orientation %i and the stored space, instead of consuming both silently",
    (orientation) => {
      // The transpose above is not enough on its own: a caller that gets 3024x4032 back cannot tell
      // a genuinely-portrait file from a rotated landscape one, and those need different diagnosis
      // when a mask lands wrong. Both facts are reported.
      expect(
        parseImageSize(jpeg({ width: 4032, height: 3024, orientation })),
      ).toEqual({
        width: 3024,
        height: 4032,
        format: "jpeg",
        orientation,
        stored: { width: 4032, height: 3024 },
      });
    },
  );

  it.each([1, 2, 3, 4])(
    "reports stored === display for non-rotating orientation %i",
    (orientation) => {
      const size = parseImageSize(
        jpeg({ width: 4032, height: 3024, orientation }),
      )!;
      expect(size.orientation).toBe(orientation);
      expect(size.stored).toEqual({ width: size.width, height: size.height });
    },
  );

  /**
   * ─── THE SECOND APP1 ────────────────────────────────────────────────────────────────────────
   *
   * Measured on the live project 2026-09-03, not imagined: every 24MP upload in the athlete's
   * library is laid out
   *
   *     FFE1 len=34412  "Exif\0\0II*"                    <- orientation 8 lives here
   *     FFE1 len=2560   "http://ns.adobe.com/xap/1.0/"   <- XMP, ALSO an APP1
   *     FFE2 len=94     "MPF"
   *     FFC0            SOF
   *
   * The scanner used to assign `orientation` on EVERY APP1, so the XMP packet — which is not Exif
   * and correctly yields no orientation — overwrote the 8 with 1. The file then measured
   * 6000x4000 landscape instead of 4000x6000 portrait, and because that single wrong number is
   * what the edit path uses for BOTH the aspect ratio it asks the provider for AND the shape
   * guard it checks the answer against, the guard agreed with the bug and the edit came back
   * rotated 90 degrees.
   *
   * Every fixture above carries exactly one APP1, which is why this survived a full suite.
   */
  it("keeps the Exif orientation when an XMP APP1 follows it", () => {
    expect(
      parseImageSize(
        jpeg({ width: 6000, height: 4000, orientation: 8, xmp: true }),
      ),
    ).toEqual({
      width: 4000,
      height: 6000,
      format: "jpeg",
      orientation: 8,
      stored: { width: 6000, height: 4000 },
    });
  });

  it("finds the Exif orientation when an XMP APP1 comes first", () => {
    expect(
      parseImageSize(
        jpeg({ width: 6000, height: 4000, orientation: 8, xmp: "before" }),
      ),
    ).toMatchObject({ width: 4000, height: 6000, orientation: 8 });
  });

  it.each([5, 6, 7, 8])(
    "survives an XMP APP1 for rotating orientation %i",
    (orientation) => {
      expect(
        parseImageSize(
          jpeg({ width: 4032, height: 3024, orientation, xmp: true }),
        )!.orientation,
      ).toBe(orientation);
    },
  );

  it("still reports orientation 1 when the only APP1 is XMP", () => {
    // The other direction: a non-Exif APP1 must not be read as a declaration of uprightness that
    // happens to be right by accident. No Exif means no claim, which is orientation 1.
    expect(
      parseImageSize(jpeg({ width: 4032, height: 3024, xmp: true })),
    ).toMatchObject({ width: 4032, height: 3024, orientation: 1 });
  });

  it("ignores an out-of-range orientation rather than trusting it", () => {
    expect(
      parseImageSize(jpeg({ width: 4032, height: 3024, orientation: 42 })),
    ).toMatchObject({ width: 4032, height: 3024 });
  });

  it("reports orientation 1 for an out-of-range flag — never the raw value", () => {
    // 42 is not an orientation. Passing it through would let a caller branch on nonsense.
    expect(
      parseImageSize(jpeg({ width: 4032, height: 3024, orientation: 42 }))!
        .orientation,
    ).toBe(1);
  });

  it("returns null for a zero dimension", () => {
    expect(parseImageSize(jpeg({ width: 0, height: 600 }))).toBeNull();
  });

  it("returns null when the SOF is truncated away", () => {
    const full = jpeg({ width: 4000, height: 6000, padBytes: 4000 });
    expect(parseImageSize(full.subarray(0, 200))).toBeNull();
  });
});

describe("PNG", () => {
  it("reads IHDR", () => {
    expect(parseImageSize(png(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
      format: "png",
      // PNG carries no orientation this parser reads, so it must not claim one.
      orientation: 1,
      stored: { width: 1920, height: 1080 },
    });
  });
  it("returns null when IHDR is not the first chunk", () => {
    const b = png(100, 100);
    b.write("IDAT", 12, "ascii");
    expect(parseImageSize(b)).toBeNull();
  });
});

describe("WebP", () => {
  it("reads a lossy VP8 frame", () => {
    expect(parseImageSize(webpLossy(1200, 900))).toEqual({
      width: 1200,
      height: 900,
      format: "webp",
      orientation: 1,
      stored: { width: 1200, height: 900 },
    });
  });
  it("reads a lossless VP8L frame", () => {
    expect(parseImageSize(webpLossless(1200, 900))).toEqual({
      width: 1200,
      height: 900,
      format: "webp",
      orientation: 1,
      stored: { width: 1200, height: 900 },
    });
  });
  it("reads an extended VP8X canvas", () => {
    expect(parseImageSize(webpExtended(4000, 6000))).toEqual({
      width: 4000,
      height: 6000,
      format: "webp",
      orientation: 1,
      stored: { width: 4000, height: 6000 },
    });
  });
  it("returns null for a bad sync code", () => {
    const b = webpLossy(100, 100);
    b[23] = 0x00;
    expect(parseImageSize(b)).toBeNull();
  });
});

describe("refusing rather than guessing", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["too short", Buffer.alloc(8, 0xff)],
    ["random noise", Buffer.alloc(400, 0x5a)],
    ["all 0xFF — every byte looks like a marker", Buffer.alloc(4096, 0xff)],
    [
      "a text file",
      Buffer.from("this is not an image, it is a letter to a brand", "utf8"),
    ],
    [
      "an mp4 header",
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from("ftypisom", "ascii"),
        Buffer.alloc(100),
      ]),
    ],
  ])("returns null for %s", (_label, buf) => {
    expect(parseImageSize(buf)).toBeNull();
  });

  it("never throws on a hostile buffer", () => {
    for (let i = 0; i < 300; i++) {
      const buf = Buffer.alloc(64 + i);
      buf[0] = 0xff;
      buf[1] = 0xd8;
      buf[2] = 0xff;
      buf[3] = 0xe1;
      buf.writeUInt16BE(0xfffe, 4); // a length that runs far past the buffer
      buf.write("Exif\0\0", 6, "ascii");
      expect(() => parseImageSize(buf)).not.toThrow();
    }
  });

  it("returns null rather than a partial number for a truncated PNG", () => {
    expect(parseImageSize(png(1920, 1080).subarray(0, 18))).toBeNull();
  });
});
