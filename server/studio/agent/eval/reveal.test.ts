import { parseScores, reveal, revealMarkdown } from "./reveal";
import { CRITERIA, scoresTemplate } from "./sheet";
import type { PlanMetrics } from "./metrics";

const metrics = (over: Partial<PlanMetrics> = {}): PlanMetrics => ({
  items: 4,
  kinds: { i2v: 2, broll: 1, image: 1, product: 0, clip: 0 },
  generationShare: 0.75,
  realShare: 0.25,
  brollCount: 1,
  i2vCount: 2,
  nulled: 0,
  nullRate: 0,
  i2vWithoutHer: 0,
  stitchedRefs: 0,
  refsReused: 0,
  soundOn: 1,
  clipsWithoutHer: 0,
  generatedItems: 3,
  generatedWithAllAxes: 0,
  axesCoverage: 0,
  gaps: 0,
  productItems: 0,
  libraryHadClips: true,
  ...over,
});

describe("parseScores", () => {
  it("reads the template back with blanks as unscored, keeps commas inside the note, and refuses a foreign header", () => {
    const filled = scoresTemplate(["P01", "P02"])
      .replace("P01" + ",".repeat(8), "P01,5,4,,3,2,5,4,fine, really")
      .replace("P02" + ",".repeat(8), "P02" + ",".repeat(8));
    const rows = parseScores(filled);
    expect(rows[0]).toEqual({
      code: "P01",
      scores: {
        i2v_reserved: 5,
        stills_where_carried: 4,
        broll_earned: 3,
        product_rules: 2,
        overall_mix: 5,
        relevance: 4,
      },
      note: "fine, really",
    });
    expect(rows[1]).toEqual({ code: "P02", scores: {}, note: "" });
    expect(() => parseScores("code,foo\nP01,1")).toThrow(/header/);
  });
});

describe("reveal", () => {
  const key = {
    P01: { run: "baseline", briefId: "hype", repeat: 0 },
    P02: { run: "baseline", briefId: "hype", repeat: 1 },
    P03: { run: "doctrine", briefId: "hype", repeat: 0 },
    P04: { run: "doctrine", briefId: "hype", repeat: 1 },
    P05: { run: "doctrine", briefId: "recap", repeat: 0 },
  };
  const row = (code: string, v: number) => ({
    code,
    scores: Object.fromEntries(CRITERIA.map((c) => [c, v])) as Record<
      (typeof CRITERIA)[number],
      number
    >,
    note: "",
  });

  it("aggregates per run and per brief, counts null plans and unscored cells, and diffs two runs against the repeat spread", () => {
    const scores = [
      row("P01", 2),
      row("P02", 2),
      row("P03", 4),
      row("P04", 5),
      { code: "P05", scores: {}, note: "" },
    ];
    const r = reveal({
      key,
      scores,
      metrics: {
        P01: metrics(),
        P02: metrics({ generationShare: 0.5 }),
        P03: null,
        P04: metrics({ generationShare: 0.25 }),
        P05: metrics(),
      },
    });
    const base = r.runs.find((x) => x.run === "baseline")!;
    const doc = r.runs.find((x) => x.run === "doctrine")!;
    expect(base.criteria.overall_mix).toMatchObject({ n: 2, mean: 2, sd: 0 });
    expect(base.metrics.fields.generationShare.mean).toBe(0.625);
    expect(doc.metrics.nullPlans).toBe(1);
    expect(doc.unscored).toBe(1);
    expect(doc.briefs.hype.criteria.relevance.mean).toBe(4.5);
    const hype = r.diff!.cells.find(
      (c) => c.briefId === "hype" && c.criterion === "relevance",
    )!;
    // +2.5 against a spread of 0.71: moved.
    expect(hype).toMatchObject({ from: 2, to: 4.5, verdict: "moved" });
    expect(hype.delta).toBeCloseTo(2.5);
    expect(r.diff!.cells.find((c) => c.briefId === "recap")!.verdict).toBe(
      "unscored",
    );
  });

  it("calls a difference inside the repeat spread ambiguous, and names the brief for re-running", () => {
    const scores = [
      row("P01", 2),
      { ...row("P02", 4) },
      row("P03", 3),
      row("P04", 4),
    ];
    const r = reveal({
      key: { P01: key.P01, P02: key.P02, P03: key.P03, P04: key.P04 },
      scores,
      metrics: {},
    });
    // baseline mean 3 sd 1.41; doctrine mean 3.5 sd 0.71; delta 0.5 < 1.41.
    expect(r.diff!.cells.every((c) => c.verdict === "ambiguous")).toBe(true);
    expect(revealMarkdown(r)).toContain(
      "Ambiguous briefs (re-run at n=5–6 before flagging a rule): hype",
    );
  });

  it("has no diff with one run or three", () => {
    expect(
      reveal({ key: { P01: key.P01 }, scores: [], metrics: {} }).diff,
    ).toBeNull();
    expect(
      reveal({
        key: { ...key, P06: { run: "third", briefId: "hype", repeat: 0 } },
        scores: [],
        metrics: {},
      }).diff,
    ).toBeNull();
  });
});
