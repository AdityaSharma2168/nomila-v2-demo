import { aggregate, aggregateMetrics, planMetrics } from "./metrics";
import type { AgentPlan, PlanItem } from "../types";

const item = (over: Partial<PlanItem>): PlanItem => ({
  kind: "i2v",
  beat: "b",
  direction: "d",
  ref: "a1",
  segment: null,
  window: null,
  motion: null,
  searchQuery: null,
  sound: false,
  ...over,
});
const lib = [
  {
    ref: "a1",
    mediaType: "photo" as const,
    athletePresent: true,
    provenance: "camera" as const,
    picked: false,
  },
  {
    ref: "a2",
    mediaType: "photo" as const,
    athletePresent: false,
    provenance: "made-here" as const,
    picked: false,
  },
  {
    ref: "a3",
    mediaType: "clip" as const,
    athletePresent: true,
    provenance: "stitched-here" as const,
    picked: true,
  },
];

describe("planMetrics", () => {
  it("counts the mix — generation share, real share, b-roll, i2v, sound — from the kinds", () => {
    const plan: AgentPlan = {
      items: [
        item({ kind: "i2v", ref: "a1", sound: true }),
        item({ kind: "broll", ref: null }),
        item({ kind: "image", ref: "a2" }),
        item({ kind: "clip", ref: "a3" }),
      ],
      nulled: [{ item: 0, axis: "camera", value: "dutch" }],
      gaps: [],
    };
    const m = planMetrics(plan, lib)!;
    expect(m.items).toBe(4);
    expect(m.kinds).toEqual({
      i2v: 1,
      broll: 1,
      image: 1,
      product: 0,
      clip: 1,
    });
    expect(m.generationShare).toBe(0.5);
    expect(m.realShare).toBe(0.5);
    expect(m.brollCount).toBe(1);
    expect(m.soundOn).toBe(1);
    expect(m.nulled).toBe(1);
    expect(m.nullRate).toBe(0.25);
    expect(m.libraryHadClips).toBe(true);
  });

  it("flags an i2v on a photo without her, a ref onto a stitched compilation, and a ref used twice", () => {
    const plan: AgentPlan = {
      items: [
        item({ kind: "i2v", ref: "a2" }),
        item({ kind: "clip", ref: "a3" }),
        item({ kind: "image", ref: "a1" }),
        item({ kind: "i2v", ref: "a1" }),
      ],
      nulled: [],
      gaps: [],
    };
    const m = planMetrics(plan, lib)!;
    expect(m.i2vWithoutHer).toBe(1);
    expect(m.stitchedRefs).toBe(1);
    expect(m.refsReused).toBe(1);
  });

  it("a clip cut to two different beats is not a reused ref; the same beat twice is", () => {
    const twoBeats: AgentPlan = {
      items: [
        item({ kind: "clip", ref: "a3", segment: 0 }),
        item({ kind: "clip", ref: "a3", segment: 1 }),
      ],
      nulled: [],
      gaps: [],
    };
    expect(planMetrics(twoBeats, lib)!.refsReused).toBe(0);
    const sameBeat: AgentPlan = {
      items: [
        item({ kind: "clip", ref: "a3", segment: 1 }),
        item({ kind: "clip", ref: "a3", segment: 1 }),
      ],
      nulled: [],
      gaps: [],
    };
    expect(planMetrics(sameBeat, lib)!.refsReused).toBe(1);
    const wholeTwice: AgentPlan = {
      items: [
        item({ kind: "clip", ref: "a3" }),
        item({ kind: "clip", ref: "a3" }),
      ],
      nulled: [],
      gaps: [],
    };
    expect(planMetrics(wholeTwice, lib)!.refsReused).toBe(1);
  });

  it("is null for a null plan, and zero-safe on an empty library", () => {
    expect(planMetrics(null, lib)).toBeNull();
    const m = planMetrics(
      { items: [item({ kind: "broll", ref: null })], nulled: [], gaps: [] },
      [],
    )!;
    expect(m.libraryHadClips).toBe(false);
    expect(m.generationShare).toBe(1);
  });
});

describe("planMetrics — the doctrine's three new numbers", () => {
  it("counts filler clips (a clip line without her), §8 axes coverage over generated items only, gaps, and product items", () => {
    const full = {
      camera: "wide",
      movement: "static",
      lighting: "natural",
      composition: "rule_of_thirds",
      motion: "slow_motion",
    } as const;
    const plan: AgentPlan = {
      items: [
        item({ kind: "clip", ref: "a2" }),
        // A clip may carry asks too (the parser keeps them on any kind) — it must NOT count toward coverage.
        item({ kind: "clip", ref: "a3", capabilities: full }),
        item({ kind: "i2v", ref: "a1", capabilities: full }),
        item({ kind: "broll", ref: null, capabilities: { camera: "wide" } }),
        item({ kind: "product", ref: null }),
        item({ kind: "image", ref: "a1" }),
      ],
      nulled: [],
      gaps: ["no match footage, so the game is not shown"],
    };
    const m = planMetrics(plan, lib)!;
    expect(m.clipsWithoutHer).toBe(1);
    expect(m.generatedItems).toBe(3);
    expect(m.generatedWithAllAxes).toBe(1);
    expect(m.axesCoverage).toBeCloseTo(1 / 3);
    expect(m.gaps).toBe(1);
    expect(m.productItems).toBe(1);
  });

  it("axes coverage is 0, never NaN, when nothing is generated", () => {
    const m = planMetrics(
      { items: [item({ kind: "clip", ref: "a3" })], nulled: [], gaps: [] },
      lib,
    )!;
    expect(m.axesCoverage).toBe(0);
    expect(m.generatedItems).toBe(0);
  });
});

describe("aggregate", () => {
  it("gives mean, range and the sample sd — and 0s, never NaN, for nothing or one value", () => {
    expect(aggregate([])).toEqual({ n: 0, mean: 0, min: 0, max: 0, sd: 0 });
    expect(aggregate([3])).toEqual({ n: 1, mean: 3, min: 3, max: 3, sd: 0 });
    const a = aggregate([1, 2, 3, 4]);
    expect(a.mean).toBe(2.5);
    expect(a.sd).toBeCloseTo(1.291, 3);
  });

  it("counts null plans separately rather than averaging them as zeros", () => {
    const one = planMetrics(
      { items: [item({ kind: "broll", ref: null })], nulled: [], gaps: [] },
      lib,
    );
    const out = aggregateMetrics([one, null, one]);
    expect(out.nullPlans).toBe(1);
    expect(out.fields.generationShare).toMatchObject({ n: 2, mean: 1 });
  });
});
