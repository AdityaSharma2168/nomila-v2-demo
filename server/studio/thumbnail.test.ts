/**
 * thumbnail.test.ts — the small copy that makes a generated frame embeddable.
 *
 * Real `sharp`, mocked GCS. The size claim is the reason this module exists, so it is measured on
 * actual encoded bytes here rather than asserted about a call argument: a test that only checked
 * "resize was called" would pass just as happily with a thumbnail still over the cap.
 */
jest.mock("../lib/mediaStore", () => ({
  saveBuffer: jest.fn(),
  readObject: jest.fn(),
}));

import sharp from "sharp";
import { writeGeneratedThumbnail, THUMB_LONG_EDGE_PX } from "./thumbnail";
import { saveBuffer, readObject } from "../lib/mediaStore";

const mockSave = saveBuffer as jest.MockedFunction<typeof saveBuffer>;
const mockRead = readObject as jest.MockedFunction<typeof readObject>;

/** Vertex's multimodal-embedding limit — the number this whole module is sized against. */
const BASE64_CAP = 27_000_000;

/** A real JPEG of the shape that broke: a 4000x6000 studio output. */
async function bigFrame(width = 4000, height = 6000): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } },
  })
    // Noise, so the encoder cannot collapse it to a few KB and flatter the size assertions.
    .composite([{ input: Buffer.from(Array.from({ length: 64 * 64 * 3 }, () => Math.floor(Math.random() * 256))), raw: { width: 64, height: 64, channels: 3 }, tile: true, blend: "over" }])
    .jpeg({ quality: 100 })
    .toBuffer();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockImplementation(async (buf: Buffer, base: string) => ({
    gcs_path: `${base}.jpg`, content_type: "image/jpeg", bytes: buf.byteLength,
  }));
});

describe("writeGeneratedThumbnail", () => {
  it("writes beside the asset, with the suffix on the base and the extension from the type", async () => {
    const path = await writeGeneratedThumbnail("athletes/a/studio/job/0.png", { bytes: await bigFrame(400, 600) });
    expect(path).toBe("athletes/a/studio/job/0.thumb.jpg");
  });

  it("brings a frame that could NEVER embed comfortably under the cap", async () => {
    // The measured failure: 24.6MB of JPEG is ~32.8M base64 characters against a 27M limit.
    const source = await bigFrame();
    const sourceB64 = Math.ceil((source.byteLength * 4) / 3);

    await writeGeneratedThumbnail("athletes/a/studio/job/0.jpg", { bytes: source });

    const written = mockSave.mock.calls[0][0] as Buffer;
    const thumbB64 = Math.ceil((written.byteLength * 4) / 3);
    expect(thumbB64).toBeLessThan(BASE64_CAP);
    // An order of magnitude of headroom, not a hair — the next model output will be bigger.
    expect(thumbB64).toBeLessThan(BASE64_CAP / 10);
    expect(written.byteLength).toBeLessThan(source.byteLength);
    expect(sourceB64).toBeGreaterThan(0);
  });

  it("caps the long edge and keeps the aspect ratio", async () => {
    await writeGeneratedThumbnail("a/0.jpg", { bytes: await bigFrame(4000, 6000) });
    const meta = await sharp(mockSave.mock.calls[0][0] as Buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(THUMB_LONG_EDGE_PX);
    expect(meta.width! / meta.height!).toBeCloseTo(4000 / 6000, 2);
  });

  it("does not ENLARGE an asset that is already small", async () => {
    // A 1008x1476 output is a real studio size. Upscaling it would cost bytes and add nothing.
    await writeGeneratedThumbnail("a/0.jpg", { bytes: await bigFrame(300, 400) });
    const meta = await sharp(mockSave.mock.calls[0][0] as Buffer).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(400);
  });

  it("reads the object back when the caller has no bytes in hand", async () => {
    mockRead.mockResolvedValue({ buf: await bigFrame(400, 600), contentType: "image/jpeg" });
    const path = await writeGeneratedThumbnail("athletes/a/studio/job/0.png");
    expect(mockRead).toHaveBeenCalledWith("athletes/a/studio/job/0.png");
    expect(path).toBe("athletes/a/studio/job/0.thumb.jpg");
  });
});

describe("it never costs the caller the asset they just paid for", () => {
  it("returns null instead of throwing when the bytes are not an image", async () => {
    const path = await writeGeneratedThumbnail("a/0.png", { bytes: Buffer.from("not an image") });
    expect(path).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns null when the object cannot be read", async () => {
    mockRead.mockResolvedValue(null);
    expect(await writeGeneratedThumbnail("a/missing.png")).toBeNull();
  });

  it("returns null when the store refuses the write", async () => {
    mockSave.mockResolvedValue({ skipped: "size" });
    expect(await writeGeneratedThumbnail("a/0.jpg", { bytes: await bigFrame(400, 600) })).toBeNull();
  });

  it("returns null when the store throws", async () => {
    mockSave.mockRejectedValue(new Error("GCS unavailable"));
    expect(await writeGeneratedThumbnail("a/0.jpg", { bytes: await bigFrame(400, 600) })).toBeNull();
  });

  it("skips VIDEO entirely — a video's thumb is a POSTER and videoPoster.ts owns it", async () => {
    const path = await writeGeneratedThumbnail("a/0.mp4", { bytes: await bigFrame(400, 600), mediaType: "VIDEO" });
    expect(path).toBeNull();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
