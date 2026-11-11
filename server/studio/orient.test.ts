/**
 * orient.test — the normalization that makes the pixels agree with everything upstream.
 *
 * These fixtures are REAL images, encoded in-test by sharp, not header stubs. That matters here in
 * a way it does not elsewhere in this directory: the thing under test decodes and re-encodes actual
 * pixels, so a synthesised header would prove nothing. Nothing is a real athlete's photo and no
 * bytes are read from GCS.
 *
 * THE FIXTURE IS ASYMMETRIC ON PURPOSE. A 400x300 landscape frame with a green marker block in one
 * corner and two differently-coloured halves. A centred or symmetric fixture would survive a wrong
 * rotation unchanged, which is the failure mode most worth catching: the marker's corner is what
 * makes "rotated the wrong way" and "rotated the right way" distinguishable at all.
 */
import sharp from "sharp";
import { needsOrienting, orientToPixels } from "./orient";

const W = 400;
const H = 300;

/** Landscape pixels: left half red, right half blue, a green block at the STORED top-left. */
async function baseJpeg(): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (x < W / 2) raw[i] = 200;
      else raw[i + 2] = 200;
      if (x >= 20 && x < 60 && y >= 20 && y < 60) {
        raw[i] = 0;
        raw[i + 1] = 220;
        raw[i + 2] = 0;
      }
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

/** The same pixels, flagged — `withMetadata` writes the tag WITHOUT rotating anything. */
const flagged = async (orientation: number) =>
  sharp(await baseJpeg()).withMetadata({ orientation }).toBuffer();

/** Which corner the green block sits in, read off the actual decoded pixels. */
async function markerCorner(buf: Buffer): Promise<string> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i + 1] > 150 && data[i] < 120 && data[i + 2] < 120) { sx += x; sy += y; n++; }
    }
  }
  if (!n) return "none";
  return `${sy / n < info.height / 2 ? "top" : "bottom"}-${sx / n < info.width / 2 ? "left" : "right"}`;
}

const sizeOf = async (buf: Buffer) => {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, orientation: m.orientation };
};

jest.setTimeout(30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("needsOrienting — every orientation that moves pixels, not just the ones that transpose", () => {
  it("is false for an upright or absent flag", () => {
    expect(needsOrienting(1)).toBe(false);
    expect(needsOrienting(undefined)).toBe(false);
    expect(needsOrienting(null)).toBe(false);
  });

  it.each([2, 3, 4])("is true for %i — a mirror or a 180 turn moves pixels without transposing", (o) => {
    // The trap this exists for: orientation 3 leaves the DIMENSIONS untouched, so nothing about the
    // frame size looks wrong while the picture is upside down.
    expect(needsOrienting(o)).toBe(true);
  });

  it.each([5, 6, 7, 8])("is true for the transposing orientation %i", (o) => {
    expect(needsOrienting(o)).toBe(true);
  });

  it("is false for a value outside 1-8 rather than attempting a transform on it", () => {
    expect(needsOrienting(42)).toBe(false);
    expect(needsOrienting(0)).toBe(false);
    expect(needsOrienting(6.5)).toBe(false);
  });
});

describe("orientToPixels — the buffer ends up reading the way it renders", () => {
  it("a rotated frame comes out UPRIGHT: transposed dimensions, marker where a viewer sees it", async () => {
    const before = await sizeOf(await flagged(6));
    expect(before).toMatchObject({ width: W, height: H, orientation: 6 });
    // Orientation 6 is a 90-degree clockwise turn, so the STORED top-left becomes the DISPLAYED
    // top-right. That is the fact the provider was getting wrong.
    expect(await markerCorner(await flagged(6))).toBe("top-left"); // raw, as Gemini saw it

    const out = await orientToPixels(await flagged(6));

    expect(await sizeOf(out.bytes)).toMatchObject({ width: H, height: W });
    expect(await markerCorner(out.bytes)).toBe("top-right");
  });

  it("drops the orientation tag, so nothing that DOES honour EXIF rotates it a second time", async () => {
    const out = await orientToPixels(await flagged(6));
    const after = await sizeOf(out.bytes);
    // undefined, or a value meaning "upright" — never a live rotating flag.
    expect(after.orientation === undefined || after.orientation === 1).toBe(true);
  });

  it.each([
    [3, W, H, "bottom-right"],
    [6, H, W, "top-right"],
    [8, H, W, "bottom-left"],
  ])(
    "orientation %i lands the marker at %s with the right extent",
    async (orientation, width, height, corner) => {
      const out = await orientToPixels(await flagged(orientation as number));
      expect(await sizeOf(out.bytes)).toMatchObject({ width, height });
      expect(await markerCorner(out.bytes)).toBe(corner);
    },
  );

  it("keeps the input's format, so the caller's content type stays true", async () => {
    const out = await orientToPixels(await flagged(6), "image/jpeg");
    expect(out.mimeType).toBe("image/jpeg");
    expect((await sharp(out.bytes).metadata()).format).toBe("jpeg");
  });

  it("derives a mime type when the caller has none", async () => {
    expect((await orientToPixels(await flagged(6))).mimeType).toBe("image/jpeg");
  });

  it("refuses a frame over the decode cap instead of risking the instance", async () => {
    const huge = Buffer.alloc(41 * 1024 * 1024);
    await expect(orientToPixels(huge)).rejects.toThrow(/over the .* orient cap/);
  });

  it("throws on bytes that are not an image — the caller turns that into a refusal", async () => {
    await expect(orientToPixels(Buffer.from("not an image at all"))).rejects.toThrow();
  });
});

describe("the round trip agrees with what the athlete drew on", () => {
  it("normalized dimensions equal the DISPLAY dimensions studio/imageSize reports", async () => {
    // imageSize returns display space (transposed for 5-8); after normalization the BUFFER is that
    // shape too. The two agreeing is the whole point — it is what makes stored space and display
    // space the same space from the provider's side of the wire.
    const out = await orientToPixels(await flagged(6));
    const { width, height } = await sizeOf(out.bytes);
    expect({ width, height }).toEqual({ width: H, height: W }); // 300x400, the upright portrait
  });

  it("an already-upright frame is unchanged in shape and corner", async () => {
    // It should never reach orientToPixels — needsOrienting(1) is false — but if it ever does, it
    // must be a no-op rather than a surprise rotation.
    const out = await orientToPixels(await flagged(1));
    expect(await sizeOf(out.bytes)).toMatchObject({ width: W, height: H });
    expect(await markerCorner(out.bytes)).toBe("top-left");
  });
});
