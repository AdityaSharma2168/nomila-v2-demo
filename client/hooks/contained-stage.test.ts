/**
 * The letterbox maths, which is the part that was wrong.
 *
 * Pure functions only — jest.config.cjs runs client suites with no renderer, so the hook itself is
 * out of reach here. That is the reason the arithmetic was extracted OUT of the hook rather than
 * left inside it: the thing that broke is testable and now tested, and what remains untested is
 * three lines of React state.
 */
import {
  containedRect,
  regionToPixels,
  stageHeightFor,
  STAGE_FALLBACK_H,
  STAGE_MIN_H,
  STAGE_MAX_ABS_H,
} from "./contained-stage";

describe("containedRect — where the photo actually lands", () => {
  it("pillarboxes a portrait photo in a square stage", () => {
    // The real case: a 1008x1476 frame (ratio 0.683) in a square 400x400 stage.
    const r = containedRect({ w: 400, h: 400 }, 1008 / 1476)!;
    expect(r.h).toBe(400);
    expect(r.w).toBeCloseTo(400 * (1008 / 1476), 4);
    expect(r.x).toBeCloseTo((400 - r.w) / 2, 4);
    expect(r.y).toBe(0);
  });

  it("letterboxes a landscape photo in a square stage", () => {
    const r = containedRect({ w: 400, h: 400 }, 16 / 9)!;
    expect(r.w).toBe(400);
    expect(r.h).toBeCloseTo(400 / (16 / 9), 4);
    expect(r.y).toBeCloseTo((400 - r.h) / 2, 4);
    expect(r.x).toBe(0);
  });

  it("fills exactly when the stage already has the photo's shape", () => {
    // What the stage is sized to do. Nothing is left for `contain` to letterbox.
    const r = containedRect({ w: 300, h: 450 }, 300 / 450)!;
    expect(r).toEqual({ x: 0, y: 0, w: 300, h: 450 });
  });

  it("takes the container's own shape when the ratio is not known yet", () => {
    expect(containedRect({ w: 300, h: 450 }, null)).toEqual({ x: 0, y: 0, w: 300, h: 450 });
  });

  it("is null before the container has been measured", () => {
    expect(containedRect(null, 1)).toBeNull();
  });
});

// ─── THE BUG, AS ARITHMETIC ────────────────────────────────────────────────────────────────────

describe("regionToPixels — the container is not the photo", () => {
  const STAGE = { w: 400, h: 400 };
  const RATIO = 1008 / 1476; // the real frame
  const drawn = containedRect(STAGE, RATIO)!;

  /** What the preview used to do: fractions read as percentages of the CONTAINER. */
  const asPercentOfStage = (r: { left: number; width: number }) => ({
    left: r.left * STAGE.w,
    width: r.width * STAGE.w,
  });

  // The two sock boxes from the live detection, as fractions of a 1008px-wide frame.
  const SOCK_A = { left: 344 / 1008, top: 1092 / 1476, width: 106 / 1008, height: 297 / 1476 };
  const SOCK_B = { left: 465 / 1008, top: 1072 / 1476, width: 120 / 1008, height: 239 / 1476 };

  it("draws a box 1.46x too wide when fractions are read against the container", () => {
    const wrong = asPercentOfStage(SOCK_A);
    const right = regionToPixels(SOCK_A, drawn);
    expect(wrong.width / right.width).toBeCloseTo(1 / RATIO, 3);
  });

  it("displaces a box further the further right it sits — so a pair drifts apart", () => {
    // Both boxes land LEFT of where they belong, and the left one by more. That asymmetry is why it
    // read as the boxes separating rather than as the whole overlay sliding.
    const errA = asPercentOfStage(SOCK_A).left - regionToPixels(SOCK_A, drawn).left;
    const errB = asPercentOfStage(SOCK_B).left - regionToPixels(SOCK_B, drawn).left;
    expect(errA).toBeLessThan(0);
    expect(errB).toBeLessThan(0);
    expect(Math.abs(errA)).toBeGreaterThan(Math.abs(errB));
  });

  it("opens a gap between the boxes that is wider than the true one — the stranded sock", () => {
    const wrongGap = asPercentOfStage(SOCK_B).left - (asPercentOfStage(SOCK_A).left + asPercentOfStage(SOCK_A).width);
    const rightGap = regionToPixels(SOCK_B, drawn).left - (regionToPixels(SOCK_A, drawn).left + regionToPixels(SOCK_A, drawn).width);
    expect(wrongGap).toBeGreaterThan(rightGap);
    // The sock that fell into it: the strip between where A's right edge was drawn and where it belongs.
    expect(rightGap).toBeGreaterThan(0);
  });

  it("puts a full-frame region exactly on the photo, bars excluded", () => {
    const full = regionToPixels({ left: 0, top: 0, width: 1, height: 1 }, drawn);
    expect(full).toEqual({ left: drawn.x, top: drawn.y, width: drawn.w, height: drawn.h });
  });
});

describe("stageHeightFor", () => {
  it("gives the stage the photo's own shape when it fits inside the bounds", () => {
    expect(stageHeightFor(300, 300 / 450, 2000)).toBeCloseTo(450, 4);
  });

  it("falls back to a neutral height before the ratio is known", () => {
    expect(stageHeightFor(300, null, 2000)).toBe(STAGE_FALLBACK_H);
    expect(stageHeightFor(null, 1, 2000)).toBe(STAGE_FALLBACK_H);
  });

  it("clamps a tall portrait rather than letting it run off the screen", () => {
    // A 9:16 story at 400px wide wants 711px. Both ceilings are lower.
    expect(stageHeightFor(400, 9 / 16, 2000)).toBe(STAGE_MAX_ABS_H);
  });

  it("uses the window fraction when the window is the tighter of the two ceilings", () => {
    expect(stageHeightFor(400, 9 / 16, 600)).toBeCloseTo(600 * 0.55, 4);
  });

  it("never returns less than the floor, however wide the panorama", () => {
    expect(stageHeightFor(400, 8, 2000)).toBe(STAGE_MIN_H);
  });
});
