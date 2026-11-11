/**
 * orientIngest.test — a photo uploaded rotated is STORED upright.
 *
 * The ingest half of the orientation work. studio/orientPath.test.ts proves the per-edit path keeps
 * the box, the bytes and the stated frame in one space; this proves that for a new upload there is
 * no rotation left to reconcile in the first place — which is the only thing that also fixes what
 * the model hands BACK, since nothing arrives with its output describing what it did.
 *
 * GCS is stubbed at the mediaStore boundary and behaves like an object store: `saveBuffer` writes
 * into a map, `signedUrl` + fetch read out of it. That makes "was the object rewritten, and with
 * what?" directly observable, which is the property under test. The images are real — encoded by
 * sharp, decoded by the parser and by sharp again — because a header stub could not prove that
 * pixels moved.
 */
import sharp from "sharp";

/** Stands in for the bucket. Keyed by gcs path. */
const objects = new Map<string, { bytes: Buffer; contentType: string }>();

jest.mock("../lib/mediaStore", () => ({
  signedUrl: async (p: string) => `https://bucket.test/${encodeURIComponent(p)}`,
  saveBuffer: async (buf: Buffer, basePath: string, contentType: string) => {
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const dest = `${basePath}.${ext}`;
    objects.set(dest, { bytes: buf, contentType });
    return { gcs_path: dest, content_type: contentType, bytes: buf.byteLength };
  },
}));

import { normalizeStoredImage } from "./orient";
import { parseImageSize } from "./imageSize";

jest.setTimeout(60_000);

const DW = 300;
const DH = 400;
const PATH = "athletes/athlete-1/uploads/abc.jpg";

/** Upright portrait: her LEFT green, her RIGHT magenta, so a mirror or a turn is visible. */
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

/** As a camera writes it: pixels turned the other way, with the flag that undoes them. */
async function storedRotated(o: number): Promise<Buffer> {
  const up = await uprightPhoto();
  const inverse: Record<number, sharp.Sharp> = {
    2: sharp(up).flop(),
    3: sharp(up).rotate(180),
    6: sharp(up).rotate(270),
    8: sharp(up).rotate(90),
  };
  return inverse[o].jpeg({ quality: 95 }).withMetadata({ orientation: o }).toBuffer();
}

const put = (bytes: Buffer, path = PATH) => objects.set(path, { bytes, contentType: "image/jpeg" });

const markerAt = async (buf: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
  if (g > 140 && r < 140 && b < 140) return "green-her-left";
  if (r > 140 && b > 140 && g < 140) return "magenta-her-right";
  return "background";
};

beforeEach(() => {
  objects.clear();
  global.fetch = jest.fn(async (url: string) => {
    const path = decodeURIComponent(String(url).replace("https://bucket.test/", ""));
    const o = objects.get(path);
    if (!o) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => o.bytes };
  }) as unknown as typeof fetch;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a rotated upload is stored upright, with the flag gone", () => {
  it("rewrites the object: dimensions swapped to true upright, no orientation left", async () => {
    put(await storedRotated(6));
    expect(await sharp(objects.get(PATH)!.bytes).metadata()).toMatchObject({
      width: DH, height: DW, orientation: 6,          // 400x300 on disk, flagged
    });

    const out = await normalizeStoredImage(PATH, "image/jpeg");

    expect(out).toMatchObject({ changed: true, width: DW, height: DH, wasOrientation: 6 });
    const after = await sharp(objects.get(PATH)!.bytes).metadata();
    expect({ width: after.width, height: after.height }).toEqual({ width: DW, height: DH });
    expect(after.orientation === undefined || after.orientation === 1).toBe(true);
  });

  it("the stored pixels are the picture she saw — her right arm is on the right", async () => {
    put(await storedRotated(6));
    await normalizeStoredImage(PATH, "image/jpeg");
    expect(await markerAt(objects.get(PATH)!.bytes, 240, 70)).toBe("magenta-her-right");
    expect(await markerAt(objects.get(PATH)!.bytes, 60, 70)).toBe("green-her-left");
  });

  it("overwrites the REGISTERED path — never a second object beside it", async () => {
    put(await storedRotated(6));
    await normalizeStoredImage(PATH, "image/jpeg");
    expect([...objects.keys()]).toEqual([PATH]);
  });

  it.each([2, 3, 8])("handles orientation %i, including the mirror", async (o) => {
    put(await storedRotated(o));
    const out = await normalizeStoredImage(PATH, "image/jpeg");
    expect(out?.changed).toBe(true);
    expect(await markerAt(objects.get(PATH)!.bytes, 240, 70)).toBe("magenta-her-right");
  });

  it("reports the byte count of what is now stored, not what arrived", async () => {
    put(await storedRotated(6));
    const out = await normalizeStoredImage(PATH, "image/jpeg");
    expect(out!.bytes).toBe(objects.get(PATH)!.bytes.byteLength);
  });
});

describe("what it leaves alone", () => {
  it("an upright upload is NOT rewritten — no needless generation of JPEG loss", async () => {
    const original = await uprightPhoto();
    put(original);

    const out = await normalizeStoredImage(PATH, "image/jpeg");

    expect(out).toMatchObject({ changed: false, width: DW, height: DH, wasOrientation: 1 });
    expect(objects.get(PATH)!.bytes).toBe(original); // byte-identical, same object
  });

  it("still measures an upright upload, which is the null-dimensions fix", async () => {
    put(await uprightPhoto());
    const out = await normalizeStoredImage(PATH, "image/jpeg");
    expect({ width: out!.width, height: out!.height }).toEqual({ width: DW, height: DH });
  });

  it("returns null for a format the parser cannot read, rather than failing the upload", async () => {
    // HEIC is an accepted upload type and imageSize.ts does not parse it. The caller registers the
    // row and records that the frame is unverified; refusing the upload would be wrong.
    put(Buffer.from("ftypheic-not-really-but-unparseable"));
    await expect(normalizeStoredImage(PATH, "image/heic")).resolves.toBeNull();
  });
});

describe("a failure must never store the un-normalized bytes", () => {
  it("throws when the object cannot be read back", async () => {
    put(await storedRotated(6));
    global.fetch = jest.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch;
    await expect(normalizeStoredImage(PATH, "image/jpeg")).rejects.toThrow(/read the uploaded object back/);
  });

  it("throws when the bytes will not decode, leaving the object as it was", async () => {
    // A VALID rotated JPEG header with no image data behind it: the parser reads 400x300 and
    // orientation 6, so it gets past the measure and dies in the decode. That ordering is the point
    // — a failure after we have decided to rewrite must not leave the original registered as done.
    const sof = Buffer.alloc(6);
    sof.writeUInt8(8, 0); sof.writeUInt16BE(300, 1); sof.writeUInt16BE(400, 3); sof.writeUInt8(3, 5);
    const seg = (m: number, p: Buffer) => {
      const h = Buffer.alloc(4);
      h.writeUInt8(0xff, 0); h.writeUInt8(m, 1); h.writeUInt16BE(p.length + 2, 2);
      return Buffer.concat([h, p]);
    };
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii"); tiff.writeUInt16LE(0x2a, 2); tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
    const headerOnly = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff])),
      seg(0xc0, sof),
      Buffer.from([0xff, 0xda]),
    ]);
    put(headerOnly);
    const before = objects.get(PATH)!.bytes;

    await expect(normalizeStoredImage(PATH, "image/jpeg")).rejects.toThrow();
    expect(objects.get(PATH)!.bytes).toBe(before); // untouched — nothing half-written
  });
});
