/**
 * photoTreat — the face-aware crop never cuts her face, the output is never enlarged more than 1.5×, each treatment
 * renders at its slot's shape, cached paths are deterministic, and the cut-out needs a mask. Real sharp on synthetic
 * images; the bucket is mocked (no storage reads or writes).
 */
jest.mock("./mediaStore", () => ({ headObject: jest.fn(), readObject: jest.fn(), saveBuffer: jest.fn() }));

import sharp from "sharp";
import { headObject, readObject, saveBuffer } from "./mediaStore";
import { cropBoxFor, derivedBase, maskPath, outputSize, renderTreatment, treatedPath, SLOT_SIZES, MAX_UPSCALE } from "./photoTreat";

const img = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 140, b: 90 } } }).jpeg().toBuffer();

describe("cropBoxFor", () => {
  it("keeps her whole face inside the crop, with headroom, when her face is near the top of a wide photo", () => {
    const face = { x: 0.7, y: 0.02, w: 0.08, h: 0.1 };
    const box = cropBoxFor(4000, 3000, 1080, 1620, face);
    const fx0 = face.x * 4000, fx1 = (face.x + face.w) * 4000, fy0 = face.y * 3000, fy1 = (face.y + face.h) * 3000;
    expect(box.left).toBeLessThanOrEqual(fx0);
    expect(box.left + box.width).toBeGreaterThanOrEqual(fx1);
    expect(box.top).toBeLessThanOrEqual(fy0);
    expect(box.top + box.height).toBeGreaterThanOrEqual(fy1);
    expect(box.width / box.height).toBeCloseTo(1080 / 1620, 2);
  });

  it("places a face in the middle of a tall photo on the upper third", () => {
    const face = { x: 0.45, y: 0.45, w: 0.1, h: 0.06 };
    const box = cropBoxFor(2000, 6000, 1080, 1350, face);
    const faceCentreY = (face.y + face.h / 2) * 6000;
    expect((faceCentreY - box.top) / box.height).toBeCloseTo(1 / 3, 1);
  });

  it("without a face, crops centred and biased to the top, inside the image", () => {
    const box = cropBoxFor(3000, 4000, 1080, 1350);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(3000);
    expect(box.top + box.height).toBeLessThanOrEqual(4000);
  });
});

describe("outputSize", () => {
  it("never enlarges a small crop more than 1.5×", () => {
    const [w, h] = outputSize({ left: 0, top: 0, width: 400, height: 600 }, 1080, 1620);
    expect(w).toBe(Math.round(400 * MAX_UPSCALE));
    expect(h / w).toBeCloseTo(1620 / 1080, 2);
  });
  it("uses the full slot size for a big crop", () => {
    expect(outputSize({ left: 0, top: 0, width: 3000, height: 4500 }, 1080, 1620)).toEqual([1080, 1620]);
  });
});

describe("renderTreatment", () => {
  it("renders photo and tonal at their slot shapes, in both looks", async () => {
    const buf = await img(3000, 4000);
    for (const look of ["luxe", "campaign"] as const) {
      const p = await renderTreatment({ buf, shape: "gallery", treatment: "photo", look });
      expect([p.width, p.height]).toEqual([...SLOT_SIZES.gallery]);
      const t = await renderTreatment({ buf, shape: "statement", treatment: "tonal", look });
      expect([t.width, t.height]).toEqual([...SLOT_SIZES.statement]);
      expect((await sharp(t.buf).metadata()).format).toBe("jpeg");
    }
  });

  it("refuses a cut-out without a mask, and makes one with it", async () => {
    const buf = await img(1200, 1800);
    await expect(renderTreatment({ buf, shape: "cover", treatment: "cutout", look: "luxe" })).rejects.toThrow(/mask/);
    const mask = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .composite([{ input: { create: { width: 500, height: 1400, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: 350, top: 300 }]).png().toBuffer();
    const c = await renderTreatment({ buf, shape: "cover", treatment: "cutout", look: "luxe", mask });
    expect([c.width, c.height]).toEqual([...SLOT_SIZES.cover]);
  });
});

describe("treatedPath", () => {
  beforeEach(() => jest.resetAllMocks());

  it("is deterministic per source, shape, treatment and look", () => {
    expect(derivedBase("a/b/c.jpg", "cover", "photo", "luxe")).toBe(derivedBase("a/b/c.jpg", "cover", "photo", "luxe"));
    expect(derivedBase("a/b/c.jpg", "cover", "photo", "luxe")).not.toBe(derivedBase("a/b/c.jpg", "cover", "tonal", "luxe"));
    expect(derivedBase("a/b/c.jpg", "cover", "photo", "luxe")).toMatch(/^a\/b\/treated\//);
    expect(maskPath("a/b/c.jpg")).toMatch(/^a\/b\/masks\/.+\.png$/);
  });

  it("reuses a cached derivative without reading or writing anything", async () => {
    (headObject as jest.Mock).mockResolvedValue({ bytes: 10, contentType: "image/jpeg" });
    const p = await treatedPath("a/b/c.jpg", { shape: "gallery", treatment: "photo", look: "luxe" });
    expect(p).toMatch(/treated\/.+\.jpg$/);
    expect(readObject).not.toHaveBeenCalled();
    expect(saveBuffer).not.toHaveBeenCalled();
  });

  it("makes and stores it once when missing", async () => {
    (headObject as jest.Mock).mockResolvedValue(null);
    (readObject as jest.Mock).mockResolvedValue({ buf: await img(2000, 3000), contentType: "image/jpeg" });
    (saveBuffer as jest.Mock).mockImplementation(async (_b: Buffer, base: string) => ({ gcs_path: `${base}.jpg`, content_type: "image/jpeg", bytes: 1 }));
    const p = await treatedPath("a/b/c.jpg", { shape: "gallery", treatment: "photo", look: "luxe", face: { x: 0.4, y: 0.1, w: 0.2, h: 0.12 } });
    expect(saveBuffer).toHaveBeenCalledTimes(1);
    expect(p).toMatch(/treated\/.+\.jpg$/);
  });

  it("keeps the original when the source is missing, the cut-out has no mask, or rendering fails", async () => {
    (headObject as jest.Mock).mockResolvedValue(null);
    (readObject as jest.Mock).mockResolvedValueOnce(null);
    expect(await treatedPath("x.jpg", { shape: "cover", treatment: "photo", look: "luxe" })).toBe("x.jpg");
    (readObject as jest.Mock).mockResolvedValueOnce({ buf: await img(800, 1200), contentType: "image/jpeg" }).mockResolvedValueOnce(null);
    expect(await treatedPath("x.jpg", { shape: "cover", treatment: "cutout", look: "luxe" })).toBe("x.jpg");
    (readObject as jest.Mock).mockResolvedValueOnce({ buf: Buffer.from("not an image"), contentType: "image/jpeg" });
    expect(await treatedPath("x.jpg", { shape: "cover", treatment: "photo", look: "luxe" })).toBe("x.jpg");
  });
});
