/**
 * rhythmLogic.test.ts — the reading's rhythm as one word, conservatively (PR 15, D-2; P-rhythm-null).
 */
import { FAST_PHRASES, SLOW_PHRASES, rhythmFrom } from "./rhythmLogic";

const campaign = (
  refs: { ref?: string; summary?: string | null; noIntent?: boolean }[],
) => ({
  schema: "campaign-brief/1",
  references: refs.map((r) => ({
    ref: r.ref ?? "ref_1",
    role: "mood",
    intent: r.noIntent
      ? null
      : {
          editing_rhythm:
            r.summary === null
              ? null
              : { summary: r.summary, tags: [], basis: "observed" },
        },
  })),
});

describe("rhythmFrom", () => {
  it("reads unambiguous fast language as fast, with the phrase and the reference it fired on", () => {
    expect(
      rhythmFrom(
        campaign([
          {
            ref: "ref_2",
            summary:
              "Fast cuts on every beat, hard transitions, almost no shot longer than a second.",
          },
        ]),
      ),
    ).toEqual({ pace: "fast", matched: "fast cuts", ref: "ref_2" });
  });

  it("reads unambiguous slow language as slow", () => {
    expect(
      rhythmFrom(
        campaign([
          { summary: "Long takes that linger; slow dissolves between scenes." },
        ]),
      ),
    ).toEqual({ pace: "slow", matched: "long takes", ref: "ref_1" });
  });

  /**
   * P-rhythm-null: with no reading, or one that names no pace, the answer is null and today's
   * default stands. ⚠️ MUTATION: return "fast" when nothing matched — this reds by name.
   */
  it("P-rhythm-null: no reading, a null dimension, a null intent, or prose with no pace word is null", () => {
    expect(rhythmFrom(null)).toBeNull();
    expect(rhythmFrom({})).toBeNull();
    expect(rhythmFrom({ references: "nope" })).toBeNull();
    expect(rhythmFrom(campaign([]))).toBeNull();
    expect(rhythmFrom(campaign([{ noIntent: true }]))).toBeNull();
    expect(rhythmFrom(campaign([{ summary: null }]))).toBeNull();
    expect(
      rhythmFrom(
        campaign([
          {
            summary:
              "Mostly medium shots of the product, a warm grade, an easy rhythm to it.",
          },
        ]),
      ),
    ).toBeNull();
  });

  /** ⚠️ MUTATION: return the first hit without checking the other list — this reds by name. */
  it("an ambiguous reading chooses a pace — never: both fast and slow language in one brief is null", () => {
    expect(
      rhythmFrom(
        campaign([
          {
            summary:
              "Fast cuts through the action, then long takes on her face.",
          },
        ]),
      ),
    ).toBeNull();
    expect(
      rhythmFrom(
        campaign([
          { ref: "ref_1", summary: "quick cuts throughout" },
          { ref: "ref_2", summary: "lingering, unhurried" },
        ]),
      ),
    ).toBeNull();
  });

  it("matches whole words only, hyphens read as spaces, case ignored", () => {
    expect(
      rhythmFrom(campaign([{ summary: "FAST-PACED montage" }]))?.pace,
    ).toBe("fast");
    // "snappy" inside another word is not "snappy".
    expect(rhythmFrom(campaign([{ summary: "unsnappyish" }]))).toBeNull();
  });

  it("every phrase on both lists fires on its own, and no phrase is on both lists", () => {
    for (const p of FAST_PHRASES)
      expect(rhythmFrom(campaign([{ summary: `it is ${p} here` }]))).toEqual({
        pace: "fast",
        matched: p,
        ref: "ref_1",
      });
    for (const p of SLOW_PHRASES)
      expect(rhythmFrom(campaign([{ summary: `it is ${p} here` }]))).toEqual({
        pace: "slow",
        matched: p,
        ref: "ref_1",
      });
    for (const p of FAST_PHRASES) expect(SLOW_PHRASES).not.toContain(p);
  });
});
