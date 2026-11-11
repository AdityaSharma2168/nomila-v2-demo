/**
 * qa/vision — the geometry, and only the geometry.
 *
 * No model is called here. `askVision` is the network boundary and is exercised where it is used;
 * what these cover is the pair of conversions that fail SILENTLY, which is the reason this file
 * exists at all rather than trusting the calls to look right:
 *
 *   1. box_2d is [ymin, xmin, ymax, xmax] — Y FIRST. A transposed read lands the box rotated
 *      relative to the picture and nothing downstream can notice, because nothing downstream looks
 *      at the crop as an image. Every case below uses a NON-SQUARE box on a NON-SQUARE frame; a
 *      square fixture passes a transposed implementation happily, which is how the last one hid
 *      (see the same note in studio/autoMask.ts).
 *
 *   2. sharp's `.rotate()` is LAZY, so `.metadata()` after it reports STORED dimensions while the
 *      eventual buffer has ROTATED ones. Four of the nine calibration references are EXIF
 *      orientation 8. The first version of cropRect measured 6000 wide, extracted from a 4000-wide
 *      upright buffer, and threw. It threw only because the mismatch was large; on a squarer frame
 *      the same bug returns the wrong region of the right image, quietly.
 */
import sharp from "sharp";

import { boxToRect, cropRect, probeScale, upright } from "./vision";

/** A frame with a distinctly coloured patch, so a crop can be checked by what colour came back. */
async function frameWithPatch(
  width: number,
  height: number,
  patch: { left: number; top: number; width: number; height: number },
  orientation?: number,
): Promise<Buffer> {
  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 20, g: 20, b: 20 },
    },
  });
  const overlay = await sharp({
    create: {
      width: patch.width,
      height: patch.height,
      channels: 3,
      background: { r: 220, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer();
  let p = base.composite([
    { input: overlay, left: patch.left, top: patch.top },
  ]);
  if (orientation) p = p.withMetadata({ orientation });
  return p.jpeg().toBuffer();
}

/** Mean red channel — the patch is red on near-black, so this says "did we cut out the patch". */
async function meanRed(bytes: Buffer): Promise<number> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += info.channels) sum += data[i];
  return sum / (data.length / info.channels);
}

describe("boxToRect — Y IS FIRST", () => {
  it("reads [ymin, xmin, ymax, xmax], not [xmin, ymin, ...]", () => {
    // Deliberately non-square: y spans 100..300 (0.1..0.3), x spans 500..900 (0.5..0.9).
    const r = boxToRect([100, 500, 300, 900]);
    expect(r).toEqual({ left: 0.5, top: 0.1, width: 0.4, height: 0.2 });
    // A transposed implementation would return left 0.1 / top 0.5 / width 0.2 / height 0.4.
    expect(r!.left).not.toBeCloseTo(0.1);
    expect(r!.width).not.toBeCloseTo(0.2);
  });

  it("refuses a degenerate or inverted box rather than returning a negative size", () => {
    expect(boxToRect([300, 500, 100, 900])).toBeNull(); // ymax < ymin
    expect(boxToRect([100, 900, 300, 500])).toBeNull(); // xmax < xmin
    expect(boxToRect([100, 500, 100, 900])).toBeNull(); // zero height
  });

  it("refuses anything that is not four finite numbers", () => {
    expect(boxToRect(null)).toBeNull();
    expect(boxToRect([1, 2, 3])).toBeNull();
    expect(boxToRect([1, 2, 3, "4"])).toBeNull();
    expect(boxToRect([NaN, 0, 10, 10])).toBeNull();
  });

  it("clamps out-of-range coordinates into the 0-1000 space", () => {
    const r = boxToRect([-50, -50, 1200, 1200]);
    expect(r).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });
});

describe("upright — sharp's .rotate() is lazy", () => {
  it("reports the dimensions the returned buffer actually has, not the stored ones", async () => {
    // Orientation 8 means "stored landscape, displays portrait".
    const bytes = await frameWithPatch(
      600,
      400,
      { left: 0, top: 0, width: 60, height: 40 },
      8,
    );

    const stored = await sharp(bytes).metadata();
    expect([stored.width, stored.height]).toEqual([600, 400]);

    const up = await upright(bytes);
    expect([up.width, up.height]).toEqual([400, 600]);

    // And the reported numbers match the buffer that was handed back — the whole point.
    const actual = await sharp(up.bytes).metadata();
    expect([actual.width, actual.height]).toEqual([up.width, up.height]);
  });

  it("leaves an image with no orientation tag alone", async () => {
    const bytes = await frameWithPatch(600, 400, {
      left: 0,
      top: 0,
      width: 60,
      height: 40,
    });
    const up = await upright(bytes);
    expect([up.width, up.height]).toEqual([600, 400]);
  });
});

describe("cropRect", () => {
  it("cuts out the region the rect names", async () => {
    // Patch occupies the right half, vertically centred: x 300..600 of 600, y 100..300 of 400.
    const bytes = await frameWithPatch(600, 400, {
      left: 300,
      top: 100,
      width: 300,
      height: 200,
    });

    const onPatch = await cropRect(bytes, {
      left: 0.5,
      top: 0.25,
      width: 0.5,
      height: 0.5,
    });
    const offPatch = await cropRect(bytes, {
      left: 0.0,
      top: 0.25,
      width: 0.4,
      height: 0.5,
    });

    expect(await meanRed(onPatch)).toBeGreaterThan(180);
    expect(await meanRed(offPatch)).toBeLessThan(60);
  });

  it("extracts the right region from an EXIF-rotated frame — the bug that threw", async () => {
    // Stored 600x400 with orientation 8, so it DISPLAYS 400x600. The patch is placed in stored
    // space at the top-left; a 90° CCW display rotation puts it at the display's BOTTOM-left.
    const bytes = await frameWithPatch(
      600,
      400,
      { left: 400, top: 0, width: 200, height: 400 },
      8,
    );

    // Whole-image crop must succeed and be display-shaped. Before the fix this threw
    // `extract_area: bad extract area`, because the width was measured as 600 on a 400-wide buffer.
    const whole = await cropRect(bytes, {
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    });
    const m = await sharp(whole).metadata();
    expect([m.width, m.height]).toEqual([400, 600]);

    // Stored top-right (x 400..600, full height) becomes display TOP (y 0..0.33, full width).
    const top = await cropRect(bytes, {
      left: 0,
      top: 0,
      width: 1,
      height: 0.33,
    });
    const bottom = await cropRect(bytes, {
      left: 0,
      top: 0.67,
      width: 1,
      height: 0.33,
    });
    expect(await meanRed(top)).toBeGreaterThan(180);
    expect(await meanRed(bottom)).toBeLessThan(60);
  });

  it("clamps a rect that runs past the edge instead of throwing", async () => {
    const bytes = await frameWithPatch(600, 400, {
      left: 0,
      top: 0,
      width: 60,
      height: 40,
    });
    const out = await cropRect(bytes, {
      left: 0.9,
      top: 0.9,
      width: 0.5,
      height: 0.5,
    });
    const m = await sharp(out).metadata();
    expect(m.width!).toBeGreaterThan(0);
    expect(m.width!).toBeLessThanOrEqual(600);
    expect(m.height!).toBeLessThanOrEqual(400);
  });

  it("adds margin as a fraction of the box, not of the frame", async () => {
    const bytes = await frameWithPatch(600, 400, {
      left: 0,
      top: 0,
      width: 60,
      height: 40,
    });
    const tight = await cropRect(bytes, {
      left: 0.4,
      top: 0.4,
      width: 0.1,
      height: 0.1,
    });
    const loose = await cropRect(
      bytes,
      { left: 0.4, top: 0.4, width: 0.1, height: 0.1 },
      0.5,
    );
    const a = await sharp(tight).metadata();
    const b = await sharp(loose).metadata();
    // 0.1 of 600 = 60px; +50% each side => 120px.
    expect(a.width).toBe(60);
    expect(b.width).toBe(120);
  });
});

describe("probeScale", () => {
  it("returns upright dimensions for an EXIF-rotated frame", async () => {
    const bytes = await frameWithPatch(
      6000,
      4000,
      { left: 0, top: 0, width: 100, height: 100 },
      8,
    );
    const p = await probeScale(bytes, 1024);
    // Display is 4000x6000, so the LONG edge is the height and it is the one pinned to 1024.
    expect(p.height).toBe(1024);
    expect(p.width).toBe(683);
    const m = await sharp(p.bytes).metadata();
    expect([m.width, m.height]).toEqual([p.width, p.height]);
  });

  it("does not upscale a frame already under the probe size", async () => {
    const bytes = await frameWithPatch(500, 300, {
      left: 0,
      top: 0,
      width: 50,
      height: 30,
    });
    const p = await probeScale(bytes, 1024);
    expect([p.width, p.height]).toEqual([500, 300]);
  });
});
