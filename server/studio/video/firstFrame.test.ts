/**
 * firstFrame.test.ts — the frame a clip starts from is the shape the clip will be.
 *
 * Real pixels through real sharp: the claim is about dimensions that LEAVE, and a mocked sharp
 * would be asserting the mock.
 */
import sharp from "sharp";
import type { ImageRef } from "../types";
import {
  cropToAspect,
  frameForClip,
  parseAspect,
  windowFor,
} from "./firstFrame";

const solid = (
  width: number,
  height: number,
  format: "jpeg" | "png" = "jpeg",
) =>
  sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 60 } },
  })
    [format]()
    .toBuffer();

const dims = async (bytes: Buffer) => {
  const m = await sharp(bytes).metadata();
  return { width: m.width!, height: m.height! };
};

describe("parseAspect", () => {
  it("reads the planner's ratios and refuses anything else", () => {
    expect(parseAspect("9:16")).toBeCloseTo(0.5625);
    expect(parseAspect("1:1")).toBe(1);
    for (const bad of [undefined, "", "portrait", "9x16", "0:16", "9:0"])
      expect(parseAspect(bad)).toBeNull();
  });
});

describe("windowFor", () => {
  const face = { x: 0.7, y: 0.1, width: 0.1, height: 0.1 };

  it("a 2:3 portrait keeps its full height and gives up width only", () => {
    expect(windowFor(2000, 3000, 9 / 16, face)).toMatchObject({
      top: 0,
      width: 1688,
      height: 3000,
    });
  });

  // MUTATION: centre the window on the image instead of on the focus. This reds.
  it("a landscape frame follows the focus rather than the centre", () => {
    const box = windowFor(3000, 2000, 9 / 16, face);
    expect(box.width).toBe(1125);
    // Her face is centred at x=2250 and the window is 1125 wide, so it starts at 2250 - 562.5,
    // rounded. Centred on the IMAGE it would start at 938.
    expect(box.left).toBe(1688);
  });

  it("never leaves the image, however far off-centre the focus is", () => {
    const edge = { x: 0.97, y: 0.97, width: 0.03, height: 0.03 };
    const box = windowFor(3000, 2000, 9 / 16, edge);
    expect(box.left + box.width).toBeLessThanOrEqual(3000);
    expect(box.top + box.height).toBeLessThanOrEqual(2000);
  });
});

describe("cropToAspect", () => {
  // MUTATION: return the upright bytes without cropping. This reds.
  it("cuts a 2:3 photograph to 9:16 — a window of it, never enlarged or padded", async () => {
    const out = await cropToAspect(await solid(800, 1200), "9:16");
    expect(out?.cropped).toBe(true);
    expect({ width: out!.width, height: out!.height }).toEqual({
      width: 675,
      height: 1200,
    });
    expect(await dims(out!.bytes)).toEqual({ width: 675, height: 1200 });
  });

  it("cuts a landscape photograph to 9:16 on its height", async () => {
    const out = await cropToAspect(await solid(1200, 800), "9:16");
    expect(await dims(out!.bytes)).toEqual({ width: 450, height: 800 });
  });

  it("honours a focus box when it is handed one", async () => {
    const out = await cropToAspect(await solid(1200, 800), "9:16", {
      x: 0.9,
      y: 0.4,
      width: 0.05,
      height: 0.05,
    });
    expect(await dims(out!.bytes)).toEqual({ width: 450, height: 800 });
  });

  it("leaves a frame that is already the clip's shape alone", async () => {
    const out = await cropToAspect(await solid(720, 1280), "9:16");
    expect(out?.cropped).toBe(false);
  });

  // MUTATION: drop `.rotate()`. This reds — a flagged portrait is measured on its side and cut
  // along the wrong axis, the `personReference` defect again.
  it("stands a flagged portrait upright BEFORE measuring it", async () => {
    const sideways = await sharp(await solid(1200, 800))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    // Stored 1200x800, flagged: upright it is 800x1200, and 9:16 of THAT is 675x1200.
    const out = await cropToAspect(sideways, "9:16");
    expect(await dims(out!.bytes)).toEqual({ width: 675, height: 1200 });
  });

  it("keeps a PNG a PNG, and answers null for an aspect it cannot read", async () => {
    const out = await cropToAspect(await solid(800, 1200, "png"), "9:16");
    expect(out?.mimeType).toBe("image/png");
    expect(await cropToAspect(await solid(800, 1200), undefined)).toBeNull();
  });
});

describe("frameForClip", () => {
  const bytesRef = async (w: number, h: number, over: Partial<ImageRef> = {}) =>
    ({
      kind: "bytes",
      bytes: await solid(w, h),
      mimeType: "image/jpeg",
      ...over,
    }) as ImageRef;

  // MUTATION: crop every reference, or crop references[last]. Both red.
  it("crops the frame the ADAPTER will send, and nothing else", async () => {
    const second = await bytesRef(800, 1200);
    const { references, note } = await frameForClip(
      [await bytesRef(800, 1200), second],
      "9:16",
    );
    expect(note).toEqual({ outcome: "cropped", width: 675, height: 1200 });
    expect(await dims((references[0] as { bytes: Buffer }).bytes)).toEqual({
      width: 675,
      height: 1200,
    });
    expect(references[1]).toBe(second);
  });

  // MUTATION: pick `references[0]` instead of asking `orderBySlot`. This reds.
  it("picks by slot, the way the adapters do — a typed frame beats array position", async () => {
    const mood = await bytesRef(800, 1200, { slot: "style" });
    const frame = await bytesRef(800, 1200, { slot: "frame" });
    const { references } = await frameForClip([mood, frame], "9:16");
    expect(references[0]).toBe(mood);
    expect(await dims((references[1] as { bytes: Buffer }).bytes)).toEqual({
      width: 675,
      height: 1200,
    });
    expect(references[1].slot).toBe("frame");
  });

  it("says why when it does nothing, and changes nothing", async () => {
    const url: ImageRef = { kind: "url", url: "https://signed/x" };
    expect((await frameForClip([], "9:16")).note.outcome).toBe("no-frame");
    expect((await frameForClip([url], "9:16")).note.outcome).toBe("not-bytes");
    expect((await frameForClip([url], "9:16")).references).toEqual([url]);
    expect(
      (await frameForClip([await bytesRef(800, 1200)], undefined)).note.outcome,
    ).toBe("no-aspect");
    expect(
      (await frameForClip([await bytesRef(720, 1280)], "9:16")).note.outcome,
    ).toBe("already-shaped");
  });

  it("never mutates the array it was given", async () => {
    const given = [await bytesRef(800, 1200)];
    const before = given[0];
    await frameForClip(given, "9:16");
    expect(given[0]).toBe(before);
  });
});
