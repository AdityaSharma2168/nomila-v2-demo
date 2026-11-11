/**
 * videoCost.test.ts — the run budget: estimate banked before the call, settled to what was
 * reported, and the named refusal when the next clip would not fit.
 */
import {
  RunBudget,
  VideoEnrichCapExceeded,
  estimateVideoTokens,
  usdOf,
} from "./videoCost";
import {
  VIDEO_ASSUMED_SECONDS,
  VIDEO_TOKENS_PER_SECOND,
  VIDEO_PROMPT_TOKENS,
} from "./config";

describe("estimateVideoTokens", () => {
  it("scales with duration at the documented tokens-per-second, plus the prompt", () => {
    const e = estimateVideoTokens(10);
    expect(e.inputTokens).toBe(
      10 * VIDEO_TOKENS_PER_SECOND + VIDEO_PROMPT_TOKENS,
    );
  });
  it("an unknown or zero duration is estimated as the assumed length, never as free", () => {
    expect(estimateVideoTokens(null)).toEqual(
      estimateVideoTokens(VIDEO_ASSUMED_SECONDS),
    );
    expect(estimateVideoTokens(0)).toEqual(
      estimateVideoTokens(VIDEO_ASSUMED_SECONDS),
    );
  });
  it("the measured library (437 s over 67 clips) estimates under a dollar on Flash", () => {
    // The cost table in the C2 report: 67 clips averaging 6.7 s. Pins the arithmetic the cap defaults were chosen against.
    const perClip = usdOf(estimateVideoTokens(6.7));
    expect(perClip * 67).toBeGreaterThan(0.3);
    expect(perClip * 67).toBeLessThan(1);
  });
});

describe("RunBudget", () => {
  it("banks the estimate on reserve, then settles to reported usage", () => {
    const b = new RunBudget(1);
    const r = b.reserve(6);
    expect(b.spentUsd).toBeCloseTo(r, 10);
    b.settle(r, { inputTokens: 1000, outputTokens: 100 });
    expect(b.spentUsd).toBeCloseTo(
      usdOf({ inputTokens: 1000, outputTokens: 100 }),
      10,
    );
    expect(b.calls).toBe(1);
  });

  it("a call that reported nothing keeps its estimate; a call that never happened gives it back", () => {
    const b = new RunBudget(1);
    const r = b.reserve(6);
    b.settle(r, null);
    expect(b.spentUsd).toBeCloseTo(r, 10);
    const r2 = b.reserve(6);
    b.release(r2);
    expect(b.spentUsd).toBeCloseTo(r, 10);
  });

  it("refuses BY NAME when the next clip would pass the cap, and banks nothing for it", () => {
    const b = new RunBudget(0.01);
    const one = usdOf(estimateVideoTokens(6));
    const fits = Math.floor(0.01 / one);
    for (let i = 0; i < fits; i++) b.reserve(6);
    const before = b.spentUsd;
    expect(() => b.reserve(6)).toThrow(VideoEnrichCapExceeded);
    try {
      b.reserve(6);
    } catch (e: any) {
      expect(e.code).toBe("video_enrich_cap");
      expect(e.message).toContain("STUDIO_VIDEO_ENRICH_MAX_RUN_USD");
    }
    expect(b.spentUsd).toBe(before);
  });

  it("the cap reads the env at construction — a planned run raises it with one line", () => {
    process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD = "7";
    try {
      expect(new RunBudget().capUsd).toBe(7);
    } finally {
      delete process.env.STUDIO_VIDEO_ENRICH_MAX_RUN_USD;
    }
    expect(new RunBudget().capUsd).toBe(2);
  });
});
