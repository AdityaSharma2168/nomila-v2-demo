/**
 * orientation.test — the display→draw→map→brief path, on a genuinely EXIF-ROTATED frame.
 *
 * WHY THIS SUITE IS SEPARATE FROM geometry.test AND imageSize.test. Each of those covers one half
 * and neither covers the seam:
 *
 *   - geometry.test transposes DIMENSIONS by hand (`PORTRAIT` / `LANDSCAPE` as bare numbers). It
 *     proves the arithmetic, but it never sees an orientation flag, so it cannot notice if the
 *     dimensions it is handed came out of the wrong space.
 *   - imageSize.test parses a real orientation flag, but stops at the dimensions and never maps a
 *     box through them.
 *
 * A photo can therefore be transposed correctly AND mapped incorrectly with both suites green.
 * This one runs a real orientation-6 JPEG header the whole way — parse, draw, map, prompt — and
 * asserts every step lands in the SAME pixel space.
 *
 * ─── THE TWO SPACES, AND WHICH ONE IS RIGHT ─────────────────────────────────────────────────────
 *
 * A phone portrait is routinely a LANDSCAPE buffer carrying orientation 6:
 *
 *   STORED  4032x3024 — the pixels in the file, lying on their side
 *   DISPLAY 3024x4032 — the picture upright, as every renderer shows it and as she draws on it
 *
 * DISPLAY is the space the whole path must use, and it is not a coin flip. The mask reaches the
 * model as LANGUAGE — buildPrompt writes "The frame is WxH pixels" and "at x,y" — so the numbers
 * are only interpretable against the picture the model can see, which is the upright one. A
 * coordinate in STORED space would be 90 degrees off the image it is describing.
 *
 * Each mapping assertion below therefore states BOTH: the display-space box it must equal, and the
 * stored-space box it must not — because "wrong space" is the failure that looks like success.
 */
import type { CreativeBrief } from "./brief";
import type { GenerationPlan } from "./types";

jest.mock("../db", () => ({ db: {}, pool: { end: async () => {}, on: () => {} } }));

const estimateMock = jest.fn();
jest.mock("./router", () => ({
  estimate: (...a: unknown[]) => estimateMock(...a),
  generate: jest.fn(),
}));

import { parseImageSize } from "./imageSize";
import { mapRegions } from "./geometry";
import { buildPrompt } from "./preview";

// ─── A real JPEG header, built from the spec. No athlete's photo, no bytes from GCS. ────────────

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function sofPayload(width: number, height: number): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(8, 0);
  b.writeUInt16BE(height, 1);
  b.writeUInt16BE(width, 3);
  b.writeUInt8(3, 5);
  return b;
}

/** APP1/Exif with one IFD0 entry: Orientation. The actual flag, not a dimension swap. */
function exifPayload(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  return Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
}

function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation) parts.push(jpegSegment(0xe1, exifPayload(orientation)));
  parts.push(jpegSegment(0xc0, sofPayload(width, height)));
  parts.push(Buffer.from([0xff, 0xda]));
  return Buffer.concat(parts);
}

// ─── The two files under test ───────────────────────────────────────────────────────────────────

const STORED = { width: 4032, height: 3024 };
const DISPLAY = { width: 3024, height: 4032 };

/** Landscape pixels in the file, orientation 6, so it DISPLAYS as an upright portrait. */
const rotatedFile = () => jpeg(STORED.width, STORED.height, 6);
/** The same picture already upright in the buffer, no EXIF. The control. */
const uprightFile = () => jpeg(DISPLAY.width, DISPLAY.height);

/**
 * What she drew: a box on her arm, in the upper-left of the UPRIGHT photo she is looking at.
 * Fractions, because that is the wire format — see the geometry.ts header.
 */
const ARM = { label: "her arm", left: 0.1, top: 0.15, width: 0.2, height: 0.12 };

/** Where that box belongs, in DISPLAY pixels. Both files must produce exactly this. */
const ARM_IN_DISPLAY_SPACE = {
  label: "her arm",
  left: Math.round(0.1 * DISPLAY.width), // 302
  top: Math.round(0.15 * DISPLAY.height), // 605
  width: Math.round(0.3 * DISPLAY.width) - Math.round(0.1 * DISPLAY.width), // 605
  height: Math.round(0.27 * DISPLAY.height) - Math.round(0.15 * DISPLAY.height), // 484
};

/** The same fractions against the STORED buffer — the wrong answer, named so it can be excluded. */
const ARM_IN_STORED_SPACE = {
  label: "her arm",
  left: Math.round(0.1 * STORED.width), // 403
  top: Math.round(0.15 * STORED.height), // 454
  width: Math.round(0.3 * STORED.width) - Math.round(0.1 * STORED.width),
  height: Math.round(0.27 * STORED.height) - Math.round(0.15 * STORED.height),
};

const mapOnto = (buf: Buffer) => {
  const frame = parseImageSize(buf);
  expect(frame).not.toBeNull();
  const mapped = mapRegions([ARM], frame!);
  if ("message" in mapped) throw new Error(`unexpected refusal: ${mapped.message}`);
  return { frame: frame!, regions: mapped.regions };
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("a rotated frame and an upright one are the same picture, and map identically", () => {
  it("the orientation-6 file reports DISPLAY dimensions, and says so was rotated", () => {
    const size = parseImageSize(rotatedFile())!;
    expect({ width: size.width, height: size.height }).toEqual(DISPLAY);
    expect(size.orientation).toBe(6);
    expect(size.stored).toEqual(STORED);
  });

  it("the upright control reports the same DISPLAY dimensions, unrotated", () => {
    const size = parseImageSize(uprightFile())!;
    expect({ width: size.width, height: size.height }).toEqual(DISPLAY);
    expect(size.orientation).toBe(1);
    expect(size.stored).toEqual(DISPLAY);
  });

  it("a box drawn at a display position maps to that position on the ROTATED file", () => {
    expect(mapOnto(rotatedFile()).regions[0]).toEqual(ARM_IN_DISPLAY_SPACE);
  });

  it("and to the identical pixels on the upright file — orientation changes nothing downstream", () => {
    expect(mapOnto(uprightFile()).regions[0]).toEqual(ARM_IN_DISPLAY_SPACE);
    expect(mapOnto(rotatedFile()).regions[0]).toEqual(
      mapOnto(uprightFile()).regions[0],
    );
  });

  it("does NOT map into the stored buffer's space — the failure that looks like success", () => {
    // If the mapping ever multiplied by `stored`, this is the box it would produce: a plausible
    // rectangle, inside the frame, on the wrong part of the photo. Nothing downstream could tell.
    expect(mapOnto(rotatedFile()).regions[0]).not.toEqual(ARM_IN_STORED_SPACE);
    expect(ARM_IN_STORED_SPACE).not.toEqual(ARM_IN_DISPLAY_SPACE); // the two really do differ
  });

  it("a box in the bottom-right of the display stays in the bottom-right", () => {
    // Corner-anchored, because a transposed mapping keeps a centred box centred and hides itself.
    const frame = parseImageSize(rotatedFile())!;
    const mapped = mapRegions(
      [{ label: "the logo", left: 0.8, top: 0.85, width: 0.15, height: 0.1 }],
      frame,
    );
    if ("message" in mapped) throw new Error(mapped.message);
    const r = mapped.regions[0];
    expect(r.left).toBeGreaterThan(frame.width * 0.5); // right half of the DISPLAY
    expect(r.top).toBeGreaterThan(frame.height * 0.5); // bottom half of the DISPLAY
    expect(r.left + r.width).toBeLessThanOrEqual(frame.width);
    expect(r.top + r.height).toBeLessThanOrEqual(frame.height);
  });
});

describe("the brief and the prompt state the SAME space the box was mapped in", () => {
  const PLAN: GenerationPlan = {
    task: "image.edit",
    provider: "vertex",
    model: "gemini-3-pro-image",
    inputs: { prompt: "p", references: 1, n: 1 },
    cost: { amountUsd: 0.13, currency: "USD", basis: "estimated", detail: "1 image" },
  };

  beforeEach(() => {
    estimateMock.mockReset();
    estimateMock.mockReturnValue(PLAN);
  });

  /** A brief frozen exactly as routes/studio.ts resolveSource would freeze it for this file. */
  function briefForRotatedFile(): CreativeBrief {
    const { frame, regions } = mapOnto(rotatedFile());
    return {
      briefId: "brief-1",
      createdAt: "2026-09-03T00:00:00.000Z",
      job: {
        origin: "system",
        objective: "grow-following",
        deliverable: "post",
        mode: "edit",
        source: {
          mediaAssetId: "asset-1",
          ref: "athletes/synthetic/frame-rot6.jpg",
          // The MEASURED display dimensions, which is what resolveSource writes.
          width: frame.width,
          height: frame.height,
          editRegions: regions,
        },
        direction: {
          set: "chosen",
          statement: "Take the competitor logo off her sleeve.",
          untrusted: false,
          featuredPieces: [],
        },
      },
      athlete: {
        athleteId: "athlete-1",
        identity: {
          name: "Test Spike Athlete", firstName: "Test",
          identityLine: "Soccer · Example · National Team", sport: "soccer",
          org: "Example", division: "D1", conference: "Example Conference",
          segment: "college", tier: "Established", marqueeTag: "National Team",
        },
        voice: { storyArc: "", highlights: [] },
        audience: { descriptor: "women 18-24 · top market US", ageRange: "18-24", topCity: "Exampleton", topMarket: "US", share: 66 },
        aesthetic: { register: "Established · college · soccer", notes: [] },
        goal: "Grow her audience",
        commercialState: "undisclosed",
      },
      brand: null,
      gaps: [],
    } as unknown as CreativeBrief;
  }

  it("freezes the DISPLAY dimensions into the brief, not the buffer's", () => {
    const source = briefForRotatedFile().job.source!;
    expect({ width: source.width, height: source.height }).toEqual(DISPLAY);
    expect({ width: source.width, height: source.height }).not.toEqual(STORED);
  });

  it("freezes the box in that same display space", () => {
    expect(briefForRotatedFile().job.source!.editRegions[0]).toEqual(ARM_IN_DISPLAY_SPACE);
  });

  it("the prompt states the frame and the coordinates in ONE space — the model gets no contradiction", () => {
    const prompt = buildPrompt(briefForRotatedFile());
    // The stated frame is the DISPLAY frame …
    expect(prompt).toContain(`The frame is ${DISPLAY.width}x${DISPLAY.height} pixels`);
    // … and the coordinates are display-space coordinates inside it.
    expect(prompt).toContain(
      `her arm (at ${ARM_IN_DISPLAY_SPACE.left},${ARM_IN_DISPLAY_SPACE.top}, ` +
        `${ARM_IN_DISPLAY_SPACE.width}x${ARM_IN_DISPLAY_SPACE.height})`,
    );
    // The buffer's own dimensions must appear nowhere — stating them would be the contradiction.
    expect(prompt).not.toContain(`${STORED.width}x${STORED.height}`);
  });
});
