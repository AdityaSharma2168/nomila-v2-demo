/**
 * PR 19's crop (S-7, ADI-R19-S): the planned window, and the cut — EXIF first, never upscaled, the format and the colour
 * profile kept, and exactly the planned window or nothing. $0: sharp on synthetic images, no model, no network.
 */
import sharp from "sharp";
import { assertIsWindow, CROP_JPEG_QUALITY, cutWindow } from "./adapters/local";
import { plannedCropWindow, ZOOM_KEEP } from "./crop";

const img = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  });

describe("the planned window", () => {
  it.each([
    ["4:5", 1200, 1800, { left: 0, top: 150, width: 1200, height: 1500 }],
    ["1:1", 1200, 1800, { left: 0, top: 300, width: 1200, height: 1200 }],
    ["9:16", 1200, 1800, { left: 94, top: 0, width: 1013, height: 1800 }],
    ["4:5", 1800, 1200, { left: 420, top: 0, width: 960, height: 1200 }],
  ])(
    "%s of a %dx%d photo is the largest centred window of that shape, never past its edges",
    (value, width, height, box) => {
      expect(plannedCropWindow({ width, height }, value)).toEqual({
        ...box,
        uprightWidth: width,
        uprightHeight: height,
      });
    },
  );
  it("zoom keeps the photo's own shape and ZOOM_KEEP of each side, centred", () => {
    expect(plannedCropWindow({ width: 1000, height: 1500 }, "zoom")).toEqual({
      left: 100,
      top: 150,
      width: 1000 * ZOOM_KEEP,
      height: 1500 * ZOOM_KEEP,
      uprightWidth: 1000,
      uprightHeight: 1500,
    });
  });
  it("plans nothing for a value a crop does not take, or an unmeasured photo", () => {
    expect(
      plannedCropWindow({ width: 1000, height: 1500 }, "21:9 wide"),
    ).toBeNull();
    expect(plannedCropWindow({ width: 0, height: 0 }, "4:5")).toBeNull();
  });
});

describe("the cut", () => {
  it("an EXIF-rotated portrait is cut upright, in its display coordinates (orientation applied first)", async () => {
    // Stored 1500x1000 landscape with orientation 6: it DISPLAYS as a 1000x1500 portrait. A marker in the stored
    // top-left corner lands at the display top-RIGHT once rotated 90° clockwise.
    const stored = await img(1500, 1000)
      .composite([
        { input: await img(100, 100).png().toBuffer(), left: 0, top: 0 },
      ])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const win = plannedCropWindow({ width: 1000, height: 1500 }, "1:1")!;
    expect(win).toMatchObject({
      width: 1000,
      height: 1000,
      top: 250,
      uprightWidth: 1000,
      uprightHeight: 1500,
    });
    const out = await cutWindow(stored, win);
    expect([out.width, out.height]).toEqual([1000, 1000]);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([
      1000, 1000, 1,
    ]);
  });

  it("never upscales: the output is the window at its own pixel size, inside the photo", async () => {
    const win = plannedCropWindow({ width: 1200, height: 1800 }, "9:16")!;
    const out = await cutWindow(await img(1200, 1800).jpeg().toBuffer(), win);
    expect([out.width, out.height]).toEqual([win.width, win.height]);
    expect(out.width).toBeLessThanOrEqual(1200);
    expect(out.height).toBeLessThanOrEqual(1800);
  });

  it("keeps the source's format: a PNG stays PNG, a JPEG stays JPEG at quality 90 or more", async () => {
    const win = plannedCropWindow({ width: 600, height: 900 }, "1:1")!;
    const png = await cutWindow(await img(600, 900).png().toBuffer(), win);
    expect(png.mimeType).toBe("image/png");
    expect((await sharp(png.bytes).metadata()).format).toBe("png");
    const jpeg = await cutWindow(await img(600, 900).jpeg().toBuffer(), win);
    expect(jpeg.mimeType).toBe("image/jpeg");
    expect((await sharp(jpeg.bytes).metadata()).format).toBe("jpeg");
    expect(CROP_JPEG_QUALITY).toBeGreaterThanOrEqual(90);
  });

  it("keeps the colour profile", async () => {
    const withP3 = await img(600, 900).jpeg().withIccProfile("p3").toBuffer();
    const inIcc = (await sharp(withP3).metadata()).icc;
    expect(inIcc).toBeDefined();
    const out = await cutWindow(
      withP3,
      plannedCropWindow({ width: 600, height: 900 }, "4:5")!,
    );
    expect((await sharp(out.bytes).metadata()).icc?.equals(inIcc!)).toBe(true);
  });

  it("refuses a photo that is not the size this crop was quoted for", async () => {
    const win = plannedCropWindow({ width: 1200, height: 1800 }, "4:5")!;
    await expect(
      cutWindow(await img(1000, 1800).jpeg().toBuffer(), win),
    ).rejects.toThrow(/quoted for/);
  });

  it("a crop that is not its planned window fails", () => {
    expect(() =>
      assertIsWindow(
        { width: 1200, height: 1499 },
        { width: 1200, height: 1500 },
      ),
    ).toThrow(/planned 1200x1500/);
    expect(() =>
      assertIsWindow(
        { width: 1200, height: 1500 },
        { width: 1200, height: 1500 },
      ),
    ).not.toThrow();
  });
});
