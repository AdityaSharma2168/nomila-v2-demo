/**
 * captionRender.safe.test.ts — Reels' safe zones for a caption (quality-scrappy piece 6, ADI-QS-GO R4): where the band
 * moves on a portrait frame, that it never moves on any other, that the words stay out of the right-hand rail — and
 * that without STUDIO_FINISHING (opt-in: the master never reaches it) nothing moves at all.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M6f — the bottom limit at 35 % instead of R4's 25 %: "Bottom lands with its lower edge at y 1440" reds.
 *   M6g — the right padding not applied: "the words stay out of the right 120 px" reds.
 */
import sharp from "sharp";
import {
  REELS_SAFE_ZONE,
  captionBandGeometry,
  renderCaptionBand,
} from "./captionRender";
import type { Caption } from "./captions";

jest.setTimeout(60_000);
const PORTRAIT = { width: 1080, height: 1920 };

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { F: process.env.STUDIO_FINISHING, M: process.env.STUDIO_ALL_ON };
  delete process.env.STUDIO_FINISHING;
  delete process.env.STUDIO_ALL_ON;
});
afterEach(() => {
  for (const [k, env] of [
    ["F", "STUDIO_FINISHING"],
    ["M", "STUDIO_ALL_ON"],
  ] as const)
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
});

describe("the geometry, portrait 1080x1920", () => {
  it("R4's zone: top 250 px, right 120 px, bottom 25 % — recorded as a compromise", () => {
    expect(REELS_SAFE_ZONE).toMatchObject({
      topPx: 250,
      rightPx: 120,
      bottomShare: 0.25,
    });
  });

  it("Bottom lands with its lower edge at y 1440 — moved up from 1446 (P6c′)", () => {
    const g = captionBandGeometry(PORTRAIT, "bottom", { safe: true });
    expect({
      y: g.y,
      bottom: g.y + g.height,
      movedFromY: g.movedFromY,
    }).toEqual({ y: 1184, bottom: 1440, movedFromY: 1446 });
  });

  it("Top moves down 110 px to clear the header", () => {
    const g = captionBandGeometry(PORTRAIT, "top", { safe: true });
    expect({ y: g.y, movedFromY: g.movedFromY }).toEqual({
      y: 250,
      movedFromY: 140,
    });
  });

  it("Middle never moves", () => {
    const g = captionBandGeometry(PORTRAIT, "middle", { safe: true });
    expect(g.y).toBe(captionBandGeometry(PORTRAIT, "middle").y);
    expect("movedFromY" in g).toBe(false);
  });

  it("the right-hand padding clears the rail; the left is untouched", () => {
    const g = captionBandGeometry(PORTRAIT, "middle", { safe: true });
    expect({ padX: g.padX, padRight: g.padRight }).toEqual({
      padX: 76,
      padRight: 120,
    });
  });

  it("square and landscape frames are never moved, and safe off is the geometry it always was", () => {
    for (const frame of [
      { width: 1080, height: 1080 },
      { width: 1920, height: 1080 },
    ])
      for (const pos of ["top", "middle", "bottom"] as const)
        expect(captionBandGeometry(frame, pos, { safe: true })).toEqual(
          captionBandGeometry(frame, pos),
        );
    expect(Object.keys(captionBandGeometry(PORTRAIT, "bottom")).sort()).toEqual(
      ["fontPx", "height", "padX", "width", "y"],
    );
  });
});

describe("the drawn band", () => {
  /** A caption long enough to wrap to two full lines. */
  const long: Caption = {
    text: "Every sprint at the end of practice is the one that counts most",
    position: "bottom",
    style: "clean",
  };
  /** The right-most column holding ink, in frame pixels. */
  async function rightmostInk(png: Buffer): Promise<number> {
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .extractChannel("alpha")
      .raw()
      .toBuffer({ resolveWithObject: true });
    let right = -1;
    for (let x = 0; x < info.width; x++)
      for (let y = 0; y < info.height; y++)
        if (data[y * info.width + x] > 0) {
          right = Math.max(right, x);
          break;
        }
    return right;
  }

  it("flag off: the band sits where it always did — and a long caption does run into the rail (P6c′)", async () => {
    const band = await renderCaptionBand(long, PORTRAIT);
    expect(band.y).toBe(1446);
    // Recorded, not asserted either way: whether an unfinished long caption crosses x 960 is the prediction's.
    (globalThis as { __rightOff?: number }).__rightOff = await rightmostInk(
      band.png,
    );
  });

  it("the master does not turn the zones on (opt-in)", async () => {
    process.env.STUDIO_ALL_ON = "true";
    expect((await renderCaptionBand(long, PORTRAIT)).y).toBe(1446);
  });

  it("under STUDIO_FINISHING: Bottom is moved into the zone, and the words stay out of the right 120 px", async () => {
    process.env.STUDIO_FINISHING = "true";
    const band = await renderCaptionBand(long, PORTRAIT);
    expect(band.y).toBe(1184);
    expect(await rightmostInk(band.png)).toBeLessThan(PORTRAIT.width - 120);
  });
});
