/**
 * orientPath.test — the WHOLE edit geometry, on real pixels, with nothing mocked.
 *
 * WHY THIS EXISTS ALONGSIDE orientation.test.ts. That suite proves the three stages agree with each
 * other; every number in it is computed by the same code under test, so a transform applied
 * consistently but WRONGLY would satisfy it. This one starts from a picture whose content is known
 * independently — a green block on the left, a magenta block on the right — and asks the only
 * question that actually matters:
 *
 *   she drew a box on the MAGENTA marker. In the bytes the provider receives, is MAGENTA what sits
 *   at those coordinates?
 *
 * Nothing here is stubbed. Real JPEGs, the real parser, the real mapper, the real normalizer, and a
 * pixel read of the result. The only thing not exercised is the model itself.
 *
 * ─── THE FOUR THINGS THAT MUST BE ONE FRAME ─────────────────────────────────────────────────────
 *
 *   (a) the BYTES sent          studio/orient.ts   — sharp().rotate() applies the EXIF transform
 *   (b) the COORDINATES         studio/geometry.ts — fractions x the measured frame
 *   (c) the STATED dimensions   studio/preview.ts  — "The frame is WxH pixels" in the prompt
 *   (d) the RETURNED image      asserted in generate.ts, not here
 *
 * (a), (b) and (c) all land in DISPLAY space, and that is not a coincidence to be maintained by
 * hand: `.rotate()` maps stored → display, and display is the space `parseImageSize` reports and
 * therefore the space the coordinates and the prompt were already in. Normalizing the pixels moves
 * them INTO the coordinate space rather than away from it, which is why no second transform is
 * applied to the box — and why applying one would break it.
 *
 * ─── MIRRORS ARE THE ONES TO WATCH ──────────────────────────────────────────────────────────────
 *
 * Orientations 2, 4, 5 and 7 are flips. A left/right flip between where a box is drawn and the
 * frame acted on is the exact signature of "asked to edit the right arm, the LEFT arm changed", and
 * it is invisible to any test whose fixture is symmetric or whose expected values are derived from
 * the same transform. Hence a fixture with a distinct left and a distinct right, and hence all
 * eight orientations rather than the four that transpose.
 */
import sharp from "sharp";
import { parseImageSize } from "./imageSize";
import { mapRegions } from "./geometry";
import { needsOrienting, orientToPixels } from "./orient";

jest.setTimeout(60_000);

/** What she SEES: an upright portrait. */
const DW = 300;
const DH = 400;

/** Her LEFT is green, her RIGHT is magenta. Deliberately asymmetric — a mirror must be visible. */
async function uprightPhoto(): Promise<Buffer> {
  const raw = Buffer.alloc(DW * DH * 3);
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      const i = (y * DW + x) * 3;
      raw[i] = 40; raw[i + 1] = 40; raw[i + 2] = 40;
      if (x >= 30 && x < 90 && y >= 40 && y < 100) { raw[i] = 0; raw[i + 1] = 220; raw[i + 2] = 0; }
      if (x >= 210 && x < 270 && y >= 40 && y < 100) { raw[i] = 230; raw[i + 1] = 0; raw[i + 2] = 230; }
    }
  }
  return sharp(raw, { raw: { width: DW, height: DH, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * A stored buffer that yields the upright photo once its EXIF orientation is applied — i.e. the
 * INVERSE of each display transform, which is how a camera actually writes these files.
 */
async function storedFor(upright: Buffer, o: number): Promise<Buffer> {
  const s = () => sharp(upright);
  const inverse: Record<number, sharp.Sharp> = {
    1: s(),
    2: s().flop(),
    3: s().rotate(180),
    4: s().flip(),
    5: s().flop().rotate(270),
    6: s().rotate(270),
    7: s().flop().rotate(90),
    8: s().rotate(90),
  };
  return inverse[o].jpeg({ quality: 95 }).withMetadata({ orientation: o }).toBuffer();
}

/**
 * Splice a second APP1 — an XMP packet — in after the Exif one, the way a real file is laid out.
 *
 * ─── WHY EVERY FIXTURE ABOVE WAS TOO CLEAN ──────────────────────────────────────────────────────
 *
 * `sharp().withMetadata({ orientation })` writes exactly one APP1. Real files do not. Measured on
 * the live project 2026-09-03, every 24MP upload in the athlete's library is:
 *
 *     FFE1 len=34412  "Exif\0\0II*"                    <- orientation 8
 *     FFE1 len=2560   "http://ns.adobe.com/xap/1.0/"   <- XMP, the SAME marker
 *     FFE2 len=94     "MPF"
 *     FFC0            SOF
 *
 * APP1 is a shared marker, and the scanner used to take the orientation from whichever APP1 came
 * last — so the XMP packet, which carries no orientation, reset a declared 8 back to 1. The frame
 * then measured 6000x4000 landscape instead of 4000x6000 portrait, every stage downstream agreed
 * with that one wrong number, and the edit came back rotated 90 degrees.
 *
 * This suite passed throughout, because a one-APP1 fixture cannot express the bug. So the eight
 * cases below run again with the layout real cameras and Lightroom actually produce.
 */
function withXmpAfterExif(jpeg: Buffer): Buffer {
  const xmp = Buffer.concat([
    Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
    Buffer.from(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/><?xpacket end="w"?>',
      "ascii",
    ),
  ]);
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(0xe1, 1);
  head.writeUInt16BE(xmp.length + 2, 2);
  const segment = Buffer.concat([head, xmp]);

  // After the existing Exif APP1 when there is one, otherwise straight after SOI.
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe1)
    at = 4 + jpeg.readUInt16BE(4) - 2 + 2;
  return Buffer.concat([jpeg.subarray(0, at), segment, jpeg.subarray(at)]);
}

const markerAt = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  if (x >= info.width || y >= info.height) return "out-of-bounds";
  const i = (y * info.width + x) * info.channels;
  const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
  if (g > 140 && r < 140 && b < 140) return "green-her-left";
  if (r > 140 && b > 140 && g < 140) return "magenta-her-right";
  return "background";
};

/** She marks the MAGENTA block — her right arm — in the upright view. */
const DRAWN_ON_HER_RIGHT = {
  label: "her right arm",
  left: 210 / DW,
  top: 40 / DH,
  width: 60 / DW,
  height: 60 / DH,
};

/** Everything the real path would compute for one stored file. */
async function runPath(stored: Buffer) {
  const frame = parseImageSize(stored);
  if (!frame) throw new Error("frame could not be measured");
  const mapped = mapRegions([DRAWN_ON_HER_RIGHT], frame);
  if ("message" in mapped) throw new Error(`refused: ${mapped.message}`);
  // Exactly the branch studio/generate.ts takes.
  const sent = needsOrienting(frame.orientation)
    ? (await orientToPixels(stored, "image/jpeg")).bytes
    : stored;
  return { frame, box: mapped.regions[0], sent };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("every orientation: the box lands on the feature she drew on", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "orientation %i — coordinates point at MAGENTA in the bytes the provider receives",
    async (o) => {
      const { frame, box, sent } = await runPath(await storedFor(await uprightPhoto(), o));

      // (a) === (c): the bytes sent are the shape the prompt claims.
      const sentMeta = await sharp(sent).metadata();
      expect({ width: sentMeta.width, height: sentMeta.height }).toEqual({
        width: frame.width,
        height: frame.height,
      });

      // (b) against (a): the only assertion that can catch a flip. Sampled well inside the box so
      // JPEG ringing at the edges cannot decide the result.
      expect(await markerAt(sent, box.left + 30, box.top + 30)).toBe("magenta-her-right");
    },
  );

  it.each([2, 4, 5, 7])(
    "mirrored orientation %i does not put her LEFT arm under a box drawn on her right",
    async (o) => {
      const { box, sent } = await runPath(await storedFor(await uprightPhoto(), o));
      expect(await markerAt(sent, box.left + 30, box.top + 30)).not.toBe("green-her-left");
    },
  );

  it("the stated frame is the DISPLAY frame for a rotated file, and the bytes match it", async () => {
    const stored = await storedFor(await uprightPhoto(), 6);
    expect(await sharp(stored).metadata()).toMatchObject({ width: DH, height: DW }); // 400x300 on disk
    const { frame, sent } = await runPath(stored);
    expect({ width: frame.width, height: frame.height }).toEqual({ width: DW, height: DH });
    expect(await sharp(sent).metadata()).toMatchObject({ width: DW, height: DH });
  });

  it("an upright file is passed through untouched — same bytes, not a re-encode", async () => {
    const stored = await storedFor(await uprightPhoto(), 1);
    const { sent } = await runPath(stored);
    expect(sent).toBe(stored);
  });
});

describe("the real-world layout: a second APP1 must not erase the orientation", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "orientation %i survives an XMP APP1 — box still lands on MAGENTA",
    async (o) => {
      const stored = withXmpAfterExif(await storedFor(await uprightPhoto(), o));
      const { frame, box, sent } = await runPath(stored);

      // The measurement itself is the thing that broke, so assert it directly rather than only
      // inferring it from where the box landed.
      expect(frame.orientation).toBe(o);
      expect({ width: frame.width, height: frame.height }).toEqual({ width: DW, height: DH });

      const sentMeta = await sharp(sent).metadata();
      expect({ width: sentMeta.width, height: sentMeta.height }).toEqual({ width: DW, height: DH });
      expect(await markerAt(sent, box.left + 30, box.top + 30)).toBe("magenta-her-right");
    },
  );

  it("measures the production layout identically with and without the XMP packet", async () => {
    // The regression stated at its narrowest: adding a segment that says nothing about orientation
    // must not change a single measured field.
    const plain = await storedFor(await uprightPhoto(), 8);
    expect(parseImageSize(withXmpAfterExif(plain))).toEqual(
      parseImageSize(plain),
    );
  });
});

describe("the failure this suite exists to catch", () => {
  it("a box mapped against the RAW buffer would miss — proving the assertion has teeth", async () => {
    // The pre-normalization bug, reproduced deliberately: multiply the same fractions by the STORED
    // dimensions and sample the STORED bytes. If this ever agreed with the real path, the test
    // above would be proving nothing.
    const stored = await storedFor(await uprightPhoto(), 6);
    const frame = parseImageSize(stored)!;
    const wrong = mapRegions([DRAWN_ON_HER_RIGHT], {
      width: frame.stored.width,
      height: frame.stored.height,
    });
    if ("message" in wrong) throw new Error(wrong.message);
    const hit = await markerAt(stored, wrong.regions[0].left + 30, wrong.regions[0].top + 30);
    expect(hit).not.toBe("magenta-her-right");
  });
});
